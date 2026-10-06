/**
 * GET /api/dev/noise?level=moderate|heavy: 20 s of the fixtures' synthetic
 * drive-thru noise (engine idle, wind, car radio) as a 16 kHz WAV. The
 * simulator loops it under the mic to test low audio quality handling.
 */
import { synthNoise } from "@serv/pipeline";
import { assertDevRoute } from "@/lib/dev-routes";
import { BadRequestError, wrapAsync } from "@/lib/error-handler";

const SECONDS = 20;
const RATE = 16_000;
/** RMS of the noise in the file (the simulator's slider scales it further). */
const LEVEL = 0.08;

function wav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, data, true);
  samples.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x * LEVEL)) * 0x7fff, true));
  return new Uint8Array(buf);
}

export const GET = wrapAsync(async (req: Request) => {
  assertDevRoute(req);
  const level = new URL(req.url).searchParams.get("level") ?? "moderate";
  if (level !== "moderate" && level !== "heavy") throw new BadRequestError("level must be moderate or heavy");
  const body = wav(synthNoise(SECONDS * RATE, level === "heavy" ? 7 : 3, level));
  return new Response(body, { headers: { "content-type": "audio/wav", "cache-control": "private, max-age=3600" } });
});
