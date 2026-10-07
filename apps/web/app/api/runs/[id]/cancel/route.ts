/** POST /api/runs/:id/cancel: stop a queued or running run. Orders already sent stay sent. */
import { cancelRun } from "@/lib/jobs";
import { BadRequestError, wrapAsync } from "@/lib/error-handler";

export const POST = wrapAsync(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  // JSON only: a cross-site form post cannot send this content type without a CORS preflight.
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new BadRequestError("content-type must be application/json");
  const { id } = await ctx.params;
  return Response.json({ cancelled: cancelRun(id) });
});
