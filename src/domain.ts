import { z } from "zod";

// Ordered westbound stops. Keep Flow assets and matching on the same catalog.
export const towns = ["Harare", "Kwekwe", "Gweru", "Bulawayo", "Hwange", "Victoria Falls"] as const;
export const cargo = ["General goods", "Produce", "Building materials", "Machinery", "Other"] as const;
export const timeZone = "Africa/Harare";
export const matchWindowDays = 2;
export const hour = 3_600_000;
export const day = 24 * hour;

export const bookingWindowDays = 30;
export const maxTonnes = 40;
export const maxPhotos = 3;
// WhatsApp sends images up to 5 MB, as JPEG or PNG only.
export const maxPhotoKb = 5120;
export const photoTypes = ["image/jpeg", "image/png"] as const;

const anyTown = z.enum(towns);
const town = (label: string) => z.enum(towns, { error: `Choose the ${label} from the list.` });
// `label` reads naturally after "Enter", e.g. "your name" or "the company name".
const text = (label: string, max: number) => z.string({ error: `Enter ${label}.` }).trim()
  .min(1, `Enter ${label}.`).max(max, `Shorten ${label} to ${max} characters or fewer.`);
const date = (label: string) => z.iso.date({ error: `Choose the ${label} from the calendar.` });
const tonnesHint = `whole tonnes from 1 to ${maxTonnes}, for example 12`;
// Whole tonnes only: decimals are rejected so capacity and loads compare cleanly.
const tonnes = (label: string) => z.string({ error: `Enter the ${label} in ${tonnesHint}.` }).trim()
  .regex(/^\d{1,2}$/, `Enter the ${label} in ${tonnesHint}. Decimals are not accepted.`)
  .transform((value) => Number(value) * 1000)
  .pipe(z.number().int().min(1000, `Enter the ${label} in ${tonnesHint}.`).max(maxTonnes * 1000, `The ${label} can be at most ${maxTonnes} tonnes.`));
const differentTowns = (from: string, to: string, message: string) => ({
  message, path: [to],
  // Run even when other fields fail, so every problem is reported in one reply.
  when: ({ value }: { value: unknown }) => {
    const v = value as Record<string, unknown> | undefined;
    return anyTown.safeParse(v?.[from]).success && v?.[from] === v?.[to];
  },
});

// Flow photo pickers submit WhatsApp media objects; only the media ID is kept.
const photoProblem = `Add up to ${maxPhotos} JPEG or PNG photos of the load, each up to ${maxPhotoKb / 1024} MB.`;
const photo = z.object({
  id: z.string().regex(/^\d{1,64}$/, photoProblem).optional(), media_id: z.string().regex(/^\d{1,64}$/, photoProblem).optional(),
  mime_type: z.enum(photoTypes, { error: photoProblem }),
}, { error: photoProblem }).refine((item) => item.id ?? item.media_id, photoProblem).transform((item) => (item.id ?? item.media_id)!);
const photos = z.array(photo, { error: photoProblem }).max(maxPhotos, photoProblem).optional().default([]);

export const shipperForm = z.object({ name: text("your name", 80) });
export const truckerForm = z.object({
  name: text("your full name", 80),
  nationalId: z.string({ error: "Enter your national ID, for example 63-1234567-F-42." }).trim().toUpperCase()
    .regex(/^\d{2}[\s-]?\d{6,7}[\s-]?[A-Z][\s-]?\d{2}$/, "Enter your national ID like 63-1234567-F-42: 2 digits, 6 or 7 digits, a letter, then 2 digits.")
    .transform((value) => value.replace(/[\s-]/g, "")),
  registration: text("the truck registration", 20).transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9 -]+$/, "Use only letters, numbers, spaces and dashes in the truck registration, for example ABC 1234.")),
  company: text("the company name", 100),
});
export const requestForm = z.object({
  pickup: town("pickup town"), dropoff: town("drop-off town"), date: date("date the load is ready"),
  cargo: z.enum(cargo, { error: "Choose the cargo type from the list." }), weight: tonnes("weight"),
  notes: z.string().trim().max(200, "Shorten the handling notes to 200 characters or fewer.").optional().default(""),
  photos,
}).refine(({ pickup, dropoff }) => pickup !== dropoff,
  differentTowns("pickup", "dropoff", "Pickup and drop-off are the same town. Choose a different drop-off town."));
export const tripForm = z.object({
  origin: town("origin"), destination: town("destination"), date: date("departure date"),
  time: z.string({ error: "Enter the departure time in 24-hour format, for example 07:30." }).trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter the departure time in 24-hour format with a colon, for example 07:30 or 16:45."),
  capacity: tonnes("space"),
  acceptedCargo: z.array(z.enum(cargo), { error: "Tick at least one cargo type you can carry." })
    .min(1, "Tick at least one cargo type you can carry.").max(cargo.length),
}).refine(({ origin, destination }) => origin !== destination,
  differentTowns("origin", "destination", "Origin and destination are the same town. Choose a different destination."));
export const capacityForm = z.object({ capacity: z.union([z.literal("0").transform(() => 0), tonnes("space")]) });
export const offerForm = z.object({
  price: z.string().trim().regex(/^\d{1,6}(\.\d{1,2})?$/)
    .transform((value) => Math.round(Number(value) * 100)).pipe(z.number().int().positive()),
});

/** One line per problem, in form order, for a reply that tells the user exactly what to fix. */
export function formProblems(error: z.ZodError) {
  return [...new Set(error.issues.map((issue) => issue.message))];
}

/** Parses a submitted form and collects every problem, including a date outside the bookable window. */
export function checkForm<S extends z.ZodType>(schema: S, input: unknown, now: Date, dateLabel?: string) {
  const parsed = schema.safeParse(input);
  const problems = parsed.success ? [] : formProblems(parsed.error);
  const date = (input as Record<string, unknown> | null)?.date;
  if (dateLabel && typeof date === "string" && z.iso.date().safeParse(date).success) {
    const problem = dateProblem(date, now, dateLabel);
    if (problem) problems.push(problem);
  }
  return parsed.success && !problems.length
    ? { ok: true as const, data: parsed.data as z.output<S> }
    : { ok: false as const, problems };
}

export function fixList(problems: string[]) {
  return `Please fix ${problems.length === 1 ? "this" : "these"} and submit the form again:\n${problems.map((p) => `• ${p}`).join("\n")}`;
}

// Searches saved before photo uploads have no `photos`.
export type RequestDetails = Omit<z.output<typeof requestForm>, "photos"> & { photos?: string[] };
export type TripDetails = z.output<typeof tripForm>;
export type Trip = Omit<TripDetails, "date" | "time"> & {
  _id: string; trucker: string; departureAt: Date; createdAt: Date; closedAt?: Date; lastAcceptedAt?: Date;
};
export type TransportRequest = RequestDetails & {
  _id: string; shipper: string; createdAt: Date; expiresAt?: Date;
  selectionId?: string; matchedAt?: Date; cancelledAt?: Date; matchedTripIds?: string[];
};
export type Shipment = {
  _id: string; requestId: string; tripId: string; shipper: string; trucker: string;
  createdAt: Date; replyBy: Date; state: "requested" | "offered" | "confirmed" | "completed" | "cancelled" | "declined";
  priceCents?: number; offeredAt?: Date; declinedAt?: Date; declinedBy?: string;
  confirmedAt?: Date; cancelledAt?: Date; cancelledBy?: string;
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

/** The first and last dates a form may use, as YYYY-MM-DD in Harare time (for the Flow date pickers). */
export function dateRange(now: Date) {
  return { min: localDate(now), max: localDate(new Date(localMidnight(localDate(now)).getTime() + bookingWindowDays * day)) };
}

export function dateAllowed(date: string, now: Date) {
  const { min, max } = dateRange(now);
  return date >= min && date <= max;
}

const shortDate = (date: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" })
  .format(new Date(`${date}T12:00:00+02:00`));

/** A specific explanation when a date is outside the bookable window, otherwise undefined. */
export function dateProblem(date: string, now: Date, label = "date") {
  const { min, max } = dateRange(now);
  if (date < min) return `The ${label} ${shortDate(date)} has passed. Choose today (${shortDate(min)}) or later.`;
  if (date > max) return `The ${label} ${shortDate(date)} is too far ahead. Choose a date up to ${shortDate(max)} (${bookingWindowDays} days from today).`;
}

/** Departures from `matchWindowDays` before to `matchWindowDays` after `date`, as whole local days. */
export function dateWindow(date: string) {
  const midnight = localMidnight(date).getTime();
  return { start: new Date(midnight - matchWindowDays * day), end: new Date(midnight + (matchWindowDays + 1) * day) };
}

/** Whole local days from `date` to the departure day: negative when the truck leaves earlier. */
export function daysFromDate(date: string, departureAt: Date) {
  return Math.round((localMidnight(localDate(departureAt)).getTime() - localMidnight(date).getTime()) / day);
}

/** "2 days before your date", "1 day after your date", or "" on the same day. */
export function dayOffset(date: string, departureAt: Date) {
  const offset = daysFromDate(date, departureAt);
  if (!offset) return "";
  const days = Math.abs(offset);
  return `${days} day${days === 1 ? "" : "s"} ${offset < 0 ? "before" : "after"} your date`;
}

export function tripFits(request: RequestDetails, trip: Trip, now: Date) {
  const pickup = towns.indexOf(request.pickup);
  const dropoff = towns.indexOf(request.dropoff);
  if (pickup === dropoff) return false;
  const { start, end } = dateWindow(request.date);
  const origin = towns.indexOf(trip.origin);
  const destination = towns.indexOf(trip.destination);
  const coversRoute = pickup < dropoff
    ? origin <= pickup && destination >= dropoff
    : origin >= pickup && destination <= dropoff;
  return coversRoute && !trip.closedAt && trip.departureAt > now && trip.departureAt >= start
    && trip.departureAt < end && trip.capacity >= request.weight && trip.acceptedCargo.includes(request.cargo);
}

export function findMatches(request: RequestDetails, trips: Trip[], now: Date) {
  // Closest to the requested day first, so early or late trucks never crowd out same-day ones.
  const distance = (trip: Trip) => Math.abs(daysFromDate(request.date, trip.departureAt));
  return trips.filter((trip) => tripFits(request, trip, now))
    .sort((a, b) => distance(a) - distance(b) || a.departureAt.getTime() - b.departureAt.getTime() || a._id.localeCompare(b._id))
    .slice(0, 10);
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
