/**
 * POST /api/dev/ingest-ticket {store, lane}: a one-time ticket for the simulator,
 * which cannot set WebSocket headers. 60 s, single use, bound to that store and lane.
 */
import { getConfig } from "@serv/config";
import { isSafeId, issueTicket } from "@serv/pipeline";
import { db } from "@/lib/data";
import { assertDevRoute } from "@/lib/dev-routes";
import { BadRequestError, wrapAsync } from "@/lib/error-handler";

export const POST = wrapAsync(async (req: Request) => {
  assertDevRoute(req);
  // JSON only: a cross-site form post cannot send this content type without a CORS preflight.
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new BadRequestError("content-type must be application/json");
  const body = (await req.json().catch(() => ({}))) as { store?: unknown; lane?: unknown };
  if (!isSafeId(body.store) || !isSafeId(body.lane)) throw new BadRequestError("store and lane must be ids (letters, digits, _ or -)");
  const t = issueTicket(db(), { storeId: body.store, laneId: body.lane });
  return Response.json({ ticket: t.ticket, expires_at: new Date(t.expiresAt).toISOString(), url: `${getConfig().ingest.publicUrl}/hme/v1/stream` });
});
