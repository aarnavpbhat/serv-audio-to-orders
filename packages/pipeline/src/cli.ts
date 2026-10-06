#!/usr/bin/env tsx
/**
 * pnpm pipeline run <file.mp3>       transcribe, segment, extract, build, deliver
 * pnpm pipeline eval                 score every fixture against ground truth
 * pnpm pipeline resend <order_id>    resend a failed or dead-lettered delivery
 * pnpm pipeline worker               run the slow-phase retry worker
 * pnpm pipeline examples             write example orders to examples/
 * pnpm pipeline settings             show Serv-dependent settings and placeholders
 * pnpm pipeline secret               generate a whsec_ signing secret
 * pnpm feed replay <fixture|file>    replay a recording as a live feed (lane path)
 * pnpm feed serve                    run the live endpoint (HME WebSocket) and lanes
 * pnpm feed replay-raw <session>     replay a captured session byte for byte to the endpoint
 * pnpm pipeline token create|list|revoke   manage ingest tokens
 * pnpm data find|usage|verify|prune|delete|label   the long-term data store
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getConfig, parseChannelMap, servSettings } from "@serv/config";
import { ConfigError, createEngine, type EngineOptions, type ExtractorKind, type TranscriberKind } from "./engine";
import { dataCommand } from "./data/cli";
import { runActedScenarios } from "./sim/acted-scenarios";
import { readRawSession } from "./data/raw-sink";
import { formatReport, runEval } from "./eval/run-eval";
import { IngestError } from "./ingest/probe";
import { createToken, issueTicket, listTokens, revokeToken } from "./input/auth/tokens";
import { DEFAULT_SCENARIO, loadScenario } from "./input/scenario";
import { replayOverWs, replayRawOverWs } from "./input/ws-replay";
import { startService } from "./server/serve";
import { openDb } from "./store/db";
import { liveWriter } from "./lane/live-feed";
import { latencySummary, replayFile, type ReplayResult } from "./lane/replay";
import { sleep } from "./lib/retry";
import { runPipeline, type RunResult } from "./run";
import { latestOrder, outboxForOrder } from "./store/db";
import { generateSecret, signedHeaders } from "./webhook/signing";

const HELP = `Usage: pnpm pipeline <command> [options]

Commands
  run <file>            Process one audio file and deliver each order to WEBHOOK_URL
  eval                  Run all fixtures and report accuracy (writes eval/report.json)
  resend <order_id>     Resend the latest delivery for an order
  worker [--once]       Process scheduled slow-phase retries
  examples              Write example orders (audio, transcript, order, payload) to examples/
  settings              List Serv-dependent settings and which are placeholders
  secret                Print a new whsec_ signing secret
  feed replay <f>       Replay a fixture id or audio file as a live feed through the lane path
  feed serve            Run the live service: the HME WebSocket endpoint plus lanes
  token create          Create an ingest token: --store <id> --lanes <a,b> [--note text] (printed once)
  token list            List ingest tokens (never the secrets)
  token revoke <id>     Revoke a token; its live sessions are closed (4401)
  feed sim-check        Run the simulator's five acted scenarios in text mode over the real endpoint
  feed replay-raw <s>   Replay a captured session byte for byte to the endpoint (--token, --url, --speed)
  data <command>        The long-term data store: find, usage, verify, prune, delete, label (pnpm data for help)

Options
  --transcriber deepgram|script   Default: deepgram if DEEPGRAM_API_KEY is set, else script (fixtures only)
  --extractor gemini|fuzzy|oracle Default: gemini if GEMINI_API_KEY is set, else fuzzy (oracle = fixture events, eval ceiling)
  --channel-map 0=customer,1=crew Override CHANNEL_MAP for this run
  --start-utc <iso>               Override AUDIO_START_UTC for this run
  --no-deliver                    Build orders without sending webhooks
  --no-judge                      Disable LLM tie-breakers for segmentation and roles
  --refresh                       Ignore cached Deepgram responses
  --json                          Print full JSON output
  eval: --layout mono|stereo (default mono), --only id1,id2, --no-compilations, --deliver, --no-webhook-check,
        --via file|lane (default file), --scenario <name> (lane only)
  feed replay: --speed 1|4|max (default max), --via direct|ws, --scenario <name>, --store <id>, --lane <id>,
        --layout mono|stereo; with --via ws: --url (default INGEST_URL), --token (default INGEST_TOKEN, or a
        dev ticket when ENABLE_DEV_ROUTES=true)
`;

function engineOpts(v: Record<string, unknown>): EngineOptions {
  return {
    ...(v.transcriber ? { transcriber: v.transcriber as TranscriberKind } : {}),
    ...(v.extractor ? { extractor: v.extractor as ExtractorKind } : {}),
    noJudge: v["no-judge"] === true,
  };
}

function printRun(r: RunResult): void {
  console.log(`\nRun ${r.run_id}`);
  console.log(`  ${r.transcript.source_file}: ${r.transcript.audio.duration_s}s, ${r.transcript.audio.channels} ch, roles from ${r.transcript.role_source}, start ${r.transcript.audio_start_utc} (${r.transcript.timestamp_source})`);
  for (const o of r.orders) {
    const p = o.payload;
    console.log(`\n  ${p.order_id}  ${p.status.toUpperCase()}${p.review.required ? ` (review: ${p.review.reasons.join(", ")})` : ""}  ${p.times.started_at.slice(11, 19)}-${p.times.ended_at.slice(11, 19)}  $${p.totals.computed.toFixed(2)}${p.totals.spoken_by_crew !== null ? ` (crew said $${p.totals.spoken_by_crew.toFixed(2)})` : ""}`);
    for (const i of p.items) {
      const comps = i.components?.map((c) => `${c.slot}: ${c.catalog_id ?? "none"}`).join(", ");
      const mods = [...i.modifiers, ...(i.components ?? []).flatMap((c) => c.modifiers ?? [])].map((m) => m.id).join(", ");
      console.log(`    + ${i.quantity} x ${i.name}${i.size ? ` (${i.size})` : ""}${comps ? ` [${comps}]` : ""}${mods ? ` {${mods}}` : ""}`);
    }
    for (const n of p.needs_review) console.log(`    ? ${n.quantity} x "${n.raw_text ?? n.catalog_id}" candidates: ${n.candidates.map((c) => `${c.catalog_id} ${c.score}`).join(", ")}`);
    for (const n of p.not_ordered) console.log(`    - ${n.catalog_id ?? n.raw_text} (${n.reason}${n.replaced_by ? ` by ${n.replaced_by}` : ""})`);
    for (const c of p.combo_opportunities) console.log(`    $ ${c.combo_name} would save $${c.savings.toFixed(2)}${c.customer_declined_combo ? " (customer declined the meal)" : ""}`);
    if (p.flags.length) console.log(`    flags: ${p.flags.join(", ")}`);
  }
  if (r.deliveries.length) {
    console.log("\n  Deliveries");
    for (const d of r.deliveries) console.log(`    ${d.webhook_id}  ${d.status}  attempts=${d.attempt_count}  last=${d.last_status_code ?? d.last_error ?? "-"}`);
  }
  const u = r.usage;
  console.log(`\n  Usage: STT ${u.stt.provider} ${u.stt.cached ? "cached (0 min)" : `${u.stt.audio_minutes} min`}; LLM ${u.llm.calls} calls (${u.llm.cached_calls} cached), ${u.llm.input_tokens} in / ${u.llm.output_tokens} out tokens; ${r.timings.total_ms} ms total`);
  const g = u.gemini_today;
  if (g) console.log(`  Gemini today (${g.day} PT): ${g.requests}/${g.cap} requests, tier ${g.tier}${g.exhausted ? ", daily quota used up" : ""}`);
}

function tokenCommand(sub: string | undefined, id: string | undefined, values: Record<string, unknown>): void {
  const engine = createEngine({ transcriber: "script", extractor: "fuzzy", log: () => {} });
  if (sub === "create") {
    const store = values.store as string | undefined;
    const lanes = (values.lanes as string | undefined)?.split(",").map((l) => l.trim()).filter(Boolean) ?? [];
    if (!store || !lanes.length) throw new ConfigError("Usage: pnpm pipeline token create --store <id> --lanes <a,b> [--note text]");
    const t = createToken(engine.db, { storeId: store, lanes, ...(values.note ? { note: values.note as string } : {}) });
    console.log(`Token for ${store} (lanes ${lanes.join(", ")}). Shown once; store it as INGEST_TOKEN on the sender:\n\n${t.token}\n`);
    return;
  }
  if (sub === "list") {
    for (const t of listTokens(engine.db)) {
      const when = (ms: number | null) => (ms ? new Date(ms).toISOString() : "-");
      console.log(`${t.token_id}  ${t.store_id.padEnd(18)} lanes ${t.allowed_lanes}  created ${when(t.created_at)}  last used ${when(t.last_used_at)}${t.revoked_at ? `  REVOKED ${when(t.revoked_at)}` : ""}${t.note ? `  (${t.note})` : ""}`);
    }
    return;
  }
  if (sub === "revoke") {
    if (!id) throw new ConfigError("Usage: pnpm pipeline token revoke <tokenId>");
    console.log(revokeToken(engine.db, id) ? `Revoked ${id}. A running server closes its sessions within a few seconds (4401).` : `No active token ${id}`);
    return;
  }
  throw new ConfigError("Usage: pnpm pipeline token create|list|revoke");
}

async function serveCommand(opts: EngineOptions): Promise<void> {
  const engine = createEngine({ ...opts, log: (m) => console.log(m) });
  const service = await startService(engine);
  const stop = async () => {
    console.log("stopping: finishing open conversations");
    await service.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await new Promise(() => {});
}

async function wsReplayCommand(ref: string, values: Record<string, unknown>): Promise<void> {
  const cfg = getConfig();
  const layout: "stereo" | "mono" = values.layout === "stereo" ? "stereo" : "mono";
  const file = resolveFixture(cfg.paths.fixturesDir, ref, layout);
  const scenario = values.scenario ? loadScenario(cfg.paths.fixturesDir, values.scenario as string) : { ...DEFAULT_SCENARIO, channels: layout };
  const speed = !values.speed || values.speed === "max" ? ("max" as const) : Number(values.speed);
  const token = (values.token as string | undefined) ?? process.env.INGEST_TOKEN;
  const laneId = (values.lane as string | undefined) ?? cfg.laneId.value;
  const storeId = (values.store as string | undefined) ?? cfg.storeId.value;
  let ticket: (() => string) | undefined;
  if (!token) {
    if (!cfg.enableDevRoutes) throw new ConfigError("No ingest token: pass --token or set INGEST_TOKEN (or ENABLE_DEV_ROUTES=true to use a dev ticket)");
    const db = openDb(cfg.paths.dbPath);
    ticket = () => issueTicket(db, { storeId, laneId }).ticket;
  }
  const fixtureId = path.basename(file).split(".")[0];
  const r = await replayOverWs(file, {
    url: (values.url as string | undefined) ?? cfg.ingest.publicUrl,
    ...(token ? { token } : {}),
    ...(ticket ? { ticket } : {}),
    scenario,
    speed,
    laneId,
    storeId,
    ...(fixtureId && existsSync(path.join(cfg.paths.fixturesDir, "audio", `${fixtureId}.timeline.json`)) ? { fixtureId } : {}),
  });
  console.log(`sent ${r.messages} messages (${Math.round(r.bytes / 1024)} KB, ${scenario.codec}) over ${r.sessions} connection(s); closes: ${r.closes.map((c) => c.code).join(", ") || "-"}`);
}

/** The simulator's five acted scenarios in text mode over the real endpoint (free with the keyword extractor). */
async function simCheckCommand(values: Record<string, unknown>): Promise<void> {
  const engine = createEngine({ transcriber: "script", ...engineOpts(values), log: () => {} });
  const results = await runActedScenarios(engine, { checkItems: engine.extractor.name.startsWith("gemini"), log: (m) => console.log(m) });
  for (const r of results) for (const o of r.orders) console.log(`  ${r.id}: ${o.order_id} v${o.version} ${o.status} [${o.items.join(", ")}]${o.flags.length ? ` flags ${o.flags.join(", ")}` : ""}`);
  const ledger = engine.gemini?.ledger();
  console.log(`${results.filter((r) => r.pass).length}/${results.length} pass with ${engine.extractor.name}; LLM ${engine.gemini?.totals.calls ?? 0} calls${ledger ? `; Gemini today ${ledger.requests}/${engine.cfg.geminiDailyCap}` : ""}`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

async function rawReplayCommand(sessionId: string | undefined, values: Record<string, unknown>): Promise<void> {
  if (!sessionId) throw new ConfigError("Usage: pnpm feed replay-raw <session_id> [--url ws://...] [--token sit_...] [--speed 1|max]");
  const engine = createEngine({ transcriber: "script", extractor: "fuzzy", log: () => {} });
  const token = (values.token as string | undefined) ?? process.env.INGEST_TOKEN;
  if (!token) throw new ConfigError("No ingest token: pass --token or set INGEST_TOKEN (the token's store must match the captured session)");
  // A capture belongs to one store: never replay it under another store's token.
  const { manifest } = await readRawSession(engine.data, sessionId);
  const tokenRow = listTokens(engine.db).find((t) => t.token_id === token.split("_")[1]);
  if (tokenRow && tokenRow.store_id !== manifest.store_id) throw new ConfigError(`Session ${sessionId} was captured for ${manifest.store_id}; this token is for ${tokenRow.store_id}`);
  const speed = !values.speed || values.speed === "max" ? ("max" as const) : Number(values.speed);
  const r = await replayRawOverWs(engine.data, sessionId, { url: (values.url as string | undefined) ?? engine.cfg.ingest.publicUrl, token, speed });
  console.log(`replayed ${r.messages} messages (${Math.round(r.bytes / 1024)} KB)${r.incomplete ? "; the capture has an incomplete part (the server stopped mid-session)" : ""}; closes: ${r.closes.map((c) => c.code).join(", ") || "-"}`);
}

/** A fixture id (01_simple, compilation_a) or a path to any audio file. */
function resolveFixture(fixturesDir: string, ref: string, layout: "mono" | "stereo"): string {
  const local = path.resolve(process.env.INIT_CWD ?? process.cwd(), ref);
  if (existsSync(local)) return local;
  const dir = path.join(fixturesDir, "audio");
  const hit = readdirSync(dir).find((f) => f.startsWith(`${ref}.${layout}.`) && f.endsWith(".mp3"));
  if (!hit) throw new ConfigError(`No audio file or fixture named "${ref}"`);
  return path.join(dir, hit);
}

function printReplay(r: ReplayResult, scenario: string): void {
  console.log(`\nReplay ${r.run_id} (scenario ${scenario}): ${r.transcript.utterances.length} utterances, ${r.segmentation.segments.length} conversation(s), ${r.orders.length} order(s)`);
  for (const o of r.orders) {
    const p = o.payload;
    console.log(`  ${p.order_id} v${p.order_version} ${p.status}${p.review.required ? ` (review: ${p.review.reasons.join(", ")})` : ""}  ${p.times.started_at} to ${p.times.ended_at}  ${p.items.map((i) => `${i.quantity}x ${i.name}`).join(", ") || "-"}`);
  }
  for (const d of r.deliveries) console.log(`  ${d.webhook_id}  ${d.status}  attempts=${d.attempt_count}`);
  console.log(`  ${r.timings.total_ms} ms; ${r.usage.deepgram_minutes} Deepgram min; LLM ${r.usage.llm.calls} calls (${r.usage.llm.cached_calls} cached)`);
  const l = latencySummary(r.closeLatencyMs);
  if (l.close_latency_p50_ms !== undefined) console.log(`  close latency (conversation end -> first webhook 2xx): p50 ${l.close_latency_p50_ms} ms, p95 ${l.close_latency_p95_ms} ms over ${r.closeLatencyMs.length} orders`);
  if (r.usage.gemini_today) console.log(`  Gemini today: ${r.usage.gemini_today.requests}/${r.usage.gemini_today.cap} requests`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      transcriber: { type: "string" },
      extractor: { type: "string" },
      "channel-map": { type: "string" },
      "start-utc": { type: "string" },
      "no-deliver": { type: "boolean" },
      deliver: { type: "boolean" },
      "no-judge": { type: "boolean" },
      refresh: { type: "boolean" },
      json: { type: "boolean" },
      layout: { type: "string" },
      only: { type: "string" },
      "no-compilations": { type: "boolean" },
      "no-webhook-check": { type: "boolean" },
      once: { type: "boolean" },
      via: { type: "string" },
      scenario: { type: "string" },
      speed: { type: "string" },
      store: { type: "string" },
      lane: { type: "string" },
      lanes: { type: "string" },
      note: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      order: { type: "string" },
      session: { type: "string" },
      kind: { type: "string" },
      "older-than": { type: "string" },
      sample: { type: "string" },
      version: { type: "string" },
      verdict: { type: "string" },
      author: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "run": {
      if (!arg) throw new ConfigError("Usage: pnpm pipeline run <file.mp3>");
      const engine = createEngine({ ...engineOpts(values), log: values.json ? () => {} : (m) => console.log(m) });
      const result = await runPipeline(engine, path.resolve(process.env.INIT_CWD ?? process.cwd(), arg), {
        ...(values["channel-map"] ? { channelMap: parseChannelMap(values["channel-map"]) } : {}),
        ...(values["start-utc"] ? { audioStartUtc: values["start-utc"] } : {}),
        deliver: !values["no-deliver"],
        refresh: values.refresh ?? false,
      });
      if (values.json) console.log(JSON.stringify({ run_id: result.run_id, orders: result.orders.map((o) => o.payload), deliveries: result.deliveries, usage: result.usage }, null, 2));
      else printRun(result);
      const pending = result.deliveries.filter((d) => d.status === "pending");
      if (pending.length) console.log(`\n  ${pending.length} delivery(ies) scheduled for slow-phase retry. Run "pnpm pipeline worker" or open the web app.`);
      return;
    }
    case "eval": {
      const engine = createEngine({ ...engineOpts(values), log: () => {} });
      const report = await runEval(engine, {
        layout: values.layout === "stereo" ? "stereo" : "mono",
        ...(values.only ? { only: values.only.split(",") } : {}),
        compilations: !values["no-compilations"],
        deliver: values.deliver === true,
        webhook: !values["no-webhook-check"],
        via: values.via === "lane" ? "lane" : "file",
        ...(values.scenario ? { scenario: loadScenario(engine.cfg.paths.fixturesDir, values.scenario) } : {}),
      });
      console.log(formatReport(report));
      return;
    }
    case "resend": {
      if (!arg) throw new ConfigError("Usage: pnpm pipeline resend <order_id>");
      const engine = createEngine({ transcriber: "script", extractor: "fuzzy" });
      const row = outboxForOrder(engine.db, arg)[0];
      if (!row) throw new ConfigError(`No delivery found for order ${arg}${latestOrder(engine.db, arg) ? " (order exists but was never queued)" : ""}`);
      const out = await engine.deliverer.resend(row.webhook_id);
      console.log(`${out.webhook_id}: ${out.status} (attempts ${out.attempt_count}, last ${out.last_status_code ?? out.last_error})`);
      return;
    }
    case "worker": {
      const engine = createEngine({ transcriber: "script", extractor: "fuzzy" });
      const recovered = engine.deliverer.recoverStuck();
      if (recovered) console.log(`recovered ${recovered} stuck delivery(ies)`);
      for (;;) {
        const done = await engine.deliverer.processDue();
        for (const d of done) console.log(`${new Date().toISOString()} ${d.webhook_id}: ${d.status}`);
        if (values.once) return;
        await sleep(5000);
      }
    }
    case "examples":
      return writeExamples(engineOpts(values));
    case "settings": {
      for (const s of servSettings()) console.log(`${s.placeholder ? "PLACEHOLDER" : "set        "}  ${s.key.padEnd(46)} ${s.value}\n             ${s.note}`);
      return;
    }
    case "secret":
      console.log(generateSecret());
      return;
    case "token":
      return tokenCommand(arg, positionals[2], values);
    case "data":
      return dataCommand(createEngine({ transcriber: "script", extractor: "fuzzy", log: () => {} }), arg, values);
    case "feed": {
      if (arg === "serve") return serveCommand(engineOpts(values));
      if (arg === "replay-raw") return rawReplayCommand(positionals[2], values);
      if (arg === "sim-check") return simCheckCommand(values);
      if (arg !== "replay" || !positionals[2]) throw new ConfigError("Usage: pnpm feed replay <fixture-id|file> [--speed 1|4|max] [--scenario name] [--via direct|ws]\n       pnpm feed serve");
      if (values.via === "ws") return wsReplayCommand(positionals[2], values);
      if (values.via && values.via !== "direct") throw new ConfigError(`--via must be direct or ws, got ${values.via}`);
      const engine = createEngine({ ...engineOpts(values), log: values.json ? () => {} : (m) => console.log(m) });
      const file = resolveFixture(engine.cfg.paths.fixturesDir, positionals[2], values.layout === "stereo" ? "stereo" : "mono");
      const scenario = values.scenario ? loadScenario(engine.cfg.paths.fixturesDir, values.scenario) : { ...DEFAULT_SCENARIO, channels: values.layout === "stereo" ? ("stereo" as const) : ("mono" as const) };
      const speed = !values.speed || values.speed === "max" ? ("max" as const) : Number(values.speed);
      if (speed !== "max" && !(speed > 0)) throw new ConfigError(`--speed must be a positive number or max, got ${values.speed}`);
      const result = await replayFile(engine, file, {
        transcriber: engine.streaming,
        scenario,
        speed,
        ...(values.store ? { storeId: values.store } : {}),
        ...(values.lane ? { laneId: values.lane } : {}),
        deliver: !values["no-deliver"],
        // The web app's Live page shows replays as they run.
        onUpdate: liveWriter(engine.db),
      });
      if (values.json) console.log(JSON.stringify({ run_id: result.run_id, orders: result.orders.map((o) => o.payload), deliveries: result.deliveries, usage: result.usage }, null, 2));
      else printReplay(result, scenario.name);
      return;
    }
    default:
      throw new ConfigError(`Unknown command "${cmd}"\n\n${HELP}`);
  }
}

/** Fixture files used for the deliverable examples, one per interesting behaviour. */
const EXAMPLE_FILES = [
  ["01_simple", "Simple order"],
  ["02_combo_slot", "Combo with drink choice and size"],
  ["04_correction", "Correction: Coke replaced by Sprite"],
  ["11_declined_upsell_out_of_stock", "Out of stock, declined meal, combo opportunity"],
  ["14_garbled", "Garbled item routed to needs_review, order flagged for review"],
  ["15_split_payment", "Split payment: two orders, one group_id"],
  ["16_crew_crosstalk", "Crew chatter excluded from the order"],
] as const;

async function writeExamples(opts: EngineOptions): Promise<void> {
  const engine = createEngine({ ...opts, log: () => {} });
  const dir = engine.cfg.paths.examplesDir;
  const index: string[] = [
    "# Example orders",
    "",
    `Generated by \`pnpm pipeline examples\` with ${engine.transcriber.name} and ${engine.extractor.name} from the mono (headset mix) fixture audio. Each folder has the audio, the normalized transcript, the built order with its events, and the signed webhook payload.`,
    "",
    "| Example | Status | Review | Items | Needs review | Not ordered | Flags |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const [id, title] of EXAMPLE_FILES) {
    const src = path.join(engine.cfg.paths.fixturesDir, "audio", `${id}.mono.clean.mp3`);
    const result = await runPipeline(engine, src, { channelMap: null, audioStartUtc: "2026-10-03T18:40:00Z", deliver: true });
    const out = path.join(dir, id);
    mkdirSync(out, { recursive: true });
    copyFileSync(src, path.join(out, "audio.mp3"));
    writeFileSync(path.join(out, "transcript.json"), JSON.stringify(result.transcript, null, 2) + "\n");
    writeFileSync(
      path.join(out, "order.json"),
      JSON.stringify(
        { segmentation: result.segmentation, orders: result.orders.map((o) => ({ order: o.order, events: o.events, build_log: o.build_log, warnings: o.warnings })) },
        null,
        2,
      ) + "\n",
    );
    const payloads = result.orders.map((o) => o.payload);
    writeFileSync(path.join(out, "webhook-payload.json"), JSON.stringify(payloads.length === 1 ? payloads[0] : payloads, null, 2) + "\n");
    const sample = payloads[0];
    if (sample) {
      const body = JSON.stringify(sample);
      const headers = { "content-type": "application/json", "user-agent": engine.cfg.webhook.userAgent, "x-delivery-attempt": "1", ...signedHeaders("whsec_ZXhhbXBsZS1zZWNyZXQtZG8tbm90LXVzZQ==", `${sample.order_id}_v1`, body) };
      writeFileSync(path.join(out, "webhook-headers.json"), JSON.stringify({ note: "Signed with a throwaway example secret, not the dev secret", headers }, null, 2) + "\n");
    }
    for (const p of payloads) {
      index.push(`| [${title}](./${id}/) | ${p.status} | ${p.review.reasons.join(", ") || "-"} | ${p.items.map((i) => `${i.quantity}x ${i.name}`).join(", ") || "-"} | ${p.needs_review.length} | ${p.not_ordered.map((n) => `${n.catalog_id} (${n.reason})`).join(", ") || "-"} | ${p.flags.filter((f) => f !== "placeholder_values").join(", ") || "-"} |`);
    }
    console.log(`examples/${id}: ${payloads.map((p) => p.status).join(", ")}`);
  }
  writeFileSync(path.join(dir, "README.md"), index.join("\n") + "\n");
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError || e instanceof IngestError) {
    console.error(`Error: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
