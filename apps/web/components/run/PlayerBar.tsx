"use client";

import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { Toggle } from "@/components/ui/Toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
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
        <div className="flex w-40 items-center justify-center gap-2">
          <Transport label="Previous order" onClick={onPrev} disabled={!ready}>
            <BackIcon className="size-[18px]" />
          </Transport>
          <Transport label={playing ? "Pause" : "Play"} onClick={onPlayPause} disabled={!ready} big>
            {playing ? <PauseIcon className="size-6" /> : <PlayIcon className="size-6" />}
          </Transport>
          <Transport label="Next order" onClick={onNext} disabled={!ready}>
            <ForwardIcon className="size-[18px]" />
          </Transport>
        </div>

        <div className="flex h-11 min-w-0 flex-1 items-center overflow-hidden rounded-md bg-lcd ring-1 ring-line">
          <Artwork seed={seed} size="sm" className="!h-11 !w-11 !rounded-none !shadow-none" />
          <div className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center px-12">
            <div className="w-full truncate text-center text-[12.5px] font-medium leading-tight">{title}</div>
            <div className="w-full truncate text-center text-[11.5px] leading-tight text-muted-foreground">{subtitle}</div>
            <span className="absolute bottom-1 left-2 text-[10px] tabular-nums text-muted-foreground">{fmt(time)}</span>
            <span className="absolute bottom-1 right-2 text-[10px] tabular-nums text-muted-foreground">-{fmt(Math.max(0, duration - time))}</span>
            <Slider
              min={0}
              max={duration || 1}
              step={0.05}
              value={[time]}
              disabled={!ready}
              onValueChange={([t]) => t !== undefined && onSeek(t)}
              aria-label="Seek"
              className="absolute inset-x-0 bottom-0 h-[3px] cursor-pointer data-disabled:opacity-100 [&_[data-slot=slider-range]]:bg-muted-foreground [&_[data-slot=slider-thumb]]:size-0 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-track]]:h-[3px] [&_[data-slot=slider-track]]:rounded-none [&_[data-slot=slider-track]]:bg-transparent"
            />
          </div>
        </div>

        <div className="flex w-40 items-center justify-end">
          <Toggle
            size="sm"
            pressed={replay}
            onPressedChange={onReplay}
            title="Replay order events with the audio"
            className="gap-1.5 text-[12px] text-muted-foreground data-[state=on]:bg-brand-soft data-[state=on]:text-brand"
          >
            <LyricsIcon className="size-4" />
            Live replay
          </Toggle>
        </div>
      </div>
    </div>
  );
}

function Transport({ label, onClick, disabled, big, children }: { label: string; onClick: () => void; disabled: boolean; big?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size={big ? "icon-lg" : "icon"} onClick={onClick} disabled={disabled} aria-label={label} className="rounded-full text-foreground hover:bg-transparent hover:opacity-70 [&_svg:not([class*='size-'])]:size-auto">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
