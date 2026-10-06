/**
 * Corrections keep the order_id and raise order_version (plan D3). Triggers: a
 * reopened conversation, late evidence that changes the outcome, or a person
 * resolving a review. Pure: the caller stores the version and enqueues it.
 */
import { OrderPayload, type CorrectionReason } from "../schemas";

export type CorrectionPatch = Partial<
  Pick<OrderPayload, "status" | "outcome_evidence" | "review" | "items" | "needs_review" | "not_ordered" | "combo_opportunities" | "flags" | "totals" | "overall_confidence" | "transcript">
>;

/** The next version of `prev` with `patch` applied. Times other than finalized_at stay as first recorded. */
export function correctedPayload(prev: OrderPayload, patch: CorrectionPatch, reason: CorrectionReason, finalizedAt: string): OrderPayload {
  const version = prev.order_version + 1;
  return OrderPayload.parse({
    ...prev,
    ...patch,
    event_type: "order.updated",
    order_version: version,
    supersedes_version: prev.order_version,
    correction_reason: reason,
    times: { ...prev.times, finalized_at: finalizedAt },
    // The archived audio belongs to the version it was written for.
    audio_ref: { ...prev.audio_ref, archive_uri: null },
  });
}
