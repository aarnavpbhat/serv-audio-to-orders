"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Card } from "@/components/ui/Card";

export interface WaveformHandle {
  seek: (t: number) => void;
  playPause: () => void;
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

/** Canvas can't read CSS variables, so resolve the theme tokens once at mount. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function Waveform({
  url,
  segments,
  utterances,
  time,
  onTime,
  onPlayState,
  onReady,
  ref,
}: {
  url: string;
  segments: WaveSegment[];
  utterances: LaneUtterance[];
  time: number;
  onTime: (t: number) => void;
  onPlayState: (playing: boolean) => void;
  onReady: (duration: number) => void;
  ref?: Ref<WaveformHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const regions = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    seek: (t: number) => {
      const w = ws.current;
      if (w && w.getDuration() > 0) w.setTime(Math.max(0, Math.min(t, w.getDuration())));
    },
    playPause: () => void ws.current?.playPause(),
  }));

  useEffect(() => {
    if (!container.current) return;
    const plugin = RegionsPlugin.create();
    const w = WaveSurfer.create({
      container: container.current,
      url,
      height: 72,
      waveColor: token("--c-faint", "gray"),
      progressColor: token("--c-accent", "gray"),
      cursorColor: token("--c-accent", "gray"),
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1.5,
      barRadius: 2,
      normalize: true,
      plugins: [plugin],
    });
    ws.current = w;
    regions.current = plugin;
    w.on("ready", (d) => {
      setDuration(d);
      onReady(d);
    });
    w.on("timeupdate", onTime);
    w.on("play", () => onPlayState(true));
    w.on("pause", () => onPlayState(false));
    w.on("finish", () => onPlayState(false));
    w.on("error", (e) => setError(String(e)));
    return () => w.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    const plugin = regions.current;
    if (!plugin || !duration) return;
    plugin.clearRegions();
    segments.forEach((s, i) => {
      plugin.addRegion({ id: s.id, start: s.start, end: s.end, color: i % 2 ? "rgba(120,120,128,0.10)" : "rgba(120,120,128,0.16)", drag: false, resize: false, content: s.label });
    });
  }, [segments, duration]);

  const total = duration || Math.max(1, ...utterances.map((u) => u.end));

  return (
    <Card className="gap-0 p-4">
      <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="label text-[10px]">Waveform · orders shaded</span>
        <div className="flex items-center gap-3">
          <Legend className="bg-customer" label="customer" />
          <Legend className="bg-crew" label="crew" />
          <Legend className="bg-faint" label="crew chatter" />
        </div>
      </div>
      {error && <p className="mb-2 text-[13px] text-destructive">Audio failed to load: {error}</p>}
      <div ref={container} />
      {/* Speaker lane: who is talking when, aligned with the waveform. */}
      <div
        className="relative mt-2 h-4 cursor-pointer rounded bg-fill"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          ws.current?.setTime(((e.clientX - r.left) / r.width) * total);
        }}
      >
        {utterances.map((u) => (
          <div
            key={u.id}
            title={`${u.id} ${u.speaker}`}
            className={`absolute top-0.5 h-3 rounded-sm ${u.nonCustomer ? "bg-faint" : u.speaker === "crew" ? "bg-crew" : "bg-customer"}`}
            style={{ left: `${(u.start / total) * 100}%`, width: `${Math.max(0.3, ((u.end - u.start) / total) * 100)}%` }}
          />
        ))}
        <div className="pointer-events-none absolute -top-0.5 h-5 w-px bg-brand" style={{ left: `${(time / total) * 100}%` }} />
      </div>
    </Card>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  );
}
