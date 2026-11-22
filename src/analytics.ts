import { collections, database } from "./db";
import { hour, localDate, localMidnight, timeZone } from "./domain";

export type Period = "7" | "30" | "all";
type DayCount = { _id: string; count: number };
type RouteCount = { pickup: string; dropoff: string; requests: number; matched: number };
type Activity = { ref: string; label: string; at: Date };
export type Analytics = {
  requests: number; trips: number; matched: number; confirmed: number; completed: number; cancelled: number;
  routes: RouteCount[]; days: { date: string; requests: number; trips: number; completed: number }[]; activity: Activity[];
};

const day = 24 * hour;
const startDate = (now: Date, days: number) => new Date(localMidnight(localDate(now)).getTime() - (days - 1) * day);

function chart(now: Date, days: number, requests: DayCount[], trips: DayCount[], completions: DayCount[]) {
  const start = startDate(now, days).getTime();
  const requestCounts = new Map(requests.map((row) => [row._id, row.count]));
  const tripCounts = new Map(trips.map((row) => [row._id, row.count]));
  const completedCounts = new Map(completions.map(row => [row._id, row.count]));
  return Array.from({ length: days }, (_, offset) => {
    const date = localDate(new Date(start + offset * day));
    return { date, requests: requestCounts.get(date) || 0, trips: tripCounts.get(date) || 0, completed: completedCounts.get(date) || 0 };
  });
}

export async function getAnalytics(period: Period, now = new Date()): Promise<Analytics> {
  const { db } = await database();
  const c = collections(db);
  const dateFilter = period === "all" ? {} : { createdAt: { $gte: startDate(now, Number(period)) } };
  const events = (field: string) => ({ [field]: period === "all" ? { $exists: true } : { $gte: startDate(now, Number(period)) } });
  const days = period === "7" ? 7 : 30;
  const dayPipeline = (field: "createdAt" | "completedAt") => [
    { $match: { [field]: { $gte: startDate(now, days) } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$" + field, timezone: timeZone } }, count: { $sum: 1 } } },
  ];
  const [requests, trips, matched, confirmed, completed, cancelled, routes, requestDays, tripDays, completionDays, activity] = await Promise.all([
    c.searchMetrics.countDocuments(dateFilter),
    c.trips.countDocuments(dateFilter),
    c.searchMetrics.countDocuments({ ...dateFilter, matchedAt: { $exists: true } }),
    c.shipments.countDocuments(events("confirmedAt")),
    c.shipments.countDocuments(events("completedAt")),
    c.shipments.countDocuments(events("cancelledAt")),
    c.searchMetrics.aggregate<RouteCount>([
      { $match: dateFilter },
      { $group: { _id: { pickup: "$pickup", dropoff: "$dropoff" }, requests: { $sum: 1 },
        matched: { $sum: { $cond: [{ $ifNull: ["$matchedAt", false] }, 1, 0] } } } },
      { $sort: { requests: -1, "_id.pickup": 1, "_id.dropoff": 1 } },
      { $limit: 6 },
      { $project: { _id: 0, pickup: "$_id.pickup", dropoff: "$_id.dropoff", requests: 1, matched: 1 } },
    ]).toArray(),
    c.searchMetrics.aggregate<DayCount>(dayPipeline("createdAt")).toArray(),
    c.trips.aggregate<DayCount>(dayPipeline("createdAt")).toArray(),
    c.shipments.aggregate<DayCount>(dayPipeline("completedAt")).toArray(),
    c.shipments.aggregate<Activity>([
      { $match: { $or: [events("confirmedAt"), events("completedAt"), events("cancelledAt")] } },
      { $project: { ref: { $substr: ["$_id", 0, 8] }, updates: [
        { label: "Offer accepted", at: "$confirmedAt" },
        { label: "Delivery completed", at: "$completedAt" },
        { label: "Shipment cancelled", at: "$cancelledAt" },
      ] } },
      { $unwind: "$updates" },
      { $match: { "updates.at": { $gte: period === "all" ? new Date(0) : startDate(now, Number(period)) } } },
      { $sort: { "updates.at": -1, _id: 1 } },
      { $limit: 5 },
      { $project: { _id: 0, ref: 1, label: "$updates.label", at: "$updates.at" } },
    ]).toArray(),
  ]);
  return { requests, trips, matched, confirmed, completed, cancelled, routes, days: chart(now, days, requestDays, tripDays, completionDays), activity };
}

export function sampleAnalytics(period: Period, now = new Date()): Analytics {
  const days = period === "7" ? 7 : 30;
  const start = startDate(now, days).getTime();
  const recent = [4, 8, 5, 11, 9, 14, 7];
  const requests = Array.from({ length: days }, (_, i) => ({
    _id: localDate(new Date(start + i * day)), count: recent[i % 7],
  }));
  const trips = requests.map(({ _id, count }, i) => ({ _id, count: Math.max(1, Math.round(count * 0.55) + (i % 3) - 1) }));
  const completions = requests.map(({ _id }, i) => ({ _id, count: [1, 3, 2, 3, 2, 5, 2][i % 7] }));
  const total = requests.reduce((sum, item) => sum + item.count, 0);
  const recentRoutes = [
    ["Harare", "Bulawayo", 19, 15], ["Gweru", "Bulawayo", 13, 10],
    ["Bulawayo", "Hwange", 11, 8], ["Harare", "Gweru", 9, 6],
    ["Hwange", "Victoria Falls", 6, 4],
  ] as const;
  const scale = total / 58;
  return {
    requests: total, trips: trips.reduce((sum, item) => sum + item.count, 0),
    matched: Math.round(43 * scale), confirmed: Math.round(26 * scale), completed: completions.reduce((sum, row) => sum + row.count, 0), cancelled: Math.round(3 * scale),
    routes: recentRoutes.map(([pickup, dropoff, requests, matched]) => ({
      pickup, dropoff, requests: Math.round(requests * scale), matched: Math.round(matched * scale),
    })),
    days: chart(now, days, requests, trips, completions),
    activity: [
      { ref: "4b291ca2", label: "Delivery completed", at: new Date(now.getTime() - hour) },
      { ref: "db5c9301", label: "Offer accepted", at: new Date(now.getTime() - 2 * hour) },
      { ref: "5cea96a0", label: "Shipment cancelled", at: new Date(now.getTime() - 4 * hour) },
      { ref: "e231b189", label: "Offer accepted", at: new Date(now.getTime() - 6 * hour) },
    ],
  };
}
