"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";

export interface WaveformHandle {
  seek: (t: number) => void;
  play: () => void;
}

export interface WaveSegment {
  id: string;
  start: number;
  end: number;
  label: string;
}

export interface LaneUtterance {
  id: string;
  start: number;
  end: number;
  speaker: "crew" | "customer";
  nonCustomer: boolean;
}

const SEG_COLORS = ["rgba(79,70,229,0.10)", "rgba(15,118,110,0.10)", "rgba(217,119,6,0.10)", "rgba(190,24,93,0.10)"];

export function Waveform({
  url,
  segments,
  utterances,
  onTime,
  onPlay,
  ref,
}: {
  url: string;
  segments: WaveSegment[];
  utterances: LaneUtterance[];
  onTime: (t: number) => void;
  onPlay: () => void;
  ref?: Ref<WaveformHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const regions = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    seek: (t: number) => {
      const w = ws.current;
      if (w && w.getDuration() > 0) w.setTime(Math.max(0, Math.min(t, w.getDuration())));
    },
    play: () => void ws.current?.play(),
  }));

  useEffect(() => {
    if (!container.current) return;
    const plugin = RegionsPlugin.create();
    const w = WaveSurfer.create({
      container: container.current,
      url,
      height: 88,
      waveColor: "#cbd5e1",
      progressColor: "#0f172a",
      cursorColor: "#e11d48",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [plugin],
    });
    ws.current = w;
    regions.current = plugin;
    w.on("ready", (d) => setDuration(d));
    w.on("timeupdate", (t) => {
      setTime(t);
      onTime(t);
    });
    w.on("play", () => {
      setPlaying(true);
      onPlay();
    });
    w.on("pause", () => setPlaying(false));
    w.on("error", (e) => setError(String(e)));
    return () => w.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    const plugin = regions.current;
    if (!plugin || !duration) return;
    plugin.clearRegions();
    segments.forEach((s, i) => {
      plugin.addRegion({ id: s.id, start: s.start, end: s.end, color: SEG_COLORS[i % SEG_COLORS.length], drag: false, resize: false, content: s.label });
    });
  }, [segments, duration]);

  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const total = duration || Math.max(1, ...utterances.map((u) => u.end));

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center gap-3">
        <button type="button" onClick={() => void ws.current?.playPause()} className="btn-primary w-20 justify-center" disabled={!duration}>
          {playing ? "Pause" : "Play"}
        </button>
        <span className="font-mono text-sm tabular-nums text-muted">
          {fmt(time)} / {fmt(duration)}
        </span>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-crew" /> crew</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-customer" /> customer</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-slate-300" /> crew chatter</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-indigo-100 ring-1 ring-indigo-200" /> order</span>
        </div>
      </div>
      {error && <p className="mb-2 text-sm text-rose-700">Audio failed to load: {error}</p>}
      <div ref={container} />
      {/* Speaker lane: who is talking when, aligned with the waveform. */}
      <div className="relative mt-2 h-5 cursor-pointer rounded bg-slate-50" onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        ws.current?.setTime(((e.clientX - r.left) / r.width) * total);
      }}>
        {utterances.map((u) => (
          <div
            key={u.id}
            title={`${u.id} ${u.speaker}`}
            className={`absolute top-0.5 h-4 rounded-sm ${u.nonCustomer ? "bg-slate-300" : u.speaker === "crew" ? "bg-crew" : "bg-customer"}`}
            style={{ left: `${(u.start / total) * 100}%`, width: `${Math.max(0.3, ((u.end - u.start) / total) * 100)}%` }}
          />
        ))}
        <div className="pointer-events-none absolute top-0 h-5 w-0.5 bg-rose-600" style={{ left: `${(time / total) * 100}%` }} />
      </div>
    </div>
  );
}
