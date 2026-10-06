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
| 6. Deepgram streaming | v2-step/06-deepgram-live | Next |

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
- **File runs and `time_basis`.** File recordings report `recording_metadata` (their start time comes from env, filename or mtime).

## Step notes

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
