/**
 * POST /api/sessions/:id/stop {mode: "end" | "discard"} (E3), dev routes and
 * localhost only. End sends the open conversation now; Discard drops it. Stopping
 * twice, or a session that already ended, is not an error.
 */
import { isSafeId } from "@serv/pipeline";
import { assertDevRoute } from "@/lib/dev-routes";
import { BadRequestError, ServiceUnavailableError, wrapAsync } from "@/lib/error-handler";
import { stopFeedSession } from "@/lib/feed";

export const POST = wrapAsync(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertDevRoute(req);
  // JSON only: a cross-site form post cannot send this content type without a CORS preflight.
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new BadRequestError("content-type must be application/json");
  const { id } = await ctx.params;
  const { mode } = (await req.json().catch(() => ({}))) as { mode?: unknown };
  if (!isSafeId(id) || (mode !== "end" && mode !== "discard")) throw new BadRequestError("need a session id and mode end or discard");
  const r = await stopFeedSession(id, mode);
  if (!r.reachable) throw new ServiceUnavailableError("The feed service is not reachable. Start it with ENABLE_DEV_ROUTES=true pnpm feed serve.");
  return Response.json({ stopped: r.stopped, mode });
});
