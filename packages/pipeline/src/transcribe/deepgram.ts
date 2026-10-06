import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DeepgramClient } from "@deepgram/sdk";
import type { IngestResult } from "../ingest/ingest";
import { isRetryableError, withRetry } from "../lib/retry";
import { assignRoles, diarizationCollapsed } from "./roles";
import { diarizedSamples, normalizeDeepgram, type DgResponse } from "./normalize";
import type { RoleJudge, TranscribeOptions, TranscribeResult, Transcriber } from "./types";

export const DEEPGRAM_MODEL = "nova-3";

/**
 * Deepgram Nova-3 prerecorded transcription.
 * Stereo + CHANNEL_MAP -> multichannel (roles from channels, preferred).
 * Otherwise diarize and assign roles from crew phrase cues, with an LLM tie-break.
 * Raw responses are cached under .cache/<sha256>/ so reruns cost nothing.
 */
export class DeepgramTranscriber implements Transcriber {
  readonly name = `deepgram/${DEEPGRAM_MODEL}`;
  private readonly client: DeepgramClient;

  constructor(
    apiKey: string,
    private readonly roleJudge: RoleJudge | null = null,
  ) {
    this.client = new DeepgramClient({ apiKey, timeoutInSeconds: 300, maxRetries: 0 });
  }

  /** Where a file's raw response is cached (keyed by the file's SHA-256). */
  static cacheFile(cacheDir: string, hash: string, multichannel: boolean, language: string): string {
    return path.join(cacheDir, hash, `deepgram${multichannel ? ".multichannel" : ""}.${language}.json`);
  }

  async transcribe(input: IngestResult, opts: TranscribeOptions): Promise<TranscribeResult> {
    const multichannel = input.audio.channels > 1 && opts.channelMap !== null;
    const dir = path.join(opts.cacheDir, input.hash);
    const cacheFile = DeepgramTranscriber.cacheFile(opts.cacheDir, input.hash, multichannel, opts.language);
    let raw: DgResponse;
    let cached = false;
    if (!opts.refresh && existsSync(cacheFile)) {
      raw = JSON.parse(readFileSync(cacheFile, "utf8")) as DgResponse;
      cached = true;
    } else {
      raw = await withRetry(() => this.request(input.file, multichannel, opts), {
        maxRetries: 4,
        initialDelay: 1000,
        maxDelay: 16_000,
        retryOn: isRetryableError,
        operationName: "deepgram transcribe",
      });
      mkdirSync(dir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(raw));
    }

    let crewOverride: Set<string> | undefined;
    let roleLlmCalls = 0;
    if (!multichannel) {
      const samples = diarizedSamples(raw);
      const roles = assignRoles(samples);
      // One voice for everything: roles come from wording per line (normalize), so no judge call.
      const collapsed = diarizationCollapsed(samples.filter((s) => s.text.trim()).map((s) => s.label));
      if (roles.ambiguous && !collapsed && this.roleJudge) {
        const byLabel = new Map<string, string[]>();
        for (const s of samples) byLabel.set(s.label, [...(byLabel.get(s.label) ?? []), s.text].slice(0, 6));
        const pick = await this.roleJudge.pickCrew([...byLabel].map(([speaker, lines]) => ({ speaker, lines })));
        roleLlmCalls++;
        // Keep chatter-only crew voices (score 0 but crew) alongside the LLM's pick.
        if (pick) crewOverride = new Set([pick, ...[...roles.crew].filter((c) => (roles.scores[c] ?? 0) === 0)]);
      }
      if (!crewOverride && roles.ambiguous && samples[0]) {
        // Last resort: the first voice on a drive-thru recording is usually the crew greeting.
        crewOverride = new Set([samples[0].label]);
      }
    }

    const transcript = normalizeDeepgram(raw, input, {
      channelMap: opts.channelMap,
      multichannel,
      lowConfWord: opts.lowConfWord,
      ...(crewOverride ? { crewOverride } : {}),
      stt: this.name,
    });
    const channels = multichannel ? raw.metadata.channels : 1;
    return {
      transcript,
      usage: {
        provider: this.name,
        audio_minutes: Math.round(((raw.metadata.duration * channels) / 60) * 1000) / 1000,
        cached,
        role_llm_calls: roleLlmCalls,
      },
    };
  }

  private async request(file: string, multichannel: boolean, opts: TranscribeOptions): Promise<DgResponse> {
    const res = await this.client.listen.v1.media.transcribeFile(createReadStream(file), {
      model: DEEPGRAM_MODEL,
      language: opts.language,
      smart_format: true,
      punctuate: true,
      utterances: true,
      utt_split: 0.8,
      filler_words: true,
      keyterm: opts.keyterms,
      ...(multichannel ? { multichannel: true } : { diarize: true }),
    });
    if (!("results" in res)) throw new Error("Deepgram returned an async (callback) response; expected results inline");
    return res as unknown as DgResponse;
  }
}
