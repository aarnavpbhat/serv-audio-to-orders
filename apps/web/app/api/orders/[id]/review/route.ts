/**
 * POST /api/orders/:id/review: resolve an order that needs review (plan step 11).
 * Picks for the unclear items and the outcome make the next version, sent as
 * order.updated. Dev routes and localhost only (the sandbox has no sign-in).
 */
import { createEngine, isSafeId, resolveReview, ReviewConflictError, ReviewResolution } from "@serv/pipeline";
import { assertDevRoute } from "@/lib/dev-routes";
import { BadRequestError, ConflictError, NotFoundError, wrapAsync } from "@/lib/error-handler";

export const POST = wrapAsync(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertDevRoute(req);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new BadRequestError("content-type must be application/json");
  const { id } = await ctx.params;
  if (!isSafeId(id)) throw new NotFoundError("No such order");
  const parsed = ReviewResolution.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500));
  const engine = createEngine({ transcriber: "script", extractor: "fuzzy", log: () => {} });
  try {
    const next = await resolveReview(engine, id, parsed.data);
    return Response.json({ order_id: next.order_id, order_version: next.order_version, status: next.status, review: next.review });
  } catch (e) {
    if (e instanceof ReviewConflictError) throw new ConflictError(e.message);
    if (/^No order /.test((e as Error).message)) throw new NotFoundError("No such order");
    throw new BadRequestError((e as Error).message.slice(0, 300));
  }
});
