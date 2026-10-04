import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getConfig, parseChannelMap } from "@serv/config";
import { defaultExtractor, defaultTranscriber, newId, store } from "@serv/pipeline";
import { db, listRunSummaries } from "@/lib/data";
import { fixturePath } from "@/lib/fixtures";
import { enqueueRun } from "@/lib/jobs";

export function GET() {
  return Response.json(listRunSummaries());
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function POST(req: Request) {
  const form = await req.formData();
  const cfg = getConfig();
  const runId = newId("run");

  let file: string | null = null;
  let sourceName: string;
  const upload = form.get("file");
  const fixture = form.get("fixture");
  if (upload instanceof File && upload.size > 0) {
    if (upload.size > MAX_UPLOAD_BYTES) return Response.json({ error: "File too large (100 MB max)" }, { status: 413 });
    const safe = upload.name.replace(/[^\w.-]/g, "_");
    const dir = path.join(cfg.paths.dataDir, "uploads");
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${runId}-${safe}`);
    writeFileSync(file, Buffer.from(await upload.arrayBuffer()));
    sourceName = safe;
  } else if (typeof fixture === "string" && fixture) {
    file = fixturePath(fixture);
    if (!file) return Response.json({ error: `Unknown fixture ${fixture}` }, { status: 400 });
    sourceName = fixture;
  } else {
    return Response.json({ error: "Upload an MP3 or pick a fixture" }, { status: 400 });
  }

  const transcriber = form.get("transcriber") === "script" ? "script" : form.get("transcriber") === "deepgram" ? "deepgram" : defaultTranscriber(cfg);
  const extractor = form.get("extractor") === "fuzzy" ? "fuzzy" : form.get("extractor") === "gemini" ? "gemini" : defaultExtractor(cfg);
  if (transcriber === "deepgram" && !cfg.deepgramApiKey) return Response.json({ error: "DEEPGRAM_API_KEY is not set" }, { status: 400 });
  if (extractor === "gemini" && !cfg.geminiApiKey) return Response.json({ error: "GEMINI_API_KEY is not set" }, { status: 400 });
  if (transcriber === "script" && !fixture) return Response.json({ error: "The script transcriber only works on fixture audio" }, { status: 400 });

  const channelMode = String(form.get("channels") ?? "config");
  let channelMap: Record<number, "crew" | "customer"> | null | undefined;
  try {
    channelMap = channelMode === "diarize" ? null : channelMode === "config" ? undefined : parseChannelMap(channelMode);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const deliver = form.get("deliver") !== "false";

  store.insertRun(db(), { id: runId, source_file: sourceName, file_path: file, options: { transcriber, extractor, channels: channelMode, deliver } });
  enqueueRun({ runId, file, transcriber, extractor, channelMap, deliver });
  return Response.json({ run_id: runId }, { status: 202 });
}
