import privateRecords from "../../../../.viewer-server/records.json";
import readings from "../../../../.viewer-server/readings.json";
import { annotatePdf } from "../../../../lib/viewer-pdf-annotations.js";
import { COOKIE_NAME, verifySessionToken } from "../../../../lib/viewer-auth.js";
import {
  createPrivateBlobReadUrl,
  readPrivateBlob,
  resolvePrivateRecordVariant,
  thumbnailBrowserCacheControl
} from "../../../../lib/viewer-blob-delivery.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const recordsById = new Map(privateRecords.map((record) => [record.id, record]));

export async function GET(request, { params }) {
  const session = await verifySessionToken(request.cookies.get(COOKIE_NAME)?.value);
  if (!session) return response("Authentication required", 401);

  const { recordId } = await params;
  const record = recordsById.get(recordId);
  if (!record) return response("Record not found", 404);

  const variant = new URL(request.url).searchParams.get("variant") || "original";
  const resolved = resolvePrivateRecordVariant(record, variant);
  if (resolved.status === "invalid") return response("Invalid record variant", 400);
  if (resolved.status === "missing") return response("Record preview not found", 404);

  if (variant === "thumbnail") {
    return thumbnailResponse(request, resolved);
  }

  // Keep PDFs on our authenticated origin. Blob's restrictive document CSP
  // can block the browser's PDF reader even when Content-Disposition is inline.
  if (resolved.mediaType === "application/pdf") {
    return pdfResponse(request, recordId, resolved);
  }

  let signedUrl;
  try {
    signedUrl = await createPrivateBlobReadUrl(resolved.pathname);
  } catch {
    return response("Record storage unavailable", 503);
  }

  return new Response(null, {
    status: 307,
    headers: privateHeaders({ Location: signedUrl })
  });
}

async function pdfResponse(request, recordId, resolved) {
  let result;
  try {
    result = await readPrivateBlob(resolved.pathname);
  } catch {
    return response("Record storage unavailable", 503);
  }
  if (!result) return response("Record not found", 404);
  const download = new URL(request.url).searchParams.get("download") === "1";
  const annotated = new URL(request.url).searchParams.get("annotated") === "1";
  let body = result.stream;
  let size = result.blob.size;
  if (annotated) {
    const available = Object.hasOwn(readings, recordId) ? readings[recordId].regions : [];
    const regionId = new URL(request.url).searchParams.get("region");
    const regions = regionId ? available.filter(region => region.id === regionId) : available;
    if (!regions?.length) return response("Annotated copy not available", 404);
    try {
      body = await annotatePdf(await new Response(result.stream).arrayBuffer(), regions);
      size = body.length;
    } catch {
      return response("Annotated copy unavailable; open the original PDF", 503);
    }
  }
  return new Response(body, {
    status: 200,
    headers: privateHeaders({
      "Content-Type": "application/pdf",
      "Content-Length": String(size),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(recordId)}${annotated ? "-annotated" : ""}.pdf"`,
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy": "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
    })
  });
}

async function thumbnailResponse(request, resolved) {
  let result;
  try {
    result = await readPrivateBlob(resolved.pathname, request.headers.get("if-none-match"));
  } catch {
    return response("Record storage unavailable", 503);
  }
  if (!result) return response("Record preview not found", 404);

  const cacheHeaders = {
    "Cache-Control": thumbnailBrowserCacheControl(),
    ETag: result.headers.get("etag") || result.blob.etag,
    "Last-Modified": result.headers.get("last-modified") || result.blob.uploadedAt.toUTCString()
  };
  if (result.statusCode === 304) {
    return new Response(null, { status: 304, headers: privateHeaders(cacheHeaders) });
  }
  return new Response(result.stream, {
    status: 200,
    headers: privateHeaders({
      ...cacheHeaders,
      "Content-Type": resolved.mediaType || result.blob.contentType,
      "Content-Length": String(result.blob.size)
    })
  });
}

function response(message, status) {
  return new Response(message, { status, headers: privateHeaders() });
}

function privateHeaders(additional = {}) {
  return {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    Vary: "Cookie",
    ...additional
  };
}
