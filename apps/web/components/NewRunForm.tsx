"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils";
import { Artwork } from "./Artwork";
import { PlayIcon, UploadIcon } from "./Icons";
import { Segmented } from "./Segmented";

interface Fixture {
  file: string;
  id: string;
  layout: string;
  noise: string;
  title: string;
}

/** One shelf tile per fixture id; mono and stereo copies are variants of it. */
interface Album {
  id: string;
  title: string;
  noise: string;
  files: Record<string, string>;
}

const shortId = (id: string) => (id.startsWith("compilation_") ? `Comp ${id.slice(-1).toUpperCase()}` : `No. ${id.slice(0, 2)}`);

export function NewRunForm({ fixtures, keys, query }: { fixtures: Fixture[]; keys: { deepgram: boolean; gemini: boolean }; query: string }) {
  const router = useRouter();
  const albums = useMemo(() => {
    const m = new Map<string, Album>();
    for (const f of fixtures) {
      const a = m.get(f.id) ?? { id: f.id, title: f.title, noise: f.noise, files: {} };
      a.files[f.layout] = f.file;
      m.set(f.id, a);
    }
    const all = [...m.values()].sort((a, b) => (a.id.startsWith("comp") === b.id.startsWith("comp") ? a.id.localeCompare(b.id) : a.id.startsWith("comp") ? -1 : 1));
    const q = query.toLowerCase();
    return q ? all.filter((a) => `${a.id} ${a.title}`.toLowerCase().includes(q)) : all;
  }, [fixtures, query]);

  const [source, setSource] = useState<"fixture" | "upload">("fixture");
  const [albumId, setAlbumId] = useState(albums.find((a) => a.id === "compilation_a")?.id ?? albums[0]?.id ?? "");
  const [layout, setLayout] = useState("mono");
  const [file, setFile] = useState<File | null>(null);
  const [transcriber, setTranscriber] = useState(keys.deepgram ? "deepgram" : "script");
  const [extractor, setExtractor] = useState(keys.gemini ? "gemini" : "fuzzy");
  const [channels, setChannels] = useState("config");
  const [deliver, setDeliver] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const album = albums.find((a) => a.id === albumId) ?? albums[0];
  const fixtureFile = album?.files[layout] ?? Object.values(album?.files ?? {})[0] ?? "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData();
    if (source === "upload" && file) form.set("file", file);
    else form.set("fixture", fixtureFile);
    form.set("transcriber", source === "upload" && transcriber === "script" ? "deepgram" : transcriber);
    form.set("extractor", extractor);
    form.set("channels", channels === "config" && source === "fixture" && layout === "stereo" ? "0=customer,1=crew" : channels);
    form.set("deliver", String(deliver));
    const res = await fetch("/api/runs", { method: "POST", body: form });
    const json = (await res.json()) as { run_id?: string; error?: { message: string } };
    setBusy(false);
    if (!res.ok || !json.run_id) return setError(json.error?.message ?? "Could not start the run");
    router.push(`/runs/${json.run_id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="section-title">Start a Run</h2>
          <p className="text-[12px] text-muted-foreground">Pick a generated fixture or upload an HME recording. Each conversation becomes an order and is POSTed to the webhook.</p>
        </div>
        <Segmented
          label="Audio source"
          value={source}
          onChange={setSource}
          options={[
            { value: "fixture", label: "Fixtures" },
            { value: "upload", label: "Upload" },
          ]}
        />
      </div>

      {source === "fixture" ? (
        <div className="no-scrollbar -mx-2 flex snap-x items-start gap-5 overflow-x-auto px-2 pb-2 pt-2">
          {albums.length === 0 && <p className="py-6 text-muted-foreground">No fixtures match &ldquo;{query}&rdquo;.</p>}
          {albums.map((a) => {
            const selected = a.id === album?.id;
            return (
              <button key={a.id} type="button" onClick={() => setAlbumId(a.id)} className="group flex w-[150px] shrink-0 snap-start flex-col text-left">
                <div className={cn("relative rounded-lg transition", selected && "ring-[3px] ring-brand ring-offset-2 ring-offset-background")}>
                  <Artwork seed={a.id} label={shortId(a.id)} />
                  <span className="absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-brand text-white opacity-0 shadow-lg transition group-hover:opacity-100">
                    <PlayIcon className="ml-0.5 h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-2 line-clamp-2 text-[12.5px] font-medium leading-snug">{a.title}</div>
                <div className="text-[11.5px] text-muted-foreground">
                  {Object.keys(a.files).join(" · ")} · {a.noise}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-stripe px-6 py-10 text-center hover:bg-muted">
          <UploadIcon className="h-7 w-7 text-brand" />
          <span className="text-[14px] font-medium">{file ? file.name : "Choose an MP3"}</span>
          <span className="text-[12px] text-muted-foreground">{file ? `${(file.size / 1e6).toFixed(1)} MB` : "Uploads always use Deepgram for transcription"}</span>
          <input type="file" accept="audio/*,.mp3" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="sr-only" />
        </label>
      )}

      {/* "Up next" bar: what will run, and how. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl bg-stripe p-3 ring-1 ring-border">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          {source === "fixture" && album ? <Artwork seed={album.id} size="sm" /> : <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted"><UploadIcon className="h-4 w-4 text-muted-foreground" /></span>}
          <div className="min-w-0">
            <div className="label text-[10px]">Up Next</div>
            <div className="truncate text-[13px] font-semibold">{source === "fixture" ? (album?.title ?? "No fixture") : (file?.name ?? "No file chosen")}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{source === "fixture" ? fixtureFile : "upload"}</div>
          </div>
        </div>
        {source === "fixture" && (
          <Field label="Layout">
            <Segmented
              label="Channel layout"
              value={layout}
              onChange={setLayout}
              options={["mono", "stereo"].map((l) => ({ value: l, label: l[0]!.toUpperCase() + l.slice(1), disabled: !album?.files[l] }))}
            />
          </Field>
        )}
        <Field label="Transcriber">
          <Choice
            label="Transcriber"
            value={transcriber}
            onChange={setTranscriber}
            options={[
              { value: "deepgram", label: `Deepgram Nova-3${keys.deepgram ? "" : " (no key)"}`, disabled: !keys.deepgram },
              { value: "script", label: "Ground truth (free)", disabled: source === "upload" },
            ]}
          />
        </Field>
        <Field label="Extractor">
          <Choice
            label="Extractor"
            value={extractor}
            onChange={setExtractor}
            options={[
              { value: "gemini", label: `Gemini${keys.gemini ? "" : " (no key)"}`, disabled: !keys.gemini },
              { value: "fuzzy", label: "Keyword + fuzzy" },
            ]}
          />
        </Field>
        <Field label="Speaker roles">
          <Choice
            label="Speaker roles"
            value={channels}
            onChange={setChannels}
            options={[
              { value: "config", label: "Auto (stereo uses channels)" },
              { value: "diarize", label: "Diarization" },
              { value: "0=customer,1=crew", label: "Ch 0 customer, ch 1 crew" },
              { value: "0=crew,1=customer", label: "Ch 0 crew, ch 1 customer" },
            ]}
          />
        </Field>
        <div className="flex items-center gap-2">
          <Switch id="deliver" size="sm" checked={deliver} onCheckedChange={setDeliver} />
          <Label htmlFor="deliver" className="text-[12px] font-normal text-muted-foreground">
            Send webhook
          </Label>
        </div>
        <Button type="submit" disabled={busy || (source === "upload" && !file) || (source === "fixture" && !fixtureFile)} className="rounded-full px-5 font-semibold">
          <PlayIcon className="size-3.5" />
          {busy ? "Starting..." : "Start Run"}
        </Button>
      </div>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error}</p>}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label text-[10px]">{label}</span>
      {children}
    </div>
  );
}

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string; disabled?: boolean }[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} size="sm" className="min-w-40 border-transparent bg-muted text-[13px] dark:bg-muted">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled} className="text-[13px]">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
