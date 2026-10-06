# Prove it works

Each section lists commands and what you should see. Cost is marked: **free**, **Gemini** (requests from the free daily cap) or **Deepgram** (minutes of credit).

## 0. Setup

```bash
pnpm install
# .env: DEEPGRAM_API_KEY, GEMINI_API_KEY (see README "Setup")
ENABLE_DEV_ROUTES=true pnpm dev           # terminal A: web app on http://localhost:3000
ENABLE_DEV_ROUTES=true pnpm feed serve    # terminal B: live service on 127.0.0.1:8787
```

With keys set, `feed serve` sends WebSocket and microphone audio to Deepgram live. To test the socket for free, start it as `ENABLE_DEV_ROUTES=true pnpm feed serve --transcriber script --extractor fuzzy` instead (fixture audio only).

## 1. Code checks (free)

```bash
pnpm typecheck && pnpm lint && pnpm test   # 252 tests pass
E2E_PORT=3000 pnpm test:e2e                # reuses the running dev server
```

## 2. Pipeline ceiling (free)

```bash
pnpm eval --transcriber script --extractor oracle
```

Expect 28/28 fixtures, 41/41 checklist rows, 74/74 conversations, Layer B 66/67 (the one difference is the planted window change).

## 3. Real providers, from cache (free once cached)

```bash
pnpm eval
```

If any audio is not cached, it prints the minutes and stops; add `--yes` only if you accept the spend. Expect 27/28 fixtures, 40/41 rows, item precision and recall 100%, Layer B 66/67. Open http://localhost:3000/eval for the report.

## 4. Live feed replay (free STT from cache; Gemini if not cached)

```bash
pnpm feed replay lane_stream_a --speed 4   # --speed 1 is real time (about 23 min)
```

Watch http://localhost:3000/live: transcript, tracker timers, orders opening and closing, corrections as new versions. Deliveries land on http://localhost:3000/mock-webhook with the signature check passing.

## 5. Real WebSocket endpoint

```bash
pnpm feed replay 01_simple --via ws --scenario codec-mulaw   # Deepgram live (~1 min) unless serve runs --transcriber script
pnpm feed sim-check                                          # free STT; Gemini if keyed
```

The replay prints `sent N messages (... KB, mulaw) over 1 connection(s)`; the order shows on `/live`. `sim-check` runs the five acted scenarios in-process and ends `5/5 pass`.

## 6. Test Lab in the browser

Open http://localhost:3000/testlab (needs terminal B).

- **Setup:** check the microphone, pick who is testing (both parts, robot crew, or two people). Typing instead of speaking (free) is under Advanced.
- **Run scenarios 1, 4 and 6** (simple order, late add-on, drive off): press Start, read the line on screen, and watch the status chip. Each ends with a scorecard: Pass or Fail, Expected vs Extracted, and for any miss whether it was heard wrong, understood wrong or timing. With the mic each is about a minute of Deepgram.
- **A wrong run on purpose:** press Skip on the customer's order line; the scorecard fails with "heard wrong".
- **Stop:** End session sends the open conversation (flag `ended_by_operator`); Discard asks, then sends nothing. The Sessions panel on `/live` does the same for any stream.
- **History:** http://localhost:3000/testlab/history.

The manual simulator (every control, no script) is still at http://localhost:3000/simulator.

## 7. Review and delivery failures (free)

- http://localhost:3000/review: only flagged orders without a known answer (fixture runs are scored on their run page instead). Listen to the flagged lines, pick what each unclear item was or change a quantity, and save (or Looks right) to send `order.updated`. Every order is on http://localhost:3000/orders.
- http://localhost:3000/mock-webhook: switch on 500, 429 or timeout, replay a fixture, and watch retries; then `pnpm pipeline resend <order_id>`.

## 8. Ingest authentication (free)

```bash
pnpm pipeline token create --store s1 --lanes lane_1     # prints a sit_... token once
pnpm feed replay 01_simple --via ws --token sit_wrong    # Error: endpoint refused the connection: HTTP 401
pnpm pipeline token list
pnpm pipeline token revoke <token_id>                    # open sessions close with 4401
```

## 9. Data store (free)

```bash
pnpm data usage                  # bytes per kind against DATA_DISK_BUDGET_GB
pnpm data find --order <order_id>
pnpm data verify                 # "checked N; all match"
```

## Costs

- **Gemini:** free tier only. `GEMINI_DAILY_CAP` (default 200) counts requests per Pacific day in `.data/gemini-ledger.<model>.json`.
- **Deepgram:** check the balance at console.deepgram.com. Cached file runs cost nothing; live sockets and the mic are billed per minute.
