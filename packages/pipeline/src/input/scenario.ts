/** Replay scenarios: what the live feed might do (fixtures/scenarios/*.json). */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WIRE_CODECS, type WireCodec } from "./decoders";

export const Scenario = z.object({
  name: z.string(),
  description: z.string().default(""),
  /** continuous, or audio only while a car is at the post (HME's "paused when no vehicle"). */
  audio_mode: z.enum(["continuous", "paused_when_no_vehicle"]).default("continuous"),
  /** off, on (from the fixture timeline), or noisy (some missed, some ghost events). */
  vehicle_events: z.enum(["off", "on", "noisy"]).default("off"),
  /** Drop the connection at at_s for for_s seconds; reconnect follows HME's 2, 4, 8 s backoff unless false. */
  disconnects: z.array(z.object({ at_s: z.number().nonnegative(), for_s: z.number().positive(), reconnect: z.boolean().default(true) })).default([]),
  codec: z.enum(WIRE_CODECS as [WireCodec, ...WireCodec[]]).default("pcm_s16le"),
  frame_ms: z.number().int().min(20).max(500).default(100),
  /** mono mix, or stereo with roles (customer left, crew right). */
  channels: z.enum(["mono", "stereo"]).default("mono"),
  /** Stream paused (no audio) at these times, without vehicle events. */
  pauses: z.array(z.object({ at_s: z.number().nonnegative(), for_s: z.number().positive() })).default([]),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;

export const DEFAULT_SCENARIO: Scenario = Scenario.parse({ name: "default" });

export function loadScenario(fixturesDir: string, nameOrPath: string): Scenario {
  const file = existsSync(nameOrPath) ? nameOrPath : path.join(fixturesDir, "scenarios", `${nameOrPath}.json`);
  if (!existsSync(file)) {
    const known = existsSync(path.join(fixturesDir, "scenarios")) ? readdirSync(path.join(fixturesDir, "scenarios")).map((f) => f.replace(/\.json$/, "")) : [];
    throw new Error(`Unknown scenario "${nameOrPath}". Known: ${known.join(", ") || "none"}`);
  }
  return Scenario.parse({ name: path.basename(file, ".json"), ...(JSON.parse(readFileSync(file, "utf8")) as object) });
}

/** HME reconnect backoff: 2 s, doubling, capped at 180 s. Returns when the link is back up after a for_s outage. */
export function reconnectDelayS(outageS: number): number {
  let t = 0;
  let delay = 2;
  while (t < outageS) {
    t += delay;
    delay = Math.min(180, delay * 2);
  }
  return t;
}
