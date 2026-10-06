import { readFileSync, statSync } from "node:fs";
import { runAudioPath } from "@/lib/data";
import { assertFound, wrapAsync } from "@/lib/error-handler";

export const GET = wrapAsync(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const file = assertFound(runAudioPath(id), "Run audio");
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  const buf = readFileSync(file);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    return new Response(buf.subarray(start, end + 1), {
      status: 206,
      headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": String(end - start + 1) },
    });
  }
  return new Response(buf, { headers: { "content-type": "audio/mpeg", "accept-ranges": "bytes", "content-length": String(size) } });
});
