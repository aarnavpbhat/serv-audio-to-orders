/**
 * pnpm data find|usage|verify|prune|delete|label
 *
 * prune and delete show what they would remove; --yes removes it. Orders,
 * order versions, outbox rows and delivery attempts are never deleted here.
 */
import { ConfigError, type Engine } from "../engine";
import { orderVersions, outboxForOrder } from "../store/db";
import { putLabel } from "./labels";
import { ARTIFACT_KINDS, type ArtifactKind, type ArtifactRow } from "./store";

export const DATA_HELP = `Usage: pnpm data <command>

  find --order <id> | --session <id> | --store <id> [--kind raw|audio|asr|llm|events|labels]
  usage                         bytes per kind against DATA_DISK_BUDGET_GB
  verify [--sample 50]          re-hash stored blobs; report missing or changed ones
  prune --kind <k> --older-than <days>d [--yes]
  delete --store <id> | --session <id> | --order <id> [--yes]
  label --order <id> --version <n> --verdict correct|incorrect|unsure --author <name> [--note text]

prune and delete list what they would remove; add --yes to remove it. Order
records and delivery history are kept.`;

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GB`;
const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)} MB`;

function kindOf(v: unknown): ArtifactKind | undefined {
  if (v === undefined) return undefined;
  if (!ARTIFACT_KINDS.includes(v as ArtifactKind)) throw new ConfigError(`--kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
  return v as ArtifactKind;
}

function printRows(rows: ArtifactRow[]): void {
  for (const r of rows) {
    console.log(`${r.kind.padEnd(7)} ${String(r.bytes).padStart(10)} B  ${new Date(r.created_at).toISOString()}  ${r.uri}${r.order_version ? `  (v${r.order_version})` : ""}`);
  }
}

export async function dataCommand(engine: Engine, sub: string | undefined, values: Record<string, unknown>): Promise<void> {
  const data = engine.data;
  const scope = {
    ...(values.order ? { orderId: String(values.order) } : {}),
    ...(values.session ? { sessionId: String(values.session) } : {}),
    ...(values.store ? { storeId: String(values.store) } : {}),
  };
  switch (sub) {
    case "find": {
      if (!Object.keys(scope).length) throw new ConfigError("Usage: pnpm data find --order <id> | --session <id> | --store <id> [--kind k]");
      const kind = kindOf(values.kind);
      const rows = data.find({ ...scope, ...(kind ? { kind } : {}) });
      if (values.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (scope.orderId) {
        for (const v of orderVersions(engine.db, scope.orderId)) console.log(`order   v${v.version} ${v.status}  run ${v.run_id}  segment ${v.segment_id}`);
        for (const o of outboxForOrder(engine.db, scope.orderId)) console.log(`webhook ${o.webhook_id}  ${o.status}  attempts=${o.attempt_count}`);
      }
      printRows(rows);
      console.log(`${rows.length} artifact(s), ${mb(rows.reduce((s, r) => s + r.bytes, 0))}`);
      return;
    }
    case "usage": {
      const u = data.usage(true);
      for (const k of ARTIFACT_KINDS) console.log(`${k.padEnd(7)} ${mb(u.byKind[k]).padStart(12)}`);
      console.log(`total   ${gb(u.total)} of ${gb(u.budget)} (${Math.round((u.total / u.budget) * 100)}%): ${u.state === "ok" ? "ok" : u.state === "warn" ? "over 80%, free space soon" : "over 95%, raw capture and audio archiving are paused"}`);
      return;
    }
    case "verify": {
      const sample = values.sample ? Number(values.sample) : 50;
      if (!Number.isInteger(sample) || sample < 1) throw new ConfigError("--sample must be a positive whole number");
      const r = await data.verify(sample);
      for (const m of r.mismatches) console.log(`${m.problem.padEnd(7)} ${m.uri}`);
      console.log(`checked ${r.checked}; ${r.mismatches.length ? `${r.mismatches.length} problem(s)` : "all match"}`);
      if (r.mismatches.length) process.exitCode = 1;
      return;
    }
    case "prune": {
      const kind = kindOf(values.kind);
      const m = /^(\d+)d?$/.exec(String(values["older-than"] ?? ""));
      if (!kind || !m) throw new ConfigError("Usage: pnpm data prune --kind <k> --older-than <days>d [--yes]");
      const days = Number(m[1]);
      const cutoff = Date.now() - days * 86_400_000;
      const rows = data.find({ kind }).filter((r) => r.created_at < cutoff);
      if (!values.yes) {
        console.log(`Would remove ${rows.length} ${kind} artifact(s), ${mb(rows.reduce((s, r) => s + r.bytes, 0))}. Add --yes to remove them.`);
        return;
      }
      const r = await data.prune(kind, days);
      console.log(`Removed ${r.artifacts} ${kind} artifact(s), ${mb(r.bytes)}. Catalog rows are kept, marked deleted.`);
      return;
    }
    case "delete": {
      if (Object.keys(scope).length !== 1) throw new ConfigError("Usage: pnpm data delete --store <id> | --session <id> | --order <id> [--yes]");
      const rows = data.find(scope);
      if (!values.yes) {
        printRows(rows);
        console.log(`Would remove ${rows.length} artifact(s), ${mb(rows.reduce((s, r) => s + r.bytes, 0))}. Orders and delivery history are kept. Add --yes to remove them.`);
        return;
      }
      const r = await data.deleteWhere(scope, "requested");
      console.log(`Removed ${r.artifacts} artifact(s), ${mb(r.bytes)}; a tombstone records the deletion.`);
      return;
    }
    case "label": {
      if (!scope.orderId || !values.version || !values.verdict || !values.author) throw new ConfigError("Usage: pnpm data label --order <id> --version <n> --verdict correct|incorrect|unsure --author <name> [--note text]");
      const label = await putLabel(engine.db, data, scope.orderId, {
        order_version: Number(values.version),
        verdict: values.verdict as "correct" | "incorrect" | "unsure",
        author: String(values.author),
        ...(values.note ? { note: String(values.note) } : {}),
      });
      console.log(`Saved ${label.label_id} for ${label.order_id} v${label.order_version}: ${label.verdict}`);
      return;
    }
    default:
      console.log(DATA_HELP);
  }
}
