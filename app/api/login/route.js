import { NextResponse } from "next/server";
import { COOKIE_NAME, createSessionToken, sanitizeReturnTo, sessionCookieOptions } from "../../../lib/viewer-auth.js";
import { verifyPassword } from "../../../lib/viewer-password.js";

export const runtime = "nodejs";

export async function POST(request) {
  const form = await request.formData();
  const returnTo = sanitizeReturnTo(form.get("returnTo"));
  const valid = await verifyPassword(form.get("password"), process.env.VIEWER_PASSWORD_HASH);
  if (!valid || !process.env.VIEWER_SESSION_SECRET) {
    const failure = new URL("/login", request.url);
    failure.searchParams.set("error", "invalid");
    failure.searchParams.set("returnTo", returnTo);
    return NextResponse.redirect(failure, 303);
  }
  const response = NextResponse.redirect(new URL(returnTo, request.url), 303);
  response.cookies.set(COOKIE_NAME, await createSessionToken(), sessionCookieOptions());
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
