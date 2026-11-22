import { sameSecret } from "../secrets";

/** Answers Meta's GET subscription check with the challenge when the verify token matches. */
export function verifyWebhookToken(request: Request) {
  const token = process.env.WA_VERIFY_TOKEN;
  const query = new URL(request.url).searchParams;
  const challenge = query.get("hub.challenge");
  return token && query.get("hub.mode") === "subscribe" && challenge !== null &&
    sameSecret(query.get("hub.verify_token") || "", token)
    ? new Response(challenge) : new Response(null, { status: 403 });
}
