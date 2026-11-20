import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Event, Message } from "./db";
import { sameSecret } from "./secrets";

const inbound = z.object({
  id: z.string().min(1).max(255),
  from: z.string().regex(/^\d{8,15}$/),
  timestamp: z.string().regex(/^\d{10}$/),
  text: z.object({ body: z.string().max(4096) }).optional(),
  interactive: z.object({
    button_reply: z.object({ id: z.string().max(256) }).optional(),
    list_reply: z.object({ id: z.string().max(256) }).optional(),
    nfm_reply: z.object({ response_json: z.string().max(16_384) }).optional(),
  }).optional(),
});
const envelope = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({ changes: z.array(z.object({
    field: z.string(),
    value: z.object({
      metadata: z.object({ phone_number_id: z.string() }).optional(),
      messages: z.array(z.unknown()).optional(),
    }),
  })) })),
});

export type WebhookMessage = z.infer<typeof inbound>;
export type WebhookPayload = z.infer<typeof envelope>;

export function authentic(raw: Buffer, signature: string, secret: string) {
  return sameSecret(signature, "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
}

// True when the payload names business numbers and none of them is ours, so we can drop it without work.
export function foreignOnly(payload: unknown, phoneId: string) {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) return false;
  const ids = parsed.data.entry.flatMap(({ changes }) => changes.map(({ value }) => value.metadata?.phone_number_id))
    .filter((id): id is string => id !== undefined);
  return ids.length > 0 && ids.every((id) => id !== phoneId);
}

export function eventsFrom(payload: unknown, phoneId: string, now = new Date()): Event[] {
  if (!phoneId.trim()) return [];
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) return [];
  const events: Event[] = [];
  for (const entry of parsed.data.entry) {
    for (const { field, value } of entry.changes) {
      // Match the receiving business number, not the customer's sender number.
      if (field !== "messages" || value.metadata?.phone_number_id !== phoneId) continue;
      for (const input of value.messages ?? []) {
        const item = inbound.safeParse(input);
        if (!item.success) continue;
        const { id, from, timestamp, interactive, text } = item.data;
        const base = { id, from, at: new Date(Math.min(Number(timestamp) * 1000, now.getTime())) };
        const form = interactive?.nfm_reply?.response_json;
        const action = interactive?.list_reply?.id ?? interactive?.button_reply?.id;
        if (form) events.push({ ...base, kind: "flow", value: form });
        else if (action) events.push({ ...base, kind: "action", value: action });
        else if (text) events.push({ ...base, kind: "text", value: text.body });
      }
    }
  }
  return events;
}

function messageBody(message: Message) {
  if (message.kind === "text") return { type: "text", text: { body: message.body, preview_url: false } };
  const body = { text: message.body };
  switch (message.kind) {
    case "flow": {
      const id = process.env[`WA_FLOW_${message.flow.toUpperCase()}`];
      if (!id) throw new Error(`Missing Flow ID for ${message.flow}`);
      return {
        type: "interactive",
        interactive: {
          type: "flow", body,
          action: { name: "flow", parameters: {
            flow_message_version: "3", flow_id: id, flow_token: message.token,
            flow_cta: "Open form", flow_action: "navigate", flow_action_payload: { screen: "FORM" },
          } },
        },
      };
    }
    case "buttons": return {
      type: "interactive",
      interactive: { type: "button", body, action: {
        buttons: message.actions.map(({ id, title }) => ({ type: "reply", reply: { id, title: title.slice(0, 20) } })),
      } },
    };
    case "list": return {
      type: "interactive",
      interactive: { type: "list", body, action: {
        button: "View options", sections: [{ rows: message.actions.map(({ id, title, description }) => ({
          id, title: title.slice(0, 24), ...(description && { description: description.slice(0, 72) }),
        })) }],
      } },
    };
  }
}

function graphConfigured() {
  const { WA_GRAPH_VERSION, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN } = process.env;
  return !!WA_GRAPH_VERSION && /^v\d+\.\d+$/.test(WA_GRAPH_VERSION) && !!WA_PHONE_NUMBER_ID && !!WA_ACCESS_TOKEN;
}

function postMessages(body: Record<string, unknown>) {
  const { WA_GRAPH_VERSION, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN } = process.env;
  return fetch(`https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_NUMBER_ID?.trim()}/messages`, {
    method: "POST", headers: { authorization: `Bearer ${WA_ACCESS_TOKEN}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(8000), body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
}

/** Marks an incoming message as read, so the sender sees blue ticks once it has been handled. */
export async function markRead(messageId: string) {
  if (!graphConfigured()) return;
  const res = await postMessages({ status: "read", message_id: messageId });
  if (!res.ok) {
    const result = await res.json().catch(() => null);
    // The Graph API error body is kept as the cause, so development logs show Meta's explanation.
    throw new Error(`WhatsApp read receipt failed (HTTP ${res.status})`, { cause: result?.error ?? result });
  }
}

export async function sendWhatsApp(to: string, message: Message, inWindow: boolean) {
  const { WA_UPDATE_TEMPLATE, WA_TEMPLATE_LANGUAGE } = process.env;
  if (!graphConfigured()) throw new Error("WhatsApp sending is not configured");
  if (!inWindow && !WA_UPDATE_TEMPLATE) return;
  const payload = inWindow ? messageBody(message) : {
    type: "template", template: { name: WA_UPDATE_TEMPLATE, language: { code: WA_TEMPLATE_LANGUAGE || "en" } },
  };
  const res = await postMessages({ to, ...payload });
  if (!res.ok) {
    const result = await res.json().catch(() => null);
    const code = Number(result?.error?.code);
    if (code === 131047 && inWindow) return sendWhatsApp(to, message, false);
    throw new Error(`WhatsApp send failed (HTTP ${res.status}${code ? `, code ${code}` : ""})`, { cause: result?.error ?? result });
  }
}
