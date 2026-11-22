import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { collections, database, ensureIndexes, type Event } from "../src/db";
import { endSession, issueAdminCode, sessionAdmin, verifyAdminCode } from "../src/admin-auth";
import { changeAccess, getPayments, getRoutes, recordPayment } from "../src/admin-operations";
import { getShipments, getUsers } from "../src/admin";
import { day, hour, localDate } from "../src/domain";
import { processOutgoing } from "../src/queue";
import { Workflow } from "../src/workflow";
import { sendAdminCode } from "../src/whatsapp";

test("OTP uses the approved authentication template body and copy-code button", async (t) => {
  Object.assign(process.env, { WA_GRAPH_VERSION: "v25.0", WA_PHONE_NUMBER_ID: "demo", WA_ACCESS_TOKEN: "test",
    WA_ADMIN_OTP_TEMPLATE: "test_auth", WA_ADMIN_OTP_LANGUAGE: "en_US" });
  let payload;
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, opts?: RequestInit) => {
    payload = JSON.parse(String(opts?.body));
    return new Response("{}", { status: 200 });
  });
  await sendAdminCode("263770000100", "012345");
  assert.deepEqual(payload, { messaging_product: "whatsapp", to: "263770000100", type: "template", template: {
    name: "test_auth", language: { code: "en_US" }, components: [
      { type: "body", parameters: [{ type: "text", text: "012345" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "012345" }] },
    ],
  } });
});

test("admin sessions, ledger and role enforcement on the freight workflow", { skip: !process.env.TEST_MONGODB_URI }, async (t) => {
  process.env.MONGODB_URI = process.env.TEST_MONGODB_URI;
  process.env.MONGODB_DB = "zunde_test_" + randomUUID().replaceAll("-", "");
  process.env.ZUNDE_DATA_KEY = "ab".repeat(32);
  const { db, client } = await database();
  const c = collections(db);
  const admin = "263770000111", shipper = "263770000112", trucker = "263770000113";
  process.env.ZUNDE_ADMIN_PHONES = "+" + admin;
  const now = new Date(), tomorrow = localDate(new Date(+now + day)), expiry = new Date(+now + 2 * day);
  try {
    await ensureIndexes(db);
    await t.test("resend limits, expiry, guess budget, single use, revocation and logout", async () => {
      const messages: string[] = [];
      const capture = async (_to: string, code: string) => { messages.push(code); };
      await issueAdminCode(db, shipper, capture, now);
      await Promise.all([issueAdminCode(db, admin, capture, now), issueAdminCode(db, admin, capture, now)]);
      assert.equal(messages.length, 1);
      const wrong = messages[0] === "000000" ? "000001" : "000000";
      await Promise.all(Array.from({ length: 12 }, () => verifyAdminCode(db, admin, wrong, now)));
      assert.equal((await c.adminCodes.findOne({ _id: admin }))?.attempts, 5);
      assert.equal(await verifyAdminCode(db, admin, messages[0], now), undefined);
      const later = new Date(+now + 60_000);
      await issueAdminCode(db, admin, capture, later);
      const sessions = await Promise.all([1, 2].map(() => verifyAdminCode(db, admin, messages[1], later)));
      const tokens = sessions.filter((token): token is string => !!token);
      assert.equal(tokens.length, 1);
      const token = tokens[0];
      assert.equal(await sessionAdmin(db, token, later), admin);
      assert.equal(await sessionAdmin(db, token, new Date(+later + 8 * hour)), undefined);
      process.env.ZUNDE_ADMIN_PHONES = "";
      assert.equal(await sessionAdmin(db, token, later), undefined);
      process.env.ZUNDE_ADMIN_PHONES = admin;
      await endSession(db, token);
      assert.equal(await sessionAdmin(db, token, later), undefined);
      for (let minute = 2; minute <= 6; minute++) await issueAdminCode(db, admin, capture, new Date(+now + minute * 60_000));
      assert.equal(messages.length, 5);
      assert.equal(await verifyAdminCode(db, admin, messages[4], new Date(+now + hour)), undefined);
      await issueAdminCode(db, admin, capture, new Date(+now + hour));
      assert.equal(messages.length, 6);
    });

    await c.profiles.insertOne({ _id: shipper, shipper: { name: "Alice" }, trucker: { name: "Alex", nationalIdEncrypted: "test", registration: "TEST", company: "Test" } });
    await t.test("payment recording retains exact cents and deduplicates retries and receipt references", async () => {
      const form = { id: randomUUID(), shipper, amount: "12.05", paidOn: localDate(now), method: "EcoCash", reference: "DEMO-42" };
      await Promise.all([recordPayment(db, admin, form, now), recordPayment(db, admin, form, now)]);
      await assert.rejects(recordPayment(db, admin, { ...form, id: randomUUID() }), /already/);
      for (const invalid of [{ amount: "-1" }, { amount: "0.001" }, { paidOn: tomorrow }, { shipper: trucker }]) {
        await assert.rejects(recordPayment(db, admin, { ...form, ...invalid }));
      }
      const [entry] = await getPayments();
      assert.equal(entry.amountCents, 1205);
      assert.equal(entry.recordedBy, admin);
      assert.equal(entry.name, "Alice");
      assert.equal(await c.payments.countDocuments(), 1);
    });

    await t.test("suspension blocks stale flows, selections, offers and matching while existing deliveries and trucker access continue", async () => {
      const request = { _id: "waiting", shipper, pickup: "Harare", dropoff: "Gweru", cargo: "Produce", weight: 1000, date: tomorrow, notes: "", createdAt: now } as const;
      const trip = { _id: "trip", trucker, origin: "Harare", destination: "Gweru", departureAt: new Date(tomorrow + "T10:00:00+02:00"), capacity: 2000, createdAt: now, acceptedCargo: ["Produce" as const] } as const;
      await c.requests.insertOne(request);
      await c.trips.insertOne({ ...trip, acceptedCargo: [...trip.acceptedCargo] });
      for (const state of ["offered", "requested", "confirmed"] as const) {
        await c.shipments.insertOne({ _id: state, state, createdAt: now, requestId: request._id, shipper, trucker, tripId: trip._id, priceCents: 1205, replyBy: expiry,
          ...(state === "confirmed" && { deliveredAt: now, confirmedAt: now }) });
      }
      const message = async (from: string, kind: Event["kind"], value: string) => {
        const id = randomUUID();
        await client.withSession(session => session.withTransaction(() => new Workflow(db, session, { id, from, kind, value, at: now }, now).handle()));
        return (await c.outbox.findOne({ _id: id + ":0" }))?.message?.body ?? "";
      };
      await changeAccess(db, client, admin, { shipper, action: "suspend", reason: "Account review" }, now);
      assert.equal((await getUsers({ role: "shipper" })).rows[0].shipperAccess?.suspended, true);
      await c.outbox.insertOne({ _id: "delayed:0", to: shipper, message: { kind: "text", body: "New truck" },
        matchShipper: shipper, attempts: 0, nextAt: now, expiresAt: expiry });
      let sent = 0;
      await processOutgoing(db, async () => { sent++; }, now, "delayed");
      assert.equal(sent, 0);
      assert.equal((await c.outbox.findOne({ _id: "delayed:0" }))?.message, undefined);
      await c.tickets.insertOne({ _id: "stale", flow: "search", owner: shipper, expiresAt: expiry });
      assert.match(await message(shipper, "flow", JSON.stringify({ flow_token: "stale" })), /suspended/);
      for (const action of ["search", "results:waiting", "select:waiting:trip", "accept:offered"]) assert.match(await message(shipper, "action", action), /suspended/);
      assert.match(await message(trucker, "action", "manage:trip"), /No open load/);
      assert.match(await message(shipper, "action", "trip"), /spare space/);
      await message(trucker, "action", "offer:requested");
      assert.match(await message(trucker, "text", "125"), /unable to receive offers/);
      await message(shipper, "action", "received:confirmed");
      assert.equal((await getShipments("completed")).rows.length, 1);
      assert.deepEqual(await getRoutes(), [{ origin: "Harare", destination: "Gweru", searches: 0, adverts: 1, completed: 1 }]);
      await changeAccess(db, client, admin, { shipper, action: "reinstate", reason: "Review complete" }, now);
      assert.match(await message(shipper, "action", "search"), /what you need/);
      assert.match(await message(trucker, "action", "manage:trip"), /1 matching load/);
      assert.equal(await c.accessEvents.countDocuments({ shipper, admin }), 2);
    });
  } finally {
    await client.close();
  }
});
