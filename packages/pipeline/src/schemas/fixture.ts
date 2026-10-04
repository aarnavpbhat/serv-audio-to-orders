import { z } from "zod";
import { OrderEvent } from "./events";
import { Size } from "./menu";
import { Flag, NotOrderedReason, OrderStatus } from "./order";

export const NoiseLevel = z.enum(["clean", "moderate", "heavy"]);
export type NoiseLevel = z.infer<typeof NoiseLevel>;

export const Turn = z.object({
  speaker: z.enum(["crew", "customer", "crew2"]),
  text: z.string(),
  pause_after_s: z.number().default(0.5),
  /** Spoken language of this turn, for voice selection. */
  lang: z.string().optional(),
});
export type Turn = z.infer<typeof Turn>;

export const ExpectedItem = z.object({
  catalog_id: z.string(),
  quantity: z.number().int().positive().default(1),
  size: Size.nullable().optional(),
  modifiers: z.array(z.string()).optional(),
  components: z.array(z.object({ slot: z.string(), catalog_id: z.string().nullable() })).optional(),
});
export type ExpectedItem = z.infer<typeof ExpectedItem>;

export const ExpectedOrder = z.object({
  items: z.array(ExpectedItem).default([]),
  needs_review: z
    .array(z.object({ quantity: z.number().int().positive().default(1), candidates_include: z.array(z.string()).default([]) }))
    .default([]),
  not_ordered: z.array(z.object({ catalog_id: z.string().nullable(), reason: NotOrderedReason })).default([]),
  /** Flags that must be present (placeholder_values is ignored by the eval). */
  flags: z.array(Flag).default([]),
  status: OrderStatus,
  /** Orders with the same non-null label must share a group_id. */
  group: z.string().nullable().default(null),
  customer_declined_combo: z.boolean().optional(),
});
export type ExpectedOrder = z.infer<typeof ExpectedOrder>;

export const FixtureScript = z.object({
  id: z.string(),
  title: z.string(),
  /** Edge case checklist rows this script covers. */
  covers: z.array(z.number().int()),
  language: z.string().default("en"),
  render: z
    .object({
      noise: NoiseLevel.default("clean"),
      lead_silence_s: z.number().default(1),
      tail_silence_s: z.number().default(3),
      /** Cut this many seconds off the start or end to simulate truncated audio. */
      trim_start_s: z.number().default(0),
      trim_end_s: z.number().default(0),
    })
    .default({ noise: "clean", lead_silence_s: 1, tail_silence_s: 3, trim_start_s: 0, trim_end_s: 0 }),
  turns: z.array(Turn),
  /**
   * Hand-written events for the builder unit tests (step 2). Utterance ids are
   * u1..uN in turn order. Multi-order scripts list events per order.
   */
  events: z.array(z.array(OrderEvent)).default([]),
  expected: z.object({ orders: z.array(ExpectedOrder) }),
});
export type FixtureScript = z.infer<typeof FixtureScript>;
export type FixtureScriptInput = z.input<typeof FixtureScript>;

/** Written next to each generated audio file: where every turn landed in time. */
export const FixtureTimeline = z.object({
  fixture_ids: z.array(z.string()),
  file: z.string(),
  layout: z.enum(["stereo", "mono"]),
  noise: NoiseLevel,
  duration_s: z.number(),
  utterances: z.array(
    z.object({
      id: z.string(),
      fixture_id: z.string(),
      turn_index: z.number().int(),
      speaker: z.enum(["crew", "customer"]),
      crew_chatter: z.boolean(),
      text: z.string(),
      language: z.string().optional(),
      start_s: z.number(),
      end_s: z.number(),
    }),
  ),
  /** Expected order spans in file time, in order. */
  orders: z.array(z.object({ fixture_id: z.string(), order_index: z.number().int(), start_s: z.number(), end_s: z.number() })),
});
export type FixtureTimeline = z.infer<typeof FixtureTimeline>;
