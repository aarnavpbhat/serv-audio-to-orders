/**
 * Input layer: whatever HME (or a replay) sends becomes canonical frames and
 * control events. Nothing past this layer knows about WebSocket, codecs or HME
 * message formats.
 */

/** Canonical audio: 16 kHz, 16-bit PCM, one array per channel (plan D6). */
export const CANONICAL_RATE = 16_000;

export type SourceType = "hme_ws" | "file_replay" | "rtsp";
export type ChannelRole = "customer" | "crew" | "mixed";
export type TimeBasis = "source_clock" | "receive_clock" | "recording_metadata";

export interface AudioSource {
  messages(): AsyncIterable<SourceMessage>;
  close(): Promise<void>;
}

export type SourceMessage =
  | { kind: "session_open"; session: StreamSession }
  | { kind: "audio"; frame: AudioFrame }
  | { kind: "control"; event: ControlEvent }
  /** Dev only (simulator text mode): a typed line that skips transcription. HME never sends this. */
  | { kind: "script_line"; line: ScriptLine }
  /** Time passing with nothing else to report (replays carry their own clock). */
  | { kind: "tick"; at: string }
  | { kind: "session_close"; sessionId: string; at: string; reason: "remote_close" | "error" | "eof" };

export interface StreamSession {
  /** One per connection. */
  sessionId: string;
  storeId: string;
  laneId: string;
  sourceType: SourceType;
  audio: { sampleRate: typeof CANONICAL_RATE; channels: number; channelRoles?: ChannelRole[] };
  timeBasis: TimeBasis;
  /** ISO UTC time of sample 0. */
  anchorAt: string;
  /** What arrived on the wire, for the record. */
  codecIn: string;
  /**
   * Replay only, set by FileReplaySource and never from the network: the file being
   * replayed and where in it this session starts (lets the free script transcriber
   * find its timeline).
   */
  sourceRef?: string;
  sourceOffsetS?: number;
}

export interface AudioFrame {
  sessionId: string;
  seq: number;
  /** Samples per channel since anchorAt. */
  sampleOffset: number;
  /** Timestamp from the source, if it sends one. */
  sourceAt?: string;
  receivedAt: string;
  /** One array per channel, 16 kHz. */
  pcm: Int16Array[];
}

export type ControlEventType =
  | "vehicle_arrived"
  | "vehicle_departed"
  | "stream_paused"
  | "stream_resumed"
  | "crew_takeover"
  | "heartbeat"
  | "unknown";

export interface ControlEvent {
  sessionId: string;
  at: string;
  type: ControlEventType;
  /** Original message, always kept. */
  raw?: unknown;
}

export interface ScriptLine {
  sessionId: string;
  at: string;
  speaker: "crew" | "customer";
  text: string;
}

/** Time of a message, for clocks driven by the source. */
export function messageTime(m: SourceMessage): string | null {
  switch (m.kind) {
    case "session_open":
      return m.session.anchorAt;
    case "audio":
      return m.frame.receivedAt;
    case "control":
      return m.event.at;
    case "script_line":
      return m.line.at;
    case "tick":
    case "session_close":
      return m.at;
  }
}
