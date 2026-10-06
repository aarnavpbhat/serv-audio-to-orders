import { expect, test, type Page } from "@playwright/test";

// v2.1 step 3: a card header's title and its details never overlap, at common laptop widths.
const WIDTHS = [1024, 1280, 1440];

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function collisions(page: Page): Promise<string[]> {
  const out: string[] = [];
  const headers = page.locator("[data-section-header]");
  const n = await headers.count();
  for (let i = 0; i < n; i++) {
    const h = headers.nth(i);
    const parts = await Promise.all(
      ["[data-header-title]", "[data-header-details]", "[data-header-actions]"].map(async (sel) => {
        const el = h.locator(sel).first();
        return (await el.count()) ? el.boundingBox() : null;
      }),
    );
    const [title, details, actions] = parts;
    const name = ((await h.locator("[data-header-title]").first().textContent()) ?? "?").trim();
    if (title && details && overlaps(title, details)) out.push(`${name}: title and details overlap`);
    if (title && actions && overlaps(title, actions)) out.push(`${name}: title and actions overlap`);
    if (details && actions && overlaps(details, actions)) out.push(`${name}: details and actions overlap`);
  }
  return out;
}

test("card headers never overlap at 1024, 1280 and 1440 px", async ({ page }) => {
  test.setTimeout(120_000);
  // A finished run, for the run page's headers (free providers, as in the golden path).
  await page.goto("/");
  await page.getByRole("button", { name: /Correction: Coke to Sprite/ }).click();
  await page.getByRole("combobox", { name: "Transcriber" }).click();
  await page.getByRole("option", { name: "Ground truth (free)" }).click();
  await page.getByRole("combobox", { name: "Extractor" }).click();
  await page.getByRole("option", { name: "Keyword + fuzzy" }).click();
  await page.getByRole("button", { name: "Start Run" }).click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  await expect(page.getByText("Conversation 1")).toBeVisible({ timeout: 60_000 });
  const run = new URL(page.url()).pathname;

  const problems: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", run, "/eval", "/mock-webhook", "/simulator"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      problems.push(...(await collisions(page)).map((p) => `${width}px ${path}: ${p}`));
    }
  }
  // The transcript names only the model this run used.
  await page.goto(run);
  await expect(page.getByText(/Speaker roles: script · Script \(ground truth\)/)).toBeVisible();
  expect(problems).toEqual([]);
});
