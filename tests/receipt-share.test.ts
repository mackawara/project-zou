import assert from "node:assert/strict";
import test from "node:test";
import { sendWhatsApp } from "../src/whatsapp";

const receipt = {
  kind: "receipt", body: "Is someone else receiving the goods?", command: "received abc.123",
  share: "Zunde delivery 23FC877F: Kwekwe → Bulawayo.\nWhen the goods reach you, tap this link:",
} as const;

// Runs first: a successful lookup below is cached for the rest of the process.
test("without any business number the shipper gets the command as plain text", async (t) => {
  const keys = ["WA_ACCESS_TOKEN", "WA_GRAPH_VERSION", "WA_PHONE_NUMBER_ID", "WA_BUSINESS_NUMBER"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]));
  Object.assign(process.env, { WA_ACCESS_TOKEN: "test-token", WA_GRAPH_VERSION: "v23.0", WA_PHONE_NUMBER_ID: "1" });
  delete process.env.WA_BUSINESS_NUMBER;
  const sent: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (!init?.method) return Response.json({}, { status: 500 });
    sent.push(JSON.parse(String(init.body)));
    return Response.json({});
  });
  await sendWhatsApp("263770000000", receipt, true);
  assert.equal(sent[0].type, "text");
  assert.match(sent[0].text.body, /send this to Zunde after delivery:\nreceived abc\.123$/);
});

test("the receipt share button links to Zunde's real number, even when WA_BUSINESS_NUMBER is wrong", async (t) => {
  const keys = ["WA_ACCESS_TOKEN", "WA_GRAPH_VERSION", "WA_PHONE_NUMBER_ID", "WA_BUSINESS_NUMBER"];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]));
  // The mistake seen in the pilot: an account ID in place of the phone number.
  Object.assign(process.env, { WA_ACCESS_TOKEN: "test-token", WA_GRAPH_VERSION: "v23.0", WA_PHONE_NUMBER_ID: "521260107744696", WA_BUSINESS_NUMBER: "523317624199816" });
  let lookup: "fail" | "ok" = "fail";
  const sent: any[] = [];
  const lookups: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (!init?.method) {
      lookups.push(url);
      return lookup === "ok" ? Response.json({ display_phone_number: "+263 77 000 1111" }) : Response.json({}, { status: 500 });
    }
    sent.push(JSON.parse(String(init.body)));
    return Response.json({});
  });
  const shareUrl = () => sent.at(-1).interactive.action.parameters.url as string;

  // Meta unreachable: the configured number is the fallback.
  await sendWhatsApp("263770000000", receipt, true);
  assert.equal(sent.at(-1).interactive.type, "cta_url");
  assert.equal(sent.at(-1).interactive.action.parameters.display_text, "Share with receiver");
  assert.match(decodeURIComponent(shareUrl()), /https:\/\/wa\.me\/523317624199816\?text=received%20abc\.123$/);

  // Meta answers: its number wins and is cached.
  lookup = "ok";
  await sendWhatsApp("263770000000", receipt, true);
  await sendWhatsApp("263770000000", receipt, true);
  assert.equal(lookups.length, 2); // One failed lookup, then one that is cached.
  assert.match(lookups[0], /\/v23\.0\/521260107744696\?fields=display_phone_number$/);
  const url = new URL(shareUrl());
  assert.equal(`${url.origin}${url.pathname}`, "https://wa.me/");
  const text = url.searchParams.get("text")!;
  assert.equal(text, `${receipt.share}\nhttps://wa.me/263770001111?text=received%20abc.123`);
  // What the receiver's link sends back to Zunde.
  assert.equal(new URL(text.split("\n").at(-1)!).searchParams.get("text"), "received abc.123");
});
