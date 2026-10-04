/**
 * Every value that depends on Serv lives here. Anything that falls back to a
 * default is reported as a placeholder so the UI can show a badge and orders
 * carry the `placeholder_values` flag until the real value is supplied.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Setting<T> {
  key: string;
  value: T;
  /** True when the value came from a sandbox default rather than a real Serv-provided value. */
  placeholder: boolean;
  /** What to replace it with, and when. */
  note: string;
}

export interface SandboxConfig {
  repoRoot: string;
  paths: {
    menu: string;
    cacheDir: string;
    dataDir: string;
    dbPath: string;
    fixturesDir: string;
    examplesDir: string;
    evalDir: string;
  };
  locationId: Setting<string>;
  laneId: Setting<string>;
  webhookUrl: Setting<string>;
  webhookSecret: Setting<string>;
  channelMap: Setting<Record<number, "crew" | "customer"> | null>;
  audioStartUtc: Setting<string | null>;
  menuVersion: Setting<string>;
  taxRate: Setting<number>;
  thresholds: Setting<{ recognition: number; commitment: number }>;
  language: string;
  deepgramApiKey: string | null;
  geminiApiKey: string | null;
  geminiModel: string;
  geminiRpm: number;
  /** Hard stop on Gemini requests per Pacific-time day, so usage stays inside the free tier. */
  geminiDailyCap: number;
  /** Gemini 3 thinking level. Low keeps output tokens (and free-tier usage) small. */
  geminiThinking: "minimal" | "low" | "medium" | "high";
  sttModel: string;
  lowConfWord: number;
  lowAudioQualityMeanConf: number;
  /** Below this speech-to-noise-floor ratio (dB) a conversation is flagged low_audio_quality. */
  lowAudioSnrDb: number;
  totalTolerance: number;
  segment: {
    gapS: number;
    maxSegmentS: number;
    highThreshold: number;
    lowThreshold: number;
  };
  webhook: {
    timeoutMs: number;
    fastScheduleS: number[];
    slowScheduleS: number[];
    userAgent: string;
  };
  pipelineVersion: string;
}

export const PIPELINE_VERSION = "0.1.0";
/** Flash-Lite: the free tier fits a full eval; gemini-flash-latest allows only 20 free requests per day. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function loadDotenv(root: string): void {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return;
  // Node 20.12+ ships a dotenv parser; values already in the environment win.
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (loader) {
    loader(file);
    return;
  }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
  }
}

function env(name: string): string | null {
  const v = process.env[name];
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "" || /REPLACE_ME|your_.*_here/i.test(t)) return null;
  return t;
}

export function parseChannelMap(raw: string | null): Record<number, "crew" | "customer"> | null {
  if (!raw) return null;
  const out: Record<number, "crew" | "customer"> = {};
  for (const part of raw.split(",")) {
    const [idx, role] = part.split("=").map((s) => s.trim());
    if (idx === undefined || role === undefined) continue;
    const n = Number(idx);
    if (!Number.isInteger(n) || (role !== "crew" && role !== "customer")) {
      throw new Error(`CHANNEL_MAP entry "${part}" is invalid. Use e.g. 0=customer,1=crew`);
    }
    out[n] = role;
  }
  return Object.keys(out).length ? out : null;
}

/** Dev secret is generated once and stored in .data so the sender and the mock receiver agree. */
function devWebhookSecret(dataDir: string): string {
  const file = path.join(dataDir, "dev-webhook-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dataDir, { recursive: true });
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  return secret;
}

function num(name: string, fallback: number): number {
  const v = env(name);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function thinking(v: string | null): SandboxConfig["geminiThinking"] {
  const t = (v ?? "low").toLowerCase();
  if (t === "minimal" || t === "low" || t === "medium" || t === "high") return t;
  throw new Error(`GEMINI_THINKING must be minimal, low, medium or high, got "${v}"`);
}

let cached: SandboxConfig | null = null;

export function getConfig(): SandboxConfig {
  if (cached) return cached;
  const repoRoot = findRepoRoot(process.env.SERV_REPO_ROOT ?? process.cwd());
  loadDotenv(repoRoot);

  const dataDir = path.join(repoRoot, ".data");
  const menuPath = path.join(repoRoot, "menu", "menu.json");
  const menuVersion = (JSON.parse(readFileSync(menuPath, "utf8")) as { menu_version: string }).menu_version;

  const location = env("LOCATION_ID");
  const lane = env("LANE_ID");
  const url = env("WEBHOOK_URL");
  const secret = env("WEBHOOK_SECRET");
  const channelMapRaw = env("CHANNEL_MAP");
  const startUtc = env("AUDIO_START_UTC");
  const tax = env("TAX_RATE");
  const recT = env("RECOGNITION_THRESHOLD");
  const comT = env("COMMITMENT_THRESHOLD");

  cached = {
    repoRoot,
    paths: {
      menu: menuPath,
      cacheDir: path.join(repoRoot, ".cache"),
      dataDir,
      dbPath: path.join(dataDir, "sandbox.db"),
      fixturesDir: path.join(repoRoot, "fixtures"),
      examplesDir: path.join(repoRoot, "examples"),
      evalDir: path.join(repoRoot, "eval"),
    },
    locationId: {
      key: "LOCATION_ID",
      value: location ?? "store_demo_001",
      placeholder: location === null || location === "store_demo_001",
      note: "Replace when Serv shares site IDs",
    },
    laneId: {
      key: "LANE_ID",
      value: lane ?? "lane_1",
      placeholder: lane === null || lane === "lane_1",
      note: "Replace when Serv shares lane IDs",
    },
    webhookUrl: {
      key: "WEBHOOK_URL",
      value: url ?? "http://localhost:3000/api/mock-webhook",
      placeholder: url === null || /\/api\/mock-webhook$/.test(url),
      note: "Replace when Serv shares the endpoint URL",
    },
    webhookSecret: {
      key: "WEBHOOK_SECRET",
      value: secret ?? devWebhookSecret(dataDir),
      placeholder: secret === null,
      note: "Generated dev secret. Replace when Serv issues one",
    },
    channelMap: {
      key: "CHANNEL_MAP",
      value: parseChannelMap(channelMapRaw),
      placeholder: channelMapRaw === null,
      note: "Unset means diarization. Set when an HME sample confirms channel layout",
    },
    audioStartUtc: {
      key: "AUDIO_START_UTC",
      value: startUtc,
      placeholder: startUtc === null,
      note: "Unset means filename pattern, then file mtime. Replace when HME metadata format is confirmed",
    },
    menuVersion: {
      key: "menu/menu.json",
      value: menuVersion,
      placeholder: menuVersion.startsWith("sandbox"),
      note: "Generic invented menu. Replace when Serv names a brand",
    },
    taxRate: {
      key: "TAX_RATE",
      value: tax === null ? 0 : Number(tax),
      placeholder: tax === null,
      note: "Spoken totals usually include tax. Set once the site is known",
    },
    thresholds: {
      key: "RECOGNITION_THRESHOLD / COMMITMENT_THRESHOLD",
      value: { recognition: recT === null ? 0.75 : Number(recT), commitment: comT === null ? 0.75 : Number(comT) },
      placeholder: recT === null || comT === null,
      note: "Uncalibrated guess until real audio with actual orders is available",
    },
    language: env("STT_LANGUAGE") ?? "multi",
    deepgramApiKey: env("DEEPGRAM_API_KEY"),
    geminiApiKey: env("GEMINI_API_KEY"),
    geminiModel: env("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL,
    geminiRpm: num("GEMINI_RPM", 10),
    geminiDailyCap: num("GEMINI_DAILY_CAP", 200),
    geminiThinking: thinking(env("GEMINI_THINKING")),
    sttModel: "nova-3",
    lowConfWord: 0.6,
    lowAudioQualityMeanConf: num("LOW_AUDIO_QUALITY_CONF", 0.8),
    lowAudioSnrDb: num("LOW_AUDIO_SNR_DB", 15),
    totalTolerance: 0.05,
    segment: {
      gapS: num("SEGMENT_GAP_S", 8),
      maxSegmentS: 360,
      highThreshold: 0.7,
      lowThreshold: 0.35,
    },
    webhook: {
      timeoutMs: num("WEBHOOK_TIMEOUT_MS", 10_000),
      fastScheduleS: [1, 2, 4, 8, 16, 32],
      slowScheduleS: [300, 1800, 7200, 18000, 36000, 36000],
      userAgent: `serv-audio-orders/${PIPELINE_VERSION.split(".").slice(0, 2).join(".")}`,
    },
    pipelineVersion: PIPELINE_VERSION,
  };
  return cached;
}

/** Test hook: forget the cached config so env changes take effect. */
export function resetConfig(): void {
  cached = null;
}

export type PlaceholderSetting = Pick<Setting<unknown>, "key" | "placeholder" | "note"> & { value: string };

/** All Serv-dependent settings, for the UI badge list and the placeholder_values flag. */
export function servSettings(cfg: SandboxConfig = getConfig()): PlaceholderSetting[] {
  const list: Setting<unknown>[] = [
    cfg.locationId,
    cfg.laneId,
    cfg.webhookUrl,
    cfg.webhookSecret,
    cfg.channelMap,
    cfg.audioStartUtc,
    cfg.menuVersion,
    cfg.taxRate,
    cfg.thresholds,
  ];
  return list.map((s) => ({
    key: s.key,
    placeholder: s.placeholder,
    note: s.note,
    value:
      s.key === "WEBHOOK_SECRET"
        ? `${String(s.value).slice(0, 10)}...`
        : typeof s.value === "string"
          ? s.value
          : JSON.stringify(s.value),
  }));
}

export function anyPlaceholders(cfg: SandboxConfig = getConfig()): boolean {
  return servSettings(cfg).some((s) => s.placeholder);
}
