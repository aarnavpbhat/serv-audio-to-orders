/**
 * Labels: a person's verdict on one order version (the review screen writes
 * these; step 11). Each label is its own blob under
 * labels/store=/lane=/date=/order=<id>/<label_id>.json, catalogued like
 * everything else, so evals can be rebuilt from labels later.
 */
import { z } from "zod";
import { newId } from "../lib/ids";
import { assertSafeId } from "../lib/safe-id";
import type { OrderPayload } from "../schemas";
import { orderVersions, type DB } from "../store/db";
import { keys, type DataStore } from "./store";

export const LabelInput = z.object({
  order_version: z.number().int().positive(),
  verdict: z.enum(["correct", "incorrect", "unsure"]),
  /** The corrected order (items, status), when the verdict is incorrect. */
  corrected: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(2000).optional(),
  author: z.string().min(1).max(100),
});
export type LabelInput = z.infer<typeof LabelInput>;

export interface Label extends LabelInput {
  label_id: string;
  order_id: string;
  created_at: string;
}

export async function putLabel(db: DB, data: DataStore, orderId: string, input: LabelInput): Promise<Label> {
  assertSafeId("order", orderId);
  const parsed = LabelInput.parse(input);
  const row = orderVersions(db, orderId).find((v) => v.version === parsed.order_version);
  if (!row) throw new Error(`Order ${orderId} has no version ${parsed.order_version}`);
  const payload = JSON.parse(row.payload) as OrderPayload;
  const label: Label = { ...parsed, label_id: newId("lbl"), order_id: orderId, created_at: new Date().toISOString() };
  const p = { storeId: payload.store_id, laneId: payload.lane_id, at: payload.times.started_at };
  await data.put("labels", keys.labels(p, orderId, label.label_id), JSON.stringify(label, null, 2), {
    storeId: payload.store_id,
    laneId: payload.lane_id,
    sessionId: payload.session_id,
    orderId,
    orderVersion: parsed.order_version,
  });
  return label;
}

export async function listLabels(data: DataStore, orderId: string): Promise<Label[]> {
  const rows = data.find({ orderId, kind: "labels" });
  const out: Label[] = [];
  for (const r of rows) out.push(JSON.parse(new TextDecoder().decode(await data.blobs.get(r.uri))) as Label);
  return out;
}
