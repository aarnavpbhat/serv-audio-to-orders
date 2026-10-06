# Serv Audio-to-Orders Sandbox

Turns an HME drive-thru recording (MP3) into structured orders and POSTs each order to a signed webhook. A Next.js app shows every step: waveform, transcript, segmentation, the events the model proposed, the order that code built from them, and every webhook attempt.

**Core principle: the LLM proposes, code decides.** The model never writes the final order. It emits events (`ADD`, `REPLACE`, `CHANGE_QTY`, `READBACK`, ...) that reference catalog IDs. A pure function, `replay(events)`, validates and applies them to build the order, so corrections, cancellations and readbacks are deterministic and unit-testable.

```
MP3 -> ingest -> transcribe -> segment -> extract -> replay -> post-process -> webhook
       ffprobe    Deepgram     rules +    Gemini     pure      buckets,         signed,
       sha256     Nova-3       LLM tie    events     code      combos, flags    outbox + retries
       cache                   breaker
```

## Setup

Requirements: Node 22+ (`.nvmrc`), pnpm 9, macOS (for regenerating fixture audio with the built-in `say` voices; everything else is cross-platform).

```bash
pnpm install
cp .env.example .env        # add DEEPGRAM_API_KEY and GEMINI_API_KEY
pnpm test                   # 107 unit and route tests, no API calls
```

Both providers have free tiers: Deepgram gives $200 of credit (console.deepgram.com) and Gemini has a free API tier (aistudio.google.com). Without keys, the pipeline still runs on fixture audio using the ground-truth transcriber and the keyword fallback extractor.

**Staying on the Gemini free tier.** Google bills Gemini only when the Google Cloud project behind the API key has a billing account linked. Create the key in AI Studio on a project with no billing account; then going over a limit returns a 429 and nothing is charged. The pipeline adds guards on top:

- `GEMINI_DAILY_CAP` (default 200) is a hard stop on requests sent per Pacific-time day (Google's quota day), counted in `.data/gemini-ledger.json` before each request, retries included.
- A 429 that names a per-day quota is not retried; the ledger marks the day used up and later calls are skipped.
- When Gemini is out of budget, or still returns 503 after retries, extraction falls back to the fuzzy extractor (everything lands in `needs_review`) and segmentation keeps its rule-based decision. The run still completes.
- `GEMINI_THINKING` (default `low`) keeps output tokens small; `GEMINI_RPM` (default 10) paces requests.
- Responses are cached in `.cache/llm/`, so reruns of the same audio cost nothing.
- Each run logs tokens and the day's request count, for example `Gemini today (2026-10-04 PT): 14/200 requests`.

Free-tier prompts and responses may be used by Google to improve its products. That is fine for the synthetic fixtures; check with Serv before sending real customer audio transcripts.

## How to run

```bash
pnpm dev                                          # web app + mock webhook on http://localhost:3000
pnpm pipeline run path/to/lane1.mp3               # process a file, deliver orders to WEBHOOK_URL
pnpm pipeline run fixtures/audio/compilation_a.mono.moderate.mp3
pnpm eval                                         # accuracy on every fixture, writes eval/report.json
pnpm pipeline resend <order_id>                   # resend a failed or dead-lettered delivery
pnpm pipeline worker                              # slow-phase retries (the web app runs this for you)
pnpm pipeline examples                            # regenerate examples/
pnpm pipeline settings                            # which Serv-dependent values are still placeholders
pnpm fixtures:build [--all-noise]                 # regenerate fixture audio from fixtures/scripts
pnpm data usage                                   # data store size against DATA_DISK_BUDGET_GB
pnpm data find --order <order_id>                 # everything kept for an order: audio, LLM calls, labels, raw capture
pnpm data verify                                  # re-hash a sample of stored files
pnpm data prune --kind raw --older-than 90d       # list (add --yes to remove) old files of one kind
pnpm data delete --store <store_id>               # list (add --yes to remove) a store's files; orders are kept
pnpm feed replay-raw <session_id> --token sit_... # replay a captured session byte for byte
```

The live service (`pnpm feed serve`) keeps every incoming message (zstd parts, rolled every 60 s or 5 MB), each order version's audio as FLAC, every Deepgram message, every Gemini request and answer, and each session's control events under `.data/blobs/`, catalogued in the `artifacts` table. `DATA_DISK_BUDGET_GB` (default 50) sets the budget: the settings panel warns at 80%, and at 95% raw capture and audio archiving pause (orders keep flowing and are flagged `capture_paused`). `RETENTION_POLICY=keep_all` is the only policy; prune and delete are manual.

Start `pnpm dev` before `pnpm pipeline run` so the mock webhook is listening. If it is not, deliveries go through the fast retry phase (about a minute) and are then scheduled for the slow phase.

Useful flags: `--transcriber deepgram|script`, `--extractor gemini|fuzzy|oracle`, `--channel-map 0=customer,1=crew`, `--start-utc <iso>`, `--no-deliver`, `--no-judge`, `--json`. For eval: `--layout mono|stereo`, `--only 01_simple,04_correction`, `--deliver`.

| Transcriber | What it is |
|---|---|
| `deepgram` | Deepgram Nova-3. Raw responses are cached in `.cache/<sha256>/`, so reruns cost nothing |
| `script` | Fixture ground truth from `<id>.timeline.json`. Free; isolates segmentation and extraction from ASR errors |

| Extractor | What it is |
|---|---|
| `gemini` | Gemini Flash with JSON-schema output (from zod), one repair retry, fuzzy fallback. Responses cached in `.cache/llm/` |
| `fuzzy` | Keyword and alias matching with no context. Everything lands in `needs_review`. Used when the LLM output is unusable |
| `oracle` | Replays the hand-written fixture events. An eval ceiling: any failure here is a pipeline bug, not a model error |

## Web app

| Page | What it shows |
|---|---|
| `/` | Start a run (upload an MP3 or pick a fixture), past runs, sandbox settings with Placeholder badges |
| `/runs/[id]` | Waveform with order segments shaded, speaker lane, transcript colored by crew/customer (click to seek), low-confidence words underlined |
| `/runs/[id]` orders | Three buckets per order (items, needs review, not ordered), flags, combo opportunities, the event log, raw LLM output. Tick "Replay events with the audio" and the order rebuilds itself as the audio plays (the same pure `replay()` runs in the browser) |
| `/runs/[id]` deliveries | Every attempt with time, phase, status code and latency; payload viewer; Resend |
| `/mock-webhook` | Received payloads, signature check result, dedupe, and toggles for 500, 429 (Retry-After) and timeout |
| `/eval` | Latest `eval/report.json`: metrics, the edge-case checklist, per-fixture diffs |

Runs execute server-side in an in-process queue; pages poll for status. The webhook retry worker runs inside the Next.js server (`instrumentation.ts`).

## Code standards

The repo follows the gone-standards engineering standards where they apply:

```bash
pnpm lint                   # ESLint (typescript-eslint; Next.js rules in apps/web)
pnpm typecheck              # tsc --noEmit in every package
pnpm test                   # Vitest, tests colocated with source as *.test.ts
pnpm test:e2e               # Playwright golden path (free providers, no API keys)
```

`.github/workflows/ci.yml` runs all four on pull requests. The e2e test starts its own dev server on port 3100; Next.js allows one dev server per app, so if `pnpm dev` is already running, use `E2E_PORT=3000 pnpm test:e2e`.

Patterns copied from gone-standards and adapted: `packages/pipeline/src/lib/retry.ts` (retry, plus a server-provided delay hint for Gemini's RetryInfo) and `apps/web/lib/error-handler.ts` (every API route returns `{ "error": { "code", "message" } }`). Gemini calls follow the LLM pattern: safety settings pinned on every call, safety blocks detected and logged, a 90 s per-request timeout, and one structured `llm_call` line per request on stderr.

Deliberate deviations:

- **Gemini auth uses an AI Studio API key, not Vertex with ADC.** Vertex has no free tier and needs billing, which this sandbox must never have. Revisit when moving to a paid, production setup.
- **No Firebase Auth, Firestore, Shopify, Sentry or App Hosting.** This is a local Serv sandbox, not a Gone app; the missing authentication and monitoring are listed under Known gaps.
- **No brand color tokens.** The UI uses its own Apple Music style palette.

## Repository layout

```
packages/pipeline/src/
  ingest/        ffprobe, silence check, SHA-256, recording start time
  transcribe/    Transcriber interface, deepgram.ts, normalize.ts, roles.ts, script.ts
  segment/       cue lexicon, gap scoring, LLM tie-breaker
  extract/       Extractor interface, gemini.ts, prompt.ts, llm-schema.ts, validate.ts, fuzzy + oracle
  build/         replay(events) -> order state (pure)
  postprocess/   buckets, combo detection, flags, status (pure)
  webhook/       payload, Standard Webhooks signing, outbox + retries, mock receiver logic
  store/         SQLite (runs, orders, outbox, attempts, mock inbox)
  eval/          comparison, checklist, eval runner, webhook self-check
  fixtures/      audio generator
  cli.ts
apps/web/        Next.js App Router UI and API routes (including /api/mock-webhook)
menu/menu.json   "Sandbox Burger": 27 items, 6 combos, 29 modifiers
config/sandbox.ts every Serv-dependent value, with placeholder tracking
fixtures/        22 scripts, 2 multi-car compilations, generated audio and timelines
examples/        deliverable example orders
eval/report.json latest eval
```

## Pipeline details

**Ingest.** ffprobe for codec, sample rate, channels and duration. Rejects empty, corrupt, too-short or silent (peak below -60 dBFS) files with a failed run record. The SHA-256 keys the transcription cache. The RMS level of every 100 ms window is kept for the noise check in post-processing.

**Transcribe.** Nova-3 with `smart_format`, `punctuate`, `utterances`, `utt_split=0.8`, `filler_words`, and every canonical menu item name as a `keyterm` (Deepgram rejects more than 500 keyterm tokens, so aliases are left to the extractor and fuzzy matcher). Stereo with `CHANNEL_MAP` set uses `multichannel` (roles from channels, preferred). Otherwise `diarize`, then the speaker who greets, asks "anything else" or reads a total is crew; a voice that only says headset chatter is crew too; ties go to a one-line LLM check, then to "first voice is the crew greeting". When diarization puts 90% or more of the lines under one voice (common on mono drive-thru audio, and on most of the synthetic fixtures), roles are inferred per line instead: customer phrases ("can I get", "that's it", "never mind") and crew phrases ("anything else", totals, "okay, large Sprite") decide first, then turn-taking fills the rest, keeping the speaker when a line continues an unfinished one. Those transcripts show `roles from wording`, and each guessed line is marked so the extractor treats the label as a hint. Words under 0.6 confidence are marked `low_conf`. Absolute time = `audio_start_utc` + offset, where the start comes from `AUDIO_START_UTC`, a filename pattern (`20261003T184000Z`, `2026-10-03_18-40-00`), or the file mtime, recorded as `timestamp_source`. 429 and 5xx are retried with backoff. Minutes billed are logged per run.

**Segment.** Every gap between utterances gets a score from crew end cues ("your total is", "pull forward"), crew start cues ("welcome to", "order when you're ready"), silence (above `SEGMENT_GAP_S`, default 8s) and restart cues ("start over", which keep the order together). Score at or above 0.7 is a boundary, below 0.35 is the same order, and in between asks the LLM "does a new customer start here?" with three utterances on either side. No segment exceeds 6 minutes. Crew-to-crew chatter is tagged `non_customer` and excluded from extraction. A first segment with no greeting near the file start is `truncated_start`; a last segment with no closing near the file end is `truncated_end`; no closing followed by silence is abandoned.

**Extract.** One Gemini call per conversation at temperature 0, with the compact catalog, the utterances with IDs and roles (guessed roles shown as `[customer?]`), low-confidence words marked, and the rules (only the customer adds items, questions are INQUIRE, crew suggestions count only when accepted, catalog IDs only). Output is validated against the zod schema; unknown IDs are fuzzy-matched through aliases, and anything still unknown triggers one repair retry, then becomes a `needs_review` line with candidates. Recognition confidence is capped at the mean ASR confidence of the source words.

**Build.** `replay()` applies events in time order. Lines are referenced by the ID of the event that created them, and references follow replacement chains. Removed, replaced, cancelled and out-of-stock lines are kept with a reason. Per-unit modifiers split lines. Combo modifiers land on the component they apply to. Readbacks are compared with the order at that moment. "Can we pay separately?" before anything is ordered splits at each spoken total.

**Post-process.** Every mention lands in exactly one bucket: `items` (recognition and commitment at or above 0.75), `needs_review` (committed but unsure what, with the top 3 catalog candidates; an item nobody could identify lands here whatever its commitment), or `not_ordered` (cancelled, replaced, declined upsell, out of stock, inquired, uncommitted). Combo opportunities (separate lines that fill every slot of a meal for less) are flagged with the savings, never auto-converted. Status precedence: cancelled, incomplete, abandoned, needs_review, completed. `low_audio_quality` is set when mean word confidence is under `LOW_AUDIO_QUALITY_CONF` (0.8) or the conversation's speech-to-noise-floor ratio is under `LOW_AUDIO_SNR_DB` (15 dB); ASR confidence stays high on loud, steady noise, so the level check catches what confidence misses. `non_english` uses Deepgram's language tags or the language the extractor reports.

**Deliver.** Each order is written to an SQLite outbox and sent the moment it is built. Signing follows [Standard Webhooks](https://www.standardwebhooks.com) (verified against the spec's reference vector): `webhook-id` (= `order_id` + version, constant across retries), `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`, plus `x-delivery-attempt`. 10s timeout; any 2xx is success. Network errors, timeouts, 408, 429 and 5xx are retried (Retry-After honored); other 4xx are marked failed with the response body. Fast phase about 1, 2, 4, 8, 16, 32s with full jitter, then 5m, 30m, 2h, 5h, 10h, 10h, then dead letter. For a real AWS endpoint (API Gateway in front of a Lambda), only `WEBHOOK_URL` and `WEBHOOK_SECRET` change; the receiver verifies with any Standard Webhooks library.

## Webhook payload (schema v1.0)

See `examples/*/webhook-payload.json` for real ones. Top-level fields: `schema_version`, `event_type` (`order.completed|cancelled|abandoned|needs_review|incomplete|updated`), `order_id`, `order_version`, `group_id` (shared by split-payment orders), `location_id`, `lane_id`, `status`, `started_at`, `ended_at`, `timestamp_source`, `audio`, `items`, `needs_review`, `not_ordered`, `combo_opportunities`, `customer_declined_combo`, `flags`, `totals` (`computed`, `spoken_by_crew`), `overall_confidence`, `transcript`, `processing`. Additions to the draft schema: `customer_declined_combo` at the top level, `unit_price` on items, and `non_customer: true` on transcript lines that were crew chatter.

## Assumptions and placeholders

Every Serv-dependent value lives in `config/sandbox.ts`, shows a yellow Placeholder badge in the UI, and adds the `placeholder_values` flag to orders until replaced. `pnpm pipeline settings` lists them.

| Assumption | Sandbox placeholder | Replace when |
|---|---|---|
| One lane per audio file | `LOCATION_ID=store_demo_001`, `LANE_ID=lane_1` | Serv shares site and lane IDs |
| Audio is MP3, mono or stereo | Both supported; `CHANNEL_MAP` (e.g. `0=customer,1=crew`) unset means diarization | An HME sample confirms channels |
| Recording wall-clock start is unknown | `AUDIO_START_UTC`, else filename pattern, else file mtime; `timestamp_source` recorded | HME metadata format is confirmed |
| Generic invented menu | `menu/menu.json` ("Sandbox Burger") | Serv names a brand |
| Serv accepts our webhook schema | Schema v1.0 above | Serv reviews it |
| Webhook endpoint | Next.js mock route `/api/mock-webhook` via `WEBHOOK_URL` | Serv shares a URL |
| Signing secret | Generated dev secret in `.data/dev-webhook-secret` unless `WEBHOOK_SECRET` is set | Serv issues one |
| English primary language | `STT_LANGUAGE=multi` (Nova-3 English/Spanish code-switching); non-English customer speech sets `non_english`, still processed | Serv says otherwise |
| Batch per file, not live streaming | Each order is sent the moment it is built | Real-time is required |
| Send all order outcomes | completed, cancelled, abandoned, needs_review, incomplete | Serv narrows it |
| Audio may go to third-party APIs | Deepgram and Gemini allowed in the sandbox | Serv confirms data rules |
| Spoken totals include tax | `TAX_RATE=0` | The site is known |
| Bucket thresholds | 0.75 recognition and commitment | Real audio with actual orders is available |

One deliberate change from the handoff doc: the default STT language is `multi` rather than `en`. Nova-3 multilingual supports keyterm prompting and returns a per-word language, which gives the `non_english` flag without a second pass. Set `STT_LANGUAGE=en` to go back.

## Synthetic test data

`fixtures/scripts/*.json` holds 22 scripted conversations. Each has turns (speaker, text, pause), hand-written events, and an expected block (items, needs_review, not_ordered, flags, status, group). `pnpm fixtures:build` renders them with two macOS voices (free, local), writes stereo (customer left, crew right, 16 kHz) and a mono headset mix (band-limited, 8 kHz), mixes in synthetic engine idle, wind and car radio at clean, moderate or heavy levels, and concatenates scripts into two multi-car compilations. Each file gets a `.timeline.json` with exact utterance and order spans.

Every row of the edge-case checklist has a fixture (rows 27 and 28 are exercised by the webhook self-check in `pnpm eval` and by unit tests).

## Eval results

`pnpm eval` reports segmentation (missed and extra orders, boundary error), item precision and recall (exact match on catalog ID, quantity, size, modifiers and combo components), bucket accuracy, status and flags (exact match, ignoring `placeholder_values`), and pass or fail per checklist row. Results go to the console and `eval/report.json`; the `/eval` page reads the report.

| Configuration | Fixtures passed | Item P / R | Bucket acc. | Segments | Notes |
|---|---|---|---|---|---|
| ground-truth transcript + oracle events | 24/24 | 100% / 100% | 100% | 34/34 | Pipeline ceiling |
| ground-truth transcript + keyword fallback | 0/24 | 100% / 0% | 1% | 34/34 | Fallback sends everything to needs_review, by design |
| Deepgram Nova-3 + Gemini 3.5 Flash-Lite | 24/24 | 100% / 100% | 100% | 34/34 | 2026-10-04, mono fixtures, prompt extract-v4, 34 LLM calls, about 102k tokens, 0 new Deepgram min (cached). The first run that day scored 12/24 (93.5% / 80.6%): diarization heard one voice, so every line was labeled crew. One run at temperature 0; expect some run-to-run variation, and these fixtures informed the fixes |
| Deepgram Nova-3 + Gemini Flash (latest alias) | not measured | | | | Free tier allows 20 requests per day per model, and 503 retries count against it, so a full eval (about 34 requests) does not fit in one day |

## Known gaps

- **Synthetic audio:** TTS voices and mixed noise are cleaner and more predictable than real drive-thru audio. Accuracy on real HME files is unknown until we test them.
- **Uncalibrated thresholds:** the 0.75 bucket thresholds and the low-audio-quality cutoffs (confidence 0.8, 15 dB) are guesses until we have real audio with actual orders.
- **Channel layout:** speaker roles rely on diarization, or on wording when diarization hears one voice, unless HME audio has separate crew and customer channels. Wording-based roles were 98% right on the fixture lines (229 of 234), against 74% from diarization alone; the cue lists were tuned on those same fixtures, so expect less on real audio.
- **Wall-clock time:** car matching needs real start times; the sandbox uses a configured value.
- **Single lane:** dual-lane sites and lane bleed are out of scope.
- **Batch, not streaming:** orders are sent as soon as each is built, but only after the file is processed.
- **Generic menu:** real menus have more items, regional names and promos.
- **Gemini model choice:** the default is `gemini-3.5-flash-lite`, which completed the eval inside the free tier. `gemini-flash-latest` may extract better, but its free tier allows 20 requests per day, too few for a full eval; set `GEMINI_MODEL=gemini-flash-latest` to try it on single runs. Quotas are per model, and the pipeline keeps one ledger per model in `.data/`.
- **Free-tier limits:** LLM rate limits and 503 "high demand" responses on the free tier slow batch runs (client-side limit `GEMINI_RPM`, default 10; daily cap `GEMINI_DAILY_CAP`, default 200).
- **Data handling:** sending audio to Deepgram and an LLM provider is assumed OK pending Serv's confirmation.
- **Orders spanning files:** flagged as incomplete, not stitched together.
- **Sandbox infrastructure:** SQLite and an in-process queue suit one machine; a deployment would move the outbox and worker to managed services.
- **No held-out test set:** the same 24 fixtures guided the prompt and cue-list tuning and measured the result, and the real-provider eval was a single run. 24/24 shows the approach can work, not that it generalizes.
- **Stereo path untested live:** every Deepgram call so far was mono with diarization. The multichannel path is unit-tested but has never been sent to Deepgram, and the stereo layout has not been evaluated (`pnpm eval --layout stereo`, about 16 Deepgram minutes).
- **Tax:** `TAX_RATE=0`. Real spoken totals include tax, so `total_mismatch` will fire on most real orders until the rate is set per site.
- **No authentication:** anyone who can reach the web app can start runs (spending Deepgram credit and Gemini quota), upload files, read every payload in the mock inbox and change its failure mode. Keep it on localhost.
- **Runs lost on restart:** the run queue lives in memory. A server restart drops queued runs and leaves their rows `queued` or `running`. Webhook deliveries are safe; the outbox recovers.
- **Serial queue:** one run at a time, and Gemini is paced at 10 requests per minute, so a recording with 60 cars needs at least 6 minutes of extraction.
- **Retries need a running process:** slow-phase webhook retries only happen while `pnpm dev` or `pnpm pipeline worker` is running.
- **No human-review loop:** the schema defines `order.updated` and `order_version`, but nothing produces a version 2 yet.
- **Payload carries the transcript:** each webhook includes the conversation's transcript, which Serv may not want for size or privacy reasons.
- **Greedy combo search:** combo opportunities are found meal by meal in menu order, so with many items the best combination can be missed.
- **No error monitoring:** dead-lettered webhooks and failed runs show in the UI and logs only; nothing alerts.

### Ingest authentication
The WebSocket endpoint uses per-store bearer tokens. A token proves the caller
holds a secret we issued, not that the caller is a genuine HME base station,
and a leaked token works until it is revoked. HME's installation guide shows
only a provider URL and port, so we could not confirm what authentication HME
supports. Before production: confirm HME's connection handshake, then add
mutual TLS (client certificates), an IP allowlist for HME and store addresses,
or signed timestamped connect requests. Each plugs into the IngestAuth
interface. Also needed: a token rotation schedule and managed TLS.

### Long-term data storage
The sandbox keeps everything (raw capture, conversation audio, Deepgram and
Gemini responses, orders and versions, delivery attempts, labels) on local
disk under .data/, indexed in SQLite. This proves the layout, not the
infrastructure. Before production: move files to object storage (S3, same
key layout) and metadata to Postgres; add lifecycle tiers (recent data on
fast storage, older data on archive tiers); encrypt at rest and limit access
by role; agree a retention policy with Serv, since recordings contain
customer and crew voices and consent and voice-data rules vary by state;
support deletion per store on request; add scheduled exports for analytics.
