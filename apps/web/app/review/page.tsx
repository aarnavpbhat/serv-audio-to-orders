import { notFound } from "next/navigation";

// The review queue page is disabled for now (2026-10-06): it answers 404 and is not in the
// sidebar. Flagged orders are still sent with review.required and listed on /orders (filter
// "Flagged"), and POST /api/orders/:id/review still resolves one. To bring the page back,
// restore this file's render of components/review/ReviewList and the Sidebar entry and badge
// from git history.
export default function ReviewPage() {
  notFound();
}
