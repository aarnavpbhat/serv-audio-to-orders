/**
 * Transcript -> conversations (one per car). Rules decide most boundaries; an
 * optional LLM yes/no judge breaks ties for gaps that score in between.
 */
import type { BoundaryDecision, Segment, Segmentation, Transcript, Utterance } from "../schemas";
import { CREW_CHATTER_CUES, END_CUES, RESTART_CUES, START_CUES, matchesAny } from "./cues";

export interface SegmentConfig {
  gapS: number;
  maxSegmentS: number;
  highThreshold: number;
  lowThreshold: number;
  lowAudioQualityMeanConf: number;
}

/** "Does a new customer start here?" asked with three utterances either side. */
export interface BoundaryJudge {
  isNewCustomer(before: Utterance[], after: Utterance[]): Promise<boolean>;
}

const EDGE_TOLERANCE_S = 2;

const isEnd = (u: Utterance | undefined) => !!u && u.speaker === "crew" && matchesAny(u.text, END_CUES);
const isStart = (u: Utterance | undefined) => !!u && u.speaker === "crew" && matchesAny(u.text, START_CUES);
export const isChatter = (u: Utterance) => u.speaker === "crew" && matchesAny(u.text, CREW_CHATTER_CUES);

/** Score the gap after utterance i. 1 = certainly a new car, 0 = certainly the same one. */
export function scoreGap(utts: Utterance[], i: number, cfg: SegmentConfig): { score: number; signals: string[] } {
  const a = utts[i];
  const b = utts[i + 1];
  if (!a || !b) return { score: 0, signals: [] };
  const signals: string[] = [];
  let score = 0;

  // End cue in the last utterance, or the one before it followed by a short customer reply ("thanks").
  const prev = utts[i - 1];
  if (isEnd(a)) {
    score += 0.4;
    signals.push("end_cue");
  } else if (isEnd(prev) && a.speaker === "customer" && a.text.split(/\s+/).length <= 4) {
    score += 0.3;
    signals.push("end_cue_prev");
  }
  if (isStart(b)) {
    score += 0.45;
    signals.push("start_cue");
  }
  const gap = b.start_s - a.end_s;
  if (gap >= cfg.gapS * 2) {
    score += 0.45;
    signals.push(`silence_${gap.toFixed(1)}s`);
  } else if (gap >= cfg.gapS) {
    score += 0.35;
    signals.push(`silence_${gap.toFixed(1)}s`);
  } else if (gap >= 1.5) {
    score += (0.25 * (gap - 1.5)) / (cfg.gapS - 1.5);
  } else {
    score -= 0.15;
  }
  if (matchesAny(b.text, RESTART_CUES) || matchesAny(a.text, RESTART_CUES)) {
    score -= 0.5;
    signals.push("restart_cue");
  }
  return { score: Math.max(0, Math.min(1, Math.round(score * 100) / 100)), signals };
}

function decide(score: number, cfg: SegmentConfig): "boundary" | "same" | "ask" {
  if (score >= cfg.highThreshold) return "boundary";
  if (score < cfg.lowThreshold) return "same";
  return "ask";
}

function majority(values: (string | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
}

function describe(
  utts: Utterance[],
  index: number,
  isFirst: boolean,
  isLast: boolean,
  nextStart: number,
  duration: number,
): Segment {
  const first = utts[0] as Utterance;
  const last = utts[utts.length - 1] as Utterance;
  const nonCustomer = utts.filter(isChatter);
  const talk = utts.filter((u) => !isChatter(u));
  const greeting = talk.slice(0, 3).find(isStart);
  const closings = talk.filter(isEnd);
  const closing = closings[closings.length - 1];
  const startS = greeting?.start_s ?? talk.find((u) => u.speaker === "customer")?.start_s ?? first.start_s;
  const endS = closing?.end_s ?? last.end_s;

  const words = utts.flatMap((u) => u.words);
  const meanConf = words.length ? words.reduce((s, w) => s + w.conf, 0) / words.length : 1;
  const customer = talk.filter((u) => u.speaker === "customer");
  const nonEn = customer.filter((u) => u.language && !u.language.startsWith("en")).length;
  let overlap = 0;
  for (let i = 1; i < utts.length; i++) {
    const p = utts[i - 1] as Utterance;
    const c = utts[i] as Utterance;
    if (c.speaker !== p.speaker) overlap = Math.max(overlap, Math.min(p.end_s, c.end_s) - c.start_s);
  }

  return {
    segment_id: `seg_${index + 1}`,
    index,
    start_s: startS,
    end_s: endS,
    utterance_ids: utts.map((u) => u.id),
    non_customer_ids: nonCustomer.map((u) => u.id),
    has_greeting: !!greeting,
    has_closing: !!closing,
    truncated_start: isFirst && !greeting && first.start_s < EDGE_TOLERANCE_S,
    truncated_end: isLast && !closing && duration - last.end_s < EDGE_TOLERANCE_S,
    trailing_silence_s: Math.round((nextStart - last.end_s) * 1000) / 1000,
    language: majority(utts.map((u) => u.language)),
    non_english: customer.length > 0 && nonEn / customer.length >= 0.3,
    mean_word_conf: Math.round(meanConf * 1000) / 1000,
    crosstalk_suspected: overlap > 0.5,
  };
}

export async function segmentTranscript(
  transcript: Transcript,
  cfg: SegmentConfig,
  judge: BoundaryJudge | null,
): Promise<Segmentation> {
  const utts = [...transcript.utterances].sort((a, b) => a.start_s - b.start_s);
  const duration = transcript.audio.duration_s;
  const boundaries: BoundaryDecision[] = [];
  let llmCalls = 0;

  for (let i = 0; i < utts.length - 1; i++) {
    const { score, signals } = scoreGap(utts, i, cfg);
    const d = decide(score, cfg);
    if (d === "ask" && judge) {
      llmCalls++;
      const yes = await judge.isNewCustomer(utts.slice(Math.max(0, i - 2), i + 1), utts.slice(i + 1, i + 4));
      boundaries.push({ after_index: i, score, signals, decided_by: "llm", is_boundary: yes });
    } else {
      boundaries.push({ after_index: i, score, signals, decided_by: "rules", is_boundary: d === "boundary" || (d === "ask" && score >= 0.5) });
    }
  }

  // Hard cap: no conversation longer than maxSegmentS; split at the best gap inside it.
  const cuts = () => boundaries.filter((b) => b.is_boundary).map((b) => b.after_index);
  for (let guard = 0; guard < 50; guard++) {
    const edges = [-1, ...cuts(), utts.length - 1];
    let changed = false;
    for (let k = 0; k < edges.length - 1; k++) {
      const from = (edges[k] ?? -1) + 1;
      const to = edges[k + 1] ?? utts.length - 1;
      const a = utts[from];
      const b = utts[to];
      if (!a || !b || b.end_s - a.start_s <= cfg.maxSegmentS) continue;
      const inside = boundaries.filter((x) => x.after_index >= from && x.after_index < to && !x.is_boundary);
      const best = inside.sort((x, y) => y.score - x.score)[0];
      if (best) {
        best.is_boundary = true;
        best.decided_by = "cap";
        changed = true;
      }
    }
    if (!changed) break;
  }

  const edges = [-1, ...cuts(), utts.length - 1];
  const segments: Segment[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const chunk = utts.slice((edges[k] ?? -1) + 1, (edges[k + 1] ?? 0) + 1);
    if (!chunk.length) continue;
    const next = utts[(edges[k + 1] ?? 0) + 1];
    segments.push(describe(chunk, segments.length, k === 0, k === edges.length - 2, next?.start_s ?? duration, duration));
  }
  // A segment of only crew chatter or a lone crew line is noise, not a car: merge it into its neighbour.
  return { segments: mergeEmpty(segments, utts, duration), boundaries, llm_calls: llmCalls };
}

function mergeEmpty(segments: Segment[], utts: Utterance[], duration: number): Segment[] {
  const byId = new Map(utts.map((u) => [u.id, u]));
  const out: Segment[] = [];
  for (const s of segments) {
    const hasCustomer = s.utterance_ids.some((id) => byId.get(id)?.speaker === "customer");
    const prev = out[out.length - 1];
    if (!hasCustomer && prev) {
      const merged = [...prev.utterance_ids, ...s.utterance_ids].map((id) => byId.get(id) as Utterance);
      const after = utts[utts.indexOf(merged[merged.length - 1] as Utterance) + 1];
      out[out.length - 1] = describe(merged, prev.index, prev.index === 0, s === segments[segments.length - 1], after?.start_s ?? duration, duration);
      continue;
    }
    out.push(s);
  }
  return out.map((s, i) => ({ ...s, index: i, segment_id: `seg_${i + 1}` }));
}
