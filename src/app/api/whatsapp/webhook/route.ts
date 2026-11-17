import { MongoServerError } from "mongodb";
import { collections, database } from "../../../../db";
import { hour } from "../../../../domain";
import { sameSecret } from "../../../../secrets";
import { authentic, eventsFrom } from "../../../../whatsapp";

export const runtime = "nodejs";

export function GET(request: Request) {
  const token = process.env.WA_VERIFY_TOKEN;
  const query = new URL(request.url).searchParams;
  const challenge = query.get("hub.challenge");
  return token && query.get("hub.mode") === "subscribe" && challenge !== null &&
    sameSecret(query.get("hub.verify_token") || "", token)
    ? new Response(challenge) : new Response(null, { status: 403 });
}

export async function POST(request: Request) {
  const { WA_APP_SECRET, WA_PHONE_NUMBER_ID } = process.env;
  if (!WA_APP_SECRET || !WA_PHONE_NUMBER_ID) return new Response(null, { status: 503 });
  if (Number(request.headers.get("content-length")) > 1024 * 1024) return new Response(null, { status: 413 });
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > 1024 * 1024) return new Response(null, { status: 413 });
  if (!authentic(raw, request.headers.get("x-hub-signature-256") || "", WA_APP_SECRET)) {
    return new Response(null, { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(raw.toString("utf8")); }
  catch { return new Response(null, { status: 400 }); }
  const now = new Date();
  const events = eventsFrom(payload, WA_PHONE_NUMBER_ID, now);
  if (events.length) {
    const { db } = await database();
    const { inbox } = collections(db);
    try {
      await inbox.bulkWrite(events.map((event) => ({
        updateOne: {
          filter: { _id: event.id }, upsert: true,
          update: { $setOnInsert: { event, nextAt: now, expiresAt: new Date(now.getTime() + 168 * hour), attempts: 0 } },
        },
      })), { ordered: false });
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      // Concurrent webhook deliveries can both attempt the same initial insert. Retry the batch.
      return new Response(null, { status: 503 });
    }
  }
  return new Response("OK");
}
