"use client";

import { Artwork } from "../Artwork";
import { BackIcon, ForwardIcon, LyricsIcon, PauseIcon, PlayIcon } from "../Icons";

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * The toolbar "LCD" from Apple Music: transport on the left, what is playing in
 * the middle, and the lyrics-style toggle on the right (here: replay the order
 * events in step with the audio).
 */
export function PlayerBar({
  seed,
  title,
  subtitle,
  time,
  duration,
  playing,
  replay,
  onPlayPause,
  onPrev,
  onNext,
  onSeek,
  onReplay,
}: {
  seed: string;
  title: string;
  subtitle: string;
  time: number;
  duration: number;
  playing: boolean;
  replay: boolean;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (t: number) => void;
  onReplay: (on: boolean) => void;
}) {
  const ready = duration > 0;
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-toolbar backdrop-blur-2xl backdrop-saturate-150">
      <div className="flex h-[60px] items-center gap-6 px-6">
        <div className="flex w-40 items-center justify-center gap-5 text-ink">
          <button type="button" onClick={onPrev} disabled={!ready} title="Previous order" className="opacity-80 hover:opacity-100 disabled:opacity-30">
            <BackIcon className="h-[18px] w-[18px]" />
          </button>
          <button type="button" onClick={onPlayPause} disabled={!ready} title={playing ? "Pause" : "Play"} className="hover:opacity-80 disabled:opacity-30">
            {playing ? <PauseIcon className="h-6 w-6" /> : <PlayIcon className="h-6 w-6" />}
          </button>
          <button type="button" onClick={onNext} disabled={!ready} title="Next order" className="opacity-80 hover:opacity-100 disabled:opacity-30">
            <ForwardIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex h-11 min-w-0 flex-1 items-center overflow-hidden rounded-md bg-lcd ring-1 ring-line">
          <Artwork seed={seed} size="sm" className="!h-11 !w-11 !rounded-none !shadow-none" />
          <div className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center px-12">
            <div className="w-full truncate text-center text-[12.5px] font-medium leading-tight">{title}</div>
            <div className="w-full truncate text-center text-[11.5px] leading-tight text-muted">{subtitle}</div>
            <span className="absolute bottom-1 left-2 text-[10px] tabular-nums text-muted">{fmt(time)}</span>
            <span className="absolute bottom-1 right-2 text-[10px] tabular-nums text-muted">-{fmt(Math.max(0, duration - time))}</span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.05}
              value={time}
              disabled={!ready}
              onChange={(e) => onSeek(Number(e.target.value))}
              aria-label="Seek"
              className="absolute inset-x-0 bottom-0 h-[3px] w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-thumb]:h-[3px] [&::-webkit-slider-thumb]:w-0 [&::-webkit-slider-thumb]:appearance-none"
              style={{ background: `linear-gradient(to right, var(--c-muted) ${(time / (duration || 1)) * 100}%, transparent 0)` }}
            />
          </div>
        </div>

        <div className="flex w-40 items-center justify-end">
          <button
            type="button"
            onClick={() => onReplay(!replay)}
            title="Replay order events with the audio"
            aria-pressed={replay}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition ${replay ? "bg-accent-soft text-accent" : "text-muted hover:bg-fill hover:text-ink"}`}
          >
            <LyricsIcon className="h-4 w-4" />
            Live replay
          </button>
        </div>
      </div>
    </div>
  );
}
