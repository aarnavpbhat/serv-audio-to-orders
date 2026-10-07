/**
 * PLACEHOLDER adapters for HME's older setup (an RTSP audio server in the base
 * station and MQTT messages for heartbeat, telemetry and arrivals). Interfaces
 * only in v2, so they can be built later without touching the lane or order logic.
 */
import type { AudioSource, ControlEvent, SourceMessage } from "./types";

export interface RtspOptions {
  url: string;
  storeId: string;
  laneId: string;
}

/** Would pull audio from the base station's RTSP server (ffmpeg -i rtsp://...) into canonical frames. */
export class RtspSource implements AudioSource {
  constructor(readonly opts: RtspOptions) {}

  messages(): AsyncIterable<SourceMessage> {
    throw new Error("RtspSource is not implemented in v2 (placeholder until HME confirms the RTSP setup)");
  }

  async close(): Promise<void> {}
}

export interface MqttOptions {
  brokerUrl: string;
  topics: string[];
}

/** Would map MQTT arrival and heartbeat messages to the same ControlEvent the WebSocket parser produces. */
export class MqttEventSource {
  constructor(readonly opts: MqttOptions) {}

  events(): AsyncIterable<ControlEvent> {
    throw new Error("MqttEventSource is not implemented in v2 (placeholder until HME confirms its MQTT topics)");
  }
}
