# Step 2: Simulator errors when nobody speaks

Status: causes confirmed. Fixes on branch `v2.1-step/02-sim-errors` (see "Fixes").

## Evidence for session 1

Your session was `ses_01M47R4H8DPNJAHG7DCWJ1MSJ0` (store_sim / lane_1), opened 2026-10-06 04:39:18Z.

| Source | What it shows |
|---|---|
| `control.ndjson` (`.data/blobs/events/store=store_sim/lane=lane_1/date=2026-10-06/session=ses_01M47R4H8DPNJAHG7DCWJ1MSJ0/`) | `session_open` at 04:39:18.029, `disconnect` and `session_close remote_close` at 04:39:22.472. No vehicle, pause or text events, no audio parts |
| Feed log | `ingest_auth ok (ticket)`, `ingest_session_open`, `ingest_session_close`. No errors |
| Raw capture index | Only `session.json`: no frames were sent |
| Tracker decisions | None: nothing opened a conversation |
| Deepgram and Gemini calls | None for this session (no audio, no conversation) |
| Web server log (`pnpm dev`) | `GET /api/runs/run_01M47R4H8DGS0JYFNNM9EPPWV8/audio 500` five times, each with `InternalError: ENOENT: no such file or directory, stat ''` |

The two `401 malformed` lines at 04:33:40Z in the feed log were not you. They came from my own TESTING.md check sending a bad token.

Click sequence, reconstructed from the log: Start (text mode, the default), then leave the simulator after about 4 s (unmounting the page closes the link: `remote_close`), then open the run "live store_sim/lane_1" from the sidebar, several times.

First error the user sees: on that run page, the waveform shows **"Audio failed to load: ..."** in red. Stack: `apps/web/app/api/runs/[id]/audio/route.ts:7` calls `statSync('')`, because a live run has `file_path = ''` and `runAudioPath` (`apps/web/lib/data.ts:145`) returns `''`, not `null`, so `assertFound` passes.

## Reproduction (scripted browser, fake silent mic)

I clicked through these sequences with Playwright against the running servers (Chrome's fake media device fed a silent WAV):

- Text mode: Start, Car arrived, Pause, Resume, Car left, Car arrived, Drop, Drop, Stop.
- Mic mode, continuous: the same sequence.
- Mic mode, only with a car: Start, Car arrived, wait 5 s, Car left, wait 25 s.

No browser exceptions came up in any of them. The server side showed the causes below.

## Hypotheses

| # | Result | Evidence |
|---|---|---|
| H1 Deepgram closes with no audio | **Confirmed** | In "only with a car" mode, Car left stops the audio without a pause event. The feed log then shows `deepgram ses_01M47TMGR3...: connection closed (1011 Deepgram did not receive audio data or a text message within the timeout window. See https://dpgr.am/net0001); reconnecting`. The adapter sends KeepAlive only after an explicit `stream_paused` (`packages/pipeline/src/lane/deepgram-stream.ts:377`), so audio that simply stops leaves the socket silent, and Deepgram drops it after about 10 s. The reconnect opens a fresh connection that will idle out again |
| H2 Empty conversation calls Gemini or fails validation | **Partly.** No model call (`lane.ts:451` returns before extraction when no line was heard) and no error. But a car that arrived and left with no speech sends nothing, while decision E1 says to send it as `abandoned` with `no_speech` | Repro: Car arrived, then Car left, gives `conv_2 closed with no speech; no order` |
| H3 Reconnect reuses the one-time ticket | Not real | `apps/web/lib/sim-link.ts:52` fetches a new ticket on every `connect()`, and every reconnect in the feed log shows a fresh `ingest_auth ok` |
| H4 Replaced socket shows 4409 as an error | Not seen | Reconnects happen after the old socket closed. The client ignores closes from a socket it already replaced (`sim-link.ts:66`). The server's 4409 path exists, but nothing in the logs hit it |
| H5 Buttons in an unexpected order throw | Not real in the tracker. The UI also sends events the tracker ignores | Car left in IDLE, Resume without Pause and double clicks are all ignored without errors (`tracker.ts:259`, `:278`). A new randomized tracker test covers it |
| H6 Browser audio setup | Risk, not seen in Chrome | The worklet runs in a 16 kHz `AudioContext` and relies on the browser to resample the mic. Chrome does this; Firefox refuses to connect a mic to a context at a different rate ("Connecting AudioNodes from AudioContexts with different sample-rate is currently not supported"). Fix: run the context at the device rate and resample to 16 kHz in the worklet |
| H7 Empty Deepgram results treated as failures | Not real | Empty finals produce no utterance (`deepgram-stream.ts` `emit` returns on empty text). Silence over 17 s of mic audio produced no errors |

Other causes found:

| # | Cause | Evidence |
|---|---|---|
| F1 | **The error you saw.** A live run has no audio file, and its run page asks for one anyway: 500 and "Audio failed to load" | Web log above, `apps/web/app/api/runs/[id]/audio/route.ts:7` |
| F2 | The feed service could crash on an unexpected error. `serve.ts:120` and `:140` call `void manager.handle(m)` with no catch, so any rejection is unhandled, and Node exits on it | Code review item B on PR #18 |
| F3 | Simulator messages are not classified. An expected drop shows "closed (4000 simulated drop); retry in 2 s" in amber, a dead feed service shows "closed (1006)" in red, and dev routes being off shows "ticket refused (404)". None of them say what happened in plain words or what to do next. The silence guard stops a silent mic after 30 s with only a small note | `sim-link.ts:73-76`, `Simulator.tsx` |

## Fixes

1. **H1:** the Deepgram adapter treats audio that stops (no frame for 3 s) as a pause. It sends Finalize and KeepAlives, and after `DEEPGRAM_IDLE_CLOSE_S` it closes, logged as info. The next audio reopens it, so Deepgram minutes stop when audio stops. Same for Resume with no audio after it.
2. **E1 (H2):** a conversation with no speech that ended because the car left is sent as `abandoned`, no items, flag `no_speech`, review not required, and no model call. E2 stays as today: no vehicle event and no speech means nothing opens.
3. **F1:** the audio route answers 404 for runs without a file. The run page shows "Live session: audio is in the archive, not a file" in place of the waveform.
4. **F2:** every `manager.handle` call has a catch that logs the error, so the service keeps running.
5. **F3:** the simulator classifies link messages. Expected ones (you dropped it, reconnecting, replaced, idle stop) are quiet info notes. Real ones say what failed and what to do ("The feed service is not running: start `pnpm feed serve`"). No raw codes or stack traces.
6. **H6:** the worklet resamples to 16 kHz itself.
7. **Monkey test** (`apps/web/e2e/monkey.spec.ts`): Chrome with a fake silent mic clicks random valid and invalid control sequences for 2 minutes against the feed service (free script transcriber in CI). It asserts no page errors, no 5xx responses and no error lines in either server log, that every session it opened is closed, that no orders with LLM calls were made, and that the audio counter stops when the stream stops.

## Question for Aarnav

E1 covers "a car arrives and leaves". Some conversations open on a car arrival but end with no speech for another reason (pause, disconnect timeout, or step 4's End session). They have no departure evidence, so their outcome would be `undetermined`, and the v2 rules put undetermined orders in review. For now I send nothing for them (the same as today). Tell me if you'd rather send them as `undetermined` with `no_speech`.
