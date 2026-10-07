# Held-out set (human voices)

8 to 12 drive-thru conversations recorded by real people, with expected orders checked by hand. This set measures how the pipeline does on voices and wording it was never tuned on, so it must never be used to change prompts, cue lists or thresholds. The eval scores it on its own (`eval/heldout-report.json`) and the main eval never reads this folder.

## Recording

- Two people: one plays the crew, one the customer. Write fresh scripts; do not reuse the synthetic fixtures' wording.
- Use a phone or a laptop mic with some background noise (a running car, a fan, outdoors).
- Cover the usual cases: a plain order, a correction, a combo with a drink choice, a late "can I also add", a cancel, a car leaving mid-order.

Two ways to record:

1. **Simulator** (`/simulator`, dev routes on, with `pnpm feed serve` running): choose Microphone, press Start, act it out, press Stop, then Save as fixture with "Held out" ticked. Mic audio goes to Deepgram live, about 1 minute of credit per conversation.
2. **Phone recording:** `pnpm pipeline heldout import path/to/recording.m4a --name heldout_01`.

## Expected orders

Each folder has `expected.json`. Listen to the recording and write one order per car, in order:

```json
{ "orders": [{ "status": "completed", "items": [{ "catalog_id": "cheeseburger", "quantity": 1, "size": null }] }] }
```

Catalog ids are in `menu/menu.json`. Status is `completed`, `cancelled`, `abandoned` or `undetermined`. Have a second person check it.

## Scoring

```bash
pnpm pipeline heldout eval --transcriber deepgram          # shows the Deepgram minutes it will use
pnpm pipeline heldout eval --transcriber deepgram --yes    # runs it once
```

Run it once per pipeline version and report the numbers separately from the main eval.
