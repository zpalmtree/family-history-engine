import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";
import branding from "./viewer-branding.js";

export const SESSION_SECONDS = 365 * 24 * 60 * 60;
export const SESSION_RENEW_AFTER_SECONDS = 7 * 24 * 60 * 60;
export const COOKIE_NAME = process.env.NODE_ENV === "production"
  ? "__Host-family-tree-session"
  : "family-tree-session";

const encoder = new TextEncoder();

function configuredSecrets() {
  const passwordHash = process.env.VIEWER_PASSWORD_HASH?.trim();
  const sessionSecret = process.env.VIEWER_SESSION_SECRET?.trim();
  return passwordHash && sessionSecret ? { passwordHash, sessionSecret } : null;
}

async function signingKey() {
  const secrets = configuredSecrets();
  if (!secrets) return null;
  return encoder.encode(`${secrets.sessionSecret}\0${secrets.passwordHash}`);
}

export function authIsConfigured() {
  return Boolean(configuredSecrets());
}

export async function createSessionToken(nowSeconds = Math.floor(Date.now() / 1000)) {
  const key = await signingKey();
  if (!key) throw new Error("viewer authentication is not configured");
  return new SignJWT({ purpose: "family-tree-viewer" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("family")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + SESSION_SECONDS)
    .setIssuer(branding.issuer)
    .setAudience("family-tree-viewer")
    .sign(key);
}

export async function verifySessionToken(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const key = await signingKey();
  if (!key || !token) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: branding.issuer,
      audience: "family-tree-viewer",
      currentDate: new Date(nowSeconds * 1000)
    });
    return payload.purpose === "family-tree-viewer" ? payload : null;
  } catch {
    return null;
  }
}

export function sessionNeedsRenewal(payload, nowSeconds = Math.floor(Date.now() / 1000)) {
  return !Number.isInteger(payload?.iat)
    || nowSeconds - payload.iat >= SESSION_RENEW_AFTER_SECONDS;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_SECONDS
  };
}

export function sanitizeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  try {
    const parsed = new URL(value, "https://family.invalid");
    return parsed.origin === "https://family.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function isSameOriginPost(request) {
  const source = request.headers.get("origin") || request.headers.get("referer");
  if (!source) {
    return request.headers.get("sec-fetch-site") === "same-origin";
  }
  try {
    const sourceOrigin = new URL(source).origin;
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
    const forwardedProtocol = request.headers.get("x-forwarded-proto") || requestUrl.protocol.replace(":", "");
    const accepted = new Set([requestUrl.origin]);
    if (forwardedHost) accepted.add(`${forwardedProtocol}://${forwardedHost}`);
    return accepted.has(sourceOrigin);
  } catch {
    return false;
  }
}
