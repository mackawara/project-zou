import type { Db, Document } from "mongodb";
import { collections, database } from "./db";
import { dateWindow, hour, isActive, type Shipment, type TransportRequest, type Trip } from "./domain";

/** Data for the administrators' dashboard pages, read from what the WhatsApp pilot already stores. */

const day = 24 * hour;
const listLimit = 100;
// A confirmed shipment with no delivery confirmation this long after departure needs a follow-up call.
const overdueAfter = 2 * day;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Development without a database shows labelled sample data instead of failing. */
export const demoMode = () => !process.env.MONGODB_URI && process.env.NODE_ENV === "development";
export const shipmentRef = (id: string) => id.slice(0, 8).toUpperCase();

export type Person = { phone: string; name?: string };
export type Tone = "ok" | "wait" | "warn" | "off";
export type Listing<T> = { rows: T[]; more: boolean };

const listing = <T>(rows: T[]): Listing<T> => ({ rows: rows.slice(0, listLimit), more: rows.length > listLimit });

async function people(db: Db, phones: string[]) {
  const unique = [...new Set(phones)];
  const profiles = unique.length ? await collections(db).profiles.find({ _id: { $in: unique } }).toArray() : [];
  const names = new Map(profiles.map((profile) => [profile._id, profile.trucker?.name ?? profile.shipper?.name]));
  return (phone: string): Person => ({ phone, name: names.get(phone) });
}

/* ---------- Dashboard home ---------- */

export type HomeCounts = {
  shippers: number; truckers: number; openTrips: number; activeShipments: number; completed: number; cancelled: number;
};
export type Alert = { id: string; label: string; detail: string; count: number; href?: string };
export type ActivityItem = { label: string; detail: string; at: Date; ref?: string };
export type Home = { counts: HomeCounts; alerts: Alert[]; activity: ActivityItem[] };

const activeShipments = (now: Date): Document => ({
  $or: [{ state: "confirmed" }, { state: { $in: ["requested", "offered"] }, replyBy: { $gt: now } }],
});
const halfConfirmed: Document = {
  state: "confirmed",
  $or: [
    { deliveredAt: { $exists: true }, receivedAt: { $exists: false } },
    { receivedAt: { $exists: true }, deliveredAt: { $exists: false } },
  ],
};

/** Confirmed shipments with no delivery confirmation from either side, well after the truck departed. */
async function overdueIds(db: Db, now: Date) {
  const rows = await collections(db).shipments.aggregate<{ _id: string }>([
    { $match: { state: "confirmed", deliveredAt: { $exists: false }, receivedAt: { $exists: false } } },
    { $lookup: { from: "trips", localField: "tripId", foreignField: "_id", as: "trip" } },
    { $match: { "trip.departureAt": { $lt: new Date(now.getTime() - overdueAfter) } } },
    { $project: { _id: 1 } },
  ]).toArray();
  return rows.map(({ _id }) => _id);
}

function shipmentEvents(shipment: Shipment): { label: string; at?: Date }[] {
  return [
    { label: "Shipment requested", at: shipment.createdAt },
    { label: "Offer made", at: shipment.offeredAt },
    { label: "Offer accepted", at: shipment.confirmedAt },
    { label: "Delivery completed", at: shipment.completedAt },
    { label: "Shipment cancelled", at: shipment.cancelledAt },
  ];
}

export async function getHome(now = new Date()): Promise<Home> {
  const { db } = await database();
  const c = collections(db);
  const since = new Date(now.getTime() - 7 * day);
  const [shippers, truckers, openTrips, active, completed, cancelled, failedIn, failedOut, half, overdue, shipments, trips] = await Promise.all([
    c.profiles.countDocuments({ shipper: { $exists: true } }),
    c.profiles.countDocuments({ trucker: { $exists: true } }),
    c.trips.countDocuments({ closedAt: { $exists: false }, departureAt: { $gt: now } }),
    c.shipments.countDocuments(activeShipments(now)),
    c.shipments.countDocuments({ state: "completed" }),
    c.shipments.countDocuments({ state: "cancelled" }),
    c.inbox.countDocuments({ failed: true }),
    c.outbox.countDocuments({ failed: true }),
    c.shipments.countDocuments(halfConfirmed),
    overdueIds(db, now),
    c.shipments.find({ $or: ["createdAt", "offeredAt", "confirmedAt", "completedAt", "cancelledAt"].map((field) => ({ [field]: { $gte: since } })) })
      .sort({ createdAt: -1 }).limit(40).toArray(),
    c.trips.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(10).toArray(),
  ]);
  const requests = await c.requests.find({ _id: { $in: shipments.map(({ requestId }) => requestId) } }).toArray();
  const routes = new Map(requests.map((request) => [request._id, `${request.pickup} → ${request.dropoff}`]));
  const activity: ActivityItem[] = [
    ...shipments.flatMap((shipment) => shipmentEvents(shipment)
      .filter((event): event is { label: string; at: Date } => !!event.at && event.at >= since)
      .map(({ label, at }) => ({ label, at, ref: shipmentRef(shipment._id), detail: routes.get(shipment.requestId) ?? "Search details expired" }))),
    ...trips.map((trip) => ({
      label: "Space advertised", at: trip.createdAt, detail: `${trip.origin} → ${trip.destination} · ${trip.capacity / 1000} t`,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 10);
  return { counts: { shippers, truckers, openTrips, activeShipments: active, completed, cancelled }, alerts: alerts(failedIn, failedOut, half, overdue.length), activity };
}

function alerts(failedIn: number, failedOut: number, half: number, overdue: number): Alert[] {
  return [
    { id: "overdue", count: overdue, label: "Deliveries not confirmed", href: "/trips?view=shipments&scope=attention",
      detail: "Confirmed shipments with no delivery confirmation two days after departure." },
    { id: "half", count: half, label: "Waiting for one side to confirm", href: "/trips?view=shipments&scope=attention",
      detail: "Either the trucker or the receiver has confirmed delivery, but not both." },
    { id: "inbox", count: failedIn, label: "Messages that could not be handled",
      detail: "Handling stopped after six attempts, so the sender got no reply. Check the web or worker logs." },
    { id: "outbox", count: failedOut, label: "Replies that could not be sent",
      detail: "WhatsApp refused these replies after six attempts. Check the worker logs for the Graph API error." },
  ].filter(({ count }) => count > 0);
}

/* ---------- Users ---------- */

export type UserRole = "shipper" | "trucker";
export type UserRow = {
  phone: string; name: string; roles: UserRole[]; company?: string; registration?: string;
  lastMessageAt?: Date; trips: number; shipments: number;
};

export async function getUsers({ role, q }: { role?: UserRole; q?: string }): Promise<Listing<UserRow>> {
  const { db } = await database();
  const c = collections(db);
  const match: Document = {};
  if (role) match[role] = { $exists: true };
  const search = q?.trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search.replace(/^\+/, "")), "i");
    match.$or = ["_id", "shipper.name", "trucker.name", "trucker.company", "trucker.registration"].map((field) => ({ [field]: pattern }));
  }
  const profiles = await c.profiles.aggregate<{
    _id: string; shipper?: { name: string }; trucker?: { name: string; registration: string; company: string };
    contact: { lastIncomingAt?: Date }[];
  }>([
    { $match: match },
    { $lookup: { from: "contacts", localField: "_id", foreignField: "_id", as: "contact" } },
    { $sort: { "contact.lastIncomingAt": -1, _id: 1 } },
    { $limit: listLimit + 1 },
  ]).toArray();
  const phones = profiles.map(({ _id }) => _id);
  const count = (collection: "trips" | "shipments", field: string) => db.collection(collection).aggregate<{ _id: string; n: number }>([
    { $match: { [field]: { $in: phones } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]).toArray().then((rows) => new Map(rows.map(({ _id, n }) => [_id, n])));
  const [trips, asShipper, asTrucker] = await Promise.all([count("trips", "trucker"), count("shipments", "shipper"), count("shipments", "trucker")]);
  return listing(profiles.map((profile) => ({
    phone: profile._id,
    name: profile.trucker?.name ?? profile.shipper?.name ?? "",
    roles: (["shipper", "trucker"] as const).filter((r) => profile[r]),
    company: profile.trucker?.company, registration: profile.trucker?.registration,
    lastMessageAt: profile.contact[0]?.lastIncomingAt,
    trips: trips.get(profile._id) ?? 0,
    shipments: (asShipper.get(profile._id) ?? 0) + (asTrucker.get(profile._id) ?? 0),
  })));
}

/* ---------- Trips, requests and bookings ---------- */

export type TripScope = "open" | "all";
export type TripRow = Pick<Trip, "origin" | "destination" | "departureAt" | "capacity" | "acceptedCargo" | "createdAt"> & {
  id: string; trucker: Person; status: string; tone: Tone; requested: number; booked: number;
};

export async function getTrips(scope: TripScope, now = new Date()): Promise<Listing<TripRow>> {
  const { db } = await database();
  const c = collections(db);
  const trips = await c.trips.find(scope === "open" ? { closedAt: { $exists: false }, departureAt: { $gt: now } } : {})
    .sort(scope === "open" ? { departureAt: 1 } : { createdAt: -1 }).limit(listLimit + 1).toArray();
  const counts = await c.shipments.aggregate<{ _id: string; requested: number; booked: number }>([
    { $match: { tripId: { $in: trips.map(({ _id }) => _id) } } },
    { $group: { _id: "$tripId", requested: { $sum: 1 }, booked: { $sum: { $cond: [{ $in: ["$state", ["confirmed", "completed"]] }, 1, 0] } } } },
  ]).toArray();
  const byTrip = new Map(counts.map((row) => [row._id, row]));
  const person = await people(db, trips.map(({ trucker }) => trucker));
  return listing(trips.map((trip) => {
    const [status, tone]: [string, Tone] = trip.closedAt ? ["Closed", "off"] : trip.departureAt <= now ? ["Departed", "off"]
      : trip.capacity === 0 ? ["Full", "wait"] : ["Open", "ok"];
    return {
      id: trip._id, origin: trip.origin, destination: trip.destination, departureAt: trip.departureAt, capacity: trip.capacity,
      acceptedCargo: trip.acceptedCargo, createdAt: trip.createdAt, trucker: person(trip.trucker), status, tone,
      requested: byTrip.get(trip._id)?.requested ?? 0, booked: byTrip.get(trip._id)?.booked ?? 0,
    };
  }));
}

export type RequestRow = Pick<TransportRequest, "pickup" | "dropoff" | "date" | "cargo" | "weight" | "notes" | "createdAt"> & {
  id: string; shipper: Person; status: string; tone: Tone; shipmentRef?: string;
};

function requestStatus(request: TransportRequest, selected: Shipment | undefined, now: Date): [string, Tone] {
  if (request.cancelledAt) return ["Cancelled", "off"];
  if (selected?.state === "completed") return ["Delivered", "ok"];
  if (selected?.state === "confirmed") return ["Booked", "ok"];
  if (selected && isActive(selected, now)) return [selected.state === "offered" ? "Offer made" : "Awaiting offer", "wait"];
  if (dateWindow(request.date).end <= now) return ["Ended", "off"];
  return ["Searching", "wait"];
}

export async function getRequests(now = new Date()): Promise<Listing<RequestRow>> {
  const { db } = await database();
  const c = collections(db);
  const requests = await c.requests.find({}).sort({ createdAt: -1 }).limit(listLimit + 1).toArray();
  const selected = await c.shipments.find({ _id: { $in: requests.flatMap(({ selectionId }) => selectionId ? [selectionId] : []) } }).toArray();
  const byId = new Map(selected.map((shipment) => [shipment._id, shipment]));
  const person = await people(db, requests.map(({ shipper }) => shipper));
  return listing(requests.map((request) => {
    const shipment = request.selectionId ? byId.get(request.selectionId) : undefined;
    const [status, tone] = requestStatus(request, shipment, now);
    return {
      id: request._id, pickup: request.pickup, dropoff: request.dropoff, date: request.date, cargo: request.cargo,
      weight: request.weight, notes: request.notes, createdAt: request.createdAt, shipper: person(request.shipper),
      status, tone, shipmentRef: shipment && shipmentRef(shipment._id),
    };
  }));
}

export type ShipmentScope = "active" | "attention" | "all";
export type TimelineStep = { label: string; at?: Date };
export type ShipmentRow = {
  id: string; ref: string; status: string; tone: Tone; attention?: string;
  load?: Pick<TransportRequest, "pickup" | "dropoff" | "cargo" | "weight">;
  shipper: Person; trucker: Person; priceCents?: number; departureAt?: Date; createdAt: Date; timeline: TimelineStep[];
};

function shipmentStatus(shipment: Shipment, now: Date): [string, Tone] {
  switch (shipment.state) {
    case "completed": return ["Completed", "ok"];
    case "cancelled": return ["Cancelled", "off"];
    case "declined": return ["Declined", "off"];
    case "confirmed":
      if (shipment.deliveredAt) return ["Awaiting receiver", "warn"];
      if (shipment.receivedAt) return ["Awaiting trucker", "warn"];
      return ["Booked", "ok"];
    default:
      if (!isActive(shipment, now)) return ["Expired", "off"];
      return [shipment.state === "offered" ? "Offer made" : "Awaiting offer", "wait"];
  }
}

function timeline(shipment: Shipment, now: Date): TimelineStep[] {
  const who = (phone?: string) => phone === shipment.shipper ? "shipper" : phone === shipment.trucker ? "trucker" : "";
  const steps: (TimelineStep | false)[] = [
    { label: "Requested by shipper", at: shipment.createdAt },
    (!!shipment.offeredAt || shipment.priceCents !== undefined) && { label: "Offer made by trucker", at: shipment.offeredAt },
    !!shipment.confirmedAt && { label: "Offer accepted", at: shipment.confirmedAt },
    !!shipment.deliveredAt && { label: "Delivery confirmed by trucker", at: shipment.deliveredAt },
    !!shipment.receivedAt && { label: "Receipt confirmed", at: shipment.receivedAt },
    !!shipment.completedAt && { label: "Completed", at: shipment.completedAt },
    shipment.state === "declined" && { label: `Declined${who(shipment.declinedBy) ? " by " + who(shipment.declinedBy) : ""}`, at: shipment.declinedAt },
    !!shipment.cancelledAt && { label: `Cancelled${who(shipment.cancelledBy) ? " by " + who(shipment.cancelledBy) : ""}`, at: shipment.cancelledAt },
    ["requested", "offered"].includes(shipment.state) && !isActive(shipment, now) && { label: "Expired without a reply", at: shipment.replyBy },
  ];
  return steps.filter((step): step is TimelineStep => !!step);
}

export async function getShipments(scope: ShipmentScope, now = new Date()): Promise<Listing<ShipmentRow>> {
  const { db } = await database();
  const c = collections(db);
  const overdue = scope === "active" ? [] : await overdueIds(db, now);
  const filter = scope === "active" ? activeShipments(now)
    : scope === "attention" ? { $or: [halfConfirmed, { _id: { $in: overdue } }] } : {};
  const shipments = await c.shipments.find(filter).sort({ createdAt: -1 }).limit(listLimit + 1).toArray();
  const [requests, trips, person] = await Promise.all([
    c.requests.find({ _id: { $in: shipments.map(({ requestId }) => requestId) } }).toArray(),
    c.trips.find({ _id: { $in: shipments.map(({ tripId }) => tripId) } }).toArray(),
    people(db, shipments.flatMap(({ shipper, trucker }) => [shipper, trucker])),
  ]);
  const requestById = new Map(requests.map((request) => [request._id, request]));
  const tripById = new Map(trips.map((trip) => [trip._id, trip]));
  const late = new Set(overdue);
  return listing(shipments.map((shipment) => {
    const request = requestById.get(shipment.requestId);
    const [status, tone] = shipmentStatus(shipment, now);
    const attention = late.has(shipment._id) ? "No delivery confirmation two days after departure"
      : shipment.state === "confirmed" && shipment.deliveredAt && !shipment.receivedAt ? "Trucker marked delivered; receiver has not confirmed"
      : shipment.state === "confirmed" && shipment.receivedAt && !shipment.deliveredAt ? "Receiver confirmed; trucker has not marked delivered"
      : undefined;
    return {
      id: shipment._id, ref: shipmentRef(shipment._id), status: late.has(shipment._id) ? "Overdue" : status,
      tone: attention ? "warn" : tone, attention,
      load: request && { pickup: request.pickup, dropoff: request.dropoff, cargo: request.cargo, weight: request.weight },
      shipper: person(shipment.shipper), trucker: person(shipment.trucker), priceCents: shipment.priceCents,
      departureAt: tripById.get(shipment.tripId)?.departureAt, createdAt: shipment.createdAt,
      timeline: timeline(shipment, now),
    };
  }));
}

/* ---------- Sample data for development without a database ---------- */

const sampleNow = () => new Date();
const ago = (now: Date, hours: number) => new Date(now.getTime() - hours * hour);
const samplePeople: Person[] = [
  { phone: "263770000101", name: "Tendai Moyo" }, { phone: "263770000102", name: "Rudo Ncube" },
  { phone: "263770000103", name: "Farai Dube" }, { phone: "263770000104", name: "Chipo Sibanda" },
  { phone: "263770000105", name: "Tatenda Banda" }, { phone: "263770000106", name: "Nyasha Phiri" },
];
const [tendai, rudo, farai, chipo, tatenda, nyasha] = samplePeople;

export function sampleHome(now = sampleNow()): Home {
  return {
    counts: { shippers: 38, truckers: 14, openTrips: 9, activeShipments: 6, completed: 21, cancelled: 3 },
    alerts: alerts(0, 1, 1, 1),
    activity: [
      { label: "Delivery completed", ref: "4B291CA2", detail: "Harare → Bulawayo", at: ago(now, 1) },
      { label: "Offer accepted", ref: "DB5C9301", detail: "Gweru → Hwange", at: ago(now, 2) },
      { label: "Space advertised", detail: "Harare → Victoria Falls · 6 t", at: ago(now, 3) },
      { label: "Offer made", ref: "A17E40C2", detail: "Kwekwe → Bulawayo", at: ago(now, 5) },
      { label: "Shipment requested", ref: "A17E40C2", detail: "Kwekwe → Bulawayo", at: ago(now, 6) },
      { label: "Shipment cancelled", ref: "5CEA96A0", detail: "Bulawayo → Hwange", at: ago(now, 9) },
    ],
  };
}

export function sampleUsers({ role, q }: { role?: UserRole; q?: string }, now = sampleNow()): Listing<UserRow> {
  const rows: UserRow[] = [
    { ...tendai, name: tendai.name!, roles: ["trucker"], company: "Moyo Haulage", registration: "AFG 4521", lastMessageAt: ago(now, 1), trips: 6, shipments: 9 },
    { ...rudo, name: rudo.name!, roles: ["shipper"], lastMessageAt: ago(now, 2), trips: 0, shipments: 4 },
    { ...farai, name: farai.name!, roles: ["trucker", "shipper"], company: "Dube Transport", registration: "ACD 1180", lastMessageAt: ago(now, 7), trips: 3, shipments: 5 },
    { ...chipo, name: chipo.name!, roles: ["shipper"], lastMessageAt: ago(now, 30), trips: 0, shipments: 2 },
    { ...tatenda, name: tatenda.name!, roles: ["trucker"], company: "Banda Logistics", registration: "AEZ 7702", lastMessageAt: ago(now, 52), trips: 2, shipments: 1 },
    { ...nyasha, name: nyasha.name!, roles: ["shipper"], trips: 0, shipments: 0 },
  ];
  const search = q?.trim().toLowerCase();
  return listing(rows.filter((row) => (!role || row.roles.includes(role))
    && (!search || [row.phone, row.name, row.company, row.registration].some((value) => value?.toLowerCase().includes(search)))));
}

export function sampleTrips(scope: TripScope, now = sampleNow()): Listing<TripRow> {
  const at = (hours: number) => new Date(now.getTime() + hours * hour);
  const rows: TripRow[] = [
    { id: "t1", origin: "Harare", destination: "Victoria Falls", departureAt: at(20), capacity: 6000, acceptedCargo: ["General goods", "Produce"], createdAt: ago(now, 3), trucker: tendai, status: "Open", tone: "ok", requested: 2, booked: 1 },
    { id: "t2", origin: "Gweru", destination: "Hwange", departureAt: at(30), capacity: 2500, acceptedCargo: ["Building materials"], createdAt: ago(now, 12), trucker: farai, status: "Open", tone: "ok", requested: 1, booked: 1 },
    { id: "t3", origin: "Harare", destination: "Bulawayo", departureAt: at(44), capacity: 0, acceptedCargo: ["General goods", "Machinery", "Other"], createdAt: ago(now, 20), trucker: tatenda, status: "Full", tone: "wait", requested: 3, booked: 2 },
    { id: "t4", origin: "Bulawayo", destination: "Victoria Falls", departureAt: ago(now, 26), capacity: 1500, acceptedCargo: ["Produce"], createdAt: ago(now, 60), trucker: tendai, status: "Departed", tone: "off", requested: 1, booked: 1 },
    { id: "t5", origin: "Kwekwe", destination: "Bulawayo", departureAt: at(70), capacity: 4000, acceptedCargo: ["General goods"], createdAt: ago(now, 80), trucker: farai, status: "Closed", tone: "off", requested: 0, booked: 0 },
  ];
  return listing(scope === "open" ? rows.filter(({ status }) => status === "Open" || status === "Full") : rows);
}

export function sampleRequests(now = sampleNow()): Listing<RequestRow> {
  const date = (days: number) => new Date(now.getTime() + days * day).toISOString().slice(0, 10);
  return listing<RequestRow>([
    { id: "r1", pickup: "Harare", dropoff: "Bulawayo", date: date(1), cargo: "General goods", weight: 1200, notes: "Keep dry", createdAt: ago(now, 2), shipper: rudo, status: "Offer made", tone: "wait", shipmentRef: "A17E40C2" },
    { id: "r2", pickup: "Gweru", dropoff: "Hwange", date: date(1), cargo: "Building materials", weight: 2000, notes: "", createdAt: ago(now, 5), shipper: chipo, status: "Booked", tone: "ok", shipmentRef: "DB5C9301" },
    { id: "r3", pickup: "Kwekwe", dropoff: "Victoria Falls", date: date(2), cargo: "Produce", weight: 800, notes: "", createdAt: ago(now, 8), shipper: nyasha, status: "Searching", tone: "wait" },
    { id: "r4", pickup: "Harare", dropoff: "Gweru", date: date(-3), cargo: "Machinery", weight: 3500, notes: "", createdAt: ago(now, 96), shipper: farai, status: "Delivered", tone: "ok", shipmentRef: "4B291CA2" },
    { id: "r5", pickup: "Bulawayo", dropoff: "Hwange", date: date(-1), cargo: "Other", weight: 500, notes: "", createdAt: ago(now, 40), shipper: rudo, status: "Cancelled", tone: "off" },
  ]);
}

export function sampleShipments(scope: ShipmentScope, now = sampleNow()): Listing<ShipmentRow> {
  const rows: ShipmentRow[] = [
    { id: "s1", ref: "A17E40C2", status: "Offer made", tone: "wait", load: { pickup: "Harare", dropoff: "Bulawayo", cargo: "General goods", weight: 1200 },
      shipper: rudo, trucker: tatenda, priceCents: 8025, departureAt: new Date(now.getTime() + 44 * hour), createdAt: ago(now, 6),
      timeline: [{ label: "Requested by shipper", at: ago(now, 6) }, { label: "Offer made by trucker", at: ago(now, 5) }] },
    { id: "s2", ref: "DB5C9301", status: "Booked", tone: "ok", load: { pickup: "Gweru", dropoff: "Hwange", cargo: "Building materials", weight: 2000 },
      shipper: chipo, trucker: farai, priceCents: 15000, departureAt: new Date(now.getTime() + 30 * hour), createdAt: ago(now, 4),
      timeline: [{ label: "Requested by shipper", at: ago(now, 4) }, { label: "Offer made by trucker", at: ago(now, 3) }, { label: "Offer accepted", at: ago(now, 2) }] },
    { id: "s3", ref: "77C0E19B", status: "Awaiting receiver", tone: "warn", attention: "Trucker marked delivered; receiver has not confirmed",
      load: { pickup: "Bulawayo", dropoff: "Victoria Falls", cargo: "Produce", weight: 1500 }, shipper: nyasha, trucker: tendai, priceCents: 9500,
      departureAt: ago(now, 26), createdAt: ago(now, 50),
      timeline: [{ label: "Requested by shipper", at: ago(now, 50) }, { label: "Offer made by trucker", at: ago(now, 49) }, { label: "Offer accepted", at: ago(now, 48) }, { label: "Delivery confirmed by trucker", at: ago(now, 18) }] },
    { id: "s4", ref: "C3F2A8D1", status: "Overdue", tone: "warn", attention: "No delivery confirmation two days after departure",
      load: { pickup: "Harare", dropoff: "Kwekwe", cargo: "Machinery", weight: 3000 }, shipper: farai, trucker: tatenda, priceCents: 12000,
      departureAt: ago(now, 60), createdAt: ago(now, 90),
      timeline: [{ label: "Requested by shipper", at: ago(now, 90) }, { label: "Offer made by trucker", at: ago(now, 88) }, { label: "Offer accepted", at: ago(now, 86) }] },
    { id: "s5", ref: "4B291CA2", status: "Completed", tone: "ok", load: { pickup: "Harare", dropoff: "Gweru", cargo: "Machinery", weight: 3500 },
      shipper: farai, trucker: tendai, priceCents: 11000, departureAt: ago(now, 30), createdAt: ago(now, 96),
      timeline: [{ label: "Requested by shipper", at: ago(now, 96) }, { label: "Offer made by trucker", at: ago(now, 95) }, { label: "Offer accepted", at: ago(now, 94) }, { label: "Delivery confirmed by trucker", at: ago(now, 3) }, { label: "Receipt confirmed", at: ago(now, 1) }, { label: "Completed", at: ago(now, 1) }] },
    { id: "s6", ref: "5CEA96A0", status: "Cancelled", tone: "off", load: { pickup: "Bulawayo", dropoff: "Hwange", cargo: "Other", weight: 500 },
      shipper: rudo, trucker: farai, priceCents: 4000, createdAt: ago(now, 40),
      timeline: [{ label: "Requested by shipper", at: ago(now, 40) }, { label: "Offer made by trucker", at: ago(now, 39) }, { label: "Offer accepted", at: ago(now, 38) }, { label: "Cancelled by shipper", at: ago(now, 9) }] },
  ];
  return listing(rows.filter((row) => scope === "all" || (scope === "attention" ? !!row.attention
    : ["Offer made", "Awaiting offer", "Booked", "Awaiting receiver", "Awaiting trucker", "Overdue"].includes(row.status))));
}
