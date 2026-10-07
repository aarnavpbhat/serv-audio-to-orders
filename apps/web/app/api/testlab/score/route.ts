/**
 * POST /api/testlab/score: score a finished Test Lab run against its scenario
 * (or the tester's answer in free play), with attribution, and keep the result
 * for the history. Dev routes and localhost only, like the simulator.
 */
import { freePlayExpected, ScoreRequestBody } from "@serv/pipeline";
import { assertDevRoute } from "@/lib/dev-routes";
import { BadRequestError, wrapAsync } from "@/lib/error-handler";
import { scoreTestRun } from "@/lib/testlab";

export const POST = wrapAsync(async (req: Request) => {
  assertDevRoute(req);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new BadRequestError("content-type must be application/json");
  const parsed = ScoreRequestBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500));
  const { expected, scenarioId, ...run } = parsed.data;
  try {
    return Response.json(await scoreTestRun({ ...run, ...(scenarioId ? { scenarioId } : {}), ...(expected ? { expected: freePlayExpected(expected) } : {}) }));
  } catch (e) {
    throw new BadRequestError((e as Error).message.slice(0, 300));
  }
});
