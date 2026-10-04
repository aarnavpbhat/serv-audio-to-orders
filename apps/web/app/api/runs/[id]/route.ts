import { getRunDetail } from "@/lib/data";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = getRunDetail(id);
  return run ? Response.json(run) : Response.json({ error: "not found" }, { status: 404 });
}
