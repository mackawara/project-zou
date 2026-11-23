import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";
import { collections, ensureIndexes, type Event } from "../src/db";
import { day, localDate, localMidnight, type TransportRequest } from "../src/domain";
import { Workflow } from "../src/workflow";

test("concurrent postings find each other and only alert eligible waiting loads", { skip: !process.env.TEST_MONGODB_URI }, async () => {
  const client = new MongoClient(process.env.TEST_MONGODB_URI!);
  const db = client.db("zunde_test_" + randomUUID().replaceAll("-", "").slice(0, 20));
  const c = collections(db);
  try {
    await ensureIndexes(db);
    const now = new Date();
    // Depart at local midnight on the last eligible day.
    const date = localDate(new Date(now.getTime() + day));
    const departureDate = localDate(new Date(localMidnight(date).getTime() + 2 * day));
    const expiresAt = new Date(localMidnight(departureDate).getTime() + day);
    const trucker = "263770000001";
    const shipper = "263770000002";
    const base: TransportRequest = {
      _id: "waiting", shipper: "waiting", pickup: "Kwekwe", dropoff: "Gweru", date,
      weight: 1000, cargo: "Produce", notes: "", createdAt: now, expiresAt,
    };
    const waiting = Array.from({ length: 11 }, (_, i) => ({ ...base, _id: "waiting-" + i, shipper: "waiting-" + i }));
    await c.requests.insertMany([...waiting,
      { ...base, _id: "self", shipper: trucker },
      { ...base, _id: "opposite", pickup: "Gweru", dropoff: "Kwekwe" },
      { ...base, _id: "overweight", weight: 1001 },
      { ...base, _id: "wrong-cargo", cargo: "Machinery" },
      { ...base, _id: "outside-window", date: localDate(now) },
      // Loads ready after the truck leaves still match within the window.
      { ...base, _id: "later-load", shipper: "later-load", date: localDate(new Date(localMidnight(departureDate).getTime() + 2 * day)) },
      { ...base, _id: "too-late-load", date: localDate(new Date(localMidnight(departureDate).getTime() + 3 * day)) },
      { ...base, _id: "expired-search", expiresAt: now },
      { ...base, _id: "cancelled-search", cancelledAt: now },
      { ...base, _id: "selected", selectionId: "current" },
      { ...base, _id: "expired-selection", selectionId: "expired", shipper: "reopened" },
    ]);
    for (const [id, replyBy] of [["current", expiresAt], ["expired", now]] as const) {
      await c.shipments.insertOne({ _id: id, requestId: id === "current" ? "selected" : "expired-selection", tripId: "other",
        state: "requested", shipper: base.shipper, trucker: "other", createdAt: now, replyBy });
    }
    await c.profiles.insertOne({ _id: trucker, trucker: { name: "Driver", nationalIdEncrypted: "test", registration: "ABC", company: "Freight" } });
    await c.tickets.insertMany([
      { _id: "advert", owner: trucker, flow: "trip", expiresAt },
      { _id: "search", owner: shipper, flow: "search", expiresAt },
    ]);
    const advert: Event = { id: "publish", from: trucker, at: now, kind: "flow", value: JSON.stringify({
      flow_token: "advert", origin: "Harare", destination: "Hwange", date: departureDate, time: "00:00", capacity: "1", acceptedCargo: ["Produce"],
    }) };
    const search: Event = { id: "submit", from: shipper, at: now, kind: "flow", value: JSON.stringify({
      flow_token: "search", pickup: base.pickup, dropoff: base.dropoff, cargo: base.cargo, date, weight: "1",
    }) };
    // Pin both transaction snapshots before either insert. A plain read from
    // the other collection in each transaction would miss the concurrent pair.
    let arrived = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    await Promise.all([advert, search].map((event) => client.withSession((session) => session.withTransaction(async () => {
      await c.tickets.findOne({ owner: event.from }, { session });
      if (++arrived === 2) release();
      await ready;
      await new Workflow(db, session, event, now).handle();
    }))));
    const trip = await c.trips.findOne({ trucker });
    const request = await c.requests.findOne({ shipper });
    assert.ok(trip && request);
    assert.deepEqual(request.matchedTripIds, [trip._id]);
    const select = `select:${request._id}:${trip._id}`;
    const outgoing = await c.outbox.find().toArray();
    assert.equal(outgoing.filter(({ to, message }) => to === shipper && message && "actions" in message && message.actions.some((a) => a.id === select)).length, 1);
    const existingLoadAlerts = outgoing.filter(({ to }) => to !== trucker && to !== shipper);
    assert.deepEqual(existingLoadAlerts.map(({ to }) => to).sort(), [...waiting.map((r) => r.shipper), "reopened", "later-load"].sort());
    // The concurrent shipper is either in the advert confirmation or announced by the later search.
    const notices = outgoing.filter(({ to }) => to === trucker).map(({ message }) => message!.body);
    assert.equal(notices.filter((body) => /14 matching loads|A shipper is looking/.test(body)).length, 1);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
