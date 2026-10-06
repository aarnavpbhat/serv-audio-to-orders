import type { Catalog } from "../menu/catalog";
import type { OrderEvent, Segment, Utterance } from "../schemas";

export interface ExtractInput {
  segment: Segment;
  /** Segment utterances with crew-to-crew chatter removed. */
  utterances: Utterance[];
  catalog: Catalog;
  /** Path of the audio being processed (used by the fixture oracle). */
  audioFile?: string;
}

export interface LlmUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_calls: number;
  model: string;
}

/** One Gemini request and its answer, kept in the data store (llm/.../order=<id>/<request_hash>.json). */
export interface LlmCallRecord {
  request_hash: string;
  site: string;
  model: string;
  prompt_version: string;
  /** sha256 of the system prompt (the prompt itself is versioned in code). */
  system_sha256: string;
  contents: { role: "user" | "model"; text: string }[];
  response_text: string;
  usage: LlmUsage;
  cached: boolean;
  at: string;
}

export interface ExtractResult {
  events: OrderEvent[];
  usage: LlmUsage;
  warnings: string[];
  /** The model's JSON (before validation), for the UI and debugging. */
  raw: unknown;
  repaired: boolean;
  /** True when the LLM output was unusable and the fuzzy extractor was used. */
  fallback: boolean;
  /** Language the model heard the customer use (ISO code), when it says. */
  customer_language?: string | null;
  /** Every LLM request made for this extraction (empty for the fuzzy and oracle extractors). */
  calls?: LlmCallRecord[];
}

/** Turns one conversation into order events. Implementations: gemini, fuzzy. */
export interface Extractor {
  readonly name: string;
  extract(input: ExtractInput): Promise<ExtractResult>;
}

export const emptyUsage = (model: string): LlmUsage => ({ calls: 0, input_tokens: 0, output_tokens: 0, cached_calls: 0, model });

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    calls: a.calls + b.calls,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_calls: a.cached_calls + b.cached_calls,
    model: b.model || a.model,
  };
}
