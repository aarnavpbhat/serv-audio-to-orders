/**
 * Mock Serv receiver: verifies Standard Webhooks signatures, dedupes on webhook-id, can simulate failures.
 * POST bodies imitate a receiver, not this app's API, so they keep their own shape; unexpected errors
 * still get the standard error response.
 */
import { getConfig } from "@serv/config";
import { handleMockWebhook, store } from "@serv/pipeline";
import { db } from "@/lib/data";
import { wrapAsync } from "@/lib/error-handler";

export const POST = wrapAsync(async (req: Request) => {
  const body = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const out = await handleMockWebhook(db(), getConfig().webhookSecret.value, { headers, body });
  return Response.json(out.json, { status: out.status, headers: out.headers });
});

export const GET = wrapAsync(async () => {
  const d = db();
  return Response.json({ settings: store.getMockSettings(d), inbox: store.listMockInbox(d, 200) });
});

export const DELETE = wrapAsync(async () => {
  db().prepare("DELETE FROM mock_inbox").run();
  return Response.json({ cleared: true });
});
