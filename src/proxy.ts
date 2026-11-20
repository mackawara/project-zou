import { NextResponse, type NextRequest } from "next/server";
import { sameSecret } from "./secrets";

export function proxy(request: NextRequest) {
  if (!process.env.MONGODB_URI && process.env.NODE_ENV === "development") return NextResponse.next();
  const user = process.env.ZUNDE_ADMIN_USER;
  const password = process.env.ZUNDE_ADMIN_PASSWORD;
  if (!user || !password || password.length < 16) return new NextResponse("Dashboard access is not configured.", { status: 503 });
  const expected = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  if (!sameSecret(request.headers.get("authorization") || "", expected)) {
    return new NextResponse("Sign in to the Zunde admin dashboard.", {
      status: 401, headers: { "WWW-Authenticate": 'Basic realm="Zunde admin", charset="UTF-8"', "Cache-Control": "no-store" },
    });
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

// Every admin page needs the admin login. The WhatsApp webhook authenticates Meta's signature itself,
// and Next.js build assets carry no data.
export const config = { matcher: ["/((?!whatsapp/hook|_next/static|_next/image|favicon.ico).*)"] };
