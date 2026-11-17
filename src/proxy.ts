import { NextResponse, type NextRequest } from "next/server";
import { sameSecret } from "./secrets";

export function proxy(request: NextRequest) {
  if (!process.env.MONGODB_URI && process.env.NODE_ENV === "development") return NextResponse.next();
  const user = process.env.ZUNDE_ADMIN_USER;
  const password = process.env.ZUNDE_ADMIN_PASSWORD;
  if (!user || !password || password.length < 16) return new NextResponse("Dashboard access is not configured.", { status: 503 });
  const expected = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  if (!sameSecret(request.headers.get("authorization") || "", expected)) {
    return new NextResponse("Sign in to view Zunde analytics.", {
      status: 401, headers: { "WWW-Authenticate": 'Basic realm="Zunde analytics", charset="UTF-8"', "Cache-Control": "no-store" },
    });
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = { matcher: ["/"] };
