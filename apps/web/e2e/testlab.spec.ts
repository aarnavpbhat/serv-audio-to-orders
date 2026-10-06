import { expect, test, type Page } from "@playwright/test";

// v2.1 step 7: Test Lab end to end, typing the lines (free): every scenario reaches a
// scorecard, in every tester mode; a deliberately wrong run fails with the right
// attribution; the history aggregates runs.
test.describe.configure({ mode: "serial" });

async function openLab(page: Page, mode: "both" | "robot" | "two"): Promise<void> {
  await page.addInitScript((m) => localStorage.setItem("serv-testlab", JSON.stringify({ testerMode: m, input: "text", micOk: false })), mode);
  await page.goto("/testlab");
  await expect(page.getByRole("button", { name: "Test 1: Simple order" })).toBeVisible();
}

async function playToScorecard(page: Page): Promise<"Pass" | "Fail"> {
  await page.getByRole("button", { name: "Start the test" }).click();
  await page.getByRole("button", { name: "Play the script" }).click();
  await expect(page.getByTestId("scorecard")).toBeVisible({ timeout: 120_000 });
  return ((await page.getByTestId("scorecard").locator("h2").first().textContent()) ?? "").trim() as "Pass" | "Fail";
}

for (const mode of ["both", "robot", "two"] as const) {
  test(`all 10 scenarios run to a scorecard (tester mode: ${mode})`, async ({ page }) => {
    test.setTimeout(15 * 60_000);
    await openLab(page, mode);
    await page.getByRole("button", { name: "Test 1: Simple order" }).click();
    for (let n = 1; n <= 10; n++) {
      await expect(page.getByText(new RegExp(`^${n}\\. `)).first()).toBeVisible();
      const result = await playToScorecard(page);
      expect(["Pass", "Fail"]).toContain(result);
      await expect(page.getByText("Speaker roles right")).toBeVisible();
      if (n < 10) await page.getByRole("button", { name: "Next test" }).click();
    }
  });
}

test("a run with a skipped line fails, and the missing item is attributed to hearing", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await openLab(page, "both");
  await page.getByRole("button", { name: "Test 1: Simple order" }).click();
  await page.getByRole("button", { name: "Start the test" }).click();
  await page.getByRole("button", { name: "Send this line" }).click();
  // Line 2 is the customer's order: leave it out.
  await expect(page.getByTestId("teleprompter")).toContainText("Can I get a cheeseburger");
  await page.getByRole("button", { name: "Skip this line" }).click();
  await page.getByRole("button", { name: "Play the script" }).click();
  const card = page.getByTestId("scorecard");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.locator("h2").first()).toHaveText("Fail");
  const missing = card.locator("li", { hasText: "Missing: 1 Cheeseburger" });
  await expect(missing).toContainText("heard wrong");
});

test("scripted runs have a known answer, so none of their orders wait in the review queue", async ({ page }) => {
  await page.goto("/review");
  await expect(page.getByText(/store_testlab \/ tl_\d+_/)).toHaveCount(0);
});

test("the history aggregates the runs per scenario", async ({ page }) => {
  await page.goto("/testlab/history");
  await expect(page.getByTestId("history-table")).toBeVisible();
  const runs = await page.getByText(/^\d+ runs$/).first().textContent();
  expect(Number(runs?.split(" ")[0])).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("history-table").getByText("1. Simple order")).toBeVisible();
});
