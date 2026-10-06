# v2 progress

Running log for the v2 live-feed plan (October 5, 2026). Newest entries go at the top of each section.

## Status

| Step | Branch | State |
|---|---|---|
| 0. Freeze v1 | main | Done: PR #1 merged, `v1.0.0` tagged, `release/v1` and `v2` created |
| 1. Outcome and review model | v2-step/01-outcomes | Done |
| 2. Versioned corrections | v2-step/02-versions | Done |
| 3. Input layer and replay | v2-step/03-input-layer | Done |
| 4. Clocks and IDs | v2-step/04-clocks-ids | Done |
| 5. Conversation tracker | v2-step/05-tracker | Done |
| 6. Deepgram streaming | v2-step/06-deepgram-live | Done: PR #7 |
| 7. WebSocket endpoint and ingest auth (Part A) | v2-step/07-ws-endpoint | Done: PR #8 |
| 7b. Long-term data store (Part B) | v2-step/07b-data-store | Done: PR #9 |
| 8. Live UI | v2-step/08-live-ui | Done: PR #10 |
| 9. Live simulator | v2-step/09-simulator | Done: PR #11 |
| 10. Review screen | v2-step/10-review-screen | Done: PR #12 |
| 11. Eval v2 | v2-step/11-eval | Done: PR #13 |
| 12. Human-voiced held-out set | v2-step/12-heldout | Done: PR #14 (tooling; recordings need people) |
| 13. Retire the batch path | v2-step/13-retire-batch | PR #15 |
| 14. Docs | v2-step/14-docs | Next |

## Decisions not covered by the plan

- **Branch names.** Git cannot hold a branch `v2` and branches under `v2/` at once, so step branches are `v2-step/NN-name` instead of `v2/NN-name`.
- **CI triggers.** The workflow ran only on PRs into `main`. It now also runs on PRs into `v2` and on pushes to `main` and `v2`, so every step PR is checked.
- **Review reason for D13.** The plan's reason list has no name for the safety cap, so it is `safety_cap`. Limits are `REVIEW_MAX_QUANTITY` (10) and `REVIEW_MAX_TOTAL` (150).
- **Outcome evidence shape.** Each entry has a `type` (`spoken_cue`, `vehicle_event`, `stream_event`, `silence`, `order_state`, `human_review`) and, for spoken cues, a `kind` (`closing`, `customer_done`, `departure_said`, `cancel`, `next_car_greeting`). This extends the plan's example without changing its fields.
- **Next car's arrival counts as departure.** In a single lane, the next car reaching the speaker post means this one left, so a later `vehicle_arrived` is departure evidence, alongside `vehicle_departed` and the crew saying the car left.
- **A closing cue needs an ordered item first.** A close with nothing ordered (and no cancel) is `undetermined`.
- **Truncated audio.** `incomplete` is gone. A truncated start with a closing cue is `completed` with the `truncated_start` flag; a truncated end with no close is `undetermined` with `truncated_end`.
- **Fixture 07 (abandoned).** With audio only it has no evidence of departure, so it is now `undetermined`. Its expected block also has `status_with_vehicle_events: "abandoned"`, used once replays send vehicle events (step 6).
- **Removed flag.** `needs_review_present` is replaced by the review reason `unclear_items`.
- **New flags.** `stream_gap`, `stream_interrupted`, `transcript_gap`, `audio_dropped`, `capture_paused`, `audio_rate_exceeded`, added with schema v2.0 so later steps do not change the schema again.
- **`STORE_ID`.** Replaces `LOCATION_ID` (the old name still works). `.env.example` is outside what I can edit in this setup, so new variables are listed in the README instead.
- **Outcome rule for noisy vehicle events.** A vehicle event followed by more talk in the same conversation (other than the crew saying the car left, or the next car's greeting) is treated as a missed or ghost event and kept as context only. Without this, noisy sensors turned completed orders into abandoned ones.
- **Expected status under noisy events.** With `vehicle_events: noisy`, the eval accepts either the audio-only status or `status_with_vehicle_events`, since a missed departure legitimately leaves the outcome undetermined.
- **Paused audio is not truncation.** When audio stops because the stream paused or the car left, the conversation is not flagged `truncated_end`.
- **Batch mode inside the lane (temporary).** Until the tracker (step 6), the lane collects the streamed transcript and runs v1 segmentation when the input ends. This keeps the step 3 parity check honest; the tracker replaces it, and step 13 retires it.
- **Replay `--via direct` sends canonical PCM.** Wire codecs (mu-law, Opus, MP3 and so on) are exercised by the decoder tests now and over a real socket with `--via ws` in step 8 (row 36).
- **Simulator text lines.** A dev-only `script_line` source message carries typed lines from the simulator's text mode. HME never sends it.
- **Fixture recording start.** Every fixture's `recording_start_utc` is `2026-10-03T18:40:00Z`, the same start the v1 eval used.
- **Tracker details the plan left open.** An arrival only starts a new conversation when the next line greets a new car (a ghost arrival during crew chatter no longer splits an order). A customer "thanks" or "that's it" during the close resets the settle timer instead of reopening ordering. A late addition does not reopen when the speaker greets ("hi, can I get...") or a car has arrived since. Crew lines heard just before a conversation opens (up to 10 s) belong to it. A conversation with no customer speech makes no order, as in v1.
- **Speech watermark.** Timers never run past speech still in progress (the transcriber reports how far its output is final), so a close does not settle while the customer is mid-sentence.
- **Late vehicle evidence.** A vehicle event in the reopen window re-runs the outcome with the same events (no new LLM call) and sends `order.updated` only if the status changes.
- **Hard cap.** A conversation longer than 6 minutes is finalized at the cap (not split at the best gap as v1 did); none of the fixtures come near it.
- **Ceiling runs stay free.** The oracle extractor turns the LLM tie-breaker off. Earlier ceiling runs today sent 11 free-tier tie-breaker requests (cached; reruns are free).
- **Live-only fixture.** `23_late_addition` is skipped by the v1 file path (it needs a reopen); the lane path expects `order_version` 2.
- **Raw capture is staged, then stored.** Parts are written to `.data/staging/raw/` as they fill, and each finished part moves into the blob store under the plan's `raw/store=/lane=/date=/session=` key with its index. A `session.json` manifest (declared format, token id, open time) goes first, so `pnpm feed replay-raw` can send a session back byte for byte.
- **What the disk guard pauses.** At 95% of `DATA_DISK_BUDGET_GB`, raw capture and order audio stop; transcripts, orders, webhooks, LLM records, events and labels continue. The open conversation (or the order, for audio) gets `capture_paused`.
- **Order audio comes from a ring buffer.** Each lane keeps its recent mono audio (the 6 minute cap plus the reopen window plus 2 minutes). Each order version's audio is cut from it with 0.5 s either side and stored as FLAC; `audio_ref.archive_uri` points at it. Replays and the v1 file path do not archive (the file is the source); `replayFile(..., { record: true })` turns it on for tests.
- **Deepgram messages are kept per connection.** Every message (interims included) of one Deepgram connection is stored as `deepgram-<n>.json` when that connection closes.
- **Gemini records sit with each order version.** Every extraction request and answer (prompt contents, system prompt hash, prompt version, usage, cached or not) is stored under `llm/.../order=<id>/<request_hash>.json`. The live yes/no tie-breaker calls are not stored yet; their answers are in the tracker decisions.
- **Prune and delete list first.** `pnpm data prune` and `pnpm data delete` show what they would remove; `--yes` removes it. Catalog rows are marked deleted, and each delete writes a tombstone row.
- **Labels before the review screen.** `pnpm data label` and `putLabel()` write a person's verdict on one order version; the review screen (step 11) will use the same call.
- **Test databases.** `openDb(":memory:")` shares one handle per path, so every `testEngine()` now gets its own temp database and blob root.
- **How the live view gets its data.** The live service and the web app are separate processes, so lane updates go through a `live_events` table in the shared SQLite database. `/api/live/events` streams them as server-sent events and resumes from `Last-Event-ID` after a reconnect. It is a display feed trimmed to the last 20,000 rows; the data store keeps the record. No dependency was added.
- **"The open order building" is a keyword preview.** Running the LLM on every line would spend free-tier requests. Instead, the open conversation's customer lines go through the free keyword extractor, and the card says the real order is built when the conversation closes.
- **Replays show up live.** `pnpm feed replay` (direct) also writes to the live feed, so a replay at `--speed 1` can be watched on the Live page.
- **Acted scenarios, scripted.** The plan's five acted scenarios are scripted in text mode (`sim/acted-scenarios.ts`) and sent over the real endpoint exactly as the simulator page sends them. They run in CI with the keyword extractor (statuses, versions and flags), and with Gemini via `pnpm feed sim-check` (items too). Timers are shortened for the run: settle 0.6 s, reopen 8 s, grace 2 s. Acting them into a mic is the same check with Deepgram in front; that needs people and Deepgram credit, so it is left for Aarnav (see below).
- **Typed lines are paced like speech.** The endpoint dates a typed line as if it were spoken (0.35 s a word, ending on arrival). Lines sent faster than that overlap, which made the tracker flag `crosstalk_suspected` and put the closing cue before the item. The scripted runner waits accordingly. Someone typing by hand is slower than that anyway.
- **Saved fixtures come from the raw capture.** Save as fixture rebuilds the audio from what the endpoint received (pauses kept as silence), and copies the raw parts. So it needs the session stopped (the last part is stored at close) and the live service running with capture on. The expected order is written in the form: status plus items from the menu.
- **Noise for the simulator** is the same synthetic engine, wind and radio mix the fixtures use (`fixtures/noise.ts`), served as a 20 s WAV by a dev route and looped under the mic.
- **Dev-route guard fix.** Next.js sets `x-forwarded-for` to the socket address on every request, so the guard (which refused any forwarded request) made every dev route answer 404 in a running server. Unit tests had not caught this. The guard now accepts the header only when every hop is loopback.
- **What resolving a review does.** A picked candidate becomes an item at full confidence, priced from the menu at the size heard (a combo gets its fixed and default slots; a slot the customer must choose stays open). "Not ordered" moves the line to `not_ordered` as `uncommitted`. Totals and the total and slot flags are re-checked; flags about the audio stay. Review is cleared, unless an unclear item was left open.
- **Optimistic check on resolve.** The person resolves the version they saw. If a newer version exists (a reopen or a late event got there first), the save is refused with 409 and the page asks for a reload.
- **Every resolution is also a label.** The reviewer's choices are stored as a label on the version they reviewed (verdict `incorrect`, with what they chose), so later evals can use them.
- **Synthetic POS tickets.** Until Serv shares POS data, each completed expected order becomes a ticket opened 10 s into its conversation, on the replay's store and lane. `fixtures/pos/window-changes.json` lists what the crew rang differently at the window (one entry so far, 01_simple: fries switched to onion rings, row 41). A ticket line is item, size and quantity; modifiers and combo slots are left out until the real ticket format is known.
- **Ticket matching uses items, not just time.** Within ±90 s on the same store and lane, pairs are taken by most items in common, then closest in time, across all orders at once. Time alone mispaired split payments (two tickets at the same moment) and back-to-back cars, and blamed the extraction for it.
- **Close latency in the eval is an estimate.** At max speed the wall clock means nothing, so the eval adds the tracker's lag on recording time (conversation end to finalize) to the measured processing time. The real 1x number came from step 6: p50 5.6 s, p95 47.1 s.
- **Shutdown drains closing sessions.** A session whose socket closed just before shutdown was still decoding when the service stopped, so its last audio and its close were lost. Row 36's last codec (FLAC) failed now and then because of it. The server now waits for draining sessions.
- **The held-out set is tooling only so far.** Recording 8 to 12 conversations with real voices needs people, and scoring them needs about 10 Deepgram minutes, beyond the one lane stream the plan allows without asking. So this step builds import, scoring and the report, and leaves the recordings and the one real run to Aarnav. `fixtures/heldout/README.md` says how.
- **FLAC is written through a temp file.** Written to a pipe, ffmpeg could not go back and fill in the stream length, so the file had no duration. ffprobe refused it, which broke replaying saved fixtures, and archived order audio had no length either.
- **Files use the prerecorded API inside the live path.** D1 sends every file through the lane. Streaming each file to Deepgram live would bill every rerun and eval, because live results cannot be cached. So file replays use Deepgram's prerecorded API, cached on disk as in v1, and the lane releases each utterance once the audio covering it has arrived (`lane/timed-stream.ts`, shared with the free script transcriber). HME connections and the simulator still stream live. `--live-stt` streams files live when that is what is being tested (as in the step 6 run).
- **A car heard entirely as crew is checked, not dropped.** The lane dropped any conversation with no customer line before the role pass could run, and the comment claimed v1 did the same. v1 did not: it extracted every conversation, and it got the first car of `compilation_b` right while v2 lost it. All 8 conversations missing in the first real v2 eval (and cars 4, 9 and 14 in the step 6 live run) had this cause: diarization put the customer's voice under the crew's label. Such conversations now go through the role pass. The LLM labels the lines; with no LLM, wording and turn-taking decide. Agreement is measured against the wording guess, not against diarization.
- **Unplanned Deepgram spend (my mistake).** Before the first real eval of this step I checked the Deepgram cache for one fixture only. The two v2 lane streams (about 23 minutes each) had never gone through the prerecorded API, so that run billed **47.6 Deepgram minutes**, more than the one lane stream the plan allows without asking. `pnpm eval` now adds up uncached minutes first and refuses to spend them without `--yes`. Everything is cached now, so reruns are free.
- **File runs and `time_basis`.** File recordings report `recording_metadata` (their start time comes from env, filename or mtime).

## Step notes

### 13. Retire the batch path (D1)

- `runPipeline` (`pnpm pipeline run`, web runs, examples) is now a thin wrapper:
  - probe the file, which still fails early on empty or corrupt audio
  - replay it into a lane at max speed
- The lane's temporary batch mode and the eval's `--via` flag are gone. There is one path.
- `lane/file-transcriber.ts`: file sessions get prerecorded transcription (cached, one transcription per file), and other sessions go to the live transcriber. `FileReplaySource` takes channel roles for stereo files (from `CHANNEL_MAP`).
- `eval/live-checks.ts` row 36 always uses the free transcriber. It checks decoders, not ASR.
- Ceiling (free): **28/28, 41/41**.
- Real providers (Deepgram prerecorded, cached; Gemini Flash-Lite) through the single path, **40/41 rows**:
  - **27/28 fixtures, 74/74 conversations**
  - 100% item precision, recall and status
  - Layer B: 66 of 67 tickets match exactly; the only difference is the intended window change
  - The one remaining difference: `lane_stream_a` leaves a hesitated cookie off `not_ordered` (an extraction nuance, not tuned)
  - v1's last real eval was 24/24 on the fixtures it had then
  - Cost: 0 Deepgram minutes and 7 new Gemini requests once cached. The first, uncached run billed 47.6 minutes; see above.

### 12. Human-voiced held-out set (tooling)

- `eval/heldout.ts`:
  - folder fixtures (`fixtures/heldout/<name>/` and `fixtures/live/<name>/`: `audio.flac`, `expected.json`, `timeline.json`)
  - `importRecording` turns a phone recording into 16 kHz mono FLAC, with an expected.json to fill in by hand
  - `runFolderEval` replays each recording through the lane and scores orders, items and status
  - it writes `eval/heldout-report.json`, never the main report
- Commands:
  - `pnpm pipeline heldout import <file> --name <id>`
  - `pnpm pipeline heldout eval --transcriber deepgram`, which shows the minutes first; `--yes` runs it
  - `--live` scores simulator recordings instead
- `/eval` has a Held-Out Set section, which explains how to record it until it has been run.
- Guard: the main eval never reads `fixtures/heldout`. A test checks that.
- **Not done (needs people):**
  - record the conversations (simulator with "held out" ticked, or phone imports)
  - write and check the expected orders
  - run the eval once with Deepgram and Gemini

### 11. Eval v2

- **Layer A ("heard"):** the same measures as v1, now labelled as Layer A.
- **Layer B ("rung up"):** `eval/pos.ts`
  - placeholder ticket schema
  - synthetic tickets plus window changes
  - a matcher that sorts every difference into `extraction_error`, `window_change` or `unmatched`
- **Live-path metrics** (`--via lane`):
  - close latency, overall and by what closed the conversation
  - reopen rate and premature reopens
  - duplicate versions
- Row 41: a window change passes when Layer A passes and Layer B blames only the window.
- `/eval` shows Layer A, Layer B and the live path, with latency broken down by close trigger.
- Ceiling run (script transcriber plus oracle, free) via the lane:
  - **28/28 fixtures, 41/41 rows**
  - Layer B: 66 of 67 tickets match exactly; the one difference is the intended window change
  - Close latency estimate: p50 3.0 s, p95 45 s
    - 70 orders settled after a closing cue (p95 3.0 s)
    - 4 hit the idle timeout (45 s)
    - 1 closed on the next car (25 s)
    - 2 ended with the input
  - 0 premature reopens and 0 duplicate versions
- **Against the plan's target (p95 under 10 s at 1x):** orders with a closing cue meet it. Orders without one wait for the 45 s idle timeout. That is the cost of "a pause never sets the outcome" (D10). Possible fixes, such as a shorter idle timeout or vehicle events, are open, so this is not tuned.
- The committed `eval/report.json` is still the v1 real-provider report. A v2 report is generated in the docs step.

### 10. Review screen

- `/review` is dev only, with Review in the sidebar when dev routes are on. It lists the latest version of every order that still needs review. Each card shows:
  - what was said
  - the order as sent
  - a menu per unclear item: candidates with scores, the whole menu, or "not ordered"
  - the outcome to confirm or change, a note, and the reviewer's name (remembered in this browser)
- Saving calls `POST /api/orders/:id/review`, which `review/resolve.ts` handles:
  - builds the next version (`order.updated`, `correction_reason: human_review`, `supersedes_version`) with `human_review` outcome evidence
  - stores it and queues it, behind any earlier version still being delivered
  - writes a label
- Tests:
  - pick a candidate: priced, review cleared, label written
  - drop an item and change the status: sent as v2
  - a stale version gives 409, an unknown id is refused, and an item left open keeps the review
  - route status codes
- Checked by eye against the sandbox database:
  - the 04_correction run (Coke to Sprite with keyword extraction)
  - the dropped-connection order from the simulator check

### 9. Live simulator

- `/simulator` is dev only: it gives a 404 unless `ENABLE_DEV_ROUTES=true` and the request is local, and the sidebar link shows only with dev routes on.
  - **Input:** text mode (free) or the mic, through an AudioWorklet in a 16 kHz AudioContext.
  - **Wire format:** PCM or mu-law over a WebSocket to `/hme/v1/stream`, with a one-time ticket per connection.
  - **Controls:**
    - audio mode (continuous, or only with a car)
    - Car arrived and Car left
    - Pause and Resume stream
    - Drop connection, with HME-style reconnects (2, 4, 8 s) or staying down
    - noise (engine, heavy)
    - hold C to label the crew (saved as labels only)
  - **Guards:** Deepgram minutes on the lane, a 15 minute limit, and a stop after 30 s with no audio (both can be changed).
  - **Live panel:** the Live page's `LaneView` plus the mock inbox.
- Save as fixture: `POST /api/dev/simulator/save` writes `fixtures/live/<name>/` (or `fixtures/heldout/<name>/`) with:
  - `audio.flac`
  - `raw/<session>/`
  - `timeline.json`: start time, vehicle and stream events, typed lines, crew labels
  - `expected.json`

  The name is a safe id, and an existing fixture is never overwritten.
- `pnpm feed sim-check`: the five acted scenarios over the real endpoint. With Gemini all **5/5 pass**:
  - simple: completed, cheeseburger and fries
  - correction: completed, hamburger and Sprite with no Coke
  - late water: v2 `order.updated`, cheeseburger and water
  - car left: abandoned
  - dropped with no reconnect: undetermined, `stream_interrupted`

  It took 9 Gemini requests across three runs (36/200 that day) and no Deepgram.
- Checked in a browser, text mode, against `pnpm feed serve`:
  - a typed order opened and finalized a conversation and showed live
  - Save wrote the fixture (then deleted)
- **Not done (needs Aarnav):** acting the five scenarios into a real mic. That uses Deepgram live: about 1 to 2 minutes of credit for all five.

### 8. Live UI

- The lane reports three new update types:
  - `status`: tracker state and timers, sent only when they change
  - `draft`: a keyword preview of the open conversation
  - `delivery`: webhook result per order version
- Session updates now carry the codec, channels and source type.
- `lane/live-feed.ts` writes updates to `live_events`, without word timings and without the transcript copy inside order payloads.
- The `/live` page (Live in the sidebar) shows lane chips with connection dots, and for the chosen lane `components/live/LaneView.tsx` shows:
  - connection and codec
  - a rolling transcript in the Apple Music lyrics style, with interim text and conversation open, close and reopen marks
  - the tracker state with timers counting down
  - the open order preview
  - recent decisions with their trigger and signals
  - orders with outcome evidence, the review flag, version and webhook status
- The simulator (step 9) reuses `LaneView`.
- Tests:
  - the lane emits every update type during a replay, and status only on change
  - live table round trip
  - the browser reducer
  - SSE route: recent rows, new rows, resume after `Last-Event-ID`
  - e2e: the Live page connects
- Checked by eye with a 2x replay of `18_back_to_back` and vehicle events.

### 7b. Long-term data store (Part B)

- `data/blob-store.ts`: the `BlobStore` interface (`put`, `get`, `exists`, `delete`, `list`). `LocalBlobStore` writes under `.data/blobs/`, writing to a temp file and then renaming it. `S3BlobStore` is a stub. Keys are checked segment by segment (no `..`, no absolute paths).
- `data/store.ts`: the `artifacts` catalog (all fields in the plan) and the `data_tombstones` table. It has key builders for raw, audio, asr, llm, events and labels, partitioned by `store=/lane=/date=`. It also provides `find`, `deleteWhere`, `prune`, `verify` and `usage`, plus the disk guard.
- What each kind holds:
  - raw: `data/raw-sink.ts`
  - audio: `lane/recorder.ts` plus `encodeFlac`
  - asr: the `raw` handler on the Deepgram stream
  - llm: `LlmCallRecord` on `ExtractResult`
  - events: session control events plus tracker decisions
  - labels: `data/labels.ts`
- `pnpm data find|usage|verify|prune|delete|label` and `pnpm feed replay-raw <session>`.
- The settings panel shows data store usage against the budget.
- The ingest ticket route now requires `content-type: application/json` (from the step 7 security review).
- README: the data commands, the env vars `DATA_DISK_BUDGET_GB` (default 50) and `RETENTION_POLICY` (`keep_all`), and the "Long-term data storage" gap, added verbatim.
- Tests (`data/data.test.ts` plus one Deepgram test):
  - a raw replay gives identical frames over a real socket
  - parts roll by size
  - a recorded replay catalogues audio, llm, events and labels
  - delete by store
  - prune
  - the disk guard pauses capture and warns at 80%
  - verify catches a changed file and a missing one
  - Deepgram messages are kept per connection
- Smoke test: `pnpm feed serve` with a dev ticket replay of `01_simple`. One order was delivered, with 5 artifacts (manifest, part, index, events, FLAC); `pnpm data verify` said all match.

### 7. WebSocket endpoint and ingest auth (Part A)

- `server/ingest-server.ts` serves `/hme/v1/stream`. The path and wire format are PLACEHOLDERS: audio arrives as binary in the declared codec and control events as JSON text. The HME parts live in `src/input/hme/`.
- `input/auth/`:
  - `IngestAuth` and `TokenAuth`; tokens are `sit_<id>_<secret>` and only the SHA-256 is stored
  - tickets for the simulator
  - auth attempt log
  - `pnpm pipeline token create|list|revoke`, where revoking closes sessions with 4401
- Limits and checks as in Part A: 429 after 10 failures per IP per minute, 64 KB and 8 KB message limits, 4409 replace, 4 per token, ping and pong, and 4413 for the rate limit. The server listens on 127.0.0.1 unless TLS or `ALLOW_INSECURE_WS` is set.
- `server/serve.ts` (`pnpm feed serve`):
  - checks the NTP offset at start
  - runs lanes on the wall clock (250 ms tick)
  - keeps run records current for the existing run view
- `input/ws-replay.ts` is a fake base station (`pnpm feed replay <f> --via ws`). Eval row 36 sends 9 codecs over a real socket.
- Security review found nothing at confidence 8 or above. The JSON content-type hardening for the ticket route went into 7b.

### 6. Deepgram streaming

- `lane/deepgram-stream.ts`:
  - Settings: nova-3 live, linear16 16 kHz, diarize for mixed audio and multichannel when roles are known, interim results, endpointing 300 ms, utterance end 1000 ms, VAD events, keyterms from the menu.
  - Connection handling: KeepAlive while paused and an idle close after 30 s; reconnect with up to 30 s buffered, and anything dropped is reported as `audio_dropped`.
  - On end it sends CloseStream and waits for the last finals.
  - A processed-to watermark keeps the tracker from settling ahead of the transcript.
- One real run (`lane_stream_a`, 19 cars, 1x, Deepgram live plus Gemini Flash-Lite): 22.6 Deepgram minutes and 14 Gemini calls, with 27 of 200 Gemini requests used that day.
  - Close latency (conversation end to first webhook 2xx): p50 5.6 s, p95 47.1 s. The tail is the 45 s idle fallback when no closing cue is heard.
  - 13 conversations gave 14 orders: 1 cancelled, 1 undetermined (car 7, no closing cue) and 3 sent to review.
  - Two bugs found and fixed, each with a regression test:
    1. Cars 4, 9 and 14 were dropped as "no customer speech". The check ran before the LLM role pass could correct guessed roles.
    2. A split part created during a reopen was given version 2 instead of 1. Versions are now kept per order id.
  - Not rerun after the fixes, because the plan allows one lane stream of Deepgram credit without asking.

### 5. Conversation tracker

- `lane/tracker.ts`: pure state machine (IDLE, ACTIVE, CLOSING, FINALIZED, reopen) with timers passed in (settle 3 s, idle 45 s, grace 180 s, reopen 20 s, cap 6 min; all in `config/sandbox.ts`, overridable by env). Every decision is logged with its trigger and signals.
- Gray zones ask the LLM yes/no question once, with a 3 s deadline and no retries; no answer means the rules decide. Live calls never wait for a per-minute slot.
- The lane runs the tracker by default; finalizations run per conversation in order (v1, then v2 on a reopen or late evidence) while audio keeps flowing.
- New fixtures: `23_late_addition` (row 35) and `24_long_silence` (row 34).
- Done when: rows 29 to 35, 38 and 39 pass on the ceiling run. All pass; the full lane eval is 26/26 with zero boundary error, and 26/26 under the vehicle-events, paused, noisy and stereo scenarios.

### 4. Clocks and IDs

- Sessions anchor at their own sample 0 and every reconnect re-anchors; utterances, conversations and payloads are on recording time. Replays carry `sourceOffsetS` so the free transcriber finds its place in the file whatever the anchor.
- `lib/safe-id.ts`: store, lane and session ids must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` before they are used in a path or payload. The lane manager refuses sessions that do not.
- `input/merge.ts`: several sources as one time-ordered stream (two lanes at once).
- Checklist rows 29 to 41 added; the live checks in `eval/live-checks.ts` run with `pnpm eval --via lane`.
- Done when: rows 37 (old recording keeps its original times) and 40 (two lanes at once, no mixing) pass.
- Still to do in step 8: log the clock offset at startup when the endpoint uses `receive_clock`, and re-anchor resumed bursts in paused mode from their own timestamps.

### 3. Input layer and replay (direct)

- `src/input/`: `AudioSource` and message types, canonical PCM helpers (G.711, resampling, levels), the decoder registry (`pcm_s16le`, `mulaw`, `alaw`, `opus` via `opus-decoder`, and MP3/AAC/WAV/Ogg/FLAC through one long-running ffmpeg per session, argument array, whitelist, lifetime cap), wire encoders for replays, `FileReplaySource`, scenarios, and RTSP/MQTT stubs.
- `src/lane/`: `LaneSession` (keyed by `store_id:lane_id`, survives reconnects, one time axis), `LaneManager`, `ScriptStreamingTranscriber` (free; never transcribes audio that did not arrive), and `replayFile()`.
- `src/orders/finalize.ts`: one finished conversation to orders and outbox, shared by the lane and the v1 file path.
- Fixture timelines gained `recording_start_utc` and `vehicle_events` (`pnpm fixtures:annotate`).
- `fixtures/scenarios/`: continuous, vehicle events, paused when no vehicle, noisy vehicle events, disconnect with and without reconnect, pause mid-order, stereo roles, and one per wire codec.
- Commands: `pnpm feed replay <fixture|file> [--speed 1|4|max] [--scenario name] [--store id] [--lane id]`; `pnpm eval --via lane [--scenario name]`.
- Done when: every fixture replays at max speed with the script transcriber and matches v1's ceiling: **24/24** via the lane (also 24/24 with vehicle events, paused-when-no-vehicle, noisy events and stereo).
- New dependency: `opus-decoder` (the plan's allowed Opus decoder; MIT, WebAssembly, no native build).

### 2. Versioned corrections

- Outbox rows for version N start as `waiting` while any earlier version of the order is not delivered, failed or dead. When a version finishes, the next waiting one is released and sent (the worker also picks it up if the process stops).
- `correctedPayload()` (`webhook/corrections.ts`) builds the next version: same `order_id`, `order_version + 1`, `supersedes_version`, `correction_reason`, `order.updated`.
- The mock receiver keeps the highest version per `order_id` (`mock_orders` table) and shows it as "Kept Orders".
- The run view shows one card per order (its latest version) with a `vN` badge.
- Done when: a forced v2 waits for v1, is delivered after it, with no duplicates (`webhook.test.ts`, "versioned corrections").

### 1. Outcome and review model

- Status values: `completed`, `cancelled`, `abandoned`, `undetermined`. Review is `{ required, reasons }` and can sit on any status.
- Outcome and review rules live in `packages/pipeline/src/postprocess/outcome.ts` (pure). The payload mapper only formats.
- Webhook schema 2.0: `order.finalized` for version 1, `order.updated` for later versions; `store_id`, `session_id`, `times`, `audio_ref`, `source`, `outcome_evidence`, `review`, `supersedes_version`, `correction_reason`.
- Ceiling eval (script transcriber, oracle extractor, free): 24/24 fixtures, status 100%, review 100%.
- Not yet done (later steps): README and `examples/` still describe schema 1.0 until the docs step.
