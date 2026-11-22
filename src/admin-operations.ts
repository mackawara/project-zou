import { MongoServerError, type Db, type MongoClient } from "mongodb";
import { z } from "zod";
import { collections, database } from "./db";
import { localDate, offerForm } from "./domain";
import { normalizePhone } from "./admin-auth";

export const paymentMethods = ["Cash", "EcoCash", "Bank transfer", "Other"] as const;
export class EntryError extends Error {}
const phone = z.string().max(32).transform(normalizePhone).pipe(z.string().min(1));
const paymentForm = z.object({
  id: z.uuid(), shipper: phone, amount: offerForm.shape.price, paidOn: z.iso.date(),
  method: z.enum(paymentMethods), reference: z.string().trim().max(80),
});
const accessForm = z.object({
  shipper: phone, action: z.enum(["suspend", "reinstate"]), reason: z.string().trim().min(1).max(200),
});
export async function recordPayment(db: Db, admin: string, fields: unknown, now = new Date()) {
  const data = paymentForm.safeParse(fields);
  if (!data.success || data.data.paidOn > localDate(now)) throw new EntryError("Check the shipper number, amount and payment date. Use today or an earlier date.");
  const { id, amount, ...details } = data.data;
  const c = collections(db);
  if (!await c.profiles.findOne({ _id: details.shipper, shipper: { $exists: true } }, { projection: { _id: 1 } })) {
    throw new EntryError("No registered shipper has that WhatsApp number.");
  }
  const receipt = { _id: id, ...details, amountCents: amount, recordedBy: admin };
  try {
    await c.payments.insertOne({ ...receipt, createdAt: now });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    if (await c.payments.findOne(receipt, { projection: { _id: 1 } })) return;
    throw new EntryError("A payment with this receipt or reference has already been recorded. Check the ledger.");
  }
}
export async function changeAccess(db: Db, client: MongoClient, admin: string, fields: unknown, now = new Date()) {
  const parsed = accessForm.safeParse(fields);
  if (!parsed.success) throw new EntryError("Choose a shipper and enter a reason of up to 200 characters.");
  const { action, shipper, reason } = parsed.data;
  const change = { suspended: action === "suspend", at: now, admin, reason };
  const c = collections(db);
  await client.withSession(session => session.withTransaction(async () => {
    const updated = await c.profiles.updateOne({
      _id: shipper, shipper: { $exists: true }, "shipperAccess.suspended": change.suspended ? { $ne: true } : true,
    }, { $set: { shipperAccess: change } }, { session });
    if (!updated.modifiedCount) throw new EntryError("Shipper access has already changed or the shipper was not found. Refresh the directory.");
    await c.accessEvents.insertOne({ shipper, ...change }, { session });
  }));
}

export async function getPayments() {
  const c = collections((await database()).db);
  const rows = await c.payments.find().sort({ paidOn: -1, createdAt: -1 }).limit(100).toArray();
  const people = await c.profiles.find({ _id: { $in: rows.map(row => row.shipper) } }, { projection: { "shipper.name": 1 } }).toArray();
  const names = new Map(people.map(row => [row._id, row.shipper?.name]));
  return rows.map(row => ({ ...row, name: names.get(row.shipper) }));
}

export type RouteRow = { origin: string; destination: string; adverts: number; searches: number; completed: number };
export async function getRoutes(): Promise<RouteRow[]> {
  const c = collections((await database()).db);
  type Count = { _id: { origin: string; destination: string }; count: number };
  const group = (origin: string, destination: string) => ({ $group: { _id: { origin, destination }, count: { $sum: 1 } } });
  const [adverts, searches, completed] = await Promise.all([
    c.trips.aggregate<Count>([group("$origin", "$destination")]).toArray(),
    c.searchMetrics.aggregate<Count>([group("$pickup", "$dropoff")]).toArray(),
    c.shipments.aggregate<Count>([{ $match: { state: "completed" } },
      { $lookup: { from: "requests", localField: "requestId", foreignField: "_id", as: "load" } },
      { $unwind: "$load" }, group("$load.pickup", "$load.dropoff")]).toArray(),
  ]);
  const routes = new Map<string, RouteRow>();
  for (const [metric, counts] of [["adverts", adverts], ["searches", searches], ["completed", completed]] as const) {
    for (const { _id, count } of counts) {
      const key = _id.origin + "/" + _id.destination;
      const row = routes.get(key) ?? { ..._id, adverts: 0, searches: 0, completed: 0 };
      row[metric] = count;
      routes.set(key, row);
    }
  }
  return [...routes.values()].sort((a, b) => b.searches - a.searches || b.adverts - a.adverts || a.origin.localeCompare(b.origin));
}
