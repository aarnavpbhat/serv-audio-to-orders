import { z } from "zod";

export const BoundaryDecision = z.object({
  /** Boundary sits between utterance index `after_index` and `after_index + 1`. */
  after_index: z.number().int(),
  score: z.number(),
  signals: z.array(z.string()),
  decided_by: z.enum(["rules", "llm", "cap"]),
  is_boundary: z.boolean(),
});
export type BoundaryDecision = z.infer<typeof BoundaryDecision>;

export const Segment = z.object({
  segment_id: z.string(),
  index: z.number().int(),
  start_s: z.number(),
  end_s: z.number(),
  utterance_ids: z.array(z.string()),
  /** Crew-to-crew chatter, excluded from extraction. */
  non_customer_ids: z.array(z.string()),
  has_greeting: z.boolean(),
  has_closing: z.boolean(),
  truncated_start: z.boolean(),
  truncated_end: z.boolean(),
  /** Silence after the last utterance (to the next segment or end of file). */
  trailing_silence_s: z.number(),
  language: z.string().nullable(),
  non_english: z.boolean(),
  mean_word_conf: z.number(),
  crosstalk_suspected: z.boolean(),
});
export type Segment = z.infer<typeof Segment>;

export const Segmentation = z.object({
  segments: z.array(Segment),
  boundaries: z.array(BoundaryDecision),
  llm_calls: z.number().int(),
});
export type Segmentation = z.infer<typeof Segmentation>;
