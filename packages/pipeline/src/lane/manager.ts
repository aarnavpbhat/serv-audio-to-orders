/** Routes source messages to lanes. Lanes are keyed by store_id:lane_id, so a reconnect continues the same lane. */
import type { SourceMessage } from "../input/types";
import { LaneSession, laneKey, type LaneOptions } from "./lane";

export class LaneManager {
  readonly lanes = new Map<string, LaneSession>();
  private readonly bySession = new Map<string, LaneSession>();

  constructor(private readonly opts: LaneOptions) {}

  async handle(m: SourceMessage): Promise<void> {
    if (m.kind === "session_open") {
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

  async end(): Promise<void> {
    for (const lane of this.lanes.values()) await lane.end();
  }
}
