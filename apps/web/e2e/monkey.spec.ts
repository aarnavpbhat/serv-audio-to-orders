import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { LOG_DIR } from "../playwright.config";

// Monkey test (v2.1 step 2): silence and button presses are normal input. Chrome's fake
// microphone plays silence while random valid and invalid control sequences are clicked
// for MONKEY_MS (2 minutes by default). Nothing may error, every session must close, no
// model is called for a conversation with no speech, and audio stops when the stream stops.
const DURATION_MS = Number(process.env.MONKEY_MS ?? 120_000);
const SEED = Number(process.env.MONKEY_SEED ?? Date.now() % 1_000_000);

/** Small seeded generator (mulberry32), so a failing run can be replayed with MONKEY_SEED. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTIONS = ["Start", "Stop", "Car arrived", "Car left", "Pause stream", "Resume stream", "Drop connection", "Reconnect toggle", "Text (free)", "Microphone", "Continuous", "Only with a car", "Wait"] as const;
type Action = (typeof ACTIONS)[number];
const RADIOS: Action[] = ["Text (free)", "Microphone", "Continuous", "Only with a car"];

async function act(page: Page, name: Action, double: boolean): Promise<void> {
  if (name === "Wait") return page.waitForTimeout(1500);
  const target =
    name === "Reconnect toggle"
      ? page.getByRole("switch", { name: "Reconnect after a drop" })
      : RADIOS.includes(name)
        ? page.getByRole("radio", { name })
        : page.getByRole("button", { name, exact: true });
  if (!(await target.count())) return;
  // Disabled buttons are clicked too (force): an invalid press must do nothing.
  if (double) await target.dblclick({ force: true, timeout: 2000 }).catch(() => {});
  else await target.click({ force: true, timeout: 2000 }).catch(() => {});
}

const lines = (file: string): string[] => {
  try {
    return readFileSync(path.join(LOG_DIR, file), "utf8").split("\n");
  } catch {
    return [];
  }
};

const sessionId = (line: string): string => (JSON.parse(line) as { session_id: string }).session_id;

test("random clicks with a silent microphone never produce an error", async ({ page, request }) => {
  test.setTimeout(DURATION_MS + 120_000);
  test.info().annotations.push({ type: "seed", description: String(SEED) });
  const lane = `monkey_${SEED}`;
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console error: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
  const feedBefore = lines("feed.log").length;
  const webBefore = lines("web.log").length;

  await page.goto("/simulator");
  await page.getByRole("textbox", { name: "Lane" }).fill(lane);
  const random = rng(SEED);
  const end = Date.now() + DURATION_MS;
  while (Date.now() < end) {
    const name = ACTIONS[Math.floor(random() * ACTIONS.length)] as Action;
    await act(page, name, random() < 0.15);
    await page.waitForTimeout(Math.floor(random() * 600));
  }

  // Stop, then the audio counter must not move and nothing reconnects.
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  if (await stop.count()) await stop.click();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  const sentS = () => page.evaluate(() => /(\d+) s sent/.exec(document.body.innerText)?.[1] ?? null);
  const sent = await sentS();
  await page.waitForTimeout(2500);
  expect(await sentS()).toBe(sent);
  await expect(page.getByText(/^(open|connecting|reconnecting)$/)).toHaveCount(0);

  // Every session the monkey opened on its lane is closed on the server.
  await expect
    .poll(
      () => {
        const feed = lines("feed.log").slice(feedBefore);
        const opened = feed.filter((l) => l.includes('"ingest_session_open"') && l.includes(`"lane_id":"${lane}"`)).map(sessionId);
        const closed = new Set(feed.filter((l) => l.includes('"ingest_session_close"')).map(sessionId));
        return opened.filter((id) => !closed.has(id));
      },
      { timeout: 15_000 },
    )
    .toEqual([]);

  // Only silence was sent: any order is a car that came and went (no_speech), built without a model.
  const { orders } = (await (await request.get("/api/mock-webhook")).json()) as { orders: { body: string }[] };
  for (const o of orders) {
    const payload = JSON.parse(o.body) as { lane_id?: string; flags?: string[] };
    if (payload.lane_id === lane) expect(payload.flags).toContain("no_speech");
  }

  // Session 1's errors came from opening the live lane's run page: it has no audio file.
  const runs = (await (await request.get("/api/runs")).json()) as { id: string; source_file: string }[];
  const live = runs.find((r) => r.source_file === `live store_sim/${lane}`);
  if (live) {
    await page.goto(`/runs/${live.id}`);
    await expect(page.getByText(/Live session: there is no single audio file/)).toBeVisible();
  }

  const feed = lines("feed.log").slice(feedBefore);
  const web = lines("web.log").slice(webBefore);
  problems.push(...feed.filter((l) => /"severity":"ERROR"|transcriber error|Unhandled|unhandled/.test(l)));
  problems.push(...feed.filter((l) => l.includes(lane) && /gemini|LLM/i.test(l)));
  problems.push(...web.filter((l) => /\[Error\]|⨯|Unhandled/.test(l)));
  expect(problems, `seed ${SEED}`).toEqual([]);
});
