import nextEnv from "@next/env";
import { setTimeout } from "node:timers/promises";
import { database, ensureIndexes } from "./db";
import { processIncoming, processOutgoing } from "./queue";
import { pilotKey } from "./secrets";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
pilotKey();
const { db, client } = await database();
await ensureIndexes(db);
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
console.info("Zunde WhatsApp worker ready");

// The inbox runs independently so a slow Graph API request cannot delay state changes.
const loop = async (run: () => Promise<boolean>) => {
  while (!stopping) {
    try {
      if (!await run()) await setTimeout(400);
    } catch {
      console.error("Queue unavailable; retrying");
      await setTimeout(2000);
    }
  }
};
try {
  await Promise.all([loop(() => processIncoming(db, client)), loop(() => processOutgoing(db))]);
} finally {
  await client.close();
}
