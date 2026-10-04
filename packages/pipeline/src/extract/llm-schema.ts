import { z } from "zod";
import { EventType } from "../schemas/events";
import { Size } from "../schemas/menu";

/**
 * What the LLM must return. Every field is present (nullable instead of
 * optional) so structured output stays simple; validate.ts converts it into
 * OrderEvent after checking ids against the catalog.
 */
export const LlmEvent = z.object({
  event_id: z.string().describe("e1, e2, ... in conversation order"),
  type: EventType,
  target_line_ref: z.string().nullable().describe("event_id of the ADD/DUPLICATE_LINE that created the line this event changes"),
  catalog_id: z.string().nullable().describe("Catalog id from the menu, or null if unsure"),
  raw_text: z.string().nullable().describe("The words the customer used for the item"),
  quantity: z.number().int().nullable(),
  size: Size.nullable().describe("Only if a size was said"),
  modifiers: z.array(z.string()).describe("Modifier ids"),
  slot: z.string().nullable().describe("Combo slot for SET_COMBO_SLOT: side or drink"),
  readback_items: z
    .array(z.object({ catalog_id: z.string(), quantity: z.number().int().nullable(), size: Size.nullable() }))
    .nullable()
    .describe("READBACK only: items as the crew read them back"),
  amount: z.number().nullable().describe("READBACK only: total the crew said, in dollars"),
  source_utterance_ids: z.array(z.string()),
  recognition_confidence: z.number().describe("0-1: sure which menu item was said"),
  commitment_confidence: z.number().describe("0-1: sure the customer committed to it"),
});
export type LlmEvent = z.infer<typeof LlmEvent>;

export const LlmExtraction = z.object({
  events: z.array(LlmEvent),
  customer_language: z.string().nullable().describe("ISO code of the language the customer spoke, e.g. en, es"),
});
export type LlmExtraction = z.infer<typeof LlmExtraction>;

let cached: Record<string, unknown> | null = null;

/** JSON Schema for Gemini structured output, generated from the zod schema. */
export function extractionJsonSchema(): Record<string, unknown> {
  if (!cached) {
    const schema = z.toJSONSchema(LlmExtraction, { target: "draft-7" }) as Record<string, unknown>;
    delete schema.$schema;
    cached = stripSafeIntBounds(schema) as Record<string, unknown>;
  }
  return cached;
}

/** zod marks .int() with +/-MAX_SAFE_INTEGER bounds, which some structured-output validators reject. */
function stripSafeIntBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSafeIntBounds);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if ((k === "minimum" || k === "maximum") && Math.abs(Number(v)) === Number.MAX_SAFE_INTEGER) continue;
      out[k] = stripSafeIntBounds(v);
    }
    return out;
  }
  return node;
}
