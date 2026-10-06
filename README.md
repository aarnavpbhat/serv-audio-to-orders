# Serv Audio-to-Orders Sandbox

A live drive-thru order service, built as a sandbox. HME base stations stream lane audio over a WebSocket (or a recording is replayed as if it were live). Each lane's conversations are tracked as they happen, each finished conversation becomes a structured order, and the order is POSTed to a signed webhook within seconds, with corrections sent as new versions. A Next.js app shows it all: lanes live, every past run step by step, Test Lab (guided tests with a scorecard, using a browser base station), a review queue, every order, and the eval.

**Core principle: the LLM proposes, code decides.** The model never writes the final order. It emits events (`ADD`, `REPLACE`, `CHANGE_QTY`, `READBACK`, ...) that reference catalog IDs. A pure function, `replay(events)`, validates and applies them to build the order, so corrections, cancellations and readbacks are deterministic and unit-testable.

```
HME base station ─ WebSocket /hme/v1/stream ─┐      (token auth, raw capture, decoders)
recording (pnpm feed replay / pipeline run) ──┼─> input layer -> lane (one per store + lane)
browser simulator ───────────────────────────┘        streaming transcriber (Deepgram)
                                                       conversation tracker (cues, vehicle and stream events, timers)
                                                       finished conversation -> extract (Gemini) -> replay -> post-process
                                                       -> order.finalized / order.updated -> signed webhook (outbox + retries)
```

Everything kept along the way (raw capture, order audio, provider responses, events, labels) goes to a local data store under `.data/`, catalogued in SQLite.

## Setup

Requirements: Node 22+ (`.nvmrc`), pnpm 9, macOS (for regenerating fixture audio with the built-in `say` voices; everything else is cross-platform).

```bash
pnpm install
cp .env.example .env        # add DEEPGRAM_API_KEY and GEMINI_API_KEY
pnpm test                   # 252 unit and route tests, no API calls
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

To prove each part works, step by step with costs, see [TESTING.md](TESTING.md).

```bash
pnpm dev                                          # web app + mock webhook on http://localhost:3000
pnpm pipeline run path/to/lane1.mp3               # process a file, deliver orders to WEBHOOK_URL
pnpm pipeline run fixtures/audio/compilation_a.mono.moderate.mp3
pnpm eval                                         # accuracy on every fixture, writes eval/report.json
pnpm pipeline resend <order_id>                   # resend a failed or dead-lettered delivery
pnpm pipeline worker                              # slow-phase retries (the web app runs this for you)
pnpm pipeline examples                            # regenerate examples/
pnpm pipeline settings                            # which Serv-dependent values are still placeholders
pnpm feed serve                                   # the live service: HME WebSocket endpoint + lanes (127.0.0.1:8787)
pnpm pipeline token create --store s1 --lanes lane_1,lane_2   # an ingest token for a base station (shown once)
pnpm feed replay lane_stream_a --speed 1          # replay a recording as a live feed (orders show on /orders)
pnpm feed replay 01_simple --via ws --scenario codec-mulaw   # ...as a fake base station over the real socket
pnpm feed sim-check                               # the simulator's five acted scenarios, typed, over the real endpoint
pnpm pipeline heldout import rec.m4a --name heldout_01      # add a human recording to the held-out set
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

Useful flags: `--transcriber deepgram|script`, `--extractor gemini|fuzzy|oracle`, `--channel-map 0=customer,1=crew`, `--start-utc <iso>`, `--no-deliver`, `--no-judge`, `--live-stt`, `--json`. For eval: `--layout mono|stereo`, `--only 01_simple,04_correction`, `--scenario vehicle-events`, `--deliver`, `--yes` (allow Deepgram minutes that are not cached; without it the eval stops and says how many).

Every file, whether from `pnpm pipeline run`, a web upload or the eval, is replayed into a lane at max speed (plan D1), so files and live feeds share one tracker, finalize and delivery. With a Deepgram key, a file is transcribed once with the prerecorded API and cached, and its utterances are released as the audio arrives. HME connections and the simulator's mic stream to Deepgram live. `--live-stt` streams files live as well (billed every run).

| Transcriber | What it is |
|---|---|
| `deepgram` | Deepgram Nova-3: prerecorded for files (raw responses cached in `.cache/<sha256>/`, so reruns cost nothing), live streaming for HME connections and the simulator |
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
| `/live` | Disabled for now (answers 404, not in the sidebar). Test Lab and the simulator show the same lane view for the stream they start; the code stays in `components/live/` |
| `/runs/[id]` known answer | Fixture runs only: Expected vs Extracted, side by side with every difference listed, scored automatically (no review prompt) |
| `/orders` | Every order (latest version), read only, filtered by status, review flag, store, lane and date |
| `/testlab` | Dev only. Test Lab: pick a scenario, follow the script on screen, get a scorecard (see "Test Lab" below). `/testlab/history` shows results over time |
| `/simulator` | Dev only. The manual base station (every control, no script), linked from Test Lab's Advanced section (see "Simulator" below) |
| `/review` | Dev only. The review queue: flagged orders nobody knows the answer to (see "Review queue" below). The sidebar badge shows how many |
| `/eval` | Latest `eval/report.json`: Layer A (heard), Layer B (rung up, against POS tickets), live-path metrics, the checklist, per-fixture diffs, and the held-out set's own report |

Runs execute server-side in an in-process queue; pages poll for status. The webhook retry worker runs inside the Next.js server (`instrumentation.ts`). The live service is a separate process (`pnpm feed serve`); the web app reads what it writes to the shared SQLite database. Dev-only pages and routes answer only with `ENABLE_DEV_ROUTES=true` and a local request.

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
  input/         AudioSource, canonical PCM, decoders, file replay, scenarios, HME placeholder parser, ingest auth, fake base station
  lane/          lane session, conversation tracker, Deepgram live, file transcriber, live feed, recorder, replay
  server/        the HME WebSocket endpoint and the live service
  orders/        one finished conversation -> order versions -> outbox
  data/          blob store, artifact catalog, raw capture, labels, pnpm data
  review/        resolving an order that needs review
  sim/           simulator back end: save as fixture, acted scenarios
  ingest/        ffprobe, silence check, SHA-256, recording start time
  transcribe/    Transcriber interface, deepgram.ts, normalize.ts, roles.ts, script.ts
  segment/       cue lexicon, gap scoring, LLM tie-breaker (used by the tracker)
  extract/       Extractor interface, gemini.ts, prompt.ts, llm-schema.ts, validate.ts, fuzzy + oracle
  build/         replay(events) -> order state (pure)
  postprocess/   buckets, combo detection, flags, status (pure)
  webhook/       payload, Standard Webhooks signing, outbox + retries, mock receiver logic
  store/         SQLite (runs, orders and versions, outbox, attempts, mock inbox, live events), raw capture parts
  eval/          comparison, checklist, eval runner, live-path checks, POS matcher (Layer B), held-out set, webhook self-check
  fixtures/      audio generator
  cli.ts
apps/web/        Next.js App Router UI and API routes (including /api/mock-webhook)
menu/menu.json   "Sandbox Burger": 27 items, 6 combos, 29 modifiers
config/sandbox.ts every Serv-dependent value, with placeholder tracking
fixtures/        24 scripts, 2 compilations and 2 lane streams, scenarios, POS window changes, held-out set (to record)
examples/        deliverable example orders
eval/report.json latest eval
V2-PROGRESS.md   how v2 was built, step by step, with every decision the plan left open
```

## Pipeline details

**Ingest.** ffprobe for codec, sample rate, channels and duration. Rejects empty, corrupt, too-short or silent (peak below -60 dBFS) files with a failed run record. The SHA-256 keys the transcription cache. The RMS level of every 100 ms window is kept for the noise check in post-processing.

**Transcribe.** Nova-3 with `smart_format`, `punctuate`, `utterances`, `utt_split=0.8`, `filler_words`, and every canonical menu item name as a `keyterm` (Deepgram rejects more than 500 keyterm tokens, so aliases are left to the extractor and fuzzy matcher). Stereo with `CHANNEL_MAP` set uses `multichannel` (roles from channels, preferred). Otherwise `diarize`, then the speaker who greets, asks "anything else" or reads a total is crew; a voice that only says headset chatter is crew too; ties go to a one-line LLM check, then to "first voice is the crew greeting". When diarization puts 90% or more of the lines under one voice (common on mono drive-thru audio, and on most of the synthetic fixtures), roles are inferred per line instead: customer phrases ("can I get", "that's it", "never mind") and crew phrases ("anything else", totals, "okay, large Sprite") decide first, then turn-taking fills the rest, keeping the speaker when a line continues an unfinished one. Those transcripts show `roles from wording`, and each guessed line is marked so the extractor treats the label as a hint. Words under 0.6 confidence are marked `low_conf`. Absolute time = `audio_start_utc` + offset, where the start comes from `AUDIO_START_UTC`, a filename pattern (`20261003T184000Z`, `2026-10-03_18-40-00`), or the file mtime, recorded as `timestamp_source`. 429 and 5xx are retried with backoff. Minutes billed are logged per run.

**Live input.** An HME base station connects to `/hme/v1/stream` (path and wire format are PLACEHOLDERS until HME documents them; the handshake, message format and connection handling live in `packages/pipeline/src/input/hme/`; the server around them is generic). It authenticates with a per-store bearer token and names its lane and audio format. Binary messages are audio in the declared codec (PCM, mu-law, a-law, Opus, or MP3, AAC, WAV, Ogg or FLAC through ffmpeg); text messages are JSON control events (`vehicle_arrived`, `vehicle_departed`, `stream_paused`, `stream_resumed`). Every message is captured raw before decoding. Audio becomes canonical 16 kHz PCM per channel, timed by our receive clock (`time_basis: receive_clock`; the service checks the machine's NTP offset at start). A replayed file uses its recording time instead (`recording_metadata`).

**Conversation tracker.** One lane per store and lane, surviving reconnects. Each final utterance goes to a state machine (IDLE, ACTIVE, CLOSING, FINALIZED). A conversation opens on a greeting, a customer line, or a car arriving followed by a greeting. It moves to CLOSING on a crew closing cue ("pull forward", "see you at the window"). It finalizes after `CLOSE_SETTLE_S` (3 s) without customer speech, after `IDLE_TIMEOUT_S` (45 s) of silence, when the next car starts, or at the 6 minute cap. A disconnect holds the conversation for `RECONNECT_GRACE_S` (180 s). A customer line within `REOPEN_WINDOW_S` (20 s) of finalizing reopens it, and the order is resent as `order.updated` version 2. Gray-zone "is this a new car?" questions get one LLM try with a 3 s deadline, no retries, and are skipped when the per-minute slot is busy; the rules decide otherwise. Timers never run past speech that is still being transcribed. Every decision is logged with its trigger and signals. The gap scoring, cue lexicon and chatter tagging are v1's segmentation rules, reused.

**Extract.** One Gemini call per conversation at temperature 0, with the compact catalog, the utterances with IDs and roles (guessed roles shown as `[customer?]`), low-confidence words marked, and the rules (only the customer adds items, questions are INQUIRE, crew suggestions count only when accepted, catalog IDs only). Output is validated against the zod schema; unknown IDs are fuzzy-matched through aliases, and anything still unknown triggers one repair retry, then becomes a `needs_review` line with candidates. Recognition confidence is capped at the mean ASR confidence of the source words.

**Build.** `replay()` applies events in time order. Lines are referenced by the ID of the event that created them, and references follow replacement chains. Removed, replaced, cancelled and out-of-stock lines are kept with a reason. Per-unit modifiers split lines. Combo modifiers land on the component they apply to. Readbacks are compared with the order at that moment. "Can we pay separately?" before anything is ordered splits at each spoken total.

**Post-process.** Every mention lands in exactly one bucket: `items` (recognition and commitment at or above 0.75), `needs_review` (committed but unsure what, with the top 3 catalog candidates; an item nobody could identify lands here whatever its commitment), or `not_ordered` (cancelled, replaced, declined upsell, out of stock, inquired, uncommitted). Combo opportunities (separate lines that fill every slot of a meal for less) are flagged with the savings, never auto-converted.

**Outcome.** Status is how the visit ended: `completed` (a closing cue after an item), `cancelled`, `abandoned` (the car left: a `vehicle_departed` event, the crew saying so, or the next car arriving), or `undetermined` (no evidence either way). A pause or a dropped connection never sets the outcome by itself (D10). `outcome_evidence` lists what decided it; events that were only context are marked so. Review is separate and can sit on any status: `review.required` with reasons (`unclear_items`, `readback_mismatch`, `total_mismatch`, `missing_required_slot`, `low_audio_quality`, `stream_gap`, `transcript_gap`, `outcome_undetermined`, `roles_guessed_low_agreement`, `safety_cap` for a quantity above 10 or a total above $150). `low_audio_quality` is set when mean word confidence is under `LOW_AUDIO_QUALITY_CONF` (0.8) or the conversation's speech-to-noise-floor ratio is under `LOW_AUDIO_SNR_DB` (15 dB). `non_english` uses Deepgram's language tags or the language the extractor reports.

**Deliver.** Each order version is written to an SQLite outbox and sent the moment it is built. Version N waits until version N-1 is delivered or dead-lettered, so a receiver sees them in order. Signing follows [Standard Webhooks](https://www.standardwebhooks.com) (verified against the spec's reference vector): `webhook-id` (= `order_id` + version, constant across retries), `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`, plus `x-delivery-attempt`. 10s timeout; any 2xx is success. Network errors, timeouts, 408, 429 and 5xx are retried (Retry-After honored); other 4xx are marked failed with the response body. Fast phase about 1, 2, 4, 8, 16, 32s with full jitter, then 5m, 30m, 2h, 5h, 10h, 10h, then dead letter. For a real AWS endpoint (API Gateway in front of a Lambda), only `WEBHOOK_URL` and `WEBHOOK_SECRET` change; the receiver verifies with any Standard Webhooks library.

## Webhook payload (schema 2.0)

See `examples/*/webhook-payload.json` for real ones. `event_type` is `order.finalized` for version 1 and `order.updated` for later versions (a reopen, late evidence that changes the outcome, or a person resolving a review), which keep the `order_id` and add `supersedes_version` and `correction_reason`. The `webhook-id` header is `{order_id}_v{order_version}`, so retries of one version dedupe and each version is distinct; receivers should keep the highest version per order (the mock receiver does).

Top-level fields: `schema_version`, `event_type`, `order_id`, `order_version`, `supersedes_version`, `correction_reason`, `group_id` (shared by split-payment orders), `store_id`, `lane_id`, `session_id`, `status`, `outcome_evidence`, `review`, `times` (`started_at`, `ended_at`, `time_basis`, `received_at`, `finalized_at`), `audio_ref` (session, sample range, archive URI), `source` (`hme_ws`, `file_replay` or `rtsp`; codec in; channels; channel roles), `items`, `needs_review`, `not_ordered`, `combo_opportunities`, `customer_declined_combo`, `flags`, `totals` (`computed`, `spoken_by_crew`), `overall_confidence`, `transcript` (D9; guessed roles marked `speaker_guessed`), `processing`.

## Assumptions and placeholders

Every Serv-dependent value lives in `config/sandbox.ts`, shows a yellow Placeholder badge in the UI, and adds the `placeholder_values` flag to orders until replaced. `pnpm pipeline settings` lists them.

| Assumption | Sandbox placeholder | Replace when |
|---|---|---|
| HME wire format | PLACEHOLDER: `/hme/v1/stream`, audio as binary in a declared codec, events as JSON text (`src/input/hme/`) | HME documents its streaming interface |
| Store and lane IDs | Live: the store comes from the ingest token, the lane from the connection. Replays: `STORE_ID=store_demo_001`, `LANE_ID=lane_1` | Serv shares site and lane IDs |
| Audio codec and channels | Any whitelisted codec, mono or stereo; `CHANNEL_MAP` (e.g. `0=customer,1=crew`) unset means diarization | An HME sample confirms channels |
| Recording wall-clock start is unknown | `AUDIO_START_UTC`, else filename pattern, else file mtime; `timestamp_source` recorded | HME metadata format is confirmed |
| Generic invented menu | `menu/menu.json` ("Sandbox Burger") | Serv names a brand |
| Serv accepts our webhook schema | Schema 2.0 above | Serv reviews it |
| Webhook endpoint | Next.js mock route `/api/mock-webhook` via `WEBHOOK_URL` | Serv shares a URL |
| Signing secret | Generated dev secret in `.data/dev-webhook-secret` unless `WEBHOOK_SECRET` is set | Serv issues one |
| English primary language | `STT_LANGUAGE=multi` (Nova-3 English/Spanish code-switching); non-English customer speech sets `non_english`, still processed | Serv says otherwise |
| Close timing | Settle 3 s after a closing cue, idle 45 s, reopen window 20 s, reconnect grace 180 s | Real traffic shows the right trade-off |
| Send all order outcomes | completed, cancelled, abandoned, undetermined, each with a review flag | Serv narrows it |
| POS tickets for Layer B | Synthetic tickets from the fixtures' expected orders | Serv shares POS data |
| Audio may go to third-party APIs | Deepgram and Gemini allowed in the sandbox | Serv confirms data rules |
| Spoken totals include tax | `TAX_RATE=0` | The site is known |
| Bucket thresholds | 0.75 recognition and commitment | Real audio with actual orders is available |

One deliberate change from the handoff doc: the default STT language is `multi` rather than `en`. Nova-3 multilingual supports keyterm prompting and returns a per-word language, which gives the `non_english` flag without a second pass. Set `STT_LANGUAGE=en` to go back.

## Configuration

`.env` holds the keys and any overrides; nothing else needs setting for the sandbox. Variables added in v2:

| Variable | Default | What it does |
|---|---|---|
| `STORE_ID` (was `LOCATION_ID`), `LANE_ID` | `store_demo_001`, `lane_1` | Store and lane for replays (live sessions get them from the token and connection) |
| `INGEST_HOST`, `INGEST_PORT` | `127.0.0.1`, `8787` | Where `pnpm feed serve` listens. A non-local address needs TLS |
| `INGEST_TLS_CERT`, `INGEST_TLS_KEY` | unset | TLS for the endpoint |
| `ALLOW_INSECURE_WS` | `false` | Allow a non-local address without TLS (trusted networks only) |
| `INGEST_AUTH_ALLOW_QUERY` | `false` | Accept `?token=` as well as the `Authorization` header |
| `INGEST_URL` | `ws://127.0.0.1:8787` | The endpoint as clients reach it (the simulator, `--via ws`) |
| `INGEST_TOKEN` | unset | Sender side only: the token `pnpm feed replay --via ws` and `feed replay-raw` send when `--token` is not given |
| `ENABLE_DEV_ROUTES` | `false` | Simulator, review screen, ingest tickets. Local requests only; never on a server reachable by others, or behind a proxy |
| `CLOSE_SETTLE_S`, `IDLE_TIMEOUT_S`, `RECONNECT_GRACE_S`, `REOPEN_WINDOW_S`, `JUDGE_TIMEOUT_MS` | 3, 45, 180, 20, 3000 | Tracker timers |
| `DEEPGRAM_IDLE_CLOSE_S` | 30 | Close an idle Deepgram live connection after this long (reopened on resume) |
| `REVIEW_MAX_QUANTITY`, `REVIEW_MAX_TOTAL` | 10, 150 | The model safety cap (D13): above either, the order goes to review |
| `DATA_DISK_BUDGET_GB` | 50 | Data store budget: warn at 80%, pause raw capture and audio archiving at 95% |
| `RETENTION_POLICY` | `keep_all` | The only policy; `pnpm data prune` and `pnpm data delete` are manual |

## Test Lab

`/testlab` (with `ENABLE_DEV_ROUTES=true`, `pnpm dev` and `pnpm feed serve` running) tests the whole live path with your own voice, guided:

1. **Setup** (remembered in your browser): check the microphone (say something; the meter turns green), and pick who is testing.
   - **Just me, both parts:** you read every line; the script says whose turn it is.
   - **Just me, robot crew:** the laptop speaks the crew's lines and you answer as the customer. Turn the volume up: echo cancellation is off so the mic hears the laptop, like a headset mix.
   - **Two people (a friend plays the crew):** sit side by side about an arm's length from the laptop and talk at a normal volume.
   - Under Advanced, **type instead of speaking**: each line is sent as text, free (no Deepgram).
2. **Pick a test:** ten scenarios (`testlab/scenarios/*.json`), each with what it checks and how long it takes: simple order, change of mind, a meal's drink choice, a late add-on, never mind, drive off, a connection blip, a lost connection (waits for the 3 minute reconnect grace), a mumbled item, and two cars. Or **free play** with no script.
3. **Run:** press Start, then read the line on screen. It moves on when the transcript has the line from the right speaker (Space or Next moves on by hand; Skip leaves a line out). The app performs the car and connection actions itself and says so in a banner. End session and Discard are always there; manual controls are under Advanced.
4. **Scorecard:** Pass or Fail, Expected vs Extracted, and for each difference where it went wrong. The run is replayed with the script's exact words through the same tracker and extractor (in a throwaway database): a mistake only the live run made was **heard wrong** (transcription), one the perfect words also made was **understood wrong** (extraction), and a missing, extra or unreopened order is **timing** (the tracker). Also: word error rate per role, how many lines got the right speaker, and the time from the end of the conversation to the order being sent. Retry, Next test, Save as fixture or Save as held-out.
5. **History** (`/testlab/history`): pass rate, word error rate, role accuracy and speed per scenario, filtered by tester mode and speech model.

In free play, after End session you pick what was actually ordered from the menu; that answer is the ground truth the run is scored against. Skip it, and anything flagged goes to the review queue.

## Stopping a stream: End session and Discard

Every live stream (Test Lab, the simulator, a WebSocket replay, a real connection) stops in one click from the page that started it (decision E3); a WebSocket replay stops with Ctrl+C or `POST /api/sessions/:id/stop` (ids from `GET /api/sessions`):

| Action | Open conversation | Webhook | Session marked |
|---|---|---|---|
| End session | Finalized now, outcome from evidence (usually `undetermined`), flag `ended_by_operator` | Sent | `ended` |
| Discard (asks first) | Dropped, no order | None | `discarded`: data kept and tagged, left out of metrics (E4) |

Behind both is `POST /api/sessions/:id/stop {"mode": "end" | "discard"}` (dev routes, local only), forwarded to the feed service. It settles the lane, closes the client socket with `4000 stopped by operator`, closes Deepgram, kills the decoder, and closes the reopen window. Stopping twice, from another tab, or during a reconnect backoff is fine, and a stopped session never reconnects. A queued or running file run has a Cancel button.

## Review queue

The review queue (`/review`) holds one kind of order: one the system flagged (`review.required`, any status) where nobody knows the right answer except by listening (E5). Fixture runs, where the script says what was ordered, never go there; their run page shows Expected vs Extracted instead (E6). Completed orders with no flag are on `/orders`.

Each item says why it was flagged in plain words ("We heard a shake but not which one"), plays exactly the flagged lines with 2 s either side (from the order's archived audio, or the run's file), shows those lines and the closest menu candidates, and lets you pick a candidate, mark an item not ordered, change a quantity, or change the outcome. Save sends the next version as `order.updated`; **Looks right** keeps the order as sent, clears the flag with a note, and sends `order.updated` too.

## Simulator

`/simulator` (with `ENABLE_DEV_ROUTES=true` and `pnpm feed serve` running) is a fake HME base station in the browser. It connects to the same `/hme/v1/stream` endpoint HME will use, with a one-time ticket, so everything after the input layer is the real pipeline. The browser never sees the provider keys.

- **Text mode** (free): type what the crew and the customer say. Lines skip transcription, so this tests the tracker, extraction and delivery at no cost.
- **Microphone**: speak; the page converts the mic to 16 kHz PCM (or mu-law) in an AudioWorklet. This uses Deepgram live: the page shows the minutes and stops after 15 minutes, or after 30 s with no audio (both can be changed).
- **Buttons**: Car arrived and Car left, Pause and Resume stream, Drop connection (reconnects at 2, 4 and 8 s like HME, or stays down), and engine or heavy noise mixed under the mic. Hold C while the crew speaks to label it; the labels are saved with the fixture and never sent.
- **Live panel**: the lane view (connection, transcript, tracker, the order building), plus the mock inbox.
- **Save as fixture**: after Stop, saves the session (raw capture, audio, timeline, events) to `fixtures/live/<name>/` with the expected orders you write in the form. Tick "held out" to save to `fixtures/heldout/` instead (see `fixtures/heldout/README.md`).

The five acted scenarios from the plan (a simple order, Coke changed to Sprite, a late "add a water", the car leaving mid-order, the connection dropping with no reconnect) run typed over the real endpoint with `pnpm feed sim-check`.

## Brand

The app uses Serv's own colors, font and logo, taken from servtech.co's stylesheet and assets (2026-10-05), never approximated: the landing page's colors for the default dark theme (background `#0a0a0c`, text `#e8e8e8`, navy `#132a49`, blue `#5a7fae`), Serv's `:root` tokens for the light theme (`--serv-navy`, `--ljs-blue`), its `.25rem` radius, Inter for body text (its default font, via `next/font`), General Sans for headings (its landing face, self-hosted from `apps/web/app/fonts/`), and its white logo. Every value is in `apps/web/app/globals.css` with its source; values marked derived are tints of a Serv value for surfaces the site does not define, or for 4.5:1 text contrast (checked in both themes by `e2e/brand.spec.ts`). Status colors stay separate from the brand accent. General Sans comes from Fontshare under the ITF Free Font License (`apps/web/app/fonts/GeneralSans-LICENSE.txt`), which allows self-hosting in our own app but not redistribution: keep this repo private, or remove the font file before publishing it.

## Decisions (v2.1)

| # | Decision | What was built |
|---|---|---|
| E1 | A car arrives and leaves, nobody orders | Sent as `abandoned`, no items, flag `no_speech`, review not required, no model call |
| E2 | No vehicle event and no speech | Nothing opens, nothing is sent |
| E3 | Two ways to stop a stream | End session (finalize and send) and Discard (drop, send nothing) |
| E4 | Data from discarded sessions | Kept, tagged `discarded` in its raw capture manifest, left out of metrics |
| E5 | Review queue contents | Only flagged orders, any status, and only when no ground truth exists |
| E6 | Runs with a known answer | Scored automatically against the script; no human review |
| E7 | Solo testing | Read both parts, or a robot crew that speaks the crew lines while you play the customer |
| E8 | Brand values | Extracted from servtech.co's CSS and assets, never guessed |
| E9 | A car arrives, nobody speaks, and it ends with no departure (pause, connection timeout, End session) | Nothing is sent, as in E2. Without a departure the outcome would be `undetermined`, which would put an empty order in review |
| E10 | The `lane_stream_a` cookie miss | Accepted as a known gap (see Known gaps); the fixture and its expected order are unchanged |

## Synthetic test data

`fixtures/scripts/*.json` holds 24 scripted conversations. Each has turns (speaker, text, pause), hand-written events, and an expected block (items, needs_review, not_ordered, flags, status, group). `pnpm fixtures:build` renders them with two macOS voices (free, local), writes stereo (customer left, crew right, 16 kHz) and a mono headset mix (band-limited, 8 kHz), mixes in synthetic engine idle, wind and car radio at clean, moderate or heavy levels, and concatenates scripts into two multi-car compilations and two lane streams (about 23 minutes and 19 cars each, with realistic gaps). Each file gets a `.timeline.json` with exact utterance and order spans, the recording start, and vehicle events.

`fixtures/scenarios/*.json` describe how a replay behaves like a live feed: continuous or paused when no car is present, vehicle events (off, on, noisy), disconnects with and without reconnect, pauses, stereo roles, and one per wire codec. `fixtures/pos/window-changes.json` lists what the crew rang up differently at the window, for Layer B.

Every row of the edge-case checklist (41 rows: v1's 28 plus 13 for the live path) is covered by a fixture or a live-path check in `pnpm eval`; rows 27 and 28 run against the webhook self-check. The human-voiced held-out set (`fixtures/heldout/`) is scored separately and is never used for tuning; it still has to be recorded.

## Eval results

`pnpm eval` replays every fixture through the live path and reports two layers, as Serv asked:

- **Layer A, "heard":** our orders against what was said (hand-checked expected orders). It covers segmentation (missed and extra conversations, boundary error), item precision and recall (exact match on catalog ID, quantity, size, modifiers and combo components), bucket accuracy, status, review and flags, and pass or fail per checklist row.
- **Layer B, "rung up":** our orders against POS tickets, matched on store and lane within ±90 s, by items in common and then time. Every difference is an `extraction_error` (we were wrong), a `window_change` (we heard it right; it was rung up differently) or `unmatched`. The tickets are synthetic until Serv shares real ones.
- **Live path:** close latency (conversation end to order sent; estimated at max speed, measured at 1x), reopens (and premature ones), and duplicate versions.

Results go to the console and `eval/report.json`; the `/eval` page reads the report. The eval stops before sending any audio to Deepgram that is not cached, unless given `--yes`.

| Configuration | Fixtures | Rows | Item P / R | Buckets | Conversations | Layer B exact | Notes |
|---|---|---|---|---|---|---|---|
| ground truth + oracle events (v2, live path) | 28/28 | 41/41 | 100% / 100% | 100% | 74/74 | 66/67 | Pipeline ceiling, free. The one Layer B difference is the planted window change |
| Deepgram Nova-3 + Gemini 3.5 Flash-Lite (v2, live path) | 27/28 | 40/41 | 100% / 100% | 99.5% | 74/74 | 66/67 | 2026-10-05, mono, files transcribed prerecorded (cached) and streamed through the lane. The one difference: `lane_stream_a` leaves a hesitated cookie off `not_ordered`. One run at temperature 0, on fixtures that informed the fixes |
| Deepgram Nova-3 + Gemini 3.5 Flash-Lite (v1, batch) | 24/24 | 28/28 | 100% / 100% | 100% | 34/34 | | 2026-10-04, before the lane streams existed |

Close latency with real providers, estimated: p50 3.0 s, p95 45 s. Orders closed by a closing cue settle in 3 s (63 of 77). The tail is 7 idle timeouts (45 s) and 5 closes on the next car (34 to 43 s). The one real-time run, `lane_stream_a` at 1x with Deepgram live and Gemini (step 6), measured p50 5.6 s and p95 47.1 s.

## Known gaps

- **Synthetic audio:** TTS voices and mixed noise are cleaner and more predictable than real drive-thru audio. Accuracy on real HME files is unknown until we test them.
- **Uncalibrated thresholds:** the 0.75 bucket thresholds and the low-audio-quality cutoffs (confidence 0.8, 15 dB) are guesses until we have real audio with actual orders.
- **Channel layout:** speaker roles rely on diarization, or on wording when diarization hears one voice, unless HME audio has separate crew and customer channels. Wording-based roles were 98% right on the fixture lines (229 of 234), against 74% from diarization alone; the cue lists were tuned on those same fixtures, so expect less on real audio.
- **Wall-clock time:** live orders are timed by our receive clock (checked against NTP at start), not by a timestamp from HME; replayed files use a configured or inferred start. Matching cars to POS tickets is only as good as those clocks.
- **Lane bleed:** each store and lane gets its own lane, and two lanes run side by side without mixing (row 40), but audio from one lane's speaker reaching the other lane's microphone is not handled.
- **Generic menu:** real menus have more items, regional names and promos.
- **Gemini model choice:** the default is `gemini-3.5-flash-lite`, which completed the eval inside the free tier. `gemini-flash-latest` may extract better, but its free tier allows 20 requests per day, too few for a full eval; set `GEMINI_MODEL=gemini-flash-latest` to try it on single runs. Quotas are per model, and the pipeline keeps one ledger per model in `.data/`.
- **Free-tier limits:** LLM rate limits and 503 "high demand" responses on the free tier slow file replays and evals (client-side limit `GEMINI_RPM`, default 10; daily cap `GEMINI_DAILY_CAP`, default 200).
- **Data handling:** sending audio to Deepgram and an LLM provider is assumed OK pending Serv's confirmation.
- **Orders spanning files:** a replayed file's last conversation without a close is `undetermined` with `truncated_end`; files are not stitched together.
- **Sandbox infrastructure:** SQLite and an in-process queue suit one machine; a deployment would move the outbox and worker to managed services.
- **No held-out results yet:** the fixtures that measure the pipeline also guided its prompt, cue-list and tracker fixes, and each real-provider eval is a single run. The tooling for a human-voiced held-out set is in place (`fixtures/heldout/README.md`), but recording 8 to 12 conversations needs people, and scoring them needs about 10 Deepgram minutes. Until then, high fixture scores show the approach can work, not that it generalizes.
- **HME interface unknown:** the endpoint path, wire format, control messages and authentication are placeholders. The service is built so only `src/input/` changes when HME documents them; nothing has been tested against a real base station.
- **Close latency when no closing cue is heard:** a conversation that ends without one waits for the 45 s idle timeout (or the next car), because a pause never sets the outcome (D10). Cue-closed orders arrive in about 3 s plus extraction. Vehicle events from HME, or a shorter `IDLE_TIMEOUT_S`, would shorten the tail; the trade-off needs real traffic.
- **Live speech recognition barely exercised:** Deepgram live has run once (one 23 minute lane stream at 1x). Test Lab's ten scenarios pass end to end typed (in CI, in every tester mode), and their expected results pass with the script's exact words through Gemini; nobody has run them with real voices yet.
- **One real-provider miss on `lane_stream_a`:** in the full 23 minute stream, Deepgram hears car 8's "Maybe a cookie... nah" as "Maybe a Coke. No." (twice, the same both times), so the hesitated cookie is missing from `not_ordered`. The same 28 s clip alone is heard correctly (6 of 6, with or without the word in the keyterms), so it depends on the surrounding audio, not on our keyterms, prompt or tracker. Accepted as a known gap (E10): the eval keeps reporting it.
- **Typed lines under-test transcription:** in Test Lab's typing mode lines skip Deepgram, so the scorecard's word error rate and role accuracy are only meaningful with the microphone.
- **Dev dependency audit:** `pnpm audit` reports one high advisory in `braces` (stack exhaustion on deeply nested patterns), reached only through dev tooling (`eslint-config-next`, the `shadcn` CLI). No patched version exists yet; production dependencies have no known vulnerabilities. Waived for v2.1; re-run `pnpm audit` before each release and upgrade once a fix is published.
- **Stereo path untested with Deepgram:** every Deepgram call so far was mono with diarization. The multichannel path is unit-tested (and the stereo scenario passes on the ceiling) but has never been sent to Deepgram; `pnpm eval --layout stereo` would bill the stereo fixtures once.
- **Tax:** `TAX_RATE=0`. Real spoken totals include tax, so `total_mismatch` will fire on most real orders until the rate is set per site.
- **No authentication on the web app:** anyone who can reach it can start runs (spending Deepgram credit and Gemini quota), upload files, read every payload, the live view and the mock inbox, and change the mock's failure mode. It binds to 127.0.0.1; keep it there. Dev routes (simulator, review, tickets) also check for a local request, but a reverse proxy on the same machine that forwards `Host: localhost` without `X-Forwarded-For` would expose them, so never enable them behind one.
- **Runs lost on restart:** the run queue lives in memory. A server restart drops queued runs and leaves their rows `queued` or `running`. Webhook deliveries are safe; the outbox recovers.
- **Serial queue:** one run at a time, and Gemini is paced at 10 requests per minute, so a recording with 60 cars needs at least 6 minutes of extraction.
- **Retries need a running process:** slow-phase webhook retries only happen while `pnpm dev` or `pnpm pipeline worker` is running.
- **Reviews have no sign-in:** the review screen records the reviewer's typed name, not an identity.
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
