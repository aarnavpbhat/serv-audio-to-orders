import { expect, test, type Page } from "@playwright/test";

// v2.1 step 6: the review queue holds only flagged orders nobody knows the answer to (E5);
// fixture runs are scored against their script instead (E6).
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

test("a fixture run shows Expected vs Extracted, no review prompt, and stays out of the queue", async ({ page }) => {
  await fixtureRun(page);
  await expect(page.getByText(/scored automatically/)).toBeVisible();
  await expect(page.getByText(/^Review:/)).toHaveCount(0);
  const orderId = (await page.locator("span.font-mono", { hasText: /^ord_/ }).first().textContent())?.trim() ?? "";
  expect(orderId).toMatch(/^ord_/);
  await page.goto("/review");
  await expect(page.locator(`[id="${orderId}"]`)).toHaveCount(0);
});

test("a live order with an unclear item is in the queue with the reason in words; saving sends v2", async ({ page }) => {
  const lane = `review_${Date.now() % 1_000_000}`;
  await page.goto("/simulator");
  await page.getByRole("textbox", { name: "Lane" }).fill(lane);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("open", { exact: true })).toBeVisible();
  const say = async (speaker: "Crew" | "Customer", text: string) => {
    await page.getByRole("radio", { name: speaker }).click();
    await page.getByRole("textbox", { name: "Line" }).fill(text);
    await page.getByRole("button", { name: "Send" }).click();
  };
  await say("Crew", "Welcome, what can I get for you today?");
  await say("Customer", "Can I get a cheeseburger?");
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByText("Session ended: the open conversation was sent.")).toBeVisible();

  await page.goto("/review");
  const card = page.locator("[id^='ord_']", { hasText: lane });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText(/^We heard/).first()).toBeVisible();
  // Every card in the queue is flagged; completed orders with no flag are only on the Orders page.
  for (const c of await page.locator("[id^='ord_']").all()) await expect(c.getByText(/^Review:/).first()).toBeVisible();

  const orderId = (await card.getAttribute("id")) ?? "";
  await page.getByRole("textbox", { name: "Reviewer" }).fill("e2e");
  await card.getByRole("button", { name: "Save and send update" }).click();
  // v2 reaches the mock receiver as order.updated, and the order leaves the queue (its flag is cleared).
  await expect
    .poll(async () => {
      const { orders } = (await (await page.request.get("/api/mock-webhook")).json()) as { orders: { order_id: string; order_version: number }[] };
      return orders.find((o) => o.order_id === orderId)?.order_version;
    }, { timeout: 20_000 })
    .toBe(2);
  await page.reload();
  await expect(page.locator(`[id="${orderId}"]`)).toHaveCount(0);
});

test("the Orders page lists every order and filters by review", async ({ page }) => {
  await page.goto("/orders?review=no");
  await expect(page.getByRole("heading", { level: 1, name: "Orders" })).toBeVisible();
  await expect(page.locator("tbody").getByText("Flagged", { exact: true })).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toBeVisible();
});
