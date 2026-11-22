import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { database } from "../db";
import { demoMode } from "../admin";
import { sessionAdmin, sessionCookie } from "../admin-auth";

export const currentAdmin = cache(async () => {
  const token = (await cookies()).get(sessionCookie)?.value;
  if (token) return sessionAdmin((await database()).db, token);
});
export async function requireAdmin() {
  const phone = await currentAdmin();
  if (!phone) redirect("/login");
  return phone;
}
export async function requireDashboard() {
  if (!demoMode()) await requireAdmin();
}
