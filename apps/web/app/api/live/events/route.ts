/**
 * GET /api/live/events: server-sent events for the Live page. The live service
 * (pnpm feed serve) and replays write lane updates to live_events; this route
 * sends the recent rows, then new ones as they arrive. Reconnects resume from
 * Last-Event-ID.
 */
import { liveAfter, liveRecent, type LiveEvent } from "@serv/pipeline";
import { db } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_MS = 250;
const HEARTBEAT_MS = 15_000;

function frame(r: LiveEvent): string {
  const row = { id: r.id, at: r.at, store_id: r.store_id, lane_id: r.lane_id, type: r.type, data: JSON.parse(r.data) as unknown };
  return `id: ${r.id}\ndata: ${JSON.stringify(row)}\n\n`;
}

export function GET(req: Request): Response {
  const url = new URL(req.url);
  const raw = req.headers.get("last-event-id") ?? url.searchParams.get("after");
  const resumeFrom = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  const d = db();
  const enc = new TextEncoder();
  let poll: ReturnType<typeof setInterval> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (poll) clearInterval(poll);
    if (beat) clearInterval(beat);
    poll = beat = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      // A fresh view gets the recent rows; a reconnect gets what it missed.
      const initial = resumeFrom === null ? liveRecent(d) : liveAfter(d, resumeFrom, 5000);
      let cursor = initial.at(-1)?.id ?? resumeFrom ?? 0;
      send(`retry: 2000\n\n`);
      for (const r of initial) send(frame(r));
      send(`event: ready\ndata: {}\n\n`);
      poll = setInterval(() => {
        for (const r of liveAfter(d, cursor)) {
          send(frame(r));
          cursor = r.id;
        }
      }, POLL_MS);
      beat = setInterval(() => send(`: keep-alive\n\n`), HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel: stop,
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-content-type-options": "nosniff" } });
}
