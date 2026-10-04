import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getConfig } from "@serv/config";

export interface FixtureFile {
  file: string;
  id: string;
  layout: string;
  noise: string;
  title: string;
}

export function listFixtureAudio(): FixtureFile[] {
  const dir = path.join(getConfig().paths.fixturesDir, "audio");
  if (!existsSync(dir)) return [];
  const titles = new Map<string, string>();
  const scriptsDir = path.join(getConfig().paths.fixturesDir, "scripts");
  for (const f of readdirSync(scriptsDir)) {
    const s = JSON.parse(readFileSync(path.join(scriptsDir, f), "utf8")) as { id: string; title: string };
    titles.set(s.id, s.title);
  }
  const comps = path.join(getConfig().paths.fixturesDir, "compilations.json");
  if (existsSync(comps)) for (const c of JSON.parse(readFileSync(comps, "utf8")) as { id: string; title: string }[]) titles.set(c.id, c.title);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mp3"))
    .sort()
    .map((file) => {
      const [id = file, layout = "", noise = ""] = file.replace(/\.mp3$/, "").split(".");
      return { file, id, layout, noise, title: titles.get(id) ?? id };
    });
}

export function fixturePath(file: string): string | null {
  if (!/^[\w.-]+\.mp3$/.test(file)) return null;
  const p = path.join(getConfig().paths.fixturesDir, "audio", file);
  return existsSync(p) ? p : null;
}
