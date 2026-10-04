"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

interface Fixture {
  file: string;
  id: string;
  layout: string;
  noise: string;
  title: string;
}

export function NewRunForm({ fixtures, keys }: { fixtures: Fixture[]; keys: { deepgram: boolean; gemini: boolean } }) {
  const router = useRouter();
  const [source, setSource] = useState<"fixture" | "upload">("fixture");
  const [fixture, setFixture] = useState(fixtures.find((f) => f.id === "compilation_a" && f.layout === "mono")?.file ?? fixtures[0]?.file ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [transcriber, setTranscriber] = useState(keys.deepgram ? "deepgram" : "script");
  const [extractor, setExtractor] = useState(keys.gemini ? "gemini" : "fuzzy");
  const [channels, setChannels] = useState("config");
  const [deliver, setDeliver] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => fixtures.find((f) => f.file === fixture), [fixtures, fixture]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData();
    if (source === "upload" && file) form.set("file", file);
    else form.set("fixture", fixture);
    form.set("transcriber", source === "upload" && transcriber === "script" ? "deepgram" : transcriber);
    form.set("extractor", extractor);
    form.set("channels", channels === "config" && source === "fixture" && selected?.layout === "stereo" ? "0=customer,1=crew" : channels);
    form.set("deliver", String(deliver));
    const res = await fetch("/api/runs", { method: "POST", body: form });
    const json = (await res.json()) as { run_id?: string; error?: string };
    setBusy(false);
    if (!res.ok || !json.run_id) return setError(json.error ?? "Could not start the run");
    router.push(`/runs/${json.run_id}`);
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-4">
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {(["fixture", "upload"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSource(s)} className={`flex-1 rounded-md px-3 py-1.5 ${source === s ? "bg-white font-medium shadow-sm" : "text-muted"}`}>
            {s === "fixture" ? "Generated fixture" : "Upload MP3"}
          </button>
        ))}
      </div>

      {source === "fixture" ? (
        <label className="block">
          <span className="label">Fixture audio</span>
          <select value={fixture} onChange={(e) => setFixture(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm">
            {fixtures.map((f) => (
              <option key={f.file} value={f.file}>
                {f.id} ({f.layout}, {f.noise}): {f.title}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="block">
          <span className="label">Audio file</span>
          <input type="file" accept="audio/*,.mp3" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm" />
        </label>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label">Transcriber</span>
          <select value={transcriber} onChange={(e) => setTranscriber(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm">
            <option value="deepgram" disabled={!keys.deepgram}>Deepgram Nova-3{keys.deepgram ? "" : " (no key)"}</option>
            <option value="script" disabled={source === "upload"}>Fixture ground truth (free)</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Extractor</span>
          <select value={extractor} onChange={(e) => setExtractor(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm">
            <option value="gemini" disabled={!keys.gemini}>Gemini{keys.gemini ? "" : " (no key)"}</option>
            <option value="fuzzy">Keyword + fuzzy (fallback)</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Speaker roles</span>
          <select value={channels} onChange={(e) => setChannels(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm">
            <option value="config">From config (stereo fixtures: channels)</option>
            <option value="diarize">Diarization</option>
            <option value="0=customer,1=crew">Channels: 0 customer, 1 crew</option>
            <option value="0=crew,1=customer">Channels: 0 crew, 1 customer</option>
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} />
          Deliver orders to the webhook
        </label>
        <button type="submit" disabled={busy || (source === "upload" && !file)} className="btn-primary">
          {busy ? "Starting..." : "Start run"}
        </button>
      </div>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
    </form>
  );
}
