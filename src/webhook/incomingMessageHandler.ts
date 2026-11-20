import { MongoServerError, type Db } from "mongodb";
import { collections, database, type Event } from "../db";
import { hour } from "../domain";
import { logger } from "../logger";
import { processIncoming, processOutgoing } from "../queue";
import { eventsFrom, markRead, sendWhatsApp } from "../whatsapp";
import type { VerifiedDelivery } from "./webhookSignature";

const TAG = "WHATSAPP_MESSAGE_NOTIFICATION";

// Swapped out by tests so replies are captured instead of sent to the Graph API.
export const transport = { deliver: sendWhatsApp, read: markRead };

// If handling fails part-way, the worker picks the message up after this delay.
const workerFallback = 30_000;

const acknowledge = () => new Response("OK");
const retryLater = () => new Response(null, { status: 503 });

/**
 * Records the message ID in the inbox. Returns false for a repeat delivery of the same ID,
 * which is skipped even while the first delivery is still being handled.
 */
async function firstDelivery(db: Db, event: Event, now: Date) {
  try {
    await collections(db).inbox.insertOne({
      _id: event.id, event, attempts: 0,
      nextAt: new Date(now.getTime() + workerFallback), expiresAt: new Date(now.getTime() + 168 * hour),
    });
    return true;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return false;
    throw error;
  }
}

/**
 * Handles a verified webhook delivery the way the ISP bot's incomingMessageNotificationHandler does,
 * before responding: ignore messages for other business numbers, skip duplicate message IDs,
 * run the conversation step, send its replies, then mark the message read.
 *
 * Handling errors are logged and still acknowledged with 200; unfinished work stays queued for the worker.
 * Only a failure to record a message in the inbox returns 503, so Meta delivers it again.
 */
export async function incomingMessageNotificationHandler({ payload, phoneID }: VerifiedDelivery, now = new Date()) {
  const events = eventsFrom(payload, phoneID, now);
  if (logger.debugEnabled()) {
    const changes = (payload as { entry?: { changes?: { field?: string; value?: { metadata?: unknown; messages?: unknown[] } }[] }[] })
      .entry?.flatMap((entry) => entry.changes ?? []) ?? [];
    logger.debug("payload", JSON.stringify(changes.map(({ field, value }) => ({
      field, metadata: value?.metadata, messages: value?.messages,
    })), null, 2), "\nhandling:", JSON.stringify(events, null, 2));
  }
  // Status updates and messages for other business numbers need no work.
  if (!events.length) return acknowledge();

  let connection: Awaited<ReturnType<typeof database>>;
  try {
    connection = await database();
  } catch (error) {
    logger.error(`${TAG}: Database unavailable; asking Meta to retry`, error);
    return retryLater();
  }
  const { db, client } = connection;

  for (const event of events) {
    try {
      if (!await firstDelivery(db, event, now)) {
        logger.info(`${TAG}: Duplicate message ${event.id} ignored`);
        continue;
      }
    } catch (error) {
      logger.error(`${TAG}: Could not record message ${event.id}; asking Meta to retry`, error);
      return retryLater();
    }
    logger.info(`${TAG}: Received ${event.kind} message ${event.id}`);
    try {
      await processIncoming(db, client, new Date(), event.id);
      while (await processOutgoing(db, transport.deliver, new Date(), event.id)) { /* Send this message's replies. */ }
      await transport.read(event.id);
    } catch (error) {
      logger.error(`${TAG}: Message ${event.id} was not fully handled`, error);
    }
  }
  return acknowledge();
}
