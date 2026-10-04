/** In-process run queue and slow-phase retry worker. Enough for a single-machine sandbox. */
import { createEngine, runPipeline, store, type Engine } from "@serv/pipeline";

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
  worker: ReturnType<typeof setInterval> | null;
}

const g = globalThis as typeof globalThis & { __servJobs?: JobState };
const state: JobState = (g.__servJobs ??= { queue: [], running: false, worker: null });

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
      try {
        const engine = createEngine({ transcriber: job.transcriber, extractor: job.extractor, log: () => {} });
        await runPipeline(engine, job.file, { runId: job.runId, channelMap: job.channelMap, deliver: job.deliver });
      } catch (e) {
        const db = deliveryEngine().db;
        store.updateRun(db, job.runId, { status: "failed", error: (e as Error).message });
      }
    }
  } finally {
    state.running = false;
  }
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
