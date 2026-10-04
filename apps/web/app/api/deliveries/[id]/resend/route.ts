import { resendDelivery } from "@/lib/jobs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return Response.json(await resendDelivery(id));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
