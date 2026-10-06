/**
 * GET /api/orders/:id/clip: the audio behind an order's review flag (the flagged
 * lines, 2 s either side), as WAV, from the order's archive or its run's file.
 * Dev routes and localhost only, like the review screen.
 */
import { createEngine, flaggedClip, isSafeId, store, type OrderPayload, type Transcript } from "@serv/pipeline";
import { db } from "@/lib/data";
import { assertDevRoute } from "@/lib/dev-routes";
import { NotFoundError, wrapAsync } from "@/lib/error-handler";

export const GET = wrapAsync(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  assertDevRoute(req);
  const { id } = await ctx.params;
  if (!isSafeId(id)) throw new NotFoundError("No such order");
  const d = db();
  const row = store.latestOrder(d, id);
  if (!row) throw new NotFoundError("No such order");
  const run = store.getRun(d, row.run_id);
  const transcript = run?.transcript ? (JSON.parse(run.transcript) as Transcript) : null;
  const engine = createEngine({ transcriber: "script", extractor: "fuzzy", log: () => {} });
  const clip = await flaggedClip(engine, JSON.parse(row.payload) as OrderPayload, { file: run?.file_path || null, audioStartUtc: transcript?.audio_start_utc ?? null });
  if (!clip) throw new NotFoundError("No audio was kept for this order");
  return new Response(new Uint8Array(clip.wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store", "x-clip-from-s": clip.fromS.toFixed(3), "x-clip-to-s": clip.toS.toFixed(3) } });
});
