import { get, issueSignedToken, presignUrl } from "@vercel/blob";

const SIGNED_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;
const SIGNED_URL_LIFETIME_MS = 5 * 60 * 1_000;
const THUMBNAIL_BROWSER_CACHE_SECONDS = 30 * 24 * 60 * 60;
const SIGNED_TOKEN_RENEWAL_MARGIN_MS = SIGNED_URL_LIFETIME_MS + 30_000;
const tokenCache = new Map();

export const recordVariantNames = Object.freeze(["original", "thumbnail", "preview"]);

export function resolvePrivateRecordVariant(record, variant = "original") {
  if (!recordVariantNames.includes(variant)) return { status: "invalid" };

  if (variant === "original") {
    return record?.blobPath
      ? { status: "available", pathname: record.blobPath, mediaType: record.mediaType }
      : { status: "missing" };
  }

  const descriptor = record?.variants?.[variant];
  if (descriptor?.blobPath) {
    return { status: "available", pathname: descriptor.blobPath, mediaType: descriptor.mediaType };
  }

  // Retain compatibility with the original optional thumbnail field while the
  // delivery inventory is introduced.
  if (variant === "thumbnail" && record?.thumbnailBlobPath) {
    return { status: "available", pathname: record.thumbnailBlobPath, mediaType: "image/jpeg" };
  }

  return { status: "missing" };
}

export async function createPrivateBlobReadUrl(pathname, now = Date.now()) {
  const token = await signedTokenFor(pathname, now);
  const validUntil = Math.min(now + SIGNED_URL_LIFETIME_MS, token.validUntil);
  return (await presignUrl(token, {
    access: "private",
    operation: "get",
    pathname,
    useCache: true,
    validUntil
  })).presignedUrl;
}

export function signedUrlLifetimeMs() {
  return SIGNED_URL_LIFETIME_MS;
}

export function thumbnailBrowserCacheControl() {
  return `private, max-age=${THUMBNAIL_BROWSER_CACHE_SECONDS}, immutable`;
}

export async function readPrivateBlob(pathname, ifNoneMatch) {
  return get(pathname, {
    access: "private",
    useCache: true,
    ...(ifNoneMatch ? { ifNoneMatch } : {})
  });
}

async function signedTokenFor(pathname, now) {
  const cached = tokenCache.get(pathname);
  if (cached && cached.validUntil > now + SIGNED_TOKEN_RENEWAL_MARGIN_MS) return cached;

  const issued = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil: now + SIGNED_TOKEN_LIFETIME_MS
  });
  tokenCache.set(pathname, issued);
  return issued;
}
