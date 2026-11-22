import { NextResponse } from "next/server";

export function proxy() {
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
// Authentication is enforced at the dashboard data boundary and independently on every mutation.
export const config = { matcher: ["/", "/login", "/trips", "/users", "/reports", "/routes", "/payments"] };
