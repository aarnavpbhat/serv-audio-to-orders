import path from "node:path";
import { getConfig } from "@serv/config";
import type { Engine } from "./engine";
import { OracleExtractor } from "./extract/oracle";
import { openDb } from "./store/db";
import { ScriptTranscriber } from "./transcribe/script";
import { Deliverer } from "./webhook/deliver";
import { loadCatalog } from "./menu/load";
import { FuzzyMatcher } from "./menu/fuzzy";
import { sequentialIds } from "./lib/ids";
import { emptySignals, type CueUtterance, type OutcomeSignals } from "./postprocess/outcome";
import type { PostprocessOptions, SegmentContext } from "./postprocess/postprocess";
import { OrderEvent, type OrderEventInput } from "./schemas";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const catalog = loadCatalog(path.join(repoRoot, "menu/menu.json"));
export const matcher = new FuzzyMatcher(catalog);

export function events(list: OrderEventInput[]): OrderEvent[] {
  return list.map((e) => OrderEvent.parse(e));
}

export function ppOptions(overrides: Partial<PostprocessOptions> = {}): PostprocessOptions {
  return {
    catalog,
    matcher,
    thresholds: { recognition: 0.75, commitment: 0.75 },
    taxRate: 0,
    totalTolerance: 0.05,
    placeholders: false,
    reviewCap: { maxQuantity: 10, maxTotal: 150 },
    newOrderId: sequentialIds("ord"),
    newGroupId: sequentialIds("grp"),
    ...overrides,
  };
}

const BASE_MS = Date.parse("2026-10-03T18:40:00Z");

/** Utterance shape the outcome rules read; times are seconds from a fixed test base. */
export function cueUtt(id: string, speaker: "crew" | "customer", text: string, start_s: number): CueUtterance {
  return { id, speaker, text, start_s, start_utc: new Date(BASE_MS + start_s * 1000).toISOString() };
}

export const atS = (s: number) => new Date(BASE_MS + s * 1000).toISOString();

/** Signals with a crew closing cue at the end, so a plain order reads as completed. */
export function closingSignals(extra: Partial<OutcomeSignals> = {}): OutcomeSignals {
  return { ...emptySignals(), utterances: [cueUtt("u99", "crew", "Please pull forward.", 59)], ...extra };
}

export function seg(overrides: Partial<SegmentContext> = {}): SegmentContext {
  return {
    segment_id: "seg_1",
    start_s: 0,
    end_s: 60,
    utterance_ids: [],
    has_closing: true,
    truncated_start: false,
    truncated_end: false,
    non_english: false,
    low_audio_quality: false,
    crosstalk_suspected: false,
    signals: closingSignals(),
    ...overrides,
  };
}

/** A free, offline engine: oracle extractor, no LLM judge, in-memory store, delivery to nowhere. */
export function testEngine(): Engine {
  const cfg = getConfig();
  const db = openDb(":memory:");
  return {
    cfg,
    catalog,
    matcher,
    db,
    transcriber: new ScriptTranscriber(),
    extractor: new OracleExtractor(path.join(repoRoot, "fixtures")),
    judge: null,
    gemini: null,
    deliverer: new Deliverer(db, { url: "http://127.0.0.1:9/unused", secret: "whsec_dGVzdC1zZWNyZXQtMTIzNDU2Nzg=", timeoutMs: 100, fastScheduleS: [], slowScheduleS: [], userAgent: "test" }),
    placeholders: false,
    log: () => {},
  };
}
