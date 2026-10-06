/** Several sources as one stream in time order (two lanes at once, in replays and checks). */
import { messageTime, type AudioSource, type SourceMessage } from "./types";
import { CANONICAL_RATE } from "./types";

/** Recording time of a message, so frames from different sources interleave the way they would live. */
function timeOf(m: SourceMessage, anchors: Map<string, number>): number {
  if (m.kind === "session_open") anchors.set(m.session.sessionId, Date.parse(m.session.anchorAt));
  if (m.kind === "audio") return (anchors.get(m.frame.sessionId) ?? 0) + (m.frame.sampleOffset * 1000) / CANONICAL_RATE;
  return Date.parse(messageTime(m) ?? "") || 0;
}

export async function* mergeSources(sources: AudioSource[]): AsyncIterable<SourceMessage> {
  const anchors = new Map<string, number>();
  const its = sources.map((s) => s.messages()[Symbol.asyncIterator]());
  const heads = await Promise.all(its.map((it) => it.next()));
  const times = heads.map((h) => (h.done ? Number.POSITIVE_INFINITY : timeOf(h.value, anchors)));
  for (;;) {
    let k = -1;
    for (let i = 0; i < heads.length; i++) if (!heads[i]?.done && (k < 0 || (times[i] ?? 0) < (times[k] ?? 0))) k = i;
    if (k < 0) return;
    const head = heads[k];
    if (!head || head.done) return;
    yield head.value;
    const next = await (its[k] as AsyncIterator<SourceMessage>).next();
    heads[k] = next;
    times[k] = next.done ? Number.POSITIVE_INFINITY : timeOf(next.value, anchors);
  }
}
