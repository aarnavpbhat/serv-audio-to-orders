/**
 * replay(events) -> order state. Pure: no I/O, no clocks, no randomness.
 *
 * The LLM proposes events; this function decides what they mean. Nothing the
 * customer said is dropped: removed, replaced and cancelled lines stay in the
 * state with a reason so post-processing can put them in `not_ordered`.
 */
import type { Catalog } from "../menu/catalog";
import type { Candidate, NotOrderedReason, OrderEvent, ReadbackItem, Size } from "../schemas";

/** Commitment at or below the prompt's hesitation level (0.3), with margin. */
const HESITATION_MAX = 0.5;

export interface LineComponent {
  slot: string;
  kind: "fixed" | "default" | "required";
  catalog_id: string | null;
  modifiers: string[];
  /** Customer explicitly said they want nothing in this slot ("no drink"). */
  declined: boolean;
  /** Set by an event rather than the combo default. */
  explicit: boolean;
}

export interface Line {
  line_id: string;
  catalog_id: string | null;
  raw_text: string | null;
  quantity: number;
  size: Size | null;
  /** Item-level modifiers. Combo modifiers live on the component they apply to. */
  modifiers: string[];
  components: LineComponent[] | null;
  recognition_confidence: number;
  commitment_confidence: number;
  source_utterance_ids: string[];
  candidates: Candidate[];
  /** Index of the separately-paid order this line belongs to (SPLIT_ORDER). */
  part: number;
  state: "active" | "removed";
  removed_reason: NotOrderedReason | null;
  replaced_by: string | null;
  /** line_id of the line that replaced this one, so later refs follow the chain. */
  replaced_by_line: string | null;
  created_seq: number;
  history: string[];
}

/** Mentions that never became a line: inquiries, declined upsells, out of stock, replaced slot items. */
export interface SideMention {
  catalog_id: string | null;
  raw_text: string | null;
  reason: NotOrderedReason;
  replaced_by: string | null;
  quantity: number | null;
  size: Size | null;
  part: number;
  source_utterance_ids: string[];
  event_id: string;
}

export interface ReadbackCheck {
  event_id: string;
  part: number;
  diffs: string[];
  source_utterance_ids: string[];
}

export interface AppliedEvent {
  event_id: string;
  type: OrderEvent["type"];
  t_s: number | null;
  applied: boolean;
  note: string;
  line_ids: string[];
}

export interface BuildState {
  lines: Line[];
  side: SideMention[];
  readbacks: ReadbackCheck[];
  /** Total the crew spoke, per part (index = part). */
  spoken_totals: (number | null)[];
  cancelled: boolean;
  /** Utterances of the last whole-order cancel, for outcome evidence. */
  cancel_utterance_ids: string[];
  split: boolean;
  parts: number;
  declined_combo_ids: string[];
  log: AppliedEvent[];
  warnings: string[];
}

class Replayer {
  private readonly lines: Line[] = [];
  private readonly side: SideMention[] = [];
  private readonly readbacks: ReadbackCheck[] = [];
  private readonly log: AppliedEvent[] = [];
  private readonly warnings: string[] = [];
  private readonly declinedCombos = new Set<string>();
  private readonly spokenTotals: (number | null)[] = [];
  private cancelled = false;
  private cancelUtteranceIds: string[] = [];
  private split = false;
  /** "Can we pay separately?" before anything was ordered: each spoken total closes one order. */
  private splitByTotals = false;
  private part = 0;
  private seq = 0;

  constructor(private readonly catalog: Catalog) {}

  run(events: OrderEvent[]): BuildState {
    for (const e of sortEvents(events)) this.apply(e);
    return {
      lines: this.lines,
      side: this.side,
      readbacks: this.readbacks,
      spoken_totals: this.spokenTotals,
      cancelled: this.cancelled,
      cancel_utterance_ids: this.cancelled ? this.cancelUtteranceIds : [],
      split: this.split,
      parts: Math.max(...this.lines.map((l) => l.part), ...this.side.map((s) => s.part), 0) + 1,
      declined_combo_ids: [...this.declinedCombos],
      log: this.log,
      warnings: this.warnings,
    };
  }

  private record(e: OrderEvent, applied: boolean, note: string, lineIds: string[] = []): void {
    this.log.push({ event_id: e.event_id, type: e.type, t_s: e.t_s, applied, note, line_ids: lineIds });
    if (!applied) this.warnings.push(`${e.event_id} ${e.type}: ${note}`);
  }

  private apply(e: OrderEvent): void {
    switch (e.type) {
      case "ADD":
        return this.add(e);
      case "REMOVE":
        return this.remove(e);
      case "CHANGE_QTY":
        return this.changeQty(e);
      case "CHANGE_SIZE":
        return this.changeSize(e);
      case "ADD_MODIFIER":
        return this.addModifier(e);
      case "REMOVE_MODIFIER":
        return this.removeModifier(e);
      case "REPLACE":
        return this.replace(e);
      case "SET_COMBO_SLOT":
        return this.setComboSlot(e);
      case "DUPLICATE_LINE":
        return this.duplicate(e);
      case "DECLINE_UPSELL":
        return this.declineUpsell(e);
      case "INQUIRE":
        return this.mention(e, "inquired");
      case "OUT_OF_STOCK":
        return this.outOfStock(e);
      case "SPLIT_ORDER":
        return this.splitOrder(e);
      case "CANCEL_ORDER":
        return this.cancelOrder(e);
      case "READBACK":
        return this.readback(e);
    }
  }

  // ---------------------------------------------------------------- helpers

  private active(): Line[] {
    return this.lines.filter((l) => l.state === "active");
  }

  private find(id: string): Line | undefined {
    return this.lines.find((l) => l.line_id === id);
  }

  /**
   * Resolve which line an edit refers to: explicit ref (following replacements),
   * then the most recent active line with the catalog id (or a combo holding it),
   * then optionally the most recent active line.
   */
  private resolve(e: OrderEvent, opts: { fallbackLast?: boolean; preferCombo?: boolean } = {}): Line | undefined {
    if (e.target_line_ref) {
      let line = this.find(e.target_line_ref);
      const seen = new Set<string>();
      while (line && line.state === "removed" && line.replaced_by_line && !seen.has(line.line_id)) {
        seen.add(line.line_id);
        line = this.find(line.replaced_by_line);
      }
      if (line && line.state === "active") return line;
    }
    const active = this.active().reverse();
    if (opts.preferCombo) {
      const combo = active.find((l) => l.components && (!e.catalog_id || this.catalog.slotFor(l.catalog_id ?? "", e.catalog_id)));
      if (combo) return combo;
    }
    if (e.catalog_id) {
      const direct = active.find((l) => l.catalog_id === e.catalog_id);
      if (direct) return direct;
      const holder = active.find((l) => l.components?.some((c) => c.catalog_id === e.catalog_id));
      if (holder) return holder;
    }
    if (opts.fallbackLast) return active[0];
    return undefined;
  }

  private newLine(e: OrderEvent, overrides: Partial<Line> = {}): Line {
    const catalogId = e.catalog_id && this.catalog.has(e.catalog_id) ? e.catalog_id : null;
    const rawText = e.raw_text ?? (e.catalog_id && !catalogId ? e.catalog_id : null);
    const line: Line = {
      line_id: e.event_id,
      catalog_id: catalogId,
      raw_text: rawText,
      quantity: e.quantity ?? 1,
      size: catalogId ? this.catalog.sizeFor(catalogId, e.size) : e.size,
      modifiers: [],
      components: catalogId && this.catalog.isCombo(catalogId) ? this.comboComponents(catalogId) : null,
      // Unknown catalog ids can never be high-recognition.
      recognition_confidence: catalogId ? e.recognition_confidence : Math.min(e.recognition_confidence, 0.4),
      commitment_confidence: e.commitment_confidence,
      source_utterance_ids: [...e.source_utterance_ids],
      candidates: [...e.candidates],
      part: this.part,
      state: "active",
      removed_reason: null,
      replaced_by: null,
      replaced_by_line: null,
      created_seq: this.seq++,
      history: [e.event_id],
      ...overrides,
    };
    if (e.modifiers.length) this.attachModifiers(line, e.modifiers);
    return line;
  }

  private comboComponents(comboId: string): LineComponent[] {
    const combo = this.catalog.combo(comboId);
    if (!combo) return [];
    return combo.slots.map((s) => ({
      slot: s.slot,
      kind: s.kind,
      catalog_id: s.kind === "required" ? null : s.item,
      modifiers: [],
      declined: false,
      explicit: false,
    }));
  }

  /** Puts modifiers on the line, or on the combo component they apply to. */
  private attachModifiers(line: Line, mods: string[]): string[] {
    const attached: string[] = [];
    for (const m of mods) {
      const mod = this.catalog.modifier(m);
      if (!mod) {
        this.warnings.push(`unknown modifier ${m} on ${line.line_id}`);
        continue;
      }
      if (line.components) {
        const target =
          line.components.find((c) => c.catalog_id && this.catalog.modifierApplies(m, c.catalog_id)) ??
          line.components.find((c) => c.kind === "fixed");
        if (target && !target.modifiers.includes(m)) target.modifiers.push(m);
      } else if (!line.modifiers.includes(m)) {
        line.modifiers.push(m);
      }
      attached.push(m);
    }
    return attached;
  }

  private removeLine(line: Line, reason: NotOrderedReason, e: OrderEvent, replacedBy: string | null = null): void {
    line.state = "removed";
    line.removed_reason = reason;
    line.replaced_by = replacedBy;
    line.history.push(e.event_id);
    for (const u of e.source_utterance_ids) if (!line.source_utterance_ids.includes(u)) line.source_utterance_ids.push(u);
  }

  private pushSide(e: OrderEvent, reason: NotOrderedReason, catalogId: string | null, replacedBy: string | null = null): void {
    this.side.push({
      catalog_id: catalogId && this.catalog.has(catalogId) ? catalogId : null,
      raw_text: e.raw_text ?? (catalogId && !this.catalog.has(catalogId) ? catalogId : null),
      reason,
      replaced_by: replacedBy,
      quantity: e.quantity,
      size: e.size,
      part: this.part,
      source_utterance_ids: [...e.source_utterance_ids],
      event_id: e.event_id,
    });
  }

  private touch(line: Line, e: OrderEvent): void {
    line.history.push(e.event_id);
    for (const u of e.source_utterance_ids) if (!line.source_utterance_ids.includes(u)) line.source_utterance_ids.push(u);
  }

  // --------------------------------------------------------------- handlers

  private add(e: OrderEvent): void {
    if (this.cancelled) this.cancelled = false; // "never mind... actually, let me get..."
    if (e.catalog_id && !this.catalog.has(e.catalog_id)) {
      this.warnings.push(`${e.event_id}: unknown catalog id "${e.catalog_id}", kept as raw text`);
    }
    const line = this.newLine(e);
    this.lines.push(line);
    this.record(e, true, `added ${this.catalog.name(line.catalog_id)} x${line.quantity}`, [line.line_id]);
  }

  private remove(e: OrderEvent): void {
    const line = this.resolve(e);
    if (!line) {
      // Already gone (out of stock, replaced): the earlier reason stands.
      const gone = e.target_line_ref ? this.find(e.target_line_ref) : this.lines.find((l) => l.catalog_id === e.catalog_id);
      if (gone?.state === "removed") return this.record(e, false, `${gone.line_id} already ${gone.removed_reason ?? "removed"}`);
      if (e.catalog_id) this.pushSide(e, "cancelled", e.catalog_id);
      return this.record(e, false, "no matching line to remove");
    }
    // Removing a slot item from a combo: "no fries with that".
    if (line.components && e.catalog_id && line.catalog_id !== e.catalog_id) {
      const comp = line.components.find((c) => c.catalog_id === e.catalog_id);
      if (comp && comp.kind !== "fixed") {
        comp.catalog_id = null;
        comp.declined = true;
        comp.explicit = true;
        this.pushSide(e, "cancelled", e.catalog_id);
        this.touch(line, e);
        return this.record(e, true, `removed ${comp.slot} from ${this.catalog.name(line.catalog_id)}`, [line.line_id]);
      }
    }
    if (e.quantity && e.quantity < line.quantity) {
      line.quantity -= e.quantity;
      this.touch(line, e);
      this.side.push({
        catalog_id: line.catalog_id,
        raw_text: line.raw_text,
        reason: "cancelled",
        replaced_by: null,
        quantity: e.quantity,
        size: line.size,
        part: line.part,
        source_utterance_ids: [...e.source_utterance_ids],
        event_id: e.event_id,
      });
      return this.record(e, true, `removed ${e.quantity} of ${line.line_id}`, [line.line_id]);
    }
    // "Maybe a cookie... no": backing off a hesitation was never an order, so it stays uncommitted.
    const reason = line.commitment_confidence < HESITATION_MAX ? "uncommitted" : "cancelled";
    this.removeLine(line, reason, e);
    this.record(e, true, `removed ${line.line_id} (${reason})`, [line.line_id]);
  }

  private changeQty(e: OrderEvent): void {
    const line = this.resolve(e, { fallbackLast: true });
    if (!line || !e.quantity) return this.record(e, false, line ? "no quantity given" : "no line to change");
    line.quantity = e.quantity;
    this.touch(line, e);
    this.record(e, true, `${line.line_id} quantity -> ${e.quantity}`, [line.line_id]);
  }

  private changeSize(e: OrderEvent): void {
    let line = this.resolve(e);
    if (!line) line = this.active().reverse().find((l) => l.catalog_id && this.catalog.hasSizes(l.catalog_id));
    if (!line || !e.size) return this.record(e, false, line ? "no size given" : "no sized line to change");
    if (!line.catalog_id || !this.catalog.hasSizes(line.catalog_id)) {
      return this.record(e, false, `${line.line_id} has no sizes`);
    }
    line.size = e.size;
    this.touch(line, e);
    this.record(e, true, `${line.line_id} size -> ${e.size}`, [line.line_id]);
  }

  private addModifier(e: OrderEvent): void {
    const line = this.resolve(e, { fallbackLast: true });
    if (!line || !e.modifiers.length) return this.record(e, false, line ? "no modifiers given" : "no line to modify");
    // Per-unit modifiers split the line: "two burgers, one with no pickles".
    if (e.quantity && e.quantity < line.quantity) {
      line.quantity -= e.quantity;
      this.touch(line, e);
      const copy = this.cloneLine(line, `${line.line_id}.${this.seq}`, e.quantity);
      copy.history.push(e.event_id);
      this.attachModifiers(copy, e.modifiers);
      this.lines.push(copy);
      return this.record(e, true, `split ${e.quantity} off ${line.line_id} with ${e.modifiers.join(", ")}`, [
        line.line_id,
        copy.line_id,
      ]);
    }
    const attached = this.attachModifiers(line, e.modifiers);
    this.touch(line, e);
    this.record(e, attached.length > 0, `${line.line_id} + ${attached.join(", ") || "nothing"}`, [line.line_id]);
  }

  private removeModifier(e: OrderEvent): void {
    const line = this.resolve(e, { fallbackLast: true });
    if (!line) return this.record(e, false, "no line to modify");
    const drop = (mods: string[]) => mods.filter((m) => !e.modifiers.includes(m));
    line.modifiers = drop(line.modifiers);
    for (const c of line.components ?? []) c.modifiers = drop(c.modifiers);
    this.touch(line, e);
    this.record(e, true, `${line.line_id} - ${e.modifiers.join(", ")}`, [line.line_id]);
  }

  private replace(e: OrderEvent): void {
    const target = this.resolve(e, { fallbackLast: Boolean(e.target_line_ref) });
    if (!target) {
      if (!e.catalog_id) return this.record(e, false, "nothing to replace and no new item");
      this.lines.push(this.newLine(e));
      return this.record(e, false, "no line to replace; added as new line");
    }
    // Slot-level replace on a combo: "Sprite instead of Coke" in a meal.
    if (target.components && e.catalog_id && !this.catalog.isCombo(e.catalog_id)) {
      const slotName = e.slot ?? this.catalog.slotFor(target.catalog_id ?? "", e.catalog_id);
      const comp = target.components.find((c) => c.slot === slotName);
      if (comp && comp.kind !== "fixed") {
        const old = comp.catalog_id;
        comp.catalog_id = e.catalog_id;
        comp.declined = false;
        if (old && old !== e.catalog_id && comp.explicit) {
          this.side.push({
            catalog_id: old,
            raw_text: null,
            reason: "replaced",
            replaced_by: e.catalog_id,
            quantity: null,
            size: target.size,
            part: target.part,
            source_utterance_ids: [...e.source_utterance_ids],
            event_id: e.event_id,
          });
        }
        comp.explicit = true;
        this.touch(target, e);
        return this.record(e, true, `${target.line_id} ${comp.slot}: ${old ?? "none"} -> ${e.catalog_id}`, [target.line_id]);
      }
    }
    const newCatalog = e.catalog_id && this.catalog.has(e.catalog_id) ? e.catalog_id : null;
    const keepSize = newCatalog && this.catalog.hasSizes(newCatalog) ? (e.size ?? target.size) : e.size;
    const replacement = this.newLine(e, {
      quantity: e.quantity ?? target.quantity,
      part: target.part,
      source_utterance_ids: [...new Set([...target.source_utterance_ids, ...e.source_utterance_ids])],
    });
    if (replacement.catalog_id) replacement.size = this.catalog.sizeFor(replacement.catalog_id, keepSize);
    const carry = target.modifiers.filter((m) => replacement.catalog_id && this.catalog.modifierApplies(m, replacement.catalog_id));
    if (carry.length && !e.modifiers.length) this.attachModifiers(replacement, carry);
    this.removeLine(target, "replaced", e, replacement.catalog_id ?? e.raw_text ?? null);
    target.replaced_by_line = replacement.line_id;
    this.lines.push(replacement);
    this.record(e, true, `${target.line_id} replaced by ${replacement.line_id}`, [target.line_id, replacement.line_id]);
  }

  private setComboSlot(e: OrderEvent): void {
    const line = this.resolve(e, { preferCombo: true });
    const combo = line?.components ? line : this.active().reverse().find((l) => l.components);
    if (!combo || !combo.components) {
      if (e.catalog_id) {
        this.lines.push(this.newLine({ ...e, type: "ADD" }));
        return this.record(e, false, "no combo to fill; added as separate line");
      }
      return this.record(e, false, "no combo to fill");
    }
    const slotName = e.slot ?? (e.catalog_id ? this.catalog.slotFor(combo.catalog_id ?? "", e.catalog_id) : null);
    const comp = combo.components.find((c) => c.slot === slotName);
    if (!comp || comp.kind === "fixed") return this.record(e, false, `slot ${slotName ?? "?"} not fillable on ${combo.line_id}`);
    if (!e.catalog_id) {
      comp.catalog_id = null;
      comp.declined = true;
      comp.explicit = true;
    } else {
      const old = comp.catalog_id;
      if (old && old !== e.catalog_id && comp.explicit) {
        this.side.push({
          catalog_id: old,
          raw_text: null,
          reason: "replaced",
          replaced_by: e.catalog_id,
          quantity: null,
          size: combo.size,
          part: combo.part,
          source_utterance_ids: [...e.source_utterance_ids],
          event_id: e.event_id,
        });
      }
      comp.catalog_id = this.catalog.has(e.catalog_id) ? e.catalog_id : null;
      comp.declined = false;
      comp.explicit = true;
      if (e.modifiers.length) this.attachModifiers(combo, e.modifiers);
    }
    // Combo size applies to side and drink: "#2 with a Sprite, large".
    if (e.size) combo.size = e.size;
    combo.recognition_confidence = Math.min(combo.recognition_confidence, e.recognition_confidence);
    this.touch(combo, e);
    this.record(e, true, `${combo.line_id} ${comp.slot} = ${e.catalog_id ?? "none"}`, [combo.line_id]);
  }

  private cloneLine(src: Line, id: string, quantity: number): Line {
    return {
      ...src,
      line_id: id,
      quantity,
      modifiers: [...src.modifiers],
      components: src.components?.map((c) => ({ ...c, modifiers: [...c.modifiers] })) ?? null,
      source_utterance_ids: [...src.source_utterance_ids],
      candidates: [...src.candidates],
      history: [...src.history],
      created_seq: this.seq++,
    };
  }

  private duplicate(e: OrderEvent): void {
    const src = this.resolve(e, { fallbackLast: true });
    if (!src) return this.record(e, false, "nothing to duplicate");
    const copy = this.cloneLine(src, e.event_id, e.quantity ?? src.quantity);
    copy.part = this.part;
    copy.source_utterance_ids = [...e.source_utterance_ids];
    copy.commitment_confidence = e.commitment_confidence;
    copy.recognition_confidence = Math.min(src.recognition_confidence, e.recognition_confidence);
    copy.history = [e.event_id];
    this.lines.push(copy);
    this.record(e, true, `duplicated ${src.line_id} as ${copy.line_id}`, [copy.line_id]);
  }

  private declineUpsell(e: OrderEvent): void {
    let catalogId = e.catalog_id;
    // "Want to make it a meal?" "No." Infer the combo from the line it was offered on.
    if (!catalogId || !this.catalog.has(catalogId)) {
      const line = this.resolve(e, { fallbackLast: true });
      const combo = line?.catalog_id ? this.catalog.menu.combos.find((c) => this.catalog.comboEntree(c.id) === line.catalog_id) : undefined;
      catalogId = combo?.id ?? catalogId;
    }
    if (catalogId && this.catalog.isCombo(catalogId)) this.declinedCombos.add(catalogId);
    this.pushSide(e, "declined_upsell", catalogId);
    this.record(e, true, `declined ${this.catalog.name(catalogId)}`);
  }

  private mention(e: OrderEvent, reason: NotOrderedReason): void {
    this.pushSide(e, reason, e.catalog_id);
    this.record(e, true, `${reason}: ${this.catalog.name(e.catalog_id) || e.raw_text}`);
  }

  private outOfStock(e: OrderEvent): void {
    const line = e.target_line_ref || e.catalog_id ? this.resolve(e) : undefined;
    if (line && (line.catalog_id === e.catalog_id || !e.catalog_id || (e.target_line_ref && line.line_id === e.target_line_ref))) {
      this.removeLine(line, "out_of_stock", e);
      return this.record(e, true, `${line.line_id} out of stock`, [line.line_id]);
    }
    if (line?.components && e.catalog_id) {
      const comp = line.components.find((c) => c.catalog_id === e.catalog_id && c.kind !== "fixed");
      if (comp) {
        comp.catalog_id = null;
        comp.explicit = false;
        this.pushSide(e, "out_of_stock", e.catalog_id);
        this.touch(line, e);
        return this.record(e, true, `${line.line_id} ${comp.slot} out of stock`, [line.line_id]);
      }
    }
    this.pushSide(e, "out_of_stock", e.catalog_id);
    this.record(e, true, `${this.catalog.name(e.catalog_id)} out of stock (no line)`);
  }

  private splitOrder(e: OrderEvent): void {
    this.split = true;
    const boundary = e.target_line_ref ? this.find(e.target_line_ref) : undefined;
    if (boundary) {
      // Split requested after ordering: the boundary line and everything after it go to the next order.
      const from = boundary.part;
      const next = from + 1;
      for (const l of this.lines) if (l.created_seq >= boundary.created_seq && l.part === from) l.part = next;
      this.part = Math.max(this.part, next);
      return this.record(e, true, `split at ${boundary.line_id}`);
    }
    // "Separate checks": the next items start a new order. Asked before anything was
    // ordered, the boundaries are not said yet; the crew's totals mark them instead.
    if (this.lines.some((l) => l.part === this.part)) this.part += 1;
    else this.splitByTotals = true;
    this.record(e, true, this.splitByTotals ? "split; each spoken total closes an order" : `split; new items go to order ${this.part + 1}`);
  }

  private cancelOrder(e: OrderEvent): void {
    const affected = this.active();
    for (const l of affected) this.removeLine(l, "cancelled", e);
    this.cancelled = true;
    this.cancelUtteranceIds = [...e.source_utterance_ids];
    this.record(e, true, `cancelled ${affected.length} line(s)`, affected.map((l) => l.line_id));
  }

  private readback(e: OrderEvent): void {
    if (e.amount !== null) this.spokenTotals[this.part] = e.amount;
    const diffs: string[] = [];
    for (const rb of e.readback_items ?? []) diffs.push(...this.compareReadback(rb));
    this.readbacks.push({ event_id: e.event_id, part: this.part, diffs, source_utterance_ids: [...e.source_utterance_ids] });
    this.record(e, true, diffs.length ? `readback differs: ${diffs.join("; ")}` : "readback matches");
    if (this.splitByTotals && e.amount !== null && this.lines.some((l) => l.part === this.part)) this.part += 1;
  }

  private compareReadback(rb: ReadbackItem): string[] {
    const name = this.catalog.name(rb.catalog_id);
    const current = this.active().filter((l) => l.part === this.part);
    const direct = current.filter((l) => l.catalog_id === rb.catalog_id);
    const inCombo = current.filter((l) => l.components?.some((c) => c.catalog_id === rb.catalog_id));
    const matches = direct.length ? direct : inCombo;
    if (!matches.length) return [`read back ${name} which is not in the order`];
    const diffs: string[] = [];
    if (rb.quantity !== null && direct.length) {
      const qty = direct.reduce((s, l) => s + l.quantity, 0);
      if (qty !== rb.quantity) diffs.push(`${name}: read back quantity ${rb.quantity}, order has ${qty}`);
    }
    if (rb.size !== null && this.catalog.hasSizes(rb.catalog_id)) {
      const sizes = matches.map((l) => l.size);
      if (!sizes.includes(rb.size)) diffs.push(`${name}: read back ${rb.size}, order has ${sizes.join("/")}`);
    }
    return diffs;
  }
}

/** Stable sort by time; events without a time keep their position relative to neighbours. */
export function sortEvents(events: OrderEvent[]): OrderEvent[] {
  if (events.some((e) => e.t_s === null)) return [...events];
  return events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.t_s ?? 0) - (b.e.t_s ?? 0) || a.i - b.i).map((x) => x.e);
}

export function replay(events: OrderEvent[], catalog: Catalog): BuildState {
  return new Replayer(catalog).run(events);
}
