import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sameSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function pilotKey() {
  const value = process.env.ZUNDE_DATA_KEY;
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) throw new Error("ZUNDE_DATA_KEY must be 32 bytes in hexadecimal");
  return Buffer.from(value, "hex");
}

export function encryptId(nationalId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pilotKey(), iv);
  const encrypted = Buffer.concat([cipher.update(nationalId, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function receiptToken(shipmentId: string) {
  const signature = createHmac("sha256", pilotKey()).update("receipt:" + shipmentId).digest("hex").slice(0, 24);
  return `${shipmentId}.${signature}`;
}
