"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { replay } from "@serv/pipeline/build/replay";
import { Catalog } from "@serv/pipeline/menu/catalog";
import { FuzzyMatcher } from "@serv/pipeline/menu/fuzzy";
import { emptySignals } from "@serv/pipeline/postprocess/outcome";
import { postprocess } from "@serv/pipeline/postprocess/postprocess";
import type { Segment } from "@serv/pipeline/schemas/index";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import type { OrderView, RunDetail } from "@/lib/data";
import { cn } from "@/lib/utils";
import { Artwork } from "../Artwork";
import { Badge, Placeholder } from "../Badge";
import { CheckIcon, Equalizer, LyricsIcon, PauseIcon, PlayIcon } from "../Icons";
import { JsonView } from "../JsonView";
import { Deliveries } from "./Deliveries";
import { EventLog, OrderCard, type PanelOrder } from "./OrderPanel";
import { PlayerBar } from "./PlayerBar";
import { Transcript } from "./Transcript";
import { Waveform, type WaveformHandle } from "./Waveform";

interface SiteValue {
  value: string;
  placeholder: boolean;
  note: string;
}

const STAGES = ["ingest", "transcribe", "extract", "deliver", "done"] as const;
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export function RunView({
  id,
  initial,
  menu,
  thresholds,
  site,
}: {
  id: string;
  initial: RunDetail;
  menu: unknown;
  thresholds: { recognition: number; commitment: number };
  site: { store: SiteValue; lane: SiteValue; webhook: SiteValue };
}) {
  const [run, setRun] = useState(initial);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sync, setSync] = useState(false);
  const wave = useRef<WaveformHandle>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/runs/${id}`, { cache: "no-store" });
    if (res.ok) setRun((await res.json()) as RunDetail);
  }, [id]);

  const active = run.status === "queued" || run.status === "running" || run.orders.some((o) => o.deliveries.some((d) => d.status === "pending" || d.status === "delivering"));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [active, refresh]);

  const catalog = useMemo(() => Catalog.fromJson(menu), [menu]);
  const matcher = useMemo(() => new FuzzyMatcher(catalog), [catalog]);
  const name = useCallback((cid: string | null) => (cid ? catalog.name(cid) : ""), [catalog]);

  const segments = useMemo(() => run.segmentation?.segments ?? [], [run.segmentation]);
  const ordersBySeg = useMemo(() => {
    const m = new Map<string, OrderView[]>();
    for (const o of run.orders) m.set(o.segment_id, [...(m.get(o.segment_id) ?? []), o]);
    return m;
  }, [run.orders]);

  /** Re-run the pure builder on the events heard so far, so the order fills in as the audio plays. */
  const liveOrders = useCallback(
    (seg: Segment, finals: OrderView[]): PanelOrder[] => {
      const first = finals[0];
      if (!first) return [];
      const events = first.events.filter((e) => e.t_s === null || e.t_s <= time);
      const flags = new Set(first.payload.flags);
      const built = postprocess(
        replay(events, catalog),
        {
          segment_id: seg.segment_id,
          start_s: seg.start_s,
          end_s: seg.end_s,
          utterance_ids: seg.utterance_ids,
          has_closing: true,
          truncated_start: false,
          truncated_end: false,
          non_english: flags.has("non_english"),
          low_audio_quality: flags.has("low_audio_quality"),
          crosstalk_suspected: flags.has("crosstalk_suspected"),
          signals: emptySignals(),
        },
        {
          catalog,
          matcher,
          thresholds,
          taxRate: 0,
          totalTolerance: 0.05,
          placeholders: flags.has("placeholder_values"),
          reviewCap: { maxQuantity: Number.POSITIVE_INFINITY, maxTotal: Number.POSITIVE_INFINITY },
          newOrderId: (() => {
            let k = 0;
            return () => finals[k++]?.order_id ?? `${first.order_id}_${k}`;
          })(),
          newGroupId: () => first.payload.group_id ?? "group",
        },
      );
      // The live preview shows items only; status and review are decided once, at finalize.
      return built.map((o) => ({ ...o, status: null, review: null, outcome_evidence: [] }));
    },
    [catalog, matcher, thresholds, time],
  );

  const seek = (t: number) => wave.current?.seek(t);
  const prevSeg = () => seek([...segments].reverse().find((s) => s.start_s < time - 1.5)?.start_s ?? 0);
  const nextSeg = () => {
    const s = segments.find((x) => x.start_s > time + 0.1);
    if (s) seek(s.start_s);
  };

  const utterances = run.transcript?.utterances ?? [];
  const nowLine = utterances.find((u) => time >= u.start_s && time <= u.end_s + 0.3);
  const nowSeg = segments.find((s) => time >= s.start_s && time <= s.end_s);
  const title = run.source_file.replace(/\.mp3$/, "");
  const lcdSub = nowLine ? `${nowLine.speaker}: ${nowLine.text}` : nowSeg ? `${nowSeg.segment_id} · ${run.orders.filter((o) => o.segment_id === nowSeg.segment_id).length} order(s)` : `${run.transcriber ?? ""} · ${run.extractor ?? ""}`;

  const stageIdx = run.status === "completed" ? STAGES.length - 1 : STAGES.indexOf((run.stage ?? "ingest") as (typeof STAGES)[number]);
  const usage = run.usage as { stt?: { provider: string; audio_minutes: number; cached: boolean }; llm?: { calls: number; cached_calls: number; input_tokens: number; output_tokens: number; model: string } } | null;
  const total = run.orders.reduce((s, o) => s + o.payload.totals.computed, 0);

  return (
    <div>
      <PlayerBar
        seed={run.source_file}
        title={title}
        subtitle={lcdSub}
        time={time}
        duration={duration}
        playing={playing}
        replay={sync}
        onPlayPause={() => wave.current?.playPause()}
        onPrev={prevSeg}
        onNext={nextSeg}
        onSeek={seek}
        onReplay={setSync}
      />

      <div className="mx-auto max-w-[1280px] space-y-8 px-8 pb-16 pt-8">
        {/* Album header */}
        <header className="flex flex-wrap items-end gap-7">
          <Artwork seed={run.source_file} size="xl" label={run.status} />
          <div className="min-w-0 flex-1 pb-1">
            <div className="label text-[10.5px]">Run</div>
            <h1 className="mt-1 break-words font-heading text-[30px] font-bold leading-tight tracking-[-0.02em]">{title}</h1>
            <div className="mt-0.5 text-[19px] font-medium text-brand">
              {run.transcriber ?? "?"} · {run.extractor ?? "?"}
            </div>
            <div className="mt-1 text-[12px] text-muted-foreground">
              {new Date(run.created_at).toLocaleString()}
              {run.transcript && ` · ${run.transcript.audio.duration_s.toFixed(1)}s · ${run.transcript.audio.channels} ch · ${run.transcript.audio.sample_rate} Hz ${run.transcript.audio.codec}`}
              {` · ${run.orders.length} order${run.orders.length === 1 ? "" : "s"} · $${total.toFixed(2)}`}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <Button size="lg" className="w-28 font-semibold" disabled={!duration} onClick={() => wave.current?.playPause()}>
                {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                {playing ? "Pause" : "Play"}
              </Button>
              <Toggle size="lg" pressed={sync} onPressedChange={setSync} className="w-36 bg-secondary font-medium hover:bg-fill-strong data-[state=on]:bg-secondary data-[state=on]:text-brand">
                <LyricsIcon className="size-4" />
                {sync ? "Replaying live" : "Live replay"}
              </Toggle>
              <Badge value={run.status} />
              <ol className="ml-auto flex items-center gap-1 text-[11px]">
                {STAGES.slice(0, -1).map((s, i) => {
                  const done = i < stageIdx;
                  const now = i === stageIdx && run.status === "running";
                  const failed = run.status === "failed" && i === stageIdx;
                  return (
                    <li key={s} className={cn("flex items-center gap-1 rounded-full px-2.5 py-1 font-medium", done ? "bg-muted text-foreground" : now ? "bg-brand-soft text-brand" : failed ? "bg-destructive/12 text-destructive" : "text-faint")}>
                      {done && <CheckIcon className="h-3 w-3 text-emerald-500" />}
                      {now && <Equalizer />}
                      {s}
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </header>

        {run.error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{run.error}</p>}
        {run.status === "queued" && run.queue_position >= 0 && <p className="text-muted-foreground">Queued (position {run.queue_position + 1})</p>}

        <Waveform
          ref={wave}
          url={`/api/runs/${id}/audio`}
          time={time}
          segments={segments.map((s) => ({ id: s.segment_id, start: s.start_s, end: s.end_s, label: s.segment_id }))}
          utterances={utterances.map((u) => ({ id: u.id, start: u.start_s, end: u.end_s, speaker: u.speaker, nonCustomer: segments.some((s) => s.non_customer_ids.includes(u.id)) }))}
          onTime={setTime}
          onReady={setDuration}
          onPlayState={(p) => {
            setPlaying(p);
            if (p) setSync(true);
          }}
        />

        <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
          {/* Orders as an album track list, one "disc" per conversation. */}
          <section className="min-w-0 space-y-7">
            <div className="flex items-baseline justify-between">
              <h2 className="section-title">Orders</h2>
              <span className="text-[12px] text-muted-foreground">{segments.length} conversations</span>
            </div>
            {!segments.length && <p className="text-muted-foreground">Orders appear after segmentation and extraction.</p>}
            {segments.map((seg, si) => {
              const finals = ordersBySeg.get(seg.segment_id) ?? [];
              const phase: "final" | "live" | "waiting" = !sync || time >= seg.end_s ? "final" : time < seg.start_s ? "waiting" : "live";
              const shown: PanelOrder[] = phase === "final" ? finals.map((o) => o.payload) : liveOrders(seg, finals);
              const first = finals[0];
              const current = nowSeg?.segment_id === seg.segment_id && playing;
              return (
                <div key={seg.segment_id}>
                  <button type="button" onClick={() => seek(seg.start_s)} className="group mb-2 flex w-full items-baseline gap-2 border-b border-line px-2 pb-1.5 text-left">
                    <span className={cn("text-[14px] font-semibold", current ? "text-brand" : "group-hover:text-brand")}>Conversation {si + 1}</span>
                    {current && <Equalizer className="text-brand" />}
                    <span className="text-[12px] text-muted-foreground">
                      {fmt(seg.start_s)} to {fmt(seg.end_s)}
                      {seg.has_greeting && " · greeting"}
                      {seg.has_closing ? " · closing" : ""}
                      {seg.non_customer_ids.length > 0 && ` · ${seg.non_customer_ids.length} chatter excluded`}
                    </span>
                    {!seg.has_closing && <span className="text-[12px] text-orange-600 dark:text-orange-400">no closing</span>}
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">word conf {seg.mean_word_conf.toFixed(2)}</span>
                  </button>
                  <div className="space-y-5">
                    {shown.length === 0 && <div className="px-2 py-2 text-muted-foreground">{run.status === "running" ? "Extracting..." : "No order"}</div>}
                    {shown.map((o) => (
                      <OrderCard key={o.order_id} order={o} phase={phase} name={name} />
                    ))}
                  </div>
                  {first && (
                    <>
                      <EventLog events={first.events} log={first.build_log} time={phase === "final" ? null : time} />
                      {first.extraction && (
                        <div className="mt-1 flex flex-wrap items-center gap-3 px-2">
                          {first.extraction.warnings.length > 0 && (
                            <span className="text-[11px] text-amber-700 dark:text-amber-400">
                              {first.extraction.warnings.length} warning(s): {first.extraction.warnings.slice(0, 2).join("; ")}
                            </span>
                          )}
                          {first.extraction.fallback && <Badge value="needs_review" label="fuzzy fallback used" />}
                          <JsonView value={first.extraction.raw} summary="Raw LLM output" />
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </section>

          <div className="min-w-0 xl:sticky xl:top-[84px]">
            {run.transcript ? (
              <Transcript seed={run.source_file} transcript={run.transcript} segments={segments} time={time} follow={sync} onSeek={seek} />
            ) : (
              <Card className="p-6 text-muted-foreground">Transcript appears after the transcribe stage.</Card>
            )}
          </div>
        </div>

        <Deliveries orders={run.orders} onChange={() => void refresh()} />

        {/* Liner notes */}
        <section>
          <h2 className="section-title mb-2">Details</h2>
          <dl className="grid gap-x-8 gap-y-2 text-[12px] sm:grid-cols-2 lg:grid-cols-3">
            <Note k="Run id" v={<span className="font-mono">{run.id}</span>} />
            <Note k="Store" v={<span className="font-mono">{site.store.value}</span>} placeholder={site.store.placeholder ? site.store.note : null} />
            <Note k="Lane" v={<span className="font-mono">{site.lane.value}</span>} placeholder={site.lane.placeholder ? site.lane.note : null} />
            <Note k="Webhook" v={<span className="break-all font-mono">{site.webhook.value}</span>} placeholder={site.webhook.placeholder ? site.webhook.note : null} />
            {run.transcript && (
              <Note
                k="Recording start"
                v={
                  <span className="font-mono">
                    {run.transcript.audio_start_utc} ({run.transcript.timestamp_source})
                  </span>
                }
                placeholder={run.transcript.timestamp_source !== "env" ? "Recording start time is not from HME metadata" : null}
              />
            )}
            {usage?.stt && <Note k="Speech to text" v={usage.stt.cached ? "cached (0 min)" : `${usage.stt.audio_minutes} min`} />}
            {usage?.llm && <Note k="LLM" v={`${usage.llm.calls} calls (${usage.llm.cached_calls} cached) · ${usage.llm.input_tokens + usage.llm.output_tokens} tokens · ${usage.llm.model}`} />}
            {run.timings?.total_ms !== undefined && <Note k="Wall time" v={`${(run.timings.total_ms / 1000).toFixed(1)}s`} />}
          </dl>
          {run.segmentation && (
            <div className="mt-3">
              <JsonView value={run.segmentation.boundaries.filter((b) => b.score > 0.2)} summary={`Segmentation boundary scores (${run.segmentation.llm_calls} LLM tie-breaks)`} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Note({ k, v, placeholder }: { k: string; v: React.ReactNode; placeholder?: string | null }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        {k}
        {placeholder && <Placeholder note={placeholder} />}
      </dt>
      <dd className="mt-0.5">{v}</dd>
    </div>
  );
}
