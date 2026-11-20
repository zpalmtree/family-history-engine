import { NextResponse } from "next/server";
import hostedViewer from "../../../.viewer-server/family.json";
import { COOKIE_NAME, createSessionToken, sessionCookieOptions, sessionNeedsRenewal, verifySessionToken } from "../../../lib/viewer-auth.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ error: "Authentication required" }, {
      status: 401,
      headers: { "Cache-Control": "private, no-store" }
    });
  }
  const response = NextResponse.json(hostedViewer, {
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" }
  });
  if (sessionNeedsRenewal(session)) {
    response.cookies.set(COOKIE_NAME, await createSessionToken(), sessionCookieOptions());
  }
  return response;
}
