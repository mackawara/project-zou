"use server";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "../session";
import { database } from "../../db";
import { EntryError, recordPayment, changeAccess } from "../../admin-operations";
import { logger } from "../../logger";

export type EntryState = { error?: string; success?: string; id?: string; fields?: Record<string, string> };
const field = (form: FormData, name: string) => String(form.get(name) ?? "").slice(0, 512);
function entryError(error: unknown) {
  if (error instanceof EntryError) return error.message;
  logger.error("Admin update failed", error);
  return "Could not save this change. Check the record and try again.";
}
export async function savePayment(_previous: EntryState, form: FormData): Promise<EntryState> {
  const admin = await requireAdmin();
  const fields = Object.fromEntries(["id", "shipper", "amount", "paidOn", "method", "reference"].map(key => [key, field(form, key)]));
  try {
    await recordPayment((await database()).db, admin, fields);
  } catch (error) {
    return { error: entryError(error), fields };
  }
  revalidatePath("/payments");
  return { success: "Payment recorded in the ledger.", id: randomUUID() };
}
export async function saveAccess(_previous: EntryState, form: FormData): Promise<EntryState> {
  const admin = await requireAdmin();
  const action = field(form, "action");
  try {
    const { db, client } = await database();
    await changeAccess(db, client, admin, { action, shipper: field(form, "shipper"), reason: field(form, "reason") });
  } catch (error) {
    return { error: entryError(error) };
  }
  revalidatePath("/users");
  return { success: action === "suspend" ? "Shipper suspended." : "Shipper reinstated." };
}
