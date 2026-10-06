import { getConfig } from "@serv/config";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ReviewList } from "@/components/review/ReviewList";
import { menuJson, ordersNeedingReview } from "@/lib/data";
import { isLocalHeaders } from "@/lib/dev-routes";

export const dynamic = "force-dynamic";

/** Dev only: resolve orders that need review; each save sends the next version as order.updated. */
export default async function ReviewPage() {
  if (!getConfig().enableDevRoutes || !isLocalHeaders(await headers())) notFound();
  return <ReviewList orders={ordersNeedingReview()} menu={menuJson()} />;
}
