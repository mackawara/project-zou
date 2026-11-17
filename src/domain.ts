import { z } from "zod";

// Ordered westbound stops. Keep Flow assets and matching on the same catalog.
export const towns = ["Harare", "Kwekwe", "Gweru", "Bulawayo", "Hwange", "Victoria Falls"] as const;
export const cargo = ["General goods", "Produce", "Building materials", "Machinery", "Other"] as const;
export const timeZone = "Africa/Harare";
export const matchWindowDays = 2;
export const hour = 3_600_000;
const day = 24 * hour;

const town = z.enum(towns);
const text = (max: number) => z.string().trim().min(1).max(max);
const tonnes = z.string().trim().regex(/^\d{1,2}(\.\d)?$/).transform((value) => Math.round(Number(value) * 1000))
  .pipe(z.number().int().min(100).max(40_000));
export const shipperForm = z.object({ name: text(80) });
export const truckerForm = z.object({
  name: text(80),
  nationalId: z.string().trim().toUpperCase().regex(/^\d{2}[\s-]?\d{6,7}[\s-]?[A-Z][\s-]?\d{2}$/)
    .transform((value) => value.replace(/[\s-]/g, "")),
  registration: text(20).transform((value) => value.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9 -]+$/)),
  company: text(100),
});
export const requestForm = z.object({
  pickup: town, dropoff: town, date: z.iso.date(), cargo: z.enum(cargo), weight: tonnes,
  notes: z.string().trim().max(200).optional().default(""),
}).refine(({ pickup, dropoff }) => pickup !== dropoff);
export const tripForm = z.object({
  origin: town, destination: town, date: z.iso.date(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  capacity: tonnes, acceptedCargo: z.array(z.enum(cargo)).min(1).max(cargo.length),
}).refine(({ origin, destination }) => origin !== destination);
export const capacityForm = z.object({ capacity: z.union([z.literal("0").transform(() => 0), tonnes]) });
export const offerForm = z.object({
  price: z.string().trim().regex(/^\d{1,6}(\.\d{1,2})?$/)
    .transform((value) => Math.round(Number(value) * 100)).pipe(z.number().int().positive()),
});

export type RequestDetails = z.output<typeof requestForm>;
export type TripDetails = z.output<typeof tripForm>;
export type Trip = Omit<TripDetails, "date" | "time"> & {
  _id: string; trucker: string; departureAt: Date; createdAt: Date; closedAt?: Date; lastAcceptedAt?: Date;
};
export type TransportRequest = RequestDetails & {
  _id: string; shipper: string; createdAt: Date; expiresAt?: Date;
  selectionId?: string; matchedAt?: Date; cancelledAt?: Date;
};
export type Shipment = {
  _id: string; requestId: string; tripId: string; shipper: string; trucker: string;
  createdAt: Date; replyBy: Date; state: "requested" | "offered" | "confirmed" | "completed" | "cancelled" | "declined";
  priceCents?: number; confirmedAt?: Date; cancelledAt?: Date; cancelledBy?: string;
  deliveredAt?: Date; receivedAt?: Date; completedAt?: Date;
};

export function localDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  return ["year", "month", "day"].map((part) => parts.find(({ type }) => type === part)!.value).join("-");
}

export function localMidnight(date: string) {
  return new Date(`${date}T00:00:00+02:00`);
}

export function dateAllowed(date: string, now: Date) {
  const value = localMidnight(date).getTime();
  const today = localMidnight(localDate(now)).getTime();
  return value >= today && value <= today + 30 * day;
}

export function dateWindow(date: string) {
  const start = localMidnight(date);
  return { start, end: new Date(start.getTime() + (matchWindowDays + 1) * day) };
}

export function findMatches(request: RequestDetails, trips: Trip[], now: Date) {
  const pickup = towns.indexOf(request.pickup);
  const dropoff = towns.indexOf(request.dropoff);
  if (pickup === dropoff) return [];
  const { start, end } = dateWindow(request.date);
  return trips.filter((trip) => {
    const origin = towns.indexOf(trip.origin);
    const destination = towns.indexOf(trip.destination);
    const coversRoute = pickup < dropoff
      ? origin <= pickup && destination >= dropoff
      : origin >= pickup && destination <= dropoff;
    return coversRoute && !trip.closedAt && trip.departureAt > now && trip.departureAt >= start
      && trip.departureAt < end && trip.capacity >= request.weight && trip.acceptedCargo.includes(request.cargo);
  }).sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime() || a._id.localeCompare(b._id)).slice(0, 10);
}

export function isActive(shipment: Shipment, now: Date) {
  return shipment.state === "confirmed" || shipment.state === "completed"
    || ((shipment.state === "requested" || shipment.state === "offered") && shipment.replyBy > now);
}

export function recordDelivery(shipment: Shipment, role: "trucker" | "receiver", now: Date): Partial<Shipment> {
  if (shipment.state !== "confirmed") return {};
  const deliveredAt = shipment.deliveredAt ?? (role === "trucker" ? now : undefined);
  const receivedAt = shipment.receivedAt ?? (role === "receiver" ? now : undefined);
  return {
    ...(deliveredAt && { deliveredAt }), ...(receivedAt && { receivedAt }),
    ...(deliveredAt && receivedAt && { state: "completed", completedAt: now }),
  };
}

export function formatDeparture(date: Date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

export const dollars = (cents: number) => `US$${(cents / 100).toFixed(2)}`;
