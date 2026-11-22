import { towns } from "./domain";

// Short explanations of how Zunde works. Each body is sent as an interactive message,
// so keep it under WhatsApp's 1024-character limit.
export type Guide = "shipper" | "trucker" | "receiver";

export const helpCommands = ["help", "how it works", "how does it work", "info", "?"];

export const welcome = [
  "Welcome to Zunde. We match goods that need moving with spare space on trucks that are already making the trip.",
  "",
  "• Sending goods? Find a truck, ask for a price and accept the offer you like.",
  "• Driving a truck? Advertise your spare space and send prices for loads that fit.",
  "",
  "When an offer is accepted, Zunde shares both phone numbers and you arrange payment directly.",
  "",
  "Reply HELP at any time to see how it works. What would you like to do?",
].join("\n");

export const menu = "Welcome to Zunde. What would you like to do?\nReply HELP to see how it works.";

export const overview = [
  "How Zunde works",
  "",
  `Zunde matches loads with spare space on planned truck trips between ${towns.join(", ")}, in both directions. Everything happens in this chat and there is no app to install.`,
  "",
  "Choose a short guide:",
].join("\n");

export const guideButtons: { id: `help:${Guide}`; title: string }[] = [
  { id: "help:shipper", title: "I'm sending goods" },
  { id: "help:trucker", title: "I drive a truck" },
  { id: "help:receiver", title: "I'm receiving goods" },
];

export const guides: Record<Guide, string> = {
  shipper: [
    "Sending goods",
    "",
    "1. Tap Find a truck and enter the pickup, destination, ready date, cargo and weight. You can search without registering.",
    "2. Zunde lists trucks leaving on your date or the next two days. Choose one to ask for a price. The first time, add your name.",
    "3. The trucker replies with a total price in USD. Accept it, or choose another truck. A request with no reply expires after 2 hours.",
    "4. When you accept, you each get the other's phone number. Arrange payment directly with the trucker.",
    "5. After delivery, tap Confirm receipt. If someone else receives the goods, forward them the receipt link instead.",
    "",
    "Your searches and shipments are under My activity.",
  ].join("\n"),
  trucker: [
    "Carrying loads",
    "",
    "1. Tap Advertise space and enter your route, departure time, free space in tonnes and the cargo you accept. The first time, add your name, national ID, truck registration and company.",
    "2. Shippers whose loads fit your trip send you requests. Reply with a total price in USD, or decline.",
    "3. When a shipper accepts, you each get the other's phone number. Arrange payment directly.",
    "4. Tap Update space after each booking or change of plan, so you only get loads that fit.",
    "5. After delivery, tap Mark delivered. The shipment completes when the receiver confirms too.",
    "",
    "Your adverts and shipments are under My activity.",
  ].join("\n"),
  receiver: [
    "Receiving goods",
    "",
    "The sender can forward you a receipt link for the shipment. When the goods arrive, open the link and send the message it fills in.",
    "",
    "The shipment completes once the trucker has also marked it delivered. You don't need to register.",
  ].join("\n"),
};
