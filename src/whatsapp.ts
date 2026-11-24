import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Event, Message } from "./db";
import { maxPhotoKb, photoTypes } from "./domain";
import { logger } from "./logger";
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

function messageBody(message: Exclude<Message, { kind: "receipt" | "image" }>) {
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
            flow_cta: "Open form", flow_action: "navigate", flow_action_payload: { screen: "FORM", ...(message.screen && { data: message.screen }) },
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

let lookedUpNumber: string | undefined;

/**
 * Zunde's WhatsApp number in international digits, for wa.me links. Asked from Meta for the
 * configured phone number ID, so a mistyped WA_BUSINESS_NUMBER (e.g. an account ID) cannot break links.
 */
export async function businessNumber() {
  const configured = process.env.WA_BUSINESS_NUMBER?.replace(/\D/g, "");
  if (lookedUpNumber) return lookedUpNumber;
  if (graphConfigured()) {
    const { WA_GRAPH_VERSION, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN } = process.env;
    try {
      const res = await fetch(`https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_NUMBER_ID?.trim()}?fields=display_phone_number`, {
        headers: { authorization: `Bearer ${WA_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(8000),
      });
      const digits = String((await res.json().catch(() => null))?.display_phone_number ?? "").replace(/\D/g, "");
      if (res.ok && /^\d{8,15}$/.test(digits)) {
        if (configured && configured !== digits) logger.warn("WA_BUSINESS_NUMBER does not match the WhatsApp number of WA_PHONE_NUMBER_ID; using the number from Meta");
        return lookedUpNumber = digits;
      }
    } catch {
      // Fall back to the configured number below.
    }
  }
  return configured && /^\d{8,15}$/.test(configured) ? configured : undefined;
}

/** Turns a receipt share into a link button, or plain instructions when no business number is known. */
async function receiptBody(message: Extract<Message, { kind: "receipt" }>) {
  const number = await businessNumber();
  if (!number) return messageBody({ kind: "text", body: `${message.body}\nAsk the receiver to send this to Zunde after delivery:\n${message.command}` });
  const confirm = `https://wa.me/${number}?text=${encodeURIComponent(message.command)}`;
  return {
    type: "interactive",
    interactive: { type: "cta_url", body: { text: message.body }, action: { name: "cta_url", parameters: {
      display_text: "Share with receiver", url: `https://wa.me/?text=${encodeURIComponent(`${message.share}\n${confirm}`)}`,
    } } },
  };
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

const graph = (path: string) => `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION}/${path}`;
const auth = () => ({ authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` });

/**
 * Copies media a user sent (e.g. Flow photos) to a new upload under Zunde's number, so it can be
 * sent to someone else. Download URLs expire after minutes, so they are looked up at send time.
 */
async function forwardMedia(mediaId: string) {
  const fail = (step: string, status?: number) => new Error(`WhatsApp send failed (media ${step}${status ? `, HTTP ${status}` : ""})`);
  const info = await fetch(graph(encodeURIComponent(mediaId)), { headers: auth(), signal: AbortSignal.timeout(8000) });
  const media = await info.json().catch(() => null);
  if (!info.ok || typeof media?.url !== "string") throw fail("lookup", info.status);
  // WhatsApp would reject these on every retry, so stop before downloading.
  const type = photoTypes.find((t) => t === media.mime_type);
  if (!type) throw fail("type unsupported");
  if (Number(media.file_size) > maxPhotoKb * 1024) throw fail("too large");
  const file = await fetch(media.url, { headers: auth(), signal: AbortSignal.timeout(20_000) });
  if (!file.ok) throw fail("download", file.status);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > maxPhotoKb * 1024) throw fail("too large");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", type);
  form.append("file", new Blob([bytes], { type }), type === "image/png" ? "load.png" : "load.jpg");
  const upload = await fetch(graph(`${process.env.WA_PHONE_NUMBER_ID?.trim()}/media`), {
    method: "POST", headers: auth(), body: form, signal: AbortSignal.timeout(20_000),
  });
  const uploaded = await upload.json().catch(() => null);
  if (!upload.ok || typeof uploaded?.id !== "string") throw fail("upload", upload.status);
  return uploaded.id;
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
  const template = WA_UPDATE_TEMPLATE?.trim();
  // Images can only be sent in the customer-service window. The message they accompany
  // already brings the recipient back, and reopening it resends the photos.
  if (message.kind === "image") {
    if (!inWindow) return;
    const res = await postMessages({ to, type: "image", image: { id: await forwardMedia(message.mediaId), caption: message.body } });
    if (!res.ok) {
      const result = await res.json().catch(() => null);
      throw new Error(`WhatsApp send failed (HTTP ${res.status}, image)`, { cause: result?.error ?? result });
    }
    return;
  }
  if (!inWindow && !template) {
    throw new Error("WhatsApp send failed: WA_UPDATE_TEMPLATE is required outside the customer-service window");
  }
  const payload = !inWindow ? {
    type: "template", template: { name: template, language: { code: WA_TEMPLATE_LANGUAGE || "en" } },
  } : message.kind === "receipt" ? await receiptBody(message) : messageBody(message);
  const res = await postMessages({ to, ...payload });
  if (!res.ok) {
    const result = await res.json().catch(() => null);
    const code = Number(result?.error?.code);
    if (code === 131047 && inWindow) return sendWhatsApp(to, message, false);
    throw new Error(`WhatsApp send failed (HTTP ${res.status}${code ? `, code ${code}` : ""})`, { cause: result?.error ?? result });
  }
}

export async function sendAdminCode(to: string, code: string) {
  const name = process.env.WA_ADMIN_OTP_TEMPLATE?.trim();
  if (!name || !graphConfigured()) throw new Error("WhatsApp admin authentication is not configured");
  const parameters = [{ type: "text", text: code }];
  const res = await postMessages({ to, type: "template", template: {
    name, language: { code: process.env.WA_ADMIN_OTP_LANGUAGE || "en" },
    components: [{ type: "body", parameters }, { type: "button", sub_type: "url", index: "0", parameters }],
  } });
  // Provider error bodies can echo authentication codes.
  if (!res.ok) throw new Error(`WhatsApp authentication template failed (HTTP ${res.status})`);
}
