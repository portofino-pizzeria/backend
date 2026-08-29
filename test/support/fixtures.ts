// Menu fixtures. Every field is optional and has a sensible default, so a test
// names only the thing it is actually about:
//
//   await seedItem({ allergenCodes: ['a', 'd'] });
//   await seedItem({ variants: [] });
//   await seedItem({ available: false });
//
// The database is truncated before every test (see ./setup), so fixtures never
// have to clean up after themselves.

import { eq } from 'drizzle-orm';

import { db } from '../../src/db/client.js';
import {
  allergenLegend,
  menuCategories,
  menuItemVariants,
  menuItems,
  type AllergenLegendRow,
  type MenuCategoryRow,
  type MenuItemRow,
  type MenuItemVariantRow,
} from '../../src/db/schema.js';

export const DEFAULT_CATEGORY_ID = 'pizza';

let itemCounter = 0;

/** Called from the per-test `beforeEach` so generated ids restart each test. */
export function resetFixtureCounters(): void {
  itemCounter = 0;
}

/** Slug in the shape the real menu uses for ids ("margherita", "gross"). */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Fixture failed to insert a ${what}.`);
  return row;
}

// --- Categories ------------------------------------------------------------

export interface SeedCategoryInput {
  id?: string;
  /** German — authoritative. */
  label?: string;
  labelEn?: string | null;
  sortOrder?: number;
}

/** Upsert a menu category. Re-seeding the same id updates it. */
export async function seedCategory(
  input: SeedCategoryInput = {},
): Promise<MenuCategoryRow> {
  const id = input.id ?? DEFAULT_CATEGORY_ID;
  const values = {
    id,
    label: input.label ?? 'Pizza',
    labelEn: input.labelEn ?? null,
    sortOrder: input.sortOrder ?? 0,
  };
  const rows = await db
    .insert(menuCategories)
    .values(values)
    .onConflictDoUpdate({
      target: menuCategories.id,
      set: {
        label: values.label,
        labelEn: values.labelEn,
        sortOrder: values.sortOrder,
      },
    })
    .returning();
  return one(rows, 'menu category');
}

/** Create the category only if it is missing — used by `seedItem`. */
async function ensureCategory(id: string): Promise<void> {
  await db
    .insert(menuCategories)
    .values({ id, label: id, sortOrder: 0 })
    .onConflictDoNothing();
}

// --- Items and variants ----------------------------------------------------

export interface SeedVariantInput {
  id?: string;
  /** German — "klein", "groß", "Blech", "Schwein". */
  label?: string;
  sortOrder?: number;
  /** Integer cents. Never null: a variant without a price cannot exist. */
  priceCents?: number;
}

export interface SeedItemInput {
  id?: string;
  /** The number printed on the menu ("1", "76a"). */
  number?: string | null;
  /** German — authoritative. */
  name?: string;
  nameEn?: string | null;
  description?: string;
  descriptionEn?: string | null;
  /** Created automatically if it does not exist yet. */
  categoryId?: string;
  /** Verbatim as printed. A code with no legend row is legal and expected. */
  allergenCodes?: string[];
  imageUrl?: string | null;
  available?: boolean;
  sortOrder?: number;
  /**
   * Omit for one default variant. Pass `[]` for an item with no variants at
   * all — a real state the menu route must still return.
   */
  variants?: SeedVariantInput[];
}

export interface SeededItem extends MenuItemRow {
  variants: MenuItemVariantRow[];
}

/** Insert one menu item plus its variants, and return both. */
export async function seedItem(
  input: SeedItemInput = {},
): Promise<SeededItem> {
  const name = input.name ?? `Testartikel ${++itemCounter}`;
  const id = input.id ?? slugify(name);
  const categoryId = input.categoryId ?? DEFAULT_CATEGORY_ID;

  await ensureCategory(categoryId);

  const itemRows = await db
    .insert(menuItems)
    .values({
      id,
      number: input.number ?? null,
      name,
      nameEn: input.nameEn ?? null,
      description: input.description ?? '',
      descriptionEn: input.descriptionEn ?? null,
      categoryId,
      allergenCodes: input.allergenCodes ?? [],
      imageUrl: input.imageUrl ?? null,
      available: input.available ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  const item = one(itemRows, 'menu item');

  const variantInputs = input.variants ?? [{ label: 'normal', priceCents: 990 }];
  const variants: MenuItemVariantRow[] = [];
  for (const [index, variant] of variantInputs.entries()) {
    variants.push(await seedVariant(id, { sortOrder: index, ...variant }));
  }

  return { ...item, variants };
}

/** Insert one variant of an existing item. */
export async function seedVariant(
  itemId: string,
  input: SeedVariantInput = {},
): Promise<MenuItemVariantRow> {
  const label = input.label ?? 'normal';
  const rows = await db
    .insert(menuItemVariants)
    .values({
      id: input.id ?? `${itemId}-${slugify(label)}`,
      itemId,
      label,
      sortOrder: input.sortOrder ?? 0,
      priceCents: input.priceCents ?? 990,
    })
    .returning();
  return one(rows, 'menu item variant');
}

// --- Allergen legend -------------------------------------------------------

export interface SeedLegendInput {
  /** Verbatim as printed: "a", "V", "1". */
  code: string;
  /** German — authoritative. */
  labelDe?: string;
  labelEn?: string | null;
  sortOrder?: number;
}

export async function seedLegendEntry(
  input: SeedLegendInput,
): Promise<AllergenLegendRow> {
  const values = {
    code: input.code,
    labelDe: input.labelDe ?? `Allergen ${input.code}`,
    labelEn: input.labelEn ?? null,
    sortOrder: input.sortOrder ?? 0,
  };
  const rows = await db
    .insert(allergenLegend)
    .values(values)
    .onConflictDoUpdate({
      target: allergenLegend.code,
      set: {
        labelDe: values.labelDe,
        labelEn: values.labelEn,
        sortOrder: values.sortOrder,
      },
    })
    .returning();
  return one(rows, 'allergen legend entry');
}

/** Seed several legend entries, keeping their array order as `sortOrder`. */
export async function seedLegend(
  entries: SeedLegendInput[],
): Promise<AllergenLegendRow[]> {
  const rows: AllergenLegendRow[] = [];
  for (const [index, entry] of entries.entries()) {
    rows.push(await seedLegendEntry({ sortOrder: index, ...entry }));
  }
  return rows;
}

// --- Mutation helpers ------------------------------------------------------
//
// For the tests that edit the menu *after* something referenced it — the order
// line snapshot properties, and (Phase 4b) the editor's safety properties.

export async function updateMenuItem(
  id: string,
  patch: Partial<typeof menuItems.$inferInsert>,
): Promise<MenuItemRow> {
  const rows = await db
    .update(menuItems)
    .set(patch)
    .where(eq(menuItems.id, id))
    .returning();
  return one(rows, `update of menu item ${id}`);
}

/** Remove a menu item (its variants cascade; order lines must not). */
export async function deleteMenuItem(id: string): Promise<void> {
  await db.delete(menuItems).where(eq(menuItems.id, id));
}

export async function updateMenuVariant(
  id: string,
  patch: Partial<typeof menuItemVariants.$inferInsert>,
): Promise<MenuItemVariantRow> {
  const rows = await db
    .update(menuItemVariants)
    .set(patch)
    .where(eq(menuItemVariants.id, id))
    .returning();
  return one(rows, `update of menu variant ${id}`);
}
