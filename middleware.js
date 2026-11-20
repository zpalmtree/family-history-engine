import { NextResponse } from "next/server";
import { COOKIE_NAME, createSessionToken, sanitizeReturnTo, sessionCookieOptions, sessionNeedsRenewal, verifySessionToken } from "./lib/viewer-auth.js";

export async function middleware(request) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/login" || pathname === "/api/login" || pathname === "/robots.txt") {
    return NextResponse.next();
  }
  const session = await verifySessionToken(request.cookies.get(COOKIE_NAME)?.value);
  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Authentication required" }, {
        status: 401,
        headers: { "Cache-Control": "private, no-store" }
      });
    }
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    login.searchParams.set("returnTo", sanitizeReturnTo(`${pathname}${request.nextUrl.search}`));
    return NextResponse.redirect(login);
  }
  const response = pathname === "/"
    ? NextResponse.rewrite(new URL(`/tree/index.html${request.nextUrl.search}`, request.url))
    : NextResponse.next();
  // Successful thumbnail responses define their own long private cache lifetime.
  // All other protected responses remain non-cacheable.
  if (pathname.startsWith("/tree/assets/fonts/")) {
    // Openly licensed web fonts; their file names change with their content.
    response.headers.set("Cache-Control", "private, max-age=31536000, immutable");
  } else if (!pathname.startsWith("/api/records/")) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  if (pathname !== "/api/family" && sessionNeedsRenewal(session)) {
    response.cookies.set(COOKIE_NAME, await createSessionToken(), sessionCookieOptions());
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
