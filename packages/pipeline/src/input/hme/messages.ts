/**
 * PLACEHOLDER: HME's message format is not documented. This parser maps the
 * text messages we expect (JSON with a "type") to control events, passes
 * anything else through as type "unknown" with the original kept, and never throws.
 *
 *   {"type": "vehicle_arrived" | "vehicle_departed" | "stream_paused" | "stream_resumed"
 *            | "crew_takeover" | "heartbeat", "at"?: ISO time from the base station}
 *   {"type": "utterance", "speaker": "crew"|"customer", "text": "..."}   dev simulator only
 */
import type { ControlEventType } from "../types";

const KNOWN: readonly ControlEventType[] = ["vehicle_arrived", "vehicle_departed", "stream_paused", "stream_resumed", "crew_takeover", "heartbeat"];

export type ParsedText =
  | { kind: "control"; type: ControlEventType; sourceAt: string | null; raw: unknown }
  | { kind: "line"; speaker: "crew" | "customer"; text: string; raw: unknown };

export function parseHmeText(text: string): ParsedText {
  let raw: unknown = text;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "control", type: "unknown", sourceAt: null, raw: text.slice(0, 2000) };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "control", type: "unknown", sourceAt: null, raw };
  const o = raw as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  if (type === "utterance" && (o.speaker === "crew" || o.speaker === "customer") && typeof o.text === "string" && o.text.trim()) {
    return { kind: "line", speaker: o.speaker, text: o.text.trim().slice(0, 500), raw };
  }
  const at = typeof o.at === "string" && !Number.isNaN(Date.parse(o.at)) ? new Date(Date.parse(o.at)).toISOString() : null;
  if ((KNOWN as readonly string[]).includes(type)) return { kind: "control", type: type as ControlEventType, sourceAt: at, raw };
  return { kind: "control", type: "unknown", sourceAt: at, raw };
}
