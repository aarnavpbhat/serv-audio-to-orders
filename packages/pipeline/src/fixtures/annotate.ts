/**
 * pnpm fixtures:annotate - add recording_start_utc and vehicle_events to every
 * timeline without re-rendering audio (fixtures:build writes them too).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getConfig } from "@serv/config";
import { FixtureTimeline } from "../schemas";
import { loadFixtureScripts } from "./load";
import { deriveVehicleEvents } from "./vehicle-events";

const cfg = getConfig();
const dir = path.join(cfg.paths.fixturesDir, "audio");
const scripts = new Map(loadFixtureScripts(path.join(cfg.paths.fixturesDir, "scripts")).map((s) => [s.id, s]));
for (const f of readdirSync(dir).filter((x) => x.endsWith(".timeline.json")).sort()) {
  const file = path.join(dir, f);
  const t = FixtureTimeline.parse(JSON.parse(readFileSync(file, "utf8")));
  const out = { ...t, vehicle_events: deriveVehicleEvents(t, scripts) };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`${f.padEnd(48)} ${out.vehicle_events.map((e) => `${e.type === "vehicle_arrived" ? "+" : "-"}${e.at_s}`).join(" ")}`);
}
