import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { GET, POST } from "../src/app/api/whatsapp/webhook/route";
import { getAnalytics } from "../src/analytics";
import { collections, database, ensureIndexes, type Message } from "../src/db";
import { hour, localDate } from "../src/domain";
import { processIncoming, processOutgoing } from "../src/queue";

const appSecret = "local-test-secret";
const testShipper = "263771000001";
const testTrucker = "263771000002";
const testReceiver = "263771000003";
const phoneId = "test-business-id";
const webhook = "https://zunde.test/api/whatsapp/webhook";
process.env.WA_APP_SECRET = appSecret;
process.env.WA_PHONE_NUMBER_ID = phoneId;
process.env.WA_VERIFY_TOKEN = "verify-local";

test("webhook answers verification and rejects a forged message", async () => {
  const response = GET(new Request(webhook + "?hub.mode=subscribe&hub.verify_token=verify-local&hub.challenge=123"));
  assert.equal(await response.text(), "123");
  assert.equal(GET(new Request(webhook + "?hub.mode=subscribe&hub.verify_token=other&hub.challenge=123")).status, 403);
  assert.equal((await POST(new Request(webhook, { method: "POST", body: "{}" }))).status, 401);
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
    const send = async (to: string, message: Message) => { delivered.push({ to, message }); };
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
      assert.equal((await POST(new Request(webhook, { method: "POST", body, headers: { "x-hub-signature-256": "sha256=" + signature } }))).status, 200);
      while (await processIncoming(db, client)) { /* Drain messages. */ }
      while (await processOutgoing(db, send)) { /* Capture outgoing replies. */ }
    }
    const say = (from: string, body: string) => message(from, { text: { body } });
    const click = (from: string, id: string) => message(from, { interactive: { button_reply: { id } } });
    const form = (from: string, fields: Record<string, unknown>, expected: string, id?: string) => {
      const received = last(from);
      assert.ok(received.kind === "flow", received.body);
      assert.equal(received.flow, expected);
      return [received.token, message(from, { interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: received.token, ...fields }) } } }, id)] as const;
    };

    const date = localDate(new Date(Date.now() + 48 * hour));
    await say(testTrucker, "advertise space");
    await form(testTrucker, { origin: "Harare", destination: "Hwange", date, time: "16:00", capacity: "5", acceptedCargo: ["Produce"] }, "trip")[1];
    assert.equal(await c.trips.countDocuments(), 0);
    await form(testTrucker, { name: "Test Driver", registration: "ABC 1001", company: "Test Freight", nationalId: "63-1234567-F-42" }, "trucker")[1];
    assert.equal(await c.trips.countDocuments(), 1);
    const registered = await c.profiles.findOne({ _id: testTrucker });
    assert.ok(registered?.trucker?.nationalIdEncrypted);
    assert.doesNotMatch(JSON.stringify(registered), /1234567/);
    const data = { pickup: "Kwekwe", dropoff: "Bulawayo", date, cargo: "Produce", weight: "2", notes: "Keep dry" };
    await say(testShipper, "find a truck");
    const [token, submission] = form(testShipper, data, "search", "search-1");
    await submission;
    const searchReply = { interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: token, ...data }) } } };
    await message(testShipper, searchReply, "search-1");
    assert.equal(await c.requests.countDocuments(), 1);
    assert.equal(await c.profiles.countDocuments({ _id: testShipper }), 0);
    const select = button(testShipper, "Truck 1");
    await click(testShipper, select);
    await form(testShipper, { name: "Test Shipper" }, "shipper")[1];
    assert.equal(await c.shipments.countDocuments(), 1);
    assert.doesNotMatch(last(testTrucker).body, new RegExp(testShipper));
    await click(testShipper, select);
    assert.equal(await c.shipments.countDocuments(), 1);
    await click(testTrucker, button(testTrucker, "Make an offer"));
    await form(testTrucker, { price: "80.25" }, "offer")[1];
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

    await say(testShipper, "find a truck");
    await form(testShipper, data, "search")[1];
    await click(testShipper, button(testShipper, "Truck 1"));
    assert.match(last(testShipper).body, /Waiting/);
    await click(testTrucker, button(testTrucker, "Make an offer"));
    await form(testTrucker, { price: "81" }, "offer")[1];
    await click(testShipper, button(testShipper, "Accept offer"));
    await click(testTrucker, button(testTrucker, "Cancel shipment"));
    const cancelled = await c.shipments.findOne({ state: "cancelled" });
    assert.equal(cancelled?.cancelledBy, testTrucker);
    assert.ok(cancelled?.cancelledAt);
    assert.equal((await c.trips.findOne({ trucker: testTrucker }))?.capacity, 5000);
    await click(testTrucker, `capacity:${cancelled?.tripId}`);
    await form(testTrucker, { capacity: "0" }, "capacity")[1];
    await say(testShipper, "find a truck");
    await form(testShipper, data, "search")[1];
    assert.match(last(testShipper).body, /No truck fits/);
    const stats = await getAnalytics("7");
    assert.deepEqual([stats.requests, stats.trips, stats.matched, stats.confirmed, stats.completed, stats.cancelled], [3, 1, 2, 2, 1, 1]);
  } finally {
    await client.close();
  }
});
