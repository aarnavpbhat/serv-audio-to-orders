/**
 * POST /api/dev/simulator/save: the simulator's "Save as fixture". Writes the
 * session's raw capture, audio, timeline and the hand-written expected orders
 * to fixtures/live/<name>/ (or fixtures/heldout/<name>/). Dev routes and
 * localhost only; the name is a safe id and an existing fixture is never overwritten.
 */
import { createEngine, saveLiveFixture, SaveFixtureInput } from "@serv/pipeline";
import { assertDevRoute } from "@/lib/dev-routes";
import { BadRequestError, wrapAsync } from "@/lib/error-handler";

export const POST = wrapAsync(async (req: Request) => {
  assertDevRoute(req);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new BadRequestError("content-type must be application/json");
  const parsed = SaveFixtureInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500));
  const engine = createEngine({ transcriber: "script", extractor: "fuzzy", log: () => {} });
  try {
    const saved = await saveLiveFixture(engine, parsed.data);
    return Response.json({ ...saved, dir: saved.dir.slice(engine.cfg.repoRoot.length + 1) });
  } catch (e) {
    throw new BadRequestError((e as Error).message.slice(0, 300));
  }
});
