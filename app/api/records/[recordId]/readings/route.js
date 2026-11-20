import readings from "../../../../../.viewer-server/readings.json";
import { COOKIE_NAME, verifySessionToken } from "../../../../../lib/viewer-auth.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request, { params }) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
  if (!await verifySessionToken(request.cookies.get(COOKIE_NAME)?.value)) {
    return Response.json({ error: "Authentication required" }, { status: 401, headers });
  }
  const { recordId } = await params;
  if (!Object.hasOwn(readings, recordId)) return Response.json({ error: "Record not found" }, { status: 404, headers });
  return Response.json(readings[recordId], { headers });
}
