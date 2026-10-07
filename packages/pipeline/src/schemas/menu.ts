import { z } from "zod";

export const Size = z.enum(["small", "medium", "large"]);
export type Size = z.infer<typeof Size>;

export const ModifierAction = z.enum(["remove", "add", "extra", "light", "sub", "on_side"]);
export type ModifierAction = z.infer<typeof ModifierAction>;

export const Category = z.enum(["burger", "chicken", "side", "drink", "dessert", "shake"]);
export type Category = z.infer<typeof Category>;

export const MenuItem = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  category: Category,
  sizes: z.array(Size).optional(),
  default_size: Size.optional(),
  price: z.union([z.number(), z.record(Size, z.number())]),
  allowed_modifiers: z.array(z.string()).default([]),
  out_of_stock_able: z.boolean().optional(),
  free: z.boolean().optional(),
});
export type MenuItem = z.infer<typeof MenuItem>;

export const ComboSlot = z.discriminatedUnion("kind", [
  z.object({ slot: z.string(), kind: z.literal("fixed"), item: z.string() }),
  z.object({ slot: z.string(), kind: z.literal("default"), item: z.string(), allowed: z.array(z.string()) }),
  z.object({ slot: z.string(), kind: z.literal("required"), allowed_category: Category }),
]);
export type ComboSlot = z.infer<typeof ComboSlot>;

export const Combo = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  price: z.number(),
  default_size: Size,
  slots: z.array(ComboSlot),
});
export type Combo = z.infer<typeof Combo>;

export const Modifier = z.object({
  id: z.string(),
  name: z.string(),
  action: ModifierAction,
  applies_to: z.array(Category),
  price: z.number().optional(),
});
export type Modifier = z.infer<typeof Modifier>;

export const Menu = z.object({
  menu_version: z.string(),
  brand: z.string(),
  currency: z.string(),
  combo_size_adjust: z.record(Size, z.number()),
  items: z.array(MenuItem),
  combos: z.array(Combo),
  modifiers: z.array(Modifier),
  lexicon: z.object({
    sizes: z.record(Size, z.array(z.string())),
    numbers: z.record(z.string(), z.number()),
    combo_phrases: z.array(z.string()),
  }),
});
export type Menu = z.infer<typeof Menu>;
