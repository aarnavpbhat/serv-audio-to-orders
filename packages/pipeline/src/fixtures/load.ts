import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FixtureScript } from "../schemas";

export function loadFixtureScripts(dir: string): FixtureScript[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const raw: unknown = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      const parsed = FixtureScript.safeParse(raw);
      if (!parsed.success) throw new Error(`${f}: ${parsed.error.message}`);
      return parsed.data;
    });
}
