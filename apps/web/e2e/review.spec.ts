import { expect, test, type Page } from "@playwright/test";

// v2.1 step 6: fixture runs are scored against their script (E6). The review queue page is
// disabled for now; flagged orders stay on the Orders page.
async function fixtureRun(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: /Correction: Coke to Sprite/ }).click();
  await page.getByRole("combobox", { name: "Transcriber" }).click();
  await page.getByRole("option", { name: "Ground truth (free)" }).click();
  await page.getByRole("combobox", { name: "Extractor" }).click();
  await page.getByRole("option", { name: "Keyword + fuzzy" }).click();
  await page.getByRole("button", { name: "Start Run" }).click();
  // A cold dev server compiles the run page on first visit.
  await expect(page).toHaveURL(/\/runs\/run_/, { timeout: 30_000 });
  await expect(page.getByTestId("expected-vs-extracted")).toBeVisible({ timeout: 60_000 });
  return page.url();
}

test("a fixture run shows Expected vs Extracted and no review prompt", async ({ page }) => {
  // fixtureRun waits up to 90 s on a cold dev server; the default 30 s test timeout cuts it short.
  test.setTimeout(120_000);
  await fixtureRun(page);
  await expect(page.getByText(/scored automatically/)).toBeVisible();
  await expect(page.getByText(/^Review:/)).toHaveCount(0);
});

test("the review queue page is disabled: 404 and not in the sidebar", async ({ page }) => {
  expect((await page.goto("/review"))?.status()).toBe(404);
  await page.goto("/orders");
  await expect(page.getByRole("link", { name: /^Review/ })).toHaveCount(0);
});

// The test makes its own order: CI starts with an empty database. With the keyword extractor this
// fixture's items are unclear, so the order is flagged.
test("the Orders page lists every order and filters by review", async ({ page }) => {
  test.setTimeout(120_000);
  const runId = new URL(await fixtureRun(page)).pathname.split("/").pop() ?? "";
  const row = page.locator("tbody tr", { has: page.locator(`a[href="/runs/${runId}"]`) });

  await page.goto("/orders");
  await expect(page.getByRole("heading", { level: 1, name: "Orders" })).toBeVisible();
  await expect(row).toHaveCount(1);
  await page.goto("/orders?review=yes");
  await expect(row.getByText("Flagged", { exact: true })).toBeVisible();
  await page.goto("/orders?review=no");
  await expect(row).toHaveCount(0);
  await expect(page.locator("tbody").getByText("Flagged", { exact: true })).toHaveCount(0);
});
