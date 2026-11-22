import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { MongoServerError, type Db } from "mongodb";
import { collections } from "./db";
import { hour } from "./domain";
import { pilotKey, sameSecret } from "./secrets";
import { sendAdminCode } from "./whatsapp";

export const sessionCookie = "zunde_admin_session";
export const sessionSeconds = 8 * 60 * 60;
export const normalizePhone = (value: string) => {
  const phone = value.trim().replace(/^\+/, "").replace(/[\s()-]/g, "");
  return /^[1-9]\d{7,14}$/.test(phone) ? phone : "";
};
export function allowedAdmin(phone: string) {
  return !!phone && (process.env.ZUNDE_ADMIN_PHONES || "").split(",").map(normalizePhone).includes(phone);
}
const digestCode = (phone: string, code: string) => createHmac("sha256", pilotKey()).update(`admin-otp:${phone}:${code}`).digest("hex");
const digestSession = (token: string) => createHash("sha256").update(token).digest("hex");

export async function issueAdminCode(db: Db, phone: string, send = sendAdminCode, now = new Date()) {
  if (!allowedAdmin(phone)) return;
  const { adminCodes } = collections(db);
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const digest = digestCode(phone, code);
  const cutoff = new Date(+now - hour);
  const freshBucket = { $lte: [{ $ifNull: ["$bucketAt", new Date(0)] }, cutoff] };
  try {
    await adminCodes.updateOne({
      _id: phone, $and: [
        { $or: [{ nextSendAt: { $exists: false } }, { nextSendAt: { $lte: now } }] },
        { $or: [{ sends: { $exists: false } }, { sends: { $lt: 5 } }, { bucketAt: { $lte: cutoff } }] },
      ],
    }, [{ $set: { digest, attempts: 0, expiresAt: new Date(+now + 300_000), nextSendAt: new Date(+now + 60_000),
      purgeAt: new Date(+now + 2 * hour), bucketAt: { $cond: [freshBucket, now, "$bucketAt"] },
      sends: { $cond: [freshBucket, 1, { $add: ["$sends", 1] }] },
    } }], { upsert: true });
  } catch (error) {
    // The existing phone owns the cooldown or has exhausted its hourly quota.
    if (error instanceof MongoServerError && error.code === 11000) return;
    throw error;
  }
  try {
    await send(phone, code);
  } catch (error) {
    await adminCodes.updateOne({ _id: phone, digest }, { $unset: { digest: "" } });
    throw error;
  }
}

export async function verifyAdminCode(db: Db, phone: string, code: string, now = new Date()) {
  if (!allowedAdmin(phone) || !/^\d{6}$/.test(code)) return;
  const { adminCodes, adminSessions } = collections(db);
  const digest = digestCode(phone, code);
  // Reserve a guess before comparing so simultaneous guesses share the same five-attempt budget.
  const challenge = await adminCodes.findOneAndUpdate({
    _id: phone, expiresAt: { $gt: now }, attempts: { $lt: 5 }, digest: { $exists: true },
  }, { $inc: { attempts: 1 } }, { returnDocument: "after" });
  if (!challenge?.digest || !sameSecret(challenge.digest, digest)) return;
  const used = await adminCodes.updateOne({ _id: phone, digest, nextSendAt: challenge.nextSendAt }, { $unset: { digest: "" } });
  if (!used.modifiedCount) return;
  const token = randomBytes(32).toString("hex");
  await adminSessions.insertOne({ _id: digestSession(token), phone, expiresAt: new Date(+now + sessionSeconds * 1000) });
  return token;
}
export async function sessionAdmin(db: Db, token: string, now = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(token)) return;
  const session = await collections(db).adminSessions.findOne({ _id: digestSession(token), expiresAt: { $gt: now } });
  if (session && allowedAdmin(session.phone)) return session.phone;
}
export async function endSession(db: Db, token: string) {
  await collections(db).adminSessions.deleteOne({ _id: digestSession(token) });
}
