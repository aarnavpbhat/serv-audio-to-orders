import { store } from "@serv/pipeline";
import { db } from "@/lib/data";
import { BadRequestError, wrapAsync } from "@/lib/error-handler";

const MODES = new Set(["ok", "fail_500", "rate_limit_429", "timeout"]);

export const POST = wrapAsync(async (req: Request) => {
  const body = (await req.json()) as { mode?: string; remaining?: number; retry_after_s?: number };
  if (!body.mode || !MODES.has(body.mode)) throw new BadRequestError("mode must be ok, fail_500, rate_limit_429 or timeout");
  const settings: store.MockSettings = {
    mode: body.mode as store.MockMode,
    remaining: body.mode === "ok" ? 0 : Math.trunc(body.remaining ?? 1),
    retry_after_s: Math.max(0, Math.trunc(body.retry_after_s ?? 3)),
  };
  store.setMockSettings(db(), settings);
  return Response.json(settings);
});
