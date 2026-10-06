"use client";

import { Catalog } from "@serv/pipeline/menu/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils";
import { emptyLane } from "@/lib/live";
import { SimLink, type LinkNote, type LinkState, type SimCodec } from "@/lib/sim-link";
import { LaneView } from "../live/LaneView";
import { useLiveFeed } from "../live/use-live-feed";
import { MockInbox } from "../MockInbox";
import { Segmented } from "../Segmented";
import { SaveFixture } from "./SaveFixture";

type InputMode = "mic" | "text";
type AudioMode = "continuous" | "car";
type Noise = "off" | "moderate" | "heavy";

const LINK_TONE: Record<LinkState, string> = {
  idle: "bg-muted text-muted-foreground",
  connecting: "bg-sky-500/12 text-sky-700 dark:text-sky-400",
  open: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  reconnecting: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  down: "bg-rose-500/12 text-rose-700 dark:text-rose-400",
};

/** Below this peak level a frame counts as silence for the no-audio guard. */
const SILENCE_DB = -50;

/**
 * A fake HME base station (plan D11): mic audio (or typed lines) and event
 * buttons go to the real /hme/v1/stream endpoint with a one-time dev ticket;
 * everything after the input layer is the real pipeline. The live panel below
 * is the Live page's lane view.
 */
export function Simulator({ menu, defaults, deepgram }: { menu: unknown; defaults: { storeId: string; laneId: string }; deepgram: boolean }) {
  const catalog = useMemo(() => Catalog.fromJson(menu), [menu]);
  const name = useCallback((cid: string | null) => (cid ? catalog.name(cid) : ""), [catalog]);
  const { lanes } = useLiveFeed();

  const [storeId, setStoreId] = useState(defaults.storeId);
  const [laneId, setLaneId] = useState(defaults.laneId);
  const [codec, setCodec] = useState<SimCodec>("pcm_s16le");
  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [audioMode, setAudioMode] = useState<AudioMode>("continuous");
  const [noise, setNoise] = useState<Noise>("off");
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [silenceS, setSilenceS] = useState(30);

  const [running, setRunning] = useState(false);
  const [link, setLink] = useState<{ state: LinkState; note?: LinkNote }>({ state: "idle" });
  const [car, setCar] = useState(false);
  const [paused, setPaused] = useState(false);
  const [levelDb, setLevelDb] = useState(-120);
  const [sentS, setSentS] = useState(0);
  const [stopNote, setStopNote] = useState<LinkNote | null>(null);
  const [session, setSession] = useState<{ since: number; until: number | null } | null>(null);
  const [crewHeld, setCrewHeld] = useState(false);
  const labels = useRef<{ start_ms: number; end_ms: number; speaker: "crew" }[]>([]);

  const linkRef = useRef<SimLink | null>(null);
  const audio = useRef<{ ctx: AudioContext; stream: MediaStream | null } | null>(null);
  // The worklet callback reads the latest switches through this ref.
  const flags = useRef({ car, paused, audioMode, inputMode, maxMinutes, silenceS, sent: 0, lastLoud: 0, lastMeter: 0 });
  useEffect(() => {
    Object.assign(flags.current, { car, paused, audioMode, inputMode, maxMinutes, silenceS });
  }, [car, paused, audioMode, inputMode, maxMinutes, silenceS]);

  const stop = useCallback((note?: LinkNote) => {
    linkRef.current?.close();
    linkRef.current = null;
    const a = audio.current;
    audio.current = null;
    a?.stream?.getTracks().forEach((t) => t.stop());
    void a?.ctx.close();
    setRunning(false);
    setPaused(false);
    setCar(false);
    setSession((s) => (s ? { ...s, until: Date.now() } : s));
    setStopNote(note ?? null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  async function startAudio(l: SimLink): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
    // The device's own rate: some browsers (Firefox) refuse to connect a mic to a context at
    // another rate. The worklet resamples to 16 kHz itself.
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule("/sim-worklet.js");
    const node = new AudioWorkletNode(ctx, "sim-capture");
    ctx.createMediaStreamSource(stream).connect(node);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    if (noise !== "off") {
      const res = await fetch(`/api/dev/noise?level=${noise}`);
      const src = ctx.createBufferSource();
      src.buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      src.loop = true;
      src.connect(node);
      src.start();
    }
    audio.current = { ctx, stream };
    flags.current.lastLoud = Date.now();
    node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; db: number }>) => {
      const f = flags.current;
      const now = Date.now();
      if (e.data.db > SILENCE_DB) f.lastLoud = now;
      if (now - f.lastMeter > 100) {
        f.lastMeter = now;
        setLevelDb(e.data.db);
        setSentS(f.sent / 16_000);
      }
      // Credit guards: stop after the minute limit, or after this long with no sound.
      if (now - f.lastLoud > f.silenceS * 1000) return stop({ tone: "info", text: `Stopped after ${f.silenceS} s with no sound from the mic, to save Deepgram credit. Speak, or raise the limit, then press Start.` });
      if (f.sent / 16_000 > f.maxMinutes * 60) return stop({ tone: "info", text: `Stopped at the ${f.maxMinutes} minute limit, to save Deepgram credit.` });
      const send = !f.paused && (f.audioMode === "continuous" || f.car);
      if (send && l.open) {
        l.sendAudio(e.data.pcm);
        f.sent += e.data.pcm.length;
      }
    };
  }

  async function start(): Promise<void> {
    setStopNote(null);
    labels.current = [];
    flags.current.sent = 0;
    setSentS(0);
    setSession({ since: Date.now(), until: null });
    const l = new SimLink({ storeId, laneId, codec, autoReconnect, onState: (state, note) => setLink({ state, ...(note ? { note } : {}) }) });
    linkRef.current = l;
    setRunning(true);
    await l.connect();
    if (inputMode === "mic") {
      try {
        await startAudio(l);
      } catch (e) {
        stop({ tone: "error", text: micProblem(e) });
      }
    }
  }

  useEffect(() => {
    if (linkRef.current) linkRef.current.autoReconnect = autoReconnect;
  }, [autoReconnect]);

  // Hold C while the crew speaks: kept as labels for scoring roles later, never sent.
  useEffect(() => {
    if (!running || inputMode !== "mic") return;
    let start = 0;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c" || e.repeat || typing(e)) return;
      start = Date.now();
      setCrewHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c" || !start) return;
      labels.current.push({ start_ms: start, end_ms: Date.now(), speaker: "crew" });
      start = 0;
      setCrewHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [running, inputMode]);

  const lane = lanes[`${storeId}:${laneId}`] ?? emptyLane(storeId, laneId);
  const open = link.state === "open";

  return (
    <div className="mx-auto max-w-[1180px] space-y-8 px-8 pb-16 pt-8">
      <header>
        <h1 className="title-xl">Simulator</h1>
        <p className="mt-0.5 max-w-3xl text-[13px] text-muted-foreground">
          A pretend HME base station. Speak into the mic or type lines, press buttons for what the car and the stream do, and watch the real endpoint build and deliver the order.
          {deepgram ? " Mic audio is transcribed by Deepgram live and uses credit; text mode is free." : " No Deepgram key is set, so use text mode."}
        </p>
      </header>

      <Card className="gap-5 px-5 py-4 text-[13px]">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Store">
            <Input value={storeId} disabled={running} onChange={(e) => setStoreId(e.target.value)} className="h-8 w-36" aria-label="Store" />
          </Field>
          <Field label="Lane">
            <Input value={laneId} disabled={running} onChange={(e) => setLaneId(e.target.value)} className="h-8 w-28" aria-label="Lane" />
          </Field>
          <Field label="Input">
            <Segmented label="Input" value={inputMode} onChange={(v) => !running && setInputMode(v)} options={[{ value: "text", label: "Text (free)" }, { value: "mic", label: "Microphone", disabled: running }]} />
          </Field>
          <Field label="Wire codec">
            <Segmented label="Wire codec" value={codec} onChange={(v) => !running && setCodec(v)} options={[{ value: "pcm_s16le", label: "PCM 16-bit" }, { value: "mulaw", label: "mu-law" }]} />
          </Field>
          <Field label="Audio mode">
            <Segmented label="Audio mode" value={audioMode} onChange={setAudioMode} options={[{ value: "continuous", label: "Continuous" }, { value: "car", label: "Only with a car" }]} />
          </Field>
          <Field label="Noise">
            <Segmented label="Noise" value={noise} onChange={(v) => !running && setNoise(v)} options={[{ value: "off", label: "Off" }, { value: "moderate", label: "Engine" }, { value: "heavy", label: "Heavy" }]} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button onClick={() => stop()} variant="secondary">
              Stop
            </Button>
          ) : (
            <Button onClick={() => void start()}>Start</Button>
          )}
          <Button
            variant="outline"
            disabled={!open || car}
            onClick={() => {
              setCar(true);
              linkRef.current?.sendEvent("vehicle_arrived");
            }}
          >
            Car arrived
          </Button>
          <Button
            variant="outline"
            disabled={!open || !car}
            onClick={() => {
              setCar(false);
              linkRef.current?.sendEvent("vehicle_departed");
            }}
          >
            Car left
          </Button>
          <Button
            variant="outline"
            disabled={!open}
            onClick={() => {
              linkRef.current?.sendEvent(paused ? "stream_resumed" : "stream_paused");
              setPaused(!paused);
            }}
          >
            {paused ? "Resume stream" : "Pause stream"}
          </Button>
          <Button variant="outline" disabled={!open} onClick={() => linkRef.current?.drop()}>
            Drop connection
          </Button>
          <label className="ml-2 flex items-center gap-2 text-muted-foreground">
            <Switch checked={autoReconnect} onCheckedChange={setAutoReconnect} aria-label="Reconnect after a drop" />
            Reconnect after a drop (2, 4, 8 s)
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
          <span className={cn("rounded-md px-2 py-0.5 font-semibold capitalize", LINK_TONE[link.state === "down" && link.note?.tone !== "error" ? "idle" : link.state])}>{link.state}</span>
          {link.note && <Note note={link.note} />}
          {inputMode === "mic" && running && <LevelMeter db={levelDb} />}
          {inputMode === "mic" && (
            <span>
              {sentS.toFixed(0)} s sent · Deepgram {lane.audioMinutes.toFixed(2)} min on this lane
            </span>
          )}
          {inputMode === "mic" && running && <span className={cn(crewHeld && "font-semibold text-brand")}>{crewHeld ? "Crew talking (C held)" : "Hold C while the crew talks"}</span>}
          <span className="flex items-center gap-1.5">
            Stop after
            <Input type="number" min={1} max={60} value={maxMinutes} onChange={(e) => setMaxMinutes(Math.max(1, Number(e.target.value) || 15))} className="h-7 w-14" aria-label="Minute limit" />
            min, or
            <Input type="number" min={5} max={600} value={silenceS} onChange={(e) => setSilenceS(Math.max(5, Number(e.target.value) || 30))} className="h-7 w-14" aria-label="Silence limit" />s with no audio
          </span>
          {stopNote && <Note note={stopNote} />}
        </div>

        {inputMode === "text" && <TextLine disabled={!open} onSend={(speaker, text) => linkRef.current?.sendLine(speaker, text)} />}
      </Card>

      <LaneView lane={lane} name={name} />

      <SaveFixture catalog={catalog} storeId={storeId} laneId={laneId} session={running ? null : session} labels={labels} />

      <MockInbox />
    </div>
  );
}

/** Info notes are quiet; errors stand out and say what to do. */
function Note({ note }: { note: LinkNote }) {
  return <span className={cn(note.tone === "error" ? "font-medium text-destructive" : "text-muted-foreground")}>{note.text}</span>;
}

/** Microphone setup failures in plain words. */
function micProblem(e: unknown): string {
  const name = (e as Error).name;
  if (name === "NotAllowedError") return "Microphone access was blocked. Allow it in the browser's site settings, then press Start.";
  if (name === "NotFoundError") return "No microphone was found. Connect one, then press Start.";
  if (name === "NotReadableError") return "The microphone is in use by another app. Close it, then press Start.";
  return `The microphone could not start (${(e as Error).message}). Try text mode, or reload the page.`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="label text-[10.5px]">{label}</div>
      {children}
    </div>
  );
}

function LevelMeter({ db }: { db: number }) {
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <span className="flex items-center gap-2" title={`${db.toFixed(0)} dBFS`}>
      mic
      <span className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", db > -3 ? "bg-rose-500" : "bg-emerald-500")} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function TextLine({ disabled, onSend }: { disabled: boolean; onSend: (speaker: "crew" | "customer", text: string) => void }) {
  const [speaker, setSpeaker] = useState<"crew" | "customer">("crew");
  const [text, setText] = useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSend(speaker, text.trim());
        setText("");
        // The crew and the customer usually take turns.
        setSpeaker(speaker === "crew" ? "customer" : "crew");
      }}
    >
      <Segmented label="Speaker" value={speaker} onChange={setSpeaker} options={[{ value: "crew", label: "Crew" }, { value: "customer", label: "Customer" }]} />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={disabled ? "Start to type lines" : `Type what the ${speaker} says, then Enter`} disabled={disabled} className="h-8 flex-1" aria-label="Line" />
      <Button type="submit" disabled={disabled || !text.trim()} size="sm">
        Send
      </Button>
    </form>
  );
}
