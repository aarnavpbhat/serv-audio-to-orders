/** Mock Serv receiver: verifies Standard Webhooks signatures, dedupes on webhook-id, can simulate failures. */
import { getConfig } from "@serv/config";
import { handleMockWebhook, store } from "@serv/pipeline";
import { db } from "@/lib/data";

export async function POST(req: Request) {
  const body = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const out = await handleMockWebhook(db(), getConfig().webhookSecret.value, { headers, body });
  return Response.json(out.json, { status: out.status, headers: out.headers });
}

export function GET() {
  const d = db();
  return Response.json({ settings: store.getMockSettings(d), inbox: store.listMockInbox(d, 200) });
}

export function DELETE() {
  db().prepare("DELETE FROM mock_inbox").run();
  return Response.json({ cleared: true });
}
