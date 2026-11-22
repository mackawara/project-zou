"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { database } from "../../db";
import { endSession, issueAdminCode, normalizePhone, sessionCookie, sessionSeconds, verifyAdminCode } from "../../admin-auth";
import { logger } from "../../logger";

export type LoginState = { phone?: string; error?: string };
export async function signIn(previous: LoginState, form: FormData): Promise<LoginState> {
  const intent = form.get("intent");
  if (intent === "change") return {};
  const phone = normalizePhone(previous.phone || String(form.get("phone") || ""));
  if (!phone) return { error: "Enter your WhatsApp number with its country code." };
  try {
    const { db } = await database();
    if (intent !== "verify") {
      await issueAdminCode(db, phone);
      return { phone };
    }
    const token = await verifyAdminCode(db, phone, String(form.get("code") || "").trim());
    if (!token) return { phone, error: "That code is incorrect or has expired." };
    (await cookies()).set(sessionCookie, token, { httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "lax", path: "/", maxAge: sessionSeconds });
  } catch (error) {
    logger.error("Admin sign-in unavailable", error);
    return { ...previous, error: "Sign-in is temporarily unavailable. Please try again shortly." };
  }
  redirect("/");
}
export async function signOut() {
  const jar = await cookies();
  const token = jar.get(sessionCookie)?.value;
  if (token) await endSession((await database()).db, token);
  jar.delete(sessionCookie);
  redirect("/login");
}
