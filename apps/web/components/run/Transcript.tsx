"use client";

import { useEffect, useRef } from "react";
import type { Segment, Transcript as T } from "@serv/pipeline/schemas/index";
import { palette } from "../Artwork";

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/**
 * The transcript as an Apple Music lyrics view: the current line is bright and
 * the rest recede. Like duet lyrics, the customer sings on the left and the crew
 * answers on the right.
 */
export function Transcript({
  seed,
  transcript,
  segments,
  time,
  follow,
  onSeek,
}: {
  seed: string;
  transcript: T;
  segments: Segment[];
  time: number;
  follow: boolean;
  onSeek: (t: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLButtonElement>(null);
  const activeId = transcript.utterances.find((u) => time >= u.start_s && time <= u.end_s + 0.3)?.id;
  useEffect(() => {
    const box = scroller.current;
    const el = active.current;
    if (!follow || !box || !el) return;
    // Scroll only the lyrics panel, keeping the line a third of the way down.
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 3, behavior: "smooth" });
  }, [activeId, follow]);

  const segOf = new Map<string, Segment>();
  for (const s of segments) for (const id of s.utterance_ids) segOf.set(id, s);
  const chatter = new Set(segments.flatMap((s) => s.non_customer_ids));
  const [a, b] = palette(seed);
  const dimOthers = follow && !!activeId;

  return (
    <section className="relative overflow-hidden rounded-xl text-white" style={{ background: `linear-gradient(160deg, ${a}, ${b})` }}>
      <div className="absolute inset-0 bg-black/45" />
      <div className="relative flex items-center justify-between px-5 pb-2 pt-4">
        <h2 className="text-[15px] font-bold">Transcript</h2>
        <span className="text-[11px] text-white/60">
          {transcript.utterances.length} lines · roles from {transcript.role_source} · {transcript.stt}
        </span>
      </div>
      <div ref={scroller} className="no-scrollbar relative max-h-[640px] overflow-y-auto px-3 pb-[40%] pt-2">
        {transcript.utterances.map((u, i) => {
          const seg = segOf.get(u.id);
          const first = seg && seg.utterance_ids[0] === u.id;
          const prev = transcript.utterances[i - 1];
          const gap = prev ? u.start_s - prev.end_s : 0;
          const isActive = u.id === activeId;
          const isChatter = chatter.has(u.id);
          const crew = u.speaker === "crew";
          const past = time > u.end_s;
          const tone = isActive ? "text-white" : dimOthers ? (past ? "text-white/40" : "text-white/30") : isChatter ? "text-white/35" : "text-white/85";
          return (
            <div key={u.id}>
              {first && (
                <div className="mx-2 mb-2 mt-6 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wider text-white/55">
                  {seg.segment_id}
                  <span className="h-px flex-1 bg-white/20" />
                  {fmt(seg.start_s)} to {fmt(seg.end_s)}
                </div>
              )}
              {gap >= 4 && <div className="px-3 py-1 text-center text-[11px] italic text-white/45">{gap.toFixed(1)}s silence</div>}
              <button
                ref={isActive ? active : undefined}
                type="button"
                onClick={() => onSeek(u.start_s)}
                className={`group flex w-full flex-col rounded-lg px-3 py-1.5 transition-all duration-300 hover:bg-white/10 ${crew ? "items-end pl-14 text-right" : "items-start pr-14 text-left"} ${isActive ? "scale-[1.02]" : ""}`}
                style={{ transformOrigin: crew ? "right center" : "left center" }}
              >
                <span className="mb-0.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-white/55">
                  <span className={`h-1.5 w-1.5 rounded-full ${isChatter ? "bg-white/40" : crew ? "bg-[#a5a3ff]" : "bg-[#5ef0dc]"}`} />
                  {isChatter ? "crew chatter" : u.speaker}
                  {u.speaker_guessed && <span title="Role guessed from wording because diarization heard one voice">?</span>}
                  <span className="font-normal normal-case tabular-nums text-white/40 opacity-0 transition group-hover:opacity-100">
                    {fmt(u.start_s)} · {u.id}
                  </span>
                  {u.language && !u.language.startsWith("en") && <span className="rounded bg-white/15 px-1 normal-case">{u.language}</span>}
                </span>
                <span className={`text-[19px] font-bold leading-snug tracking-[-0.01em] transition-colors duration-300 ${tone} ${isChatter ? "line-through decoration-white/40" : ""}`}>
                  {u.words.length
                    ? u.words.map((w, k) => (
                        <span key={k} className={w.low_conf ? "underline decoration-rose-300 decoration-dotted decoration-2 underline-offset-4" : undefined} title={`${w.w} ${w.conf}`}>
                          {w.w}{" "}
                        </span>
                      ))
                    : u.text}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
