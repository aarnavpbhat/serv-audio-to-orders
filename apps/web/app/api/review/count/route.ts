/** GET /api/review/count: how many orders wait in the review queue (sidebar badge). Dev routes only, like the queue. */
import { reviewQueueCount } from "@/lib/data";
import { assertDevRoute } from "@/lib/dev-routes";
import { wrapAsync } from "@/lib/error-handler";

export const dynamic = "force-dynamic";

export const GET = wrapAsync(async (req: Request) => {
  assertDevRoute(req);
  return Response.json({ count: reviewQueueCount() });
});
