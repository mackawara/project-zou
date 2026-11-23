import { MongoClient, type Db } from "mongodb";
import type { Shipment, TransportRequest, Trip, TripDetails } from "./domain";

export type Action = { id: string; title: string; description?: string };
export const flowNames = ["search", "trip", "trucker"] as const;
export type FlowName = typeof flowNames[number];
export type Message =
  | { kind: "text"; body: string }
  | { kind: "buttons" | "list"; body: string; actions: Action[] }
  | { kind: "flow"; body: string; flow: FlowName; token: string; screen?: Record<string, string> }
  // A "Share with receiver" button: `share` is forwarded together with a link that sends `command` to Zunde.
  | { kind: "receipt"; body: string; share: string; command: string };
export type Event = { id: string; from: string; at: Date } & (
  { kind: "text" | "action"; value: string } | { kind: "flow"; value: string }
);
export type ShipperAccess = { suspended: boolean; reason: string; at: Date; admin: string };
export type Payment = {
  _id: string; shipper: string; amountCents: number; paidOn: string; method: string; reference: string; recordedBy: string; createdAt: Date;
};
type Profile = {
  _id: string; shipper?: { name: string }; shipperAccess?: ShipperAccess; shipperRevision?: number;
  trucker?: { name: string; nationalIdEncrypted: string; registration: string; company: string };
};
export type FlowTicket = {
  _id: string; owner: string; flow: FlowName; data?: {
    requestId?: string; tripId?: string; shipmentId?: string; draftTrip?: TripDetails;
  }; expiresAt: Date;
};
export type PendingInput = {
  _id: string; input: "shipper" | "offer" | "capacity";
  data: { requestId?: string; tripId?: string; shipmentId?: string };
  expiresAt: Date;
};

export function collections(db: Db) {
  return {
    adminCodes: db.collection<{ _id: string; digest?: string; expiresAt: Date; nextSendAt: Date; bucketAt: Date; sends: number; attempts: number; purgeAt: Date }>("adminCodes"),
    adminSessions: db.collection<{ _id: string; phone: string; expiresAt: Date }>("adminSessions"),
    payments: db.collection<Payment>("shipperPayments"),
    accessEvents: db.collection<ShipperAccess & { shipper: string }>("shipperAccessEvents"),
    profiles: db.collection<Profile>("profiles"),
    trips: db.collection<Trip>("trips"),
    requests: db.collection<TransportRequest>("requests"),
    matchDays: db.collection<{ _id: Date; revision: number; expiresAt: Date }>("matchDays"),
    searchMetrics: db.collection<Pick<TransportRequest, "_id" | "pickup" | "dropoff" | "createdAt" | "matchedAt">>("searchMetrics"),
    shipments: db.collection<Shipment>("shipments"),
    tickets: db.collection<FlowTicket>("flowTickets"),
    inputs: db.collection<PendingInput>("pendingInputs"),
    contacts: db.collection<{ _id: string; lastIncomingAt: Date; expiresAt: Date }>("contacts"),
    inbox: db.collection<{ _id: string; event?: Event; attempts: number; nextAt: Date; expiresAt: Date; failed?: boolean }>("inbox"),
    outbox: db.collection<{ _id: string; to?: string; message?: Message; matchShipper?: string; attempts: number; nextAt: Date; expiresAt: Date; failed?: boolean }>("outbox"),
  };
}

const shared = globalThis as typeof globalThis & { zundeMongo?: ReturnType<typeof connect> };

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
  try {
    await client.connect();
    return { db: client.db(process.env.MONGODB_DB || "zunde"), client };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export function database() {
  return shared.zundeMongo ??= connect().catch((error) => {
    delete shared.zundeMongo;
    throw error;
  });
}

export async function ensureIndexes(db: Db) {
  const c = collections(db);
  await Promise.all([
    c.adminCodes.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),
    c.adminSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.payments.createIndex({ shipper: 1, method: 1, reference: 1 }, { unique: true, partialFilterExpression: { reference: { $gt: "" } } }),
    c.payments.createIndex({ paidOn: -1, createdAt: -1 }),
    c.profiles.createIndex({ "shipperAccess.suspended": 1 }),
    c.tickets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.inputs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.contacts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.inbox.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.outbox.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.requests.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.matchDays.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.inbox.createIndex({ nextAt: 1 }),
    c.outbox.createIndex({ nextAt: 1 }),
    c.trips.createIndex({ departureAt: 1, capacity: 1 }),
    c.trips.createIndex({ trucker: 1, departureAt: 1 }),
    c.requests.createIndex({ shipper: 1, createdAt: -1 }),
    c.requests.createIndex({ cargo: 1, date: 1, weight: 1 }),
    c.searchMetrics.createIndex({ createdAt: -1 }),
    c.shipments.createIndex({ trucker: 1, createdAt: -1 }),
    c.shipments.createIndex({ shipper: 1, createdAt: -1 }),
  ]);
}
