import { z } from "zod";
import { Size } from "./menu";

export const EVENT_TYPES = [
  "ADD",
  "REMOVE",
  "CHANGE_QTY",
  "CHANGE_SIZE",
  "ADD_MODIFIER",
  "REMOVE_MODIFIER",
  "REPLACE",
  "SET_COMBO_SLOT",
  "DUPLICATE_LINE",
  "DECLINE_UPSELL",
  "INQUIRE",
  "OUT_OF_STOCK",
  "SPLIT_ORDER",
  "CANCEL_ORDER",
  "READBACK",
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const Candidate = z.object({ catalog_id: z.string(), score: z.number() });
export type Candidate = z.infer<typeof Candidate>;

export const ReadbackItem = z.object({
  catalog_id: z.string(),
  quantity: z.number().int().positive().nullable().default(null),
  size: Size.nullable().default(null),
});
export type ReadbackItem = z.infer<typeof ReadbackItem>;

/**
 * One thing that happened in the conversation. The LLM proposes these; the
 * builder (pure code) decides what they mean for the order.
 *
 * Lines are referenced by the event_id of the ADD (or DUPLICATE_LINE) that
 * created them, so `target_line_ref: "e1"` means "the line created by e1".
 */
export const OrderEvent = z.object({
  event_id: z.string(),
  type: EventType,
  target_line_ref: z.string().nullable().default(null),
  catalog_id: z.string().nullable().default(null),
  raw_text: z.string().nullable().default(null),
  quantity: z.number().int().positive().nullable().default(null),
  size: Size.nullable().default(null),
  /** Modifier ids (ADD_MODIFIER / REMOVE_MODIFIER / ADD). */
  modifiers: z.array(z.string()).default([]),
  /** Combo slot name for SET_COMBO_SLOT and slot-level REPLACE. */
  slot: z.string().nullable().default(null),
  /** READBACK: what the crew read back. */
  readback_items: z.array(ReadbackItem).nullable().default(null),
  /** READBACK: total spoken by the crew, if any. */
  amount: z.number().nullable().default(null),
  source_utterance_ids: z.array(z.string()).default([]),
  recognition_confidence: z.number().min(0).max(1).default(1),
  commitment_confidence: z.number().min(0).max(1).default(1),
  /** Fuzzy-match candidates when the catalog id is uncertain. */
  candidates: z.array(Candidate).default([]),
  /** Offset of the first source utterance; used to order events. */
  t_s: z.number().nullable().default(null),
});
export type OrderEvent = z.infer<typeof OrderEvent>;
export type OrderEventInput = z.input<typeof OrderEvent>;
