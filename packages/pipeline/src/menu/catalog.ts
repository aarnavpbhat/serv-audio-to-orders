import { Menu, type Category, type Combo, type MenuItem, type Modifier, type Size } from "../schemas";

/** Indexed, read-only view of menu.json used by every stage. */
export class Catalog {
  readonly menu: Menu;
  private readonly items = new Map<string, MenuItem>();
  private readonly combos = new Map<string, Combo>();
  private readonly modifiers = new Map<string, Modifier>();

  constructor(menu: Menu) {
    this.menu = menu;
    for (const i of menu.items) this.items.set(i.id, i);
    for (const c of menu.combos) this.combos.set(c.id, c);
    for (const m of menu.modifiers) this.modifiers.set(m.id, m);
  }

  static fromJson(json: unknown): Catalog {
    return new Catalog(Menu.parse(json));
  }

  get version(): string {
    return this.menu.menu_version;
  }

  item(id: string): MenuItem | undefined {
    return this.items.get(id);
  }

  combo(id: string): Combo | undefined {
    return this.combos.get(id);
  }

  modifier(id: string): Modifier | undefined {
    return this.modifiers.get(id);
  }

  isCombo(id: string | null | undefined): boolean {
    return !!id && this.combos.has(id);
  }

  has(id: string | null | undefined): boolean {
    return !!id && (this.items.has(id) || this.combos.has(id));
  }

  name(id: string | null | undefined): string {
    if (!id) return "Unknown item";
    return this.items.get(id)?.name ?? this.combos.get(id)?.name ?? id;
  }

  category(id: string): Category | "combo" | undefined {
    if (this.combos.has(id)) return "combo";
    return this.items.get(id)?.category;
  }

  allIds(): string[] {
    return [...this.items.keys(), ...this.combos.keys()];
  }

  /**
   * Deepgram keyterm prompts: canonical item names only. Deepgram rejects more than
   * 500 tokens across all keyterms and recommends a short list of distinctive terms;
   * aliases are handled after transcription by the LLM and the fuzzy matcher.
   */
  keyterms(): string[] {
    return [...new Set(this.menu.items.map((i) => i.name))];
  }

  hasSizes(id: string): boolean {
    if (this.combos.has(id)) return true;
    return !!this.items.get(id)?.sizes?.length;
  }

  defaultSize(id: string): Size | null {
    const combo = this.combos.get(id);
    if (combo) return combo.default_size;
    return this.items.get(id)?.default_size ?? null;
  }

  /** Normalizes a size against what the item supports (null for unsized items). */
  sizeFor(id: string, size: Size | null | undefined): Size | null {
    if (!this.hasSizes(id)) return null;
    return size ?? this.defaultSize(id);
  }

  itemPrice(id: string, size: Size | null): number {
    const item = this.items.get(id);
    if (!item) return 0;
    if (typeof item.price === "number") return item.price;
    const s = size ?? item.default_size ?? "medium";
    return item.price[s] ?? 0;
  }

  comboPrice(id: string, size: Size | null): number {
    const combo = this.combos.get(id);
    if (!combo) return 0;
    const adjust = this.menu.combo_size_adjust[size ?? combo.default_size] ?? 0;
    return round2(combo.price + adjust);
  }

  modifierPrice(ids: string[]): number {
    return ids.reduce((sum, m) => sum + (this.modifiers.get(m)?.price ?? 0), 0);
  }

  /** True when the modifier makes sense for this item (or the combo's entree). */
  modifierApplies(modId: string, targetId: string): boolean {
    const mod = this.modifiers.get(modId);
    if (!mod) return false;
    const cat = this.category(targetId);
    if (cat === "combo") {
      const entree = this.comboEntree(targetId);
      return entree ? this.modifierApplies(modId, entree) : false;
    }
    return !!cat && mod.applies_to.includes(cat);
  }

  comboEntree(comboId: string): string | null {
    const combo = this.combos.get(comboId);
    const slot = combo?.slots.find((s) => s.kind === "fixed");
    return slot && slot.kind === "fixed" ? slot.item : null;
  }

  /** Which slot of the combo can hold this item, if any. */
  slotFor(comboId: string, itemId: string): string | null {
    const combo = this.combos.get(comboId);
    const item = this.items.get(itemId);
    if (!combo || !item) return null;
    for (const s of combo.slots) {
      if (s.kind === "fixed" && s.item === itemId) return s.slot;
      if (s.kind === "default" && s.allowed.includes(itemId)) return s.slot;
      if (s.kind === "required" && s.allowed_category === item.category) return s.slot;
    }
    return null;
  }

  /** Compact text catalog for the LLM prompt. */
  promptCatalog(): string {
    const lines: string[] = [];
    lines.push("ITEMS (id | name | aliases | sizes):");
    for (const i of this.menu.items) {
      const sizes = i.sizes?.length ? i.sizes.join("/") : "-";
      lines.push(`${i.id} | ${i.name} | ${i.aliases.join(", ")} | ${sizes}`);
    }
    lines.push("", "COMBOS / MEALS (id | number | name | slots). Combo size applies to side and drink:");
    for (const c of this.menu.combos) {
      const slots = c.slots
        .map((s) =>
          s.kind === "fixed"
            ? `${s.slot}=${s.item}`
            : s.kind === "default"
              ? `${s.slot}=${s.item} (or ${s.allowed.filter((a) => a !== s.item).join("/")})`
              : `${s.slot}=required ${s.allowed_category}`,
        )
        .join("; ");
      lines.push(`${c.id} | #${c.number} | ${c.name} | ${slots}`);
    }
    lines.push("", "MODIFIERS (id | name | applies to):");
    for (const m of this.menu.modifiers) lines.push(`${m.id} | ${m.name} | ${m.applies_to.join(",")}`);
    return lines.join("\n");
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
