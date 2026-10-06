/** In-process run queue and slow-phase retry worker. Enough for a single-machine sandbox. */
import { RunCancelledError, createEngine, runPipeline, store, type Engine } from "@serv/pipeline";

export interface RunJob {
  runId: string;
  file: string;
  transcriber: "deepgram" | "script";
  extractor: "gemini" | "fuzzy" | "oracle";
  channelMap: Record<number, "crew" | "customer"> | null | undefined;
  deliver: boolean;
}

interface JobState {
  queue: RunJob[];
  running: boolean;
  /** The run in progress and its Cancel switch. */
  current: { runId: string; abort: AbortController } | null;
  worker: ReturnType<typeof setInterval> | null;
}

const g = globalThis as typeof globalThis & { __servJobs?: JobState };
const state: JobState = (g.__servJobs ??= { queue: [], running: false, current: null, worker: null });

function deliveryEngine(): Engine {
  return createEngine({ transcriber: "script", extractor: "fuzzy", log: () => {} });
}

export function enqueueRun(job: RunJob): void {
  state.queue.push(job);
  void pump();
}

async function pump(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    for (let job = state.queue.shift(); job; job = state.queue.shift()) {
      const abort = new AbortController();
      state.current = { runId: job.runId, abort };
      try {
        const engine = createEngine({ transcriber: job.transcriber, extractor: job.extractor, log: () => {} });
        await runPipeline(engine, job.file, { runId: job.runId, channelMap: job.channelMap, deliver: job.deliver, signal: abort.signal });
      } catch (e) {
        if (!(e instanceof RunCancelledError)) store.updateRun(deliveryEngine().db, job.runId, { status: "failed", error: (e as Error).message });
      } finally {
        state.current = null;
      }
    }
  } finally {
    state.running = false;
  }
}

/** Cancel a queued or running run. Idempotent: false when it is neither (already finished). */
export function cancelRun(runId: string): boolean {
  const i = state.queue.findIndex((j) => j.runId === runId);
  if (i >= 0) {
    state.queue.splice(i, 1);
    store.updateRun(deliveryEngine().db, runId, { status: "cancelled", stage: "done" });
    return true;
  }
  if (state.current?.runId === runId) {
    state.current.abort.abort();
    return true;
  }
  return false;
}

export function queuePosition(runId: string): number {
  return state.queue.findIndex((j) => j.runId === runId);
}

export function startWorker(): void {
  if (state.worker) return;
  const engine = deliveryEngine();
  engine.deliverer.recoverStuck();
  let busy = false;
  state.worker = setInterval(() => {
    if (busy) return;
    busy = true;
    engine.deliverer
      .processDue()
      .catch((e: unknown) => console.error("webhook worker:", e))
      .finally(() => (busy = false));
  }, 5000);
}

export async function resendDelivery(webhookId: string) {
  return deliveryEngine().deliverer.resend(webhookId);
}
