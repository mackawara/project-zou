import { createHash, createHmac } from "node:crypto";
import { logger } from "../logger";
import { authentic, foreignOnly } from "../whatsapp";

const TAG = "WHATSAPP_WEBHOOK_SIGNATURE";
const maxBody = 1024 * 1024;

const mask = (value: string) =>
  `len=${value.length} sha256=${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;

/** A delivery whose bytes carry Meta's signature, ready for the message handler. */
export type VerifiedDelivery = { payload: unknown; phoneID: string };

/**
 * Runs before the message handler, like the ISP bot's `preValidation` hook: nothing in the body is
 * handled until its bytes carry Meta's HMAC-SHA256 signature made with the app secret.
 * Returns the response to send when the delivery stops here.
 *
 * Posts addressed only to other business numbers are acknowledged before the signature check,
 * because they may be signed with another Meta app's secret and a 401 would make Meta retry them.
 */
export async function verifyWebhookSignature(request: Request): Promise<VerifiedDelivery | Response> {
  // Trim both: stray whitespace or newlines in env files change the HMAC key.
  const secret = process.env.WA_APP_SECRET?.trim();
  const phoneID = process.env.WA_PHONE_NUMBER_ID?.trim();
  if (!secret || !phoneID) {
    logger.error(`${TAG}: WA_APP_SECRET or WA_PHONE_NUMBER_ID is not set; rejecting webhook delivery`);
    return new Response(null, { status: 503 });
  }
  if (Number(request.headers.get("content-length")) > maxBody) return new Response(null, { status: 413 });
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > maxBody) return new Response(null, { status: 413 });
  let payload: unknown;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { payload = undefined; }

  if (foreignOnly(payload, phoneID)) {
    logger.info(`${TAG}: Delivery for another business phone number ignored (expected ${phoneID})`);
    return new Response("OK");
  }

  const signature = request.headers.get("x-hub-signature-256") || "";
  const valid = authentic(raw, signature, secret);
  if (logger.debugEnabled()) {
    logger.debug("auth", {
      valid, appSecretInfo: mask(secret), phoneID,
      receivedSignature: signature || "<missing>",
      expectedSignature: "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
      bodyBytes: raw.length,
      rawBody: raw.toString("utf8"),
      headers: Object.fromEntries(request.headers),
    });
  }
  if (!valid) {
    logger.warn(`${TAG}: Rejected webhook delivery with a missing or invalid signature`);
    return new Response(null, { status: 401 });
  }
  if (payload === undefined) {
    logger.warn(`${TAG}: Signed webhook delivery is not valid JSON`);
    return new Response(null, { status: 400 });
  }
  return { payload, phoneID };
}
