"use client";

import { useEffect, useRef } from "react";
import type { Segment, Transcript as T } from "@serv/pipeline/schemas/index";

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

export function Transcript({
  transcript,
  segments,
  time,
  follow,
  onSeek,
}: {
  transcript: T;
  segments: Segment[];
  time: number;
  follow: boolean;
  onSeek: (t: number) => void;
}) {
  const active = useRef<HTMLButtonElement>(null);
  const activeId = transcript.utterances.find((u) => time >= u.start_s && time <= u.end_s + 0.3)?.id;
  useEffect(() => {
    if (follow) active.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId, follow]);

  const segOf = new Map<string, Segment>();
  for (const s of segments) for (const id of s.utterance_ids) segOf.set(id, s);
  const chatter = new Set(segments.flatMap((s) => s.non_customer_ids));

  return (
    <div className="card flex max-h-[640px] flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="font-semibold">Transcript</h2>
        <span className="text-xs text-muted">
          {transcript.utterances.length} utterances · roles from {transcript.role_source} · {transcript.stt}
        </span>
      </div>
      <div className="overflow-y-auto p-2">
        {transcript.utterances.map((u, i) => {
          const seg = segOf.get(u.id);
          const first = seg && seg.utterance_ids[0] === u.id;
          const prev = transcript.utterances[i - 1];
          const gap = prev ? u.start_s - prev.end_s : 0;
          const isActive = u.id === activeId;
          return (
            <div key={u.id}>
              {first && (
                <div className="mx-2 mb-1 mt-3 flex items-center gap-2 text-xs font-semibold text-muted">
                  <span className="h-px flex-1 bg-line" />
                  {seg.segment_id} · {fmt(seg.start_s)} to {fmt(seg.end_s)}
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              {gap >= 4 && <div className="px-3 py-0.5 text-[11px] italic text-muted">{gap.toFixed(1)}s silence</div>}
              <button
                ref={isActive ? active : undefined}
                type="button"
                onClick={() => onSeek(u.start_s)}
                className={`flex w-full gap-3 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${isActive ? "bg-yellow-50 ring-1 ring-yellow-300" : "hover:bg-slate-50"}`}
              >
                <span className="w-12 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-muted">{fmt(u.start_s)}</span>
                <span className={`w-16 shrink-0 pt-0.5 text-[11px] font-semibold uppercase ${chatter.has(u.id) ? "text-slate-400" : u.speaker === "crew" ? "text-crew" : "text-customer"}`}>
                  {u.speaker}
                </span>
                <span className={`flex-1 ${chatter.has(u.id) ? "text-slate-400 line-through decoration-slate-300" : ""}`}>
                  {u.words.length
                    ? u.words.map((w, k) => (
                        <span key={k} className={w.low_conf ? "underline decoration-rose-400 decoration-dotted underline-offset-2" : undefined} title={`${w.w} ${w.conf}`}>
                          {w.w}{" "}
                        </span>
                      ))
                    : u.text}
                  {chatter.has(u.id) && <span className="ml-2 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 no-underline">non_customer</span>}
                  {u.language && !u.language.startsWith("en") && <span className="ml-2 rounded bg-sky-50 px-1 text-[10px] font-medium text-sky-700">{u.language}</span>}
                </span>
                <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] text-muted">{u.id}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
