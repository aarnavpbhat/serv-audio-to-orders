import { getRunDetail } from "@/lib/data";
import { assertFound, wrapAsync } from "@/lib/error-handler";

export const GET = wrapAsync(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return Response.json(assertFound(getRunDetail(id), "Run"));
});
