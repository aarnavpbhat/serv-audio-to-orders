import { ConflictError, NotFoundError, wrapAsync } from "@/lib/error-handler";
import { resendDelivery } from "@/lib/jobs";

export const POST = wrapAsync(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  try {
    return Response.json(await resendDelivery(id));
  } catch (e) {
    const message = (e as Error).message;
    throw /^No delivery/.test(message) ? new NotFoundError(message) : new ConflictError(message);
  }
});
