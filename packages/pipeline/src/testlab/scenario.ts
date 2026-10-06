/**
 * Test Lab scenarios (v2.1 step 7): a script to read aloud, the actions the app
 * performs while you read it (a car arrives, the connection drops), and the
 * order the system should produce. Stored in testlab/scenarios/*.json.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Catalog } from "../menu/catalog";
import { ExpectedOrder } from "../schemas";

export const ScenarioLine = z.object({
  role: z.enum(["crew", "customer"]),
  text: z.string().min(1),
  /** Read this line only once the previous order was sent (a late addition after the close). */
  wait_for: z.literal("order_sent").optional(),
});
export type ScenarioLine = z.infer<typeof ScenarioLine>;

export const ScenarioAction = z.object({
  /** When: before the first line, after line N (1-based), or after the last line. */
  at: z.union([z.literal("start"), z.literal("end"), z.object({ after_line: z.number().int().min(1) })]),
  do: z.enum(["car_arrived", "car_left", "drop"]),
  /** drop: seconds offline before reconnecting; null drops for good. */
  seconds: z.number().positive().nullable().optional(),
});
export type ScenarioAction = z.infer<typeof ScenarioAction>;

export const Scenario = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  number: z.number().int().positive(),
  title: z.string(),
  /** What it checks, in plain words (shown on the card). */
  checks: z.string(),
  /** About how long a run takes, in minutes (shown on the card). */
  minutes: z.number().positive(),
  lines: z.array(ScenarioLine).min(1),
  actions: z.array(ScenarioAction).default([]),
  expected: z.object({ orders: z.array(ExpectedOrder).min(1) }),
});
export type Scenario = z.infer<typeof Scenario>;

/** Actions that happen at a point in the script, in file order. */
export function actionsAt(s: Pick<Scenario, "actions" | "lines">, point: "start" | "end" | number): ScenarioAction[] {
  return s.actions.filter((a) => {
    if (point === "start") return a.at === "start";
    if (point === "end") return a.at === "end" || (typeof a.at === "object" && a.at.after_line === s.lines.length);
    return typeof a.at === "object" && a.at.after_line === point && point !== s.lines.length;
  });
}

/** Every scenario, by number. Each is validated, and every catalog id it expects must be on the menu. */
export function loadScenarios(dir: string, catalog?: Catalog): Scenario[] {
  const out = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const parsed = Scenario.safeParse(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return parsed.data;
    });
  if (catalog) {
    for (const s of out) {
      for (const o of s.expected.orders) {
        const ids = [...o.items.map((i) => i.catalog_id), ...o.not_ordered.map((n) => n.catalog_id).filter((x): x is string => !!x), ...o.needs_review.flatMap((n) => n.candidates_include)];
        for (const id of ids) if (!catalog.has(id)) throw new Error(`${s.id}: ${id} is not on the menu`);
      }
    }
  }
  return out.sort((a, b) => a.number - b.number);
}
