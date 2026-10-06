import { expect, test } from "@playwright/test";

// Golden path: pick a fixture, run it with the free providers, and see the order
// built and its webhook delivered to the mock receiver.
test("a fixture run produces an order and a delivered webhook", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Correction: Coke to Sprite/ }).click();

  await page.getByRole("combobox", { name: "Transcriber" }).click();
  await page.getByRole("option", { name: "Ground truth (free)" }).click();
  await page.getByRole("combobox", { name: "Extractor" }).click();
  await page.getByRole("option", { name: "Keyword + fuzzy" }).click();

  await page.getByRole("button", { name: "Start Run" }).click();
  // A cold dev server compiles the run page on first visit.
  await expect(page).toHaveURL(/\/runs\/run_/, { timeout: 30_000 });

  await expect(page.getByText("Conversation 1")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("delivered", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
});

test("the Live page is disabled: 404 and not in the sidebar", async ({ page }) => {
  expect((await page.goto("/live"))?.status()).toBe(404);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Live", exact: true })).toHaveCount(0);
});
