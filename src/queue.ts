import type { Db, MongoClient } from "mongodb";
import { collections } from "./db";
import { hour } from "./domain";
import { Workflow } from "./workflow";
import { sendWhatsApp } from "./whatsapp";

const retries = 6;
const retryAt = (attempts: number, now: Date) => new Date(now.getTime() + 1000 * 2 ** attempts);

export async function processIncoming(db: Db, client: MongoClient, now = new Date()) {
  const { inbox } = collections(db);
  const item = await inbox.findOne({ nextAt: { $lte: now }, event: { $exists: true }, failed: { $ne: true } }, { sort: { nextAt: 1, _id: 1 } });
  if (!item?.event) return false;
  try {
    await client.withSession((session) => session.withTransaction(async () => {
      const pending = await inbox.findOne({ _id: item._id, event: { $exists: true }, attempts: item.attempts }, { session });
      if (!pending?.event) return;
      await new Workflow(db, session, pending.event, now).handle();
      await inbox.updateOne({ _id: item._id }, { $unset: { event: "" } }, { session });
    }));
  } catch {
    const failed = item.attempts + 1 >= retries;
    await inbox.updateOne({ _id: item._id, event: { $exists: true }, attempts: item.attempts }, {
      $inc: { attempts: 1 }, $set: { nextAt: retryAt(item.attempts, now), failed },
      ...(failed && { $unset: { event: "" } }),
    });
    console.error(failed ? "Incoming message failed permanently" : "Incoming message will retry");
  }
  return true;
}

export async function processOutgoing(db: Db, deliver = sendWhatsApp, now = new Date()) {
  const { outbox, contacts } = collections(db);
  const item = await outbox.findOneAndUpdate(
    { nextAt: { $lte: now }, message: { $exists: true }, failed: { $ne: true } },
    { $set: { nextAt: new Date(now.getTime() + 30_000) } },
    { sort: { nextAt: 1, _id: 1 }, returnDocument: "after" },
  );
  if (!item?.message || !item.to) return false;
  try {
    const contact = await contacts.findOne({ _id: item.to });
    const inWindow = !!contact && now.getTime() - contact.lastIncomingAt.getTime() < 24 * hour;
    await deliver(item.to, item.message, inWindow);
    await outbox.updateOne({ _id: item._id }, { $unset: { to: "", message: "" } });
  } catch (error) {
    const failed = item.attempts + 1 >= retries;
    await outbox.updateOne({ _id: item._id }, {
      $inc: { attempts: 1 }, $set: { nextAt: retryAt(item.attempts, now), failed },
      ...(failed && { $unset: { to: "", message: "" } }),
    });
    console.error(error instanceof Error && error.message.startsWith("WhatsApp send failed") ? error.message : "Outgoing message could not be sent");
  }
  return true;
}
