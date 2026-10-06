# Step 1: The one failing eval case

Status: root cause proven (Deepgram, context-dependent). No code fix exists at our layers; the way forward needs Aarnav's call (see "Decision needed").

## What failed

| | |
|---|---|
| Fixture | `lane_stream_a` (19 cars, about 23 minutes, mono, moderate noise) |
| Checklist row | 23, Back-to-back orders |
| Run | Real providers: Deepgram Nova-3 (prerecorded, cached) + Gemini 3.5 Flash-Lite, file replay at max speed (`eval/report.json`, generated 2026-10-06T03:36Z) |
| Car | Expected order 8 (from script `08_per_unit_and_hesitation`), at 511.7 to 535.6 s |
| Diff | `missing not_ordered cookie:uncommitted`. Items were right (2 hamburgers, one no pickles, a medium Coke). Status and flags were right. |

The car's script:

```
crew:     Welcome to Sandbox Burger, what can I get for you today?
customer: Can I get two hamburgers, one with no pickles?
crew:     Two hamburgers, one no pickles. Anything else?
customer: Maybe a cookie... nah, I'm good. Just a medium Coke.
crew:     Okay, your total is $6.97. Pull forward please.
```

## Which layer failed

| Configuration | Result for this car | Evidence |
|---|---|---|
| Script transcriber + oracle events | Pass | Ceiling eval, 28/28 fixtures, run on 2026-10-05 after the PR #20 fix |
| Script transcriber + Gemini | Pass: Gemini emits `ADD cookie` with commitment 0.1 to 0.2, which replay turns into `not_ordered cookie:uncommitted` (`HESITATION_MAX = 0.5`, `packages/pipeline/src/build/replay.ts:12`, `:350`) | Four cached extract-v4 responses on the true words: `.cache/llm/09929dc2…`, `9275faf3…`, `b4968d6b…`, `066c7d13…` |
| Deepgram + Gemini, max speed | **Fail** | Runs `run_01M47KQ3Q6QVB586SKE6NYRZT7`, `run_01M47MCMYYKV8FHYN0YGTRWQM5`, `run_01M47MGCMA4PEB7K5T8NDZBWWY` |
| Deepgram + Gemini, 1x | Not run | The max-speed run already fails, and the cause is upstream of timing |

What Deepgram heard for that line, identical in all three runs:

```
u53 525.0 customer [0.95]: Maybe a Coke. No. I'm good. Just a medium Coke.
```

"Maybe a cookie... nah" came back as "Maybe a Coke. No." Gemini then extracted that transcript correctly (2 hamburgers, a medium Coke, nothing else). No extraction rule can recover a cookie that isn't in the words.

**Flaky?** No, not in our code. All three failing runs used the same cached Deepgram response, so the transcript was identical and the result was 3/3 the same. Whether a fresh Deepgram call would hear it differently is unknown, because finding out costs credit (below).

## Root cause

This is a transcription error under noise: the word "cookie" was heard as "Coke". One likely contributor is the keyterm list sent to Deepgram (`Catalog.keyterms()`, `packages/pipeline/src/menu/catalog.ts:64`). It contains canonical item names only, so it boosts "Coke" while "cookie" appears only inside "Chocolate Chip Cookie". The customer said the short form.

This is a hypothesis, not proven yet. The same line in the clean standalone fixture is transcribed correctly, so noise is the main factor.

## Experiments (run 2026-10-05, with Aarnav's approval to spend Deepgram credit)

About 26.8 Deepgram minutes in total.

| Test | Request | Result for the line |
|---|---|---|
| Car 8 clip alone (28 s, cut from 509 s), today's keyterms, `en` | 3 calls | "Maybe a cookie. Nah." 3/3 |
| Same clip, keyterms plus "cookie", `en` | 3 calls | "Maybe a cookie. Nah." 3/3 |
| Same clip, today's keyterms, `multi` (what production uses) | 3 calls | "Maybe a cookie. No." 3/3 |
| Full `lane_stream_a`, fresh call with the exact production options (`packages/pipeline/src/transcribe/deepgram.ts:96`) | 1 call | "Maybe a Coke. No." (Coke at confidence 0.65), identical to the cached response, same model version `2026-01-27.9107` |

What this shows:

- The keyterm hypothesis is wrong. Deepgram hears "cookie" on the clip with or without it in the keyterm list.
- Language mode is not the cause either.
- The error appears only when Deepgram transcribes the whole 23-minute stream, and it is repeatable there (cached plus fresh: 2 of 2 calls, plus 3 of 3 eval runs). It is deterministic, not flaky. Deepgram uses the surrounding audio as context; in the long file, after many "Coke" orders, this noisy word comes out as "Coke".
- Our code, the prompt and the tracker behave correctly given the words they get.

## Why there is no fix at our layers

- **Keyterms:** proven not to matter.
- **Extraction:** "Maybe a Coke. No. ... Just a medium Coke." really does read as a medium Coke. Inventing a cookie from it would be wrong.
- **Splitting the stream into per-car requests before transcription:** this would change how file replay works (v2 decision D1: files go through the lane like live audio). Live streaming would not get the same help. And tuning the pipeline until one fixture passes is the kind of special-casing the plan rules out.

## Decision needed (Aarnav)

The step's done-when ("passes 3 of 3") cannot be met without one of these:

1. **Accept it as a known gap (recommended).** The case stays in the report as a documented transcription miss under moderate noise. The release gate line for step 1 is waived. The README's known gaps section gets one line. No code change, so no regression test.
2. **Change the fixture.** Rebuild `lane_stream_a` at a lower noise level, or change car 8's hesitation to a word that does not collide with a menu item. This changes eval data, not a rule. It costs about 23 Deepgram minutes to re-transcribe.
3. **Change the expectation.** Drop `not_ordered cookie:uncommitted` from that one car's expected order. This edits ground truth to match a known error, so I advise against it.

Until you choose, the eval keeps reporting the case as failing and nothing else changes.
