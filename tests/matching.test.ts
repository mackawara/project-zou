import assert from "node:assert/strict";
import test from "node:test";
import { dayOffset, findMatches, recordDelivery, type RequestDetails, type Shipment, type Trip } from "../src/domain";

const now = new Date("2026-11-14T15:00:00Z");
const request: RequestDetails = { pickup: "Kwekwe", dropoff: "Bulawayo", date: "2026-11-17", cargo: "Produce", weight: 2000, notes: "" };
const trip: Trip = {
  _id: "valid", trucker: "truck", origin: "Harare", destination: "Hwange", acceptedCargo: ["Produce"],
  departureAt: new Date("2026-11-16T22:00:00Z"), capacity: 2000, createdAt: now,
};

test("matches a sub-route in the correct direction with enough compatible space", () => {
  const candidates: Trip[] = [
    { ...trip, _id: "backwards", origin: "Hwange", destination: "Harare" },
    { ...trip, _id: "short", destination: "Gweru" },
    { ...trip, _id: "full", capacity: 1999 },
    { ...trip, _id: "incompatible", acceptedCargo: ["Machinery"] },
    { ...trip, _id: "closed", closedAt: now },
    { ...trip, _id: "too early locally", departureAt: new Date("2026-11-14T21:59:59Z") },
    { ...trip, _id: "two days early", departureAt: new Date("2026-11-14T22:00:00Z") },
    { ...trip, _id: "too late locally", departureAt: new Date("2026-11-19T22:00:00Z") },
    { ...trip, _id: "last minute", departureAt: new Date("2026-11-19T21:59:00Z") },
    trip,
  ];
  assert.deepEqual(findMatches(request, candidates, now).map((item) => item._id), ["valid", "two days early", "last minute"]);
  assert.deepEqual(findMatches({ ...request, pickup: "Bulawayo", dropoff: "Kwekwe" }, candidates, now).map((item) => item._id), ["backwards"]);
  assert.equal(findMatches(request, candidates.slice(-1), trip.departureAt).length, 0);
  // An early truck that has already left no longer matches.
  assert.deepEqual(findMatches(request, candidates, new Date("2026-11-15T12:00:00Z")).map((item) => item._id), ["valid", "last minute"]);
});

test("a search for 24 December matches trucks from 22 to 26 December, closest first", () => {
  const search = { ...request, date: "2026-12-24" };
  const local = (date: string) => new Date(`${date}T08:00:00+02:00`);
  const candidates = ["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24", "2026-12-25", "2026-12-26", "2026-12-27"]
    .map((date) => ({ ...trip, _id: date, departureAt: local(date) }));
  assert.deepEqual(findMatches(search, candidates, now).map((item) => item._id),
    ["2026-12-24", "2026-12-23", "2026-12-25", "2026-12-22", "2026-12-26"]);
  assert.equal(dayOffset(search.date, local("2026-12-22")), "2 days before your date");
  assert.equal(dayOffset(search.date, local("2026-12-25")), "1 day after your date");
  assert.equal(dayOffset(search.date, local("2026-12-24")), "");
});

test("returns ten trips in departure order", () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({
    ...trip, _id: String(i), departureAt: new Date(trip.departureAt.getTime() + (12 - i) * 60_000),
  }));
  assert.deepEqual(findMatches(request, candidates, now).map((item) => item._id), ["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"]);
});

test("completes a shipment only when both sides have confirmed, in either order", () => {
  const initial: Shipment = {
    _id: "s", requestId: "r", tripId: "t", trucker: "1", shipper: "2", createdAt: now, replyBy: now, state: "confirmed",
  };
  for (const [first, second] of [["receiver", "trucker"], ["trucker", "receiver"]] as const) {
    const one = { ...initial, ...recordDelivery(initial, first, now) };
    assert.equal(one.state, "confirmed");
    assert.equal(recordDelivery(one, first, now).state, undefined);
    const both = recordDelivery(one, second, now);
    assert.equal(both.state, "completed");
    assert.deepEqual(both.completedAt, now);
    assert.deepEqual(recordDelivery({ ...one, ...both }, second, now), {});
  }
});
