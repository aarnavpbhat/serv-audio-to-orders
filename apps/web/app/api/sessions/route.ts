/** GET /api/sessions: live sessions an operator can stop (dev routes, local only). */
import { assertDevRoute } from "@/lib/dev-routes";
import { wrapAsync } from "@/lib/error-handler";
import { listFeedSessions } from "@/lib/feed";

export const dynamic = "force-dynamic";

export const GET = wrapAsync(async (req: Request) => {
  assertDevRoute(req);
  return Response.json(await listFeedSessions());
});
