import { getConfig } from "@serv/config";
import { MockInbox } from "@/components/MockInbox";
import { Placeholder } from "@/components/Badge";

export const dynamic = "force-dynamic";

export default function MockWebhookPage() {
  const cfg = getConfig();
  return (
    <div className="space-y-4">
      <section>
        <h1 className="text-xl font-semibold">Mock webhook receiver</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Stands in for Serv&apos;s endpoint at <code className="font-mono">/api/mock-webhook</code>. It verifies the Standard Webhooks signature and timestamp
          (5 minute tolerance), dedupes on <code className="font-mono">webhook-id</code>, and stores every request. Use the toggles to make it fail and watch the
          retries on a run page.
        </p>
        <p className="mt-2 flex items-center gap-2 text-xs text-muted">
          Signing secret <span className="font-mono">{cfg.webhookSecret.value.slice(0, 10)}...</span>
          {cfg.webhookSecret.placeholder && <Placeholder note={cfg.webhookSecret.note} />}
        </p>
      </section>
      <MockInbox />
    </div>
  );
}
