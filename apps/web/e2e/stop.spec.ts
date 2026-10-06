import { expect, test, type Page } from "@playwright/test";

// v2.1 step 4: End and Discard (E3) stop everything, never come back by themselves,
// and leave the lane ready for the next connection.
type Order = { lane_id?: string; flags?: string[] };

async function ordersFor(page: Page, lane: string): Promise<Order[]> {
  const { orders } = (await (await page.request.get("/api/mock-webhook")).json()) as { orders: { body: string }[] };
  return orders.map((o) => JSON.parse(o.body) as Order).filter((o) => o.lane_id === lane);
}

async function open(page: Page, lane: string): Promise<void> {
  await page.goto("/simulator");
  await page.getByRole("textbox", { name: "Lane" }).fill(lane);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("open", { exact: true })).toBeVisible();
}

async function say(page: Page, speaker: "Crew" | "Customer", text: string): Promise<void> {
  await page.getByRole("radio", { name: speaker }).click();
  await page.getByRole("textbox", { name: "Line" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

async function order(page: Page): Promise<void> {
  await say(page, "Crew", "Welcome, what can I get for you today?");
  await say(page, "Customer", "Can I get a cheeseburger?");
  // The session shows up in the feed's list (polled every 2 s) before stopping it.
  await page.waitForTimeout(2500);
}

const lane = (name: string) => `${name}_${Date.now() % 1_000_000}`;

test("End sends the open conversation once, flagged; the lane takes a new connection right after", async ({ page }) => {
  const l = lane("stop_end");
  await open(page, l);
  await order(page);
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByText("Session ended: the open conversation was sent.")).toBeVisible();
  await expect.poll(async () => (await ordersFor(page, l)).map((o) => o.flags?.includes("ended_by_operator"))).toEqual([true]);
  // Nothing reconnects by itself.
  await page.waitForTimeout(3000);
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  // A new connection on the same lane works at once.
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("open", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "End session" }).click();
  await page.waitForTimeout(1000);
  expect(await ordersFor(page, l)).toHaveLength(1);
});

test("Discard asks first, then drops the conversation: no webhook", async ({ page }) => {
  const l = lane("stop_discard");
  await open(page, l);
  await order(page);
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("button", { name: "Yes, discard" }).click();
  await expect(page.getByText("Session discarded: nothing was sent.")).toBeVisible();
  await page.waitForTimeout(4000);
  expect(await ordersFor(page, l)).toEqual([]);
});

test("End during reconnect backoff still sends, and stops the reconnect", async ({ page }) => {
  const l = lane("stop_backoff");
  await open(page, l);
  await order(page);
  await page.getByRole("button", { name: "Drop connection" }).click();
  await expect(page.getByText("reconnecting", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "End session" }).click();
  await expect.poll(async () => (await ordersFor(page, l)).length).toBe(1);
  await page.waitForTimeout(5000);
  await expect(page.getByText(/^(open|connecting|reconnecting)$/)).toHaveCount(0);
});

test("stopping twice, or from a second tab, is not an error", async ({ page, context }) => {
  const l = lane("stop_tabs");
  await open(page, l);
  await order(page);
  const { sessions } = (await (await page.request.get("/api/sessions")).json()) as { sessions: { sessionId: string; laneId: string }[] };
  const id = sessions.find((s) => s.laneId === l)?.sessionId ?? "";
  expect(id).not.toBe("");
  // The Live page's Sessions panel in another tab ends it.
  const other = await context.newPage();
  await other.goto("/live");
  await other.locator(`[data-session="${id}"]`).getByRole("button", { name: "End session" }).click();
  await expect(page.getByText(/stopped by operator/i)).toBeVisible();
  await page.waitForTimeout(3000);
  await expect(page.getByText(/^(open|connecting|reconnecting)$/)).toHaveCount(0);
  const again = await page.request.post(`/api/sessions/${id}/stop`, { data: { mode: "end" } });
  expect(again.status()).toBe(200);
  expect(await ordersFor(page, l)).toHaveLength(1);
});

test("with the microphone, audio stops within 2 s of End", async ({ page }) => {
  const l = lane("stop_mic");
  await page.goto("/simulator");
  await page.getByRole("textbox", { name: "Lane" }).fill(l);
  await page.getByRole("radio", { name: "Microphone" }).click();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const sent = () => page.evaluate(() => Number(/(\d+) s sent/.exec(document.body.innerText)?.[1] ?? -1));
  await expect.poll(sent).toBeGreaterThan(1);
  await page.getByRole("button", { name: "End session" }).click();
  await page.waitForTimeout(2000);
  const after = await sent();
  await page.waitForTimeout(3000);
  expect(await sent()).toBe(after);
});
