/** Routes source messages to lanes. Lanes are keyed by store_id:lane_id, so a reconnect continues the same lane. */
import type { SourceMessage } from "../input/types";
import { isSafeId } from "../lib/safe-id";
import { LaneSession, laneKey, type LaneOptions } from "./lane";

export class LaneManager {
  readonly lanes = new Map<string, LaneSession>();
  private readonly bySession = new Map<string, LaneSession>();

  /** Sessions refused at open (unsafe ids); their later messages are dropped. */
  readonly rejected = new Set<string>();

  constructor(private readonly opts: LaneOptions) {}

  async handle(m: SourceMessage): Promise<void> {
    if (m.kind === "session_open") {
      // Store, lane and session ids end up in file paths and payloads: strict pattern only.
      const { storeId, laneId, sessionId } = m.session;
      if (![storeId, laneId, sessionId].every(isSafeId)) {
        this.rejected.add(sessionId);
        (this.opts.log ?? this.opts.engine.log)(`session refused: unsafe store, lane or session id`);
        return;
      }
      const key = laneKey(m.session.storeId, m.session.laneId);
      let lane = this.lanes.get(key);
      if (!lane) {
        lane = new LaneSession(m.session.storeId, m.session.laneId, this.opts);
        this.lanes.set(key, lane);
      }
      this.bySession.set(m.session.sessionId, lane);
      return lane.handle(m);
    }
    if (m.kind === "tick") {
      await Promise.all([...this.lanes.values()].map((l) => l.handle(m)));
      return;
    }
    const id = m.kind === "audio" ? m.frame.sessionId : m.kind === "control" ? m.event.sessionId : m.kind === "script_line" ? m.line.sessionId : m.sessionId;
    await this.bySession.get(id)?.handle(m);
  }

  /** Operator stop (E3) by session id; false if no lane knows it. */
  async stop(sessionId: string, mode: "end" | "discard", at: string): Promise<boolean> {
    const lane = this.bySession.get(sessionId);
    return lane ? lane.stop(sessionId, mode, at) : false;
  }

  /** Every session an operator can stop, across lanes. */
  sessions(): { sessionId: string; storeId: string; laneId: string; open: boolean; sourceType: string; openedAt: string; audioMinutes: number }[] {
    return [...this.lanes.values()].flatMap((l) => l.stoppable.map((s) => ({ ...s, storeId: l.storeId, laneId: l.laneId })));
  }

  lane(storeId: string, laneId: string): LaneSession | undefined {
    return this.lanes.get(laneKey(storeId, laneId));
  }

  async end(): Promise<void> {
    for (const lane of this.lanes.values()) await lane.end();
  }
}
