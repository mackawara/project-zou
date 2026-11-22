import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { GET, POST } from "../src/app/whatsapp/hook/route";
import { getAnalytics } from "../src/analytics";
import { collections, database, ensureIndexes, type Message } from "../src/db";
import { hour, localDate } from "../src/domain";
import { transport } from "../src/webhook/incomingMessageHandler";
import { eventsFrom, sendWhatsApp } from "../src/whatsapp";

const appSecret = "local-test-secret";
const testShipper = "263771000001";
const testTrucker = "263771000002";
const testReceiver = "263771000003";
const phoneId = "test-business-id";
const webhook = "https://zunde.test/whatsapp/hook";
process.env.WA_APP_SECRET = appSecret;
process.env.WA_PHONE_NUMBER_ID = phoneId;
process.env.WA_VERIFY_TOKEN = "verify-local";

test("webhook answers verification and rejects a forged message", async () => {
  const response = GET(new Request(webhook + "?hub.mode=subscribe&hub.verify_token=verify-local&hub.challenge=123"));
  assert.equal(await response.text(), "123");
  assert.equal(GET(new Request(webhook + "?hub.mode=subscribe&hub.verify_token=other&hub.challenge=123")).status, 403);
  assert.equal((await POST(new Request(webhook, { method: "POST", body: "{}" }))).status, 401);
});

test("hook requires a valid signature from the configured app secret even when the phone ID matches", async () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{
    field: "messages", value: { metadata: { phone_number_id: phoneId }, messages: [{
      id: "signature-test", from: testShipper, timestamp: "1794931200", text: { body: "MENU" },
    }] },
  }] }] });
  const signature = "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex");
  const wrongSecretSignature = "sha256=" + createHmac("sha256", "other-app-secret").update(body).digest("hex");
  for (const supplied of [undefined, "", "sha256=invalid", appSecret, wrongSecretSignature]) {
    const response = await POST(new Request(webhook, { method: "POST", body,
      headers: supplied === undefined ? {} : { "x-hub-signature-256": supplied } }));
    assert.equal(response.status, 401);
  }
  const tampered = await POST(new Request(webhook, { method: "POST", body: body.replace("MENU", "find a truck"),
    headers: { "x-hub-signature-256": signature } }));
  assert.equal(tampered.status, 401);
  // Signed requests pass authentication; a status-only payload needs no database work.
  const statusBody = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{
    field: "messages", value: { metadata: { phone_number_id: phoneId }, statuses: [] },
  }] }] });
  const accepted = await POST(new Request(webhook, { method: "POST", body: statusBody,
    headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", appSecret).update(statusBody).digest("hex") } }));
  assert.equal(accepted.status, 200);
});

test("only extracts messages addressed to our business phone number ID in mixed batches", () => {
  const change = (id: string, metadata?: { phone_number_id: string }, content = { text: { body: "MENU" } } as Record<string, unknown>) => ({
    field: "messages", value: { ...(metadata && { metadata }),
      messages: [{ id, from: testShipper, timestamp: "1794931200", ...content }] },
  });
  const ours = { phone_number_id: phoneId };
  const payload = { object: "whatsapp_business_account", entry: [
    { changes: [change("foreign", { phone_number_id: "other-business-id" }), change("our-text", ours), change("missing")] },
    { changes: [change("our-action", ours, { interactive: { button_reply: { id: "search" } } }),
      change("our-flow", ours, { interactive: { nfm_reply: { response_json: '{"flow_token":"test"}' } } }),
      { field: "messages", value: { metadata: ours, statuses: [{ id: "status-only" }] } },
      { ...change("other-field", ours), field: "account_update" }] },
  ] };
  assert.deepEqual(eventsFrom(payload, phoneId).map(({ id, kind }) => ({ id, kind })), [
    { id: "our-text", kind: "text" }, { id: "our-action", kind: "action" }, { id: "our-flow", kind: "flow" },
  ]);
  assert.deepEqual(eventsFrom(payload, ""), []);
  assert.deepEqual(eventsFrom({ object: "whatsapp_business_account", entry: [{ changes: [change("blank", { phone_number_id: "" })] }] }, ""), []);
});

test("hook acknowledges signed messages for other or missing business IDs without queuing", async () => {
  for (const metadata of [{ phone_number_id: "other-business-id" }, undefined]) {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{
      field: "messages", value: { metadata, messages: [{ id: randomUUID(), from: testShipper,
        timestamp: "1794931200", text: { body: "MENU" } }] },
    }] }] });
    const signature = createHmac("sha256", appSecret).update(body).digest("hex");
    const response = await POST(new Request(webhook, { method: "POST", body,
      headers: { "x-hub-signature-256": "sha256=" + signature } }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "OK");
  }
});

test("hook fails closed when either the app secret or business phone number ID is not configured", async () => {
  for (const key of ["WA_APP_SECRET", "WA_PHONE_NUMBER_ID"]) {
    const configured = process.env[key];
    try {
      for (const value of [undefined, "", "   "]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        assert.equal((await POST(new Request(webhook, { method: "POST", body: "{}" }))).status, 503);
      }
    } finally {
      if (configured === undefined) delete process.env[key];
      else process.env[key] = configured;
    }
  }
});

test("out-of-window sends use the configured template or report the missing configuration", async (t) => {
  const keys = ["WA_UPDATE_TEMPLATE", "WA_TEMPLATE_LANGUAGE", "WA_ACCESS_TOKEN", "WA_GRAPH_VERSION"] as const;
  const saved = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  }));
  process.env.WA_ACCESS_TOKEN = "test-token";
  process.env.WA_GRAPH_VERSION = "v23.0";
  process.env.WA_TEMPLATE_LANGUAGE = "en";
  delete process.env.WA_UPDATE_TEMPLATE;
  const sent: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    sent.push(payload);
    return payload.type === "template" ? Response.json({}) : Response.json({ error: { code: 131047 } }, { status: 400 });
  });
  const alert = { kind: "text", body: "Match found" } as const;
  await assert.rejects(sendWhatsApp(testShipper, alert, false), /WA_UPDATE_TEMPLATE/);
  assert.equal(sent.length, 0);
  await assert.rejects(sendWhatsApp(testShipper, alert, true), /WA_UPDATE_TEMPLATE/);
  process.env.WA_UPDATE_TEMPLATE = "pilot_update";
  await sendWhatsApp(testShipper, alert, true);
  assert.deepEqual(sent.map((payload) => payload.type), ["text", "text", "template"]);
  assert.deepEqual(sent.at(-1)?.template, { name: "pilot_update", language: { code: "en" } });
});

test("WhatsApp webhook to shipment completion, cancellation, and analytics", { skip: !process.env.TEST_MONGODB_URI }, async () => {
  process.env.MONGODB_URI = process.env.TEST_MONGODB_URI;
  process.env.MONGODB_DB = "zunde_test_" + randomUUID().replaceAll("-", "");
  process.env.ZUNDE_DATA_KEY = "42".repeat(32);
  const { db, client } = await database();
  try {
    const c = collections(db);
    await ensureIndexes(db);
    const delivered: { to: string; message: Message }[] = [];
    const read: string[] = [];
    // The webhook handles messages and sends replies itself; capture them instead of calling the Graph API.
    transport.deliver = async (to: string, message: Message) => { delivered.push({ to, message }); };
    transport.read = async (id: string) => { read.push(id); };
    const last = (to: string) => delivered.filter((item) => item.to === to).at(-1)!.message;
    const button = (to: string, title: string) => {
      const message = last(to);
      assert.ok(message.kind === "buttons" || message.kind === "list", message.body);
      const found = message.actions.find((item) => item.title.startsWith(title));
      assert.ok(found, title);
      return found.id;
    };
    async function message(from: string, content: Record<string, unknown>, id: string = randomUUID()) {
      const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{
        field: "messages", value: { metadata: { phone_number_id: phoneId },
          messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...content }] },
      }] }] });
      const signature = createHmac("sha256", appSecret).update(body).digest("hex");
      const [before, duplicate] = [delivered.length, read.includes(id)];
      assert.equal((await POST(new Request(webhook, { method: "POST", body, headers: { "x-hub-signature-256": "sha256=" + signature } }))).status, 200);
      // Like the ISP bot, a new message is answered and marked read before the webhook returns;
      // a repeat delivery of the same message ID is acknowledged without being handled again.
      assert.equal(delivered.length > before, !duplicate);
      assert.equal(read.filter((item) => item === id).length, 1);
      assert.equal(await c.inbox.countDocuments({ event: { $exists: true } }), 0);
      assert.equal(await c.outbox.countDocuments({ message: { $exists: true } }), 0);
    }
    const say = (from: string, body: string, id?: string) => message(from, { text: { body } }, id);
    const click = (from: string, id: string) => message(from, { interactive: { button_reply: { id } } });
    const form = (from: string, fields: Record<string, unknown>, expected: string, id?: string) => {
      const received = last(from);
      assert.ok(received.kind === "flow", received.body);
      assert.equal(received.flow, expected);
      return [received.token, message(from, { interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: received.token, ...fields }) } } }, id)] as const;
    };

    await say(testTrucker, "Hi");
    assert.match(last(testTrucker).body, /spare space on trucks/);
    await say(testTrucker, "Hi again");
    assert.match(last(testTrucker).body, /^Welcome to Zunde\. What would you like to do\?/);
    await say(testTrucker, " Help ");
    assert.match(last(testTrucker).body, /^How Zunde works/);
    await click(testTrucker, button(testTrucker, "I drive a truck"));
    assert.match(last(testTrucker).body, /^Carrying loads/);
    assert.ok(button(testTrucker, "Advertise space"));
    await click(testTrucker, button(testTrucker, "Main menu"));
    assert.ok(button(testTrucker, "Find a truck"));
    await click(testReceiver, "help:receiver");
    assert.match(last(testReceiver).body, /^Receiving goods/);

    const date = localDate(new Date(Date.now() + 48 * hour));
    const data = { pickup: "Kwekwe", dropoff: "Bulawayo", date, cargo: "Produce", weight: "2", notes: "Keep dry" };
    await say(testShipper, "find a truck");
    const [token, submission] = form(testShipper, data, "search", "search-1");
    await submission;
    const searchReply = { interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: token, ...data }) } } };
    await message(testShipper, searchReply, "search-1");
    assert.match(last(testShipper).body, /No truck fits/);
    assert.equal(await c.requests.countDocuments(), 1);
    assert.equal(await c.profiles.countDocuments({ _id: testShipper }), 0);
    await say(testTrucker, "advertise space");
    await form(testTrucker, { origin: "Harare", destination: "Hwange", date, time: "16:00", capacity: "5", acceptedCargo: ["Produce"] }, "trip")[1];
    assert.equal(await c.trips.countDocuments(), 0);
    assert.match(last(testShipper).body, /No truck fits/);
    const registration = { name: "Test Driver", registration: "ABC 1001", company: "Test Freight", nationalId: "63-1234567-F-42" };
    const [registrationToken, posted] = form(testTrucker, registration, "trucker", "new-advert");
    await posted;
    await message(testTrucker, { interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: registrationToken, ...registration }) } } }, "new-advert");
    assert.equal(await c.trips.countDocuments(), 1);
    const registered = await c.profiles.findOne({ _id: testTrucker });
    assert.ok(registered?.trucker?.nationalIdEncrypted);
    assert.doesNotMatch(JSON.stringify(registered), /1234567/);
    assert.match(last(testTrucker).body, /1 matching load[\s\S]*Kwekwe → Bulawayo · 2 t of Produce/);
    assert.doesNotMatch(last(testTrucker).body, new RegExp(testShipper + "|Keep dry"));
    assert.match(last(testShipper).body, /A truck now fits your load/);
    assert.doesNotMatch(last(testShipper).body, new RegExp(testTrucker));
    assert.equal(await c.shipments.countDocuments(), 0);
    assert.equal(await c.searchMetrics.countDocuments({ matchedAt: { $exists: true } }), 1);
    const select = button(testShipper, "Request a price");
    await click(testShipper, select);
    assert.equal(last(testShipper).kind, "text");
    assert.match(last(testShipper).body, /Reply with your name/);
    await say(testReceiver, "Other Person");
    assert.equal(await c.profiles.countDocuments({ _id: testReceiver }), 0);
    await say(testShipper, " ");
    assert.match(last(testShipper).body, /1 to 80/);
    await say(testShipper, "x".repeat(81));
    assert.equal(await c.profiles.countDocuments({ _id: testShipper }), 0);
    assert.equal(await c.inputs.countDocuments({ _id: testShipper }), 1);
    await say(testShipper, "  Test Shipper  ", "shipper-name");
    await say(testShipper, "  Test Shipper  ", "shipper-name");
    assert.equal((await c.profiles.findOne({ _id: testShipper }))?.shipper?.name, "Test Shipper");
    assert.equal(await c.inputs.countDocuments({ _id: testShipper }), 0);
    assert.equal(await c.shipments.countDocuments(), 1);
    assert.doesNotMatch(last(testTrucker).body, new RegExp(testShipper));
    await click(testShipper, select);
    assert.equal(await c.shipments.countDocuments(), 1);
    await click(testTrucker, button(testTrucker, "Make an offer"));
    assert.equal(last(testTrucker).kind, "text");
    for (const invalid of ["free", "0", "-1", "80.255", "1000000"]) {
      await say(testTrucker, invalid);
      assert.match(last(testTrucker).body, /Enter a total price in USD/);
      assert.equal(await c.shipments.countDocuments({ state: "offered" }), 0);
    }
    await say(testTrucker, " 80.25 ", "offer-price");
    await say(testTrucker, " 80.25 ", "offer-price");
    assert.equal(await c.inputs.countDocuments({ _id: testTrucker }), 0);
    assert.match(last(testShipper).body, /US\$80\.25/);
    assert.doesNotMatch(last(testShipper).body, new RegExp(testTrucker));
    const accept = button(testShipper, "Accept offer");
    await click(testReceiver, accept);
    assert.equal(await c.shipments.countDocuments({ state: "offered" }), 1);
    await click(testShipper, accept);
    assert.match(last(testShipper).body, new RegExp(testTrucker));
    assert.match(last(testTrucker).body, new RegExp(testShipper));
    const receipt = last(testShipper).body.match(/received [\w.-]+/)?.[0];
    assert.ok(receipt);
    const mark = button(testTrucker, "Mark delivered");
    await say(testTrucker, receipt);
    assert.equal(await c.shipments.countDocuments({ receivedAt: { $exists: true } }), 0);
    await say(testReceiver, receipt);
    assert.equal(await c.shipments.countDocuments({ state: "completed" }), 0);
    await click(testTrucker, mark);
    assert.equal(await c.shipments.countDocuments({ state: "completed" }), 1);
    assert.equal(await c.profiles.countDocuments({ _id: testReceiver }), 0);

    // Navigating, cancelling or timing out must not apply a later reply to an old advert.
    const trip = await c.trips.findOne({ trucker: testTrucker });
    assert.ok(trip);
    await click(testTrucker, `capacity:${trip._id}`);
    await say(testTrucker, "MENU");
    assert.equal(await c.inputs.countDocuments({ _id: testTrucker }), 0);
    await say(testTrucker, "1");
    assert.equal((await c.trips.findOne({ _id: trip._id }))?.capacity, 5000);
    await click(testTrucker, `capacity:${trip._id}`);
    await click(testTrucker, "activity");
    assert.equal(await c.inputs.countDocuments({ _id: testTrucker }), 0);
    await click(testTrucker, `capacity:${trip._id}`);
    await say(testTrucker, "CANCEL");
    assert.equal(await c.inputs.countDocuments({ _id: testTrucker }), 0);
    await click(testTrucker, `capacity:${trip._id}`);
    await c.inputs.updateOne({ _id: testTrucker }, { $set: { expiresAt: new Date(0) } });
    await say(testTrucker, "1");
    assert.match(last(testTrucker).body, /expired|Welcome/);
    assert.equal((await c.trips.findOne({ _id: trip._id }))?.capacity, 5000);

    await say(testShipper, "find a truck");
    await form(testShipper, data, "search")[1];
    assert.match(last(testTrucker).body, /A shipper is looking for space/);
    await click(testShipper, button(testShipper, "Truck 1"));
    assert.match(last(testShipper).body, /Waiting/);
    await click(testTrucker, button(testTrucker, "Make an offer"));
    // An offer can become unavailable while the trucker is typing.
    const requested = await c.shipments.findOne({ state: "requested" });
    assert.ok(requested);
    const replyBy = requested.replyBy;
    await c.shipments.updateOne({ _id: requested._id }, { $set: { replyBy: new Date(0) } });
    await say(testTrucker, "81");
    assert.match(last(testTrucker).body, /no longer open/);
    assert.equal(await c.shipments.countDocuments({ state: "offered" }), 0);
    await c.shipments.updateOne({ _id: requested._id }, { $set: { replyBy } });
    await click(testTrucker, `offer:${requested._id}`);
    await say(testTrucker, "81");
    await click(testShipper, button(testShipper, "Accept offer"));
    await click(testTrucker, button(testTrucker, "Cancel shipment"));
    const cancelled = await c.shipments.findOne({ state: "cancelled" });
    assert.equal(cancelled?.cancelledBy, testTrucker);
    assert.ok(cancelled?.cancelledAt);
    assert.equal((await c.trips.findOne({ trucker: testTrucker }))?.capacity, 5000);
    await click(testTrucker, `capacity:${cancelled?.tripId}`);
    assert.equal(last(testTrucker).kind, "text");
    for (const invalid of ["lots", "-1", "40.1", "0.01"]) {
      await say(testTrucker, invalid);
      assert.match(last(testTrucker).body, /Enter 0 or a number/);
      assert.equal((await c.trips.findOne({ _id: trip._id }))?.capacity, 5000);
    }
    await say(testTrucker, "2.5");
    assert.equal((await c.trips.findOne({ _id: trip._id }))?.capacity, 2500);
    await click(testTrucker, `capacity:${trip._id}`);
    await say(testTrucker, " 0 ");
    assert.equal((await c.trips.findOne({ _id: trip._id }))?.capacity, 0);
    await say(testShipper, "find a truck");
    await form(testShipper, data, "search")[1];
    assert.match(last(testShipper).body, /No truck fits/);
    const stats = await getAnalytics("7");
    assert.deepEqual([stats.requests, stats.trips, stats.matched, stats.confirmed, stats.completed, stats.cancelled], [3, 1, 2, 2, 1, 1]);
    const beforeIncrease = delivered.length;
    await click(testTrucker, `capacity:${trip._id}`);
    await say(testTrucker, "3");
    assert.equal(delivered.slice(beforeIncrease).filter((item) => item.to === testShipper).length, 1);
    assert.match(last(testShipper).body, /A truck now fits your load/);
    assert.match(last(testTrucker).body, /2 matching loads/); // The completed shipment is excluded.
    assert.equal((await getAnalytics("7")).matched, 3);
    const beforeRefresh = delivered.length;
    await click(testTrucker, `manage:${trip._id}`);
    await click(testTrucker, `capacity:${trip._id}`);
    await say(testTrucker, "0");
    await click(testTrucker, `capacity:${trip._id}`);
    await say(testTrucker, "3");
    assert.equal(delivered.slice(beforeRefresh).filter((item) => item.to === testShipper).length, 0);
  } finally {
    await client.close();
  }
});
