import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getConfig, parseChannelMap } from "@serv/config";
import { defaultExtractor, defaultTranscriber, newId, store } from "@serv/pipeline";
import { db, listRunSummaries } from "@/lib/data";
import { fixturePath } from "@/lib/fixtures";
import { AppError, BadRequestError, wrapAsync } from "@/lib/error-handler";
import { enqueueRun } from "@/lib/jobs";

export const GET = wrapAsync(async () => Response.json(listRunSummaries()));

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const POST = wrapAsync(async (req: Request) => {
  const form = await req.formData();
  const cfg = getConfig();
  const runId = newId("run");

  let file: string | null = null;
  let sourceName: string;
  const upload = form.get("file");
  const fixture = form.get("fixture");
  if (upload instanceof File && upload.size > 0) {
    if (upload.size > MAX_UPLOAD_BYTES) throw new AppError("File too large (100 MB max)", 413, "BAD_REQUEST");
    const safe = upload.name.replace(/[^\w.-]/g, "_");
    const dir = path.join(cfg.paths.dataDir, "uploads");
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${runId}-${safe}`);
    writeFileSync(file, Buffer.from(await upload.arrayBuffer()));
    sourceName = safe;
  } else if (typeof fixture === "string" && fixture) {
    file = fixturePath(fixture);
    if (!file) throw new BadRequestError(`Unknown fixture ${fixture}`);
    sourceName = fixture;
  } else {
    throw new BadRequestError("Upload an MP3 or pick a fixture");
  }

  const transcriber = form.get("transcriber") === "script" ? "script" : form.get("transcriber") === "deepgram" ? "deepgram" : defaultTranscriber(cfg);
  const extractor = form.get("extractor") === "fuzzy" ? "fuzzy" : form.get("extractor") === "gemini" ? "gemini" : defaultExtractor(cfg);
  if (transcriber === "deepgram" && !cfg.deepgramApiKey) throw new BadRequestError("DEEPGRAM_API_KEY is not set");
  if (extractor === "gemini" && !cfg.geminiApiKey) throw new BadRequestError("GEMINI_API_KEY is not set");
  if (transcriber === "script" && !fixture) throw new BadRequestError("The script transcriber only works on fixture audio");

  const channelMode = String(form.get("channels") ?? "config");
  let channelMap: Record<number, "crew" | "customer"> | null | undefined;
  try {
    channelMap = channelMode === "diarize" ? null : channelMode === "config" ? undefined : parseChannelMap(channelMode);
  } catch (e) {
    throw new BadRequestError((e as Error).message);
  }
  const deliver = form.get("deliver") !== "false";

  store.insertRun(db(), { id: runId, source_file: sourceName, file_path: file, options: { transcriber, extractor, channels: channelMode, deliver } });
  enqueueRun({ runId, file, transcriber, extractor, channelMap, deliver });
  return Response.json({ run_id: runId }, { status: 202 });
});
