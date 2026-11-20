import { NextResponse } from "next/server";
import { COOKIE_NAME, isSameOriginPost, sessionCookieOptions } from "../../../lib/viewer-auth.js";

export async function POST(request) {
  if (!isSameOriginPost(request)) return new NextResponse("Invalid request", { status: 400 });
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(COOKIE_NAME, "", { ...sessionCookieOptions(), maxAge: 0 });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
