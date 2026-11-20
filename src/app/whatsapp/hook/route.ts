import { incomingMessageNotificationHandler } from "../../../webhook/incomingMessageHandler";
import { verifyWebhookToken } from "../../../webhook/verifyWebhook";
import { verifyWebhookSignature } from "../../../webhook/webhookSignature";

export const runtime = "nodejs";

// Wired like the ISP bot's WhatsApp routes: GET verifies the subscription token;
// POST checks Meta's signature first, then hands the delivery to the message handler.
export const GET = verifyWebhookToken;

export async function POST(request: Request) {
  const delivery = await verifyWebhookSignature(request);
  return delivery instanceof Response ? delivery : incomingMessageNotificationHandler(delivery);
}
