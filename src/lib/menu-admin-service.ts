// The owner's menu editor — the write half.
//
// This module is a safety surface: what it stores is what a diner reads before
// deciding whether a dish will hurt them, and what they are charged. Four
// properties are load-bearing here and each one is enforced in this file:
//
//  1. ALLERGENS CANNOT BE LOST SILENTLY. "The client did not mention
//     allergenCodes" and "the client asserts this item has none" are different
//     requests. The first leaves the stored codes untouched; the second is
//     refused unless it carries `confirmNoAllergens: true`. A form that forgets
//     the field cannot erase an allergen.
//  2. VALIDATION REFUSES IMPOSSIBLE STATES. A variant with no price, a price
//     with no variant, a duplicate size on one item, a negative or fractional
//     price, an item with no category, an available item with nothing to buy —
//     and an allergen code that is not in the legend (a typo guard: `x` for `a`
//     is how an allergen gets lost). See `assertCodesAreKnown` for how that
//     last rule stays a *validation* rule and never becomes a schema
//     constraint, which would make an unresolved code unrepresentable and
//     defeat decision D2.
//  3. AN INTERRUPTED EDIT LEAVES THE PREVIOUS GOOD VERSION LIVE. Every write is
//     one transaction. Nothing here writes twice.
//  4. A HALF-SAVED ITEM NEVER REACHES A DINER. An item and its variants are
//     written inside that same transaction, so the public menu never observes
//     an item with a new name and old prices, or a new item with no prices.
//
// Editing the menu never rewrites order history: `order_lines` snapshots the
// name, variant label and unit price at order time and carries no foreign key
// into the menu (see db/schema.ts).

import { asc, eq, inArray } from 'drizzle-orm';

import { db } from '../db/client.js';
import {
  allergenLegend,
  menuCategories,
  menuExtraPrices,
  menuExtras,
  menuItemVariants,
  menuItems,
  type AllergenLegendRow,
  type MenuCategoryRow,
} from '../db/schema.js';
import type { AdminMenu, AdminMenuExtra, AdminMenuItem, MenuVariant } from '../types.js';
import { HttpError, badRequest, conflict, notFound } from './http-errors.js';
import { loadMenu, sizeKey } from './menu-service.js';

/** The transaction handle drizzle hands to `db.transaction(cb)`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// --- Inputs ----------------------------------------------------------------

export interface VariantInput {
  /** Omit to derive it from the item id and the label. */
  id?: string;
  /** German — "klein", "groß", "Blech", "Schwein". */
  label: string;
  sortOrder?: number;
  /** Integer cents, greater than zero. */
  priceCents: number;
}

export interface CreateItemInput {
  id?: string;
  number?: string | null;
  name: string;
  nameEn?: string | null;
  description?: string;
  descriptionEn?: string | null;
  categoryId: string;
  allergenCodes?: string[];
  /** Required when the resulting allergen list would be empty. */
  confirmNoAllergens?: boolean;
  imageUrl?: string | null;
  available?: boolean;
  sortOrder?: number;
  variants: VariantInput[];
}

export interface UpdateItemInput {
  number?: string | null;
  name?: string;
  nameEn?: string | null;
  description?: string;
  descriptionEn?: string | null;
  categoryId?: string;
  /** Absent means "untouched". Present and empty means "this item has none",
   *  which needs `confirmNoAllergens`. */
  allergenCodes?: string[];
  confirmNoAllergens?: boolean;
  imageUrl?: string | null;
  available?: boolean;
  sortOrder?: number;
  /** Absent means "untouched". Present means "this is the complete set". */
  variants?: VariantInput[];
}

export interface CategoryInput {
  id: string;
  label: string;
  labelEn?: string | null;
  sortOrder?: number;
  offersExtras?: boolean;
}

export interface CategoryPatch {
  label?: string;
  labelEn?: string | null;
  sortOrder?: number;
  offersExtras?: boolean;
}

export interface ExtraPriceInput {
  /** A size as the dishes print it — a variant label, e.g. "groß 28cm". */
  size: string;
  /** Integer cents, greater than zero. */
  priceCents: number;
}

export interface CreateExtraInput {
  id?: string;
  name: string;
  nameEn?: string | null;
  allergenCodes?: string[];
  /** Required when the resulting allergen list would be empty. */
  confirmNoAllergens?: boolean;
  available?: boolean;
  sortOrder?: number;
  prices: ExtraPriceInput[];
}

export interface UpdateExtraInput {
  name?: string;
  nameEn?: string | null;
  /** Absent means "untouched", exactly as on an item. */
  allergenCodes?: string[];
  confirmNoAllergens?: boolean;
  available?: boolean;
  sortOrder?: number;
  /** Absent means "untouched". Present means "this is the complete set". */
  prices?: ExtraPriceInput[];
}

export interface AllergenInput {
  code: string;
  labelDe: string;
  labelEn?: string | null;
  sortOrder?: number;
}

// --- Reads -----------------------------------------------------------------

/** The editor's menu: everything the public route returns plus the items it
 *  filters out. */
export function loadAdminMenu(): Promise<AdminMenu> {
  return loadMenu({ includeUnavailable: true });
}

// --- Items -----------------------------------------------------------------

export async function createMenuItem(
  input: CreateItemInput,
): Promise<AdminMenuItem> {
  const name = requireText(input.name, 'Der Name des Gerichts');
  const id = normaliseId(input.id?.trim() || slugify(name), 'Die Kennung');
  const variants = normaliseVariants(id, input.variants);
  const available = input.available ?? true;

  // Property 1, on the create path too. An item created by a form that never
  // sent the field would otherwise land on the menu with a silently empty
  // allergen list, which is exactly the outcome the rule exists to prevent.
  const codes = normaliseCodes(input.allergenCodes ?? []);
  assertAllergenIntent(codes, input.confirmNoAllergens);
  assertOrderable(available, variants.length, name);

  return withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [clash] = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(eq(menuItems.id, id));
      if (clash) {
        throw conflict(
          `Es gibt bereits ein Gericht mit der Kennung „${id}“. Bitte eine andere Kennung wählen.`,
        );
      }

      await assertCategoryExists(tx, input.categoryId);
      // A brand-new item has no stored codes, so the legend is the only thing
      // that can vouch for a code here.
      await assertCodesAreKnown(tx, codes, []);

      await tx.insert(menuItems).values({
        id,
        number: emptyToNull(input.number),
        name,
        nameEn: emptyToNull(input.nameEn),
        description: input.description?.trim() ?? '',
        descriptionEn: emptyToNull(input.descriptionEn),
        categoryId: input.categoryId,
        allergenCodes: codes,
        imageUrl: emptyToNull(input.imageUrl),
        available,
        sortOrder: input.sortOrder ?? 0,
      });

      if (variants.length > 0) {
        // Same transaction as the item row: property 4. If this throws — a
        // variant id already taken by another item, say — the item never
        // existed as far as the public menu is concerned.
        await tx.insert(menuItemVariants).values(
          variants.map((v) => ({
            id: v.id,
            itemId: id,
            label: v.label,
            sortOrder: v.sortOrder,
            priceCents: v.priceCents,
          })),
        );
      }

      return loadItem(tx, id);
    }),
  );
}

export async function updateMenuItem(
  id: string,
  input: UpdateItemInput,
): Promise<AdminMenuItem> {
  const name = input.name === undefined ? undefined : requireText(input.name, 'Der Name des Gerichts');
  const variants =
    input.variants === undefined ? undefined : normaliseVariants(id, input.variants);

  return withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(menuItems)
        .where(eq(menuItems.id, id));
      if (!existing) {
        throw notFound(`Es gibt kein Gericht mit der Kennung „${id}“.`);
      }

      if (input.categoryId !== undefined) {
        await assertCategoryExists(tx, input.categoryId);
      }

      // Property 1: an update that never mentions allergenCodes leaves the
      // stored codes exactly as they were. Only an explicit list replaces them.
      let codes = existing.allergenCodes;
      if (input.allergenCodes !== undefined) {
        codes = normaliseCodes(input.allergenCodes);
        assertAllergenIntent(codes, input.confirmNoAllergens);
        await assertCodesAreKnown(tx, codes, existing.allergenCodes);
      }

      const existingVariants = await tx
        .select()
        .from(menuItemVariants)
        .where(eq(menuItemVariants.itemId, id))
        .orderBy(asc(menuItemVariants.sortOrder));

      const available = input.available ?? existing.available;
      const variantCount = variants ? variants.length : existingVariants.length;
      assertOrderable(available, variantCount, name ?? existing.name);

      // Only the fields the request actually named. An absent field is left
      // alone — which is what makes "the client did not mention allergenCodes"
      // a different request from "the client says there are none".
      const patch = {
        ...(input.number !== undefined ? { number: emptyToNull(input.number) } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(input.nameEn !== undefined ? { nameEn: emptyToNull(input.nameEn) } : {}),
        ...(input.description !== undefined
          ? { description: input.description.trim() }
          : {}),
        ...(input.descriptionEn !== undefined
          ? { descriptionEn: emptyToNull(input.descriptionEn) }
          : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.allergenCodes !== undefined ? { allergenCodes: codes } : {}),
        ...(input.imageUrl !== undefined ? { imageUrl: emptyToNull(input.imageUrl) } : {}),
        ...(input.available !== undefined ? { available } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      };

      // The item row goes first, the variants after, inside one transaction.
      // If a variant write fails the whole edit is discarded and the previous
      // good version stays live — property 3.
      if (Object.keys(patch).length > 0) {
        await tx.update(menuItems).set(patch).where(eq(menuItems.id, id));
      }

      if (variants) {
        const keep = new Set(variants.map((v) => v.id));
        const removed = existingVariants
          .filter((v) => !keep.has(v.id))
          .map((v) => v.id);
        if (removed.length > 0) {
          await tx
            .delete(menuItemVariants)
            .where(inArray(menuItemVariants.id, removed));
        }

        const known = new Set(existingVariants.map((v) => v.id));
        for (const v of variants.filter((v) => known.has(v.id))) {
          await tx
            .update(menuItemVariants)
            .set({ label: v.label, sortOrder: v.sortOrder, priceCents: v.priceCents })
            .where(eq(menuItemVariants.id, v.id));
        }

        // Inserted, never upserted. An id that already belongs to a DIFFERENT
        // item must fail loudly rather than be quietly reassigned — stealing a
        // variant would change another dish's price behind the owner's back.
        const added = variants.filter((v) => !known.has(v.id));
        if (added.length > 0) {
          await tx.insert(menuItemVariants).values(
            added.map((v) => ({
              id: v.id,
              itemId: id,
              label: v.label,
              sortOrder: v.sortOrder,
              priceCents: v.priceCents,
            })),
          );
        }
      }

      return loadItem(tx, id);
    }),
  );
}

/** Toggle whether diners can see and order an item. */
export async function setMenuItemAvailability(
  id: string,
  available: boolean,
): Promise<AdminMenuItem> {
  return withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(menuItems)
        .where(eq(menuItems.id, id));
      if (!existing) {
        throw notFound(`Es gibt kein Gericht mit der Kennung „${id}“.`);
      }

      const variantCount = await countVariants(tx, id);
      assertOrderable(available, variantCount, existing.name);

      await tx
        .update(menuItems)
        .set({ available })
        .where(eq(menuItems.id, id));

      return loadItem(tx, id);
    }),
  );
}

/** Remove an item and its variants. Past orders keep their own snapshot of the
 *  name, size and price and are not touched. */
export async function deleteMenuItem(id: string): Promise<void> {
  await withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(eq(menuItems.id, id));
      if (!existing) {
        throw notFound(`Es gibt kein Gericht mit der Kennung „${id}“.`);
      }
      await tx.delete(menuItems).where(eq(menuItems.id, id));
    }),
  );
}

// --- Categories ------------------------------------------------------------

export async function createCategory(
  input: CategoryInput,
): Promise<MenuCategoryRow> {
  const id = normaliseId(input.id.trim() || slugify(input.label), 'Die Kennung');
  const label = requireText(input.label, 'Der Name der Kategorie');

  return withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [clash] = await tx
        .select({ id: menuCategories.id })
        .from(menuCategories)
        .where(eq(menuCategories.id, id));
      if (clash) {
        throw conflict(`Es gibt bereits eine Kategorie „${id}“.`);
      }
      const [row] = await tx
        .insert(menuCategories)
        .values({
          id,
          label,
          labelEn: emptyToNull(input.labelEn),
          sortOrder: input.sortOrder ?? 0,
          offersExtras: input.offersExtras ?? false,
        })
        .returning();
      return row!;
    }),
  );
}

export async function updateCategory(
  id: string,
  patch: CategoryPatch,
): Promise<MenuCategoryRow> {
  const label =
    patch.label === undefined
      ? undefined
      : requireText(patch.label, 'Der Name der Kategorie');

  return withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(menuCategories)
        .where(eq(menuCategories.id, id));
      if (!existing) throw notFound(`Es gibt keine Kategorie „${id}“.`);

      const [row] = await tx
        .update(menuCategories)
        .set({
          ...(label !== undefined ? { label } : {}),
          ...(patch.labelEn !== undefined ? { labelEn: emptyToNull(patch.labelEn) } : {}),
          ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
          ...(patch.offersExtras !== undefined ? { offersExtras: patch.offersExtras } : {}),
        })
        .where(eq(menuCategories.id, id))
        .returning();
      return row!;
    }),
  );
}

/** Reorder every category in one transaction. The list must name all of them,
 *  so a half-sent order cannot leave two categories claiming the same slot. */
export async function reorderCategories(
  ids: string[],
): Promise<MenuCategoryRow[]> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw badRequest(`Die Kategorie „${id}“ kommt in der Reihenfolge mehrfach vor.`);
    }
    seen.add(id);
  }

  return withStorageErrors(() =>
    db.transaction(async (tx) => {
      const existing = await tx.select().from(menuCategories);
      const known = new Set(existing.map((c) => c.id));

      for (const id of ids) {
        if (!known.has(id)) throw badRequest(`Es gibt keine Kategorie „${id}“.`);
      }
      const missing = existing.filter((c) => !seen.has(c.id)).map((c) => c.id);
      if (missing.length > 0) {
        throw badRequest(
          `Die Reihenfolge muss alle Kategorien enthalten. Es fehlen: ${missing.join(', ')}.`,
        );
      }

      for (const [index, id] of ids.entries()) {
        await tx
          .update(menuCategories)
          .set({ sortOrder: index })
          .where(eq(menuCategories.id, id));
      }

      return tx
        .select()
        .from(menuCategories)
        .orderBy(asc(menuCategories.sortOrder));
    }),
  );
}

/** Delete an empty category. A category still holding dishes is refused by
 *  name and count rather than cascading them off the menu. */
export async function deleteCategory(id: string): Promise<void> {
  await withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(menuCategories)
        .where(eq(menuCategories.id, id));
      if (!existing) throw notFound(`Es gibt keine Kategorie „${id}“.`);

      const items = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(eq(menuItems.categoryId, id));
      if (items.length > 0) {
        throw conflict(
          `Die Kategorie „${existing.label}“ enthält noch ${items.length} ` +
            `${items.length === 1 ? 'Gericht' : 'Gerichte'}. Bitte die Gerichte zuerst ` +
            'verschieben oder löschen.',
        );
      }

      await tx.delete(menuCategories).where(eq(menuCategories.id, id));
    }),
  );
}

// --- Extras ----------------------------------------------------------------
//
// Extra ingredients carry the same two safety properties as a dish: their
// allergen codes cannot be lost silently (property 1), and a price that cannot
// be charged correctly cannot be stored (property 2).

export async function createExtra(input: CreateExtraInput): Promise<AdminMenuExtra> {
  const name = requireText(input.name, 'Der Name der Zutat');
  const id = normaliseId(input.id?.trim() || slugify(name), 'Die Kennung');
  const prices = normaliseExtraPrices(input.prices);
  const available = input.available ?? true;

  const codes = normaliseCodes(input.allergenCodes ?? []);
  assertAllergenIntent(codes, input.confirmNoAllergens);
  assertExtraOrderable(available, prices.length, name);

  await withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [clash] = await tx
        .select({ id: menuExtras.id })
        .from(menuExtras)
        .where(eq(menuExtras.id, id));
      if (clash) {
        throw conflict(
          `Es gibt bereits eine Zutat mit der Kennung „${id}“. Bitte eine andere Kennung wählen.`,
        );
      }
      await assertCodesAreKnown(tx, codes, []);
      await assertSizesAreKnown(tx, prices, []);

      await tx.insert(menuExtras).values({
        id,
        name,
        nameEn: emptyToNull(input.nameEn),
        allergenCodes: codes,
        available,
        sortOrder: input.sortOrder ?? 0,
      });
      if (prices.length > 0) {
        await tx.insert(menuExtraPrices).values(
          prices.map((p) => ({ extraId: id, sizeLabel: p.size, priceCents: p.priceCents })),
        );
      }
    }),
  );
  return loadExtra(id);
}

export async function updateExtra(
  id: string,
  input: UpdateExtraInput,
): Promise<AdminMenuExtra> {
  const name =
    input.name === undefined ? undefined : requireText(input.name, 'Der Name der Zutat');
  const prices = input.prices === undefined ? undefined : normaliseExtraPrices(input.prices);

  await withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx.select().from(menuExtras).where(eq(menuExtras.id, id));
      if (!existing) throw notFound(`Es gibt keine Zutat mit der Kennung „${id}“.`);

      // Property 1: absent leaves the stored codes exactly as they were.
      let codes = existing.allergenCodes;
      if (input.allergenCodes !== undefined) {
        codes = normaliseCodes(input.allergenCodes);
        assertAllergenIntent(codes, input.confirmNoAllergens);
        await assertCodesAreKnown(tx, codes, existing.allergenCodes);
      }

      const existingPrices = await tx
        .select()
        .from(menuExtraPrices)
        .where(eq(menuExtraPrices.extraId, id));
      if (prices) {
        await assertSizesAreKnown(
          tx,
          prices,
          existingPrices.map((p) => p.sizeLabel),
        );
      }

      // Counts stored prices, not only prices for sizes a dish carries today:
      // renaming a dish's size must not lock the owner out of editing an
      // extra. An extra with no live size is hidden from diners instead (see
      // `toPublicMenu`).
      const available = input.available ?? existing.available;
      assertExtraOrderable(
        available,
        prices ? prices.length : existingPrices.length,
        name ?? existing.name,
      );

      const patch = {
        ...(name !== undefined ? { name } : {}),
        ...(input.nameEn !== undefined ? { nameEn: emptyToNull(input.nameEn) } : {}),
        ...(input.allergenCodes !== undefined ? { allergenCodes: codes } : {}),
        ...(input.available !== undefined ? { available } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await tx.update(menuExtras).set(patch).where(eq(menuExtras.id, id));
      }

      // The price list is replaced whole, inside the same transaction: a diner
      // never sees an extra with half its new prices.
      if (prices) {
        await tx.delete(menuExtraPrices).where(eq(menuExtraPrices.extraId, id));
        if (prices.length > 0) {
          await tx.insert(menuExtraPrices).values(
            prices.map((p) => ({ extraId: id, sizeLabel: p.size, priceCents: p.priceCents })),
          );
        }
      }
    }),
  );
  return loadExtra(id);
}

/** Remove an extra and its prices. Past orders keep their own snapshot of the
 *  extra's name and price. */
export async function deleteExtra(id: string): Promise<void> {
  await withStorageErrors(async () => {
    const deleted = await db
      .delete(menuExtras)
      .where(eq(menuExtras.id, id))
      .returning({ id: menuExtras.id });
    if (deleted.length === 0) {
      throw notFound(`Es gibt keine Zutat mit der Kennung „${id}“.`);
    }
  });
}

// --- Allergen legend -------------------------------------------------------

/**
 * Add or relabel one legend entry.
 *
 * This is the one-step escape hatch that keeps the editor's "unknown allergen
 * letter" refusal a *validation* rule rather than a schema constraint: an owner
 * who genuinely prints a code we have never seen writes the legend entry here
 * and then saves the dish. Nothing about the codes already stored on items
 * changes.
 */
export async function upsertAllergen(
  input: AllergenInput,
): Promise<AllergenLegendRow> {
  const code = input.code.trim();
  if (!code) throw badRequest('Der Allergen-Code darf nicht leer sein.');
  if (code.length > 8) {
    throw badRequest(
      `„${code}“ ist kein Allergen-Code — auf der Karte steht dort ein kurzes Kürzel wie „a“ oder „1“.`,
    );
  }
  const labelDe = requireText(input.labelDe, 'Die deutsche Bezeichnung');

  return withStorageErrors(async () => {
    const values = {
      code,
      labelDe,
      labelEn: emptyToNull(input.labelEn),
      sortOrder: input.sortOrder ?? 0,
    };
    const [row] = await db
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
    return row!;
  });
}

export interface DeleteAllergenResult {
  code: string;
  /** Items that still print this code. They keep it — it simply renders as
   *  "unbekannt" again, which is honest rather than silently dropped. */
  stillUsedBy: string[];
  /** Extra ingredients that still print this code — same rule as dishes. */
  stillUsedByExtras: string[];
}

export async function deleteAllergen(
  code: string,
): Promise<DeleteAllergenResult> {
  return withStorageErrors(() =>
    db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(allergenLegend)
        .where(eq(allergenLegend.code, code));
      if (!existing) throw notFound(`Es gibt keinen Allergen-Eintrag „${code}“.`);

      const items = await tx
        .select({ id: menuItems.id, allergenCodes: menuItems.allergenCodes })
        .from(menuItems);
      const stillUsedBy = items
        .filter((i) => i.allergenCodes.includes(code))
        .map((i) => i.id)
        .sort();
      const extras = await tx
        .select({ id: menuExtras.id, allergenCodes: menuExtras.allergenCodes })
        .from(menuExtras);
      const stillUsedByExtras = extras
        .filter((e) => e.allergenCodes.includes(code))
        .map((e) => e.id)
        .sort();

      // The codes on those items are NOT rewritten. Removing a legend entry
      // removes a label, never an allergen: the code stays on the dish and the
      // menu renders it as "unbekannt".
      await tx.delete(allergenLegend).where(eq(allergenLegend.code, code));

      return { code, stillUsedBy, stillUsedByExtras };
    }),
  );
}

// --- Validation helpers ----------------------------------------------------

function requireText(value: string | undefined, what: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw badRequest(`${what} darf nicht leer sein.`);
  return trimmed;
}

function normaliseId(value: string, what: string): string {
  const id = value.trim();
  if (!id) throw badRequest(`${what} darf nicht leer sein.`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw badRequest(
      `${what} „${id}“ ist ungültig: erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche.`,
    );
  }
  return id;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Slug in the shape the menu uses for ids ("margherita", "gross"). */
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

interface NormalisedVariant {
  id: string;
  label: string;
  sortOrder: number;
  priceCents: number;
}

/**
 * Turn the submitted sizes into rows, refusing every impossible one on the way
 * (property 2). A price with no size, a size with no price, the same size
 * twice, a fractional or non-positive price — none of them can reach the
 * database.
 */
function normaliseVariants(
  itemId: string,
  inputs: VariantInput[],
): NormalisedVariant[] {
  const out: NormalisedVariant[] = [];
  const labels = new Set<string>();
  const ids = new Set<string>();

  for (const [index, input] of inputs.entries()) {
    const position = index + 1;
    const label = (input.label ?? '').trim();
    if (!label) {
      throw badRequest(
        `Ein Preis ohne Variante ist nicht möglich: Variante ${position} hat einen Preis, ` +
          'aber keine Bezeichnung (z. B. „klein“, „groß“, „Blech“).',
      );
    }

    if (typeof input.priceCents !== 'number' || Number.isNaN(input.priceCents)) {
      throw badRequest(`Die Variante „${label}“ hat keinen Preis.`);
    }
    if (!Number.isInteger(input.priceCents)) {
      throw badRequest(
        `Der Preis der Variante „${label}“ muss eine ganze Zahl in Cent sein ` +
          `(z. B. 790 für 7,90 €), nicht ${input.priceCents}.`,
      );
    }
    if (input.priceCents <= 0) {
      throw badRequest(
        `Der Preis der Variante „${label}“ muss größer als 0 sein (angegeben: ${input.priceCents}).`,
      );
    }

    const key = label.toLocaleLowerCase('de-DE');
    if (labels.has(key)) {
      throw badRequest(
        `Die Variante „${label}“ kommt bei diesem Gericht mehrfach vor. ` +
          'Jede Größe darf es pro Gericht nur einmal geben.',
      );
    }
    labels.add(key);

    const id = normaliseId(
      input.id?.trim() || `${itemId}-${slugify(label)}`,
      'Die Kennung der Variante',
    );
    if (ids.has(id)) {
      throw badRequest(`Die Varianten-Kennung „${id}“ kommt mehrfach vor.`);
    }
    ids.add(id);

    out.push({
      id,
      label,
      sortOrder: input.sortOrder ?? index,
      priceCents: input.priceCents,
    });
  }

  return out;
}

/** 1.000 € per extra — far above any real topping, and far below what twenty
 *  extras on one line would need to overflow the 32-bit
 *  `order_lines.unit_price`. Dish prices are deliberately not capped here. */
export const MAX_EXTRA_PRICE_CENTS = 100_000;

/**
 * Turn the submitted per-size prices into rows (property 2): no price without
 * a size, no size twice, no zero, negative or fractional price.
 */
function normaliseExtraPrices(inputs: ExtraPriceInput[]): ExtraPriceInput[] {
  const out: ExtraPriceInput[] = [];
  const seen = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const size = (input.size ?? '').trim();
    if (!size) {
      throw badRequest(
        `Preis ${index + 1} hat keine Größe. Bitte eine Größe der Speisekarte wählen ` +
          '(z. B. „groß 28cm“).',
      );
    }
    const cents = input.priceCents;
    if (
      typeof cents !== 'number' ||
      !Number.isInteger(cents) ||
      cents <= 0
    ) {
      throw badRequest(
        `Der Preis für „${size}“ muss eine ganze Zahl in Cent größer als 0 sein ` +
          '(z. B. 150 für 1,50 €).',
      );
    }
    if (cents > MAX_EXTRA_PRICE_CENTS) {
      throw badRequest(`Der Aufpreis für „${size}“ darf höchstens 1.000,00 € betragen.`);
    }
    const key = sizeKey(size);
    if (seen.has(key)) {
      throw badRequest(`Die Größe „${size}“ hat mehr als einen Preis. Bitte nur einen angeben.`);
    }
    seen.add(key);
    out.push({ size, priceCents: cents });
  }
  return out;
}

/**
 * The typo guard for sizes, shaped like `assertCodesAreKnown`: a price is
 * matched to a dish by its size label, so "gross 28cm" typed for "groß 28cm"
 * would be a price that silently never applies. Every size must be a variant
 * label some dish on the menu carries — or one this extra already had, so a
 * renamed size never blocks an unrelated edit.
 */
async function assertSizesAreKnown(
  tx: Tx,
  prices: ExtraPriceInput[],
  alreadyStored: string[],
): Promise<void> {
  if (prices.length === 0) return;
  const labels = await variantSizeLabels(tx);
  const known = new Set([...labels.map(sizeKey), ...alreadyStored.map(sizeKey)]);
  const unknown = prices.find((p) => !known.has(sizeKey(p.size)));
  if (unknown) {
    throw badRequest(
      `Die Größe „${unknown.size}“ gibt es auf der Speisekarte nicht. Bitte eine Größe ` +
        'wählen, wie sie bei den Gerichten steht (z. B. „groß 28cm“).',
    );
  }
}

/** Every size label some dish on the menu carries. */
async function variantSizeLabels(tx: Tx): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ label: menuItemVariants.label })
    .from(menuItemVariants);
  return rows.map((r) => r.label);
}

/** An extra a diner can see must be an extra a diner can buy on some size. */
function assertExtraOrderable(available: boolean, priceCount: number, name: string): void {
  if (available && priceCount === 0) {
    throw badRequest(
      `„${name}“ hat für keine Größe einen Preis und kann deshalb nicht angeboten werden. ` +
        'Bitte mindestens einen Preis angeben — oder die Zutat auf „nicht verfügbar“ setzen.',
    );
  }
}

/** Codes exactly as printed, de-duplicated, blanks dropped. Case is preserved:
 *  the harvest distinguishes "a" from "V". */
function normaliseCodes(codes: string[]): string[] {
  const out: string[] = [];
  for (const raw of codes) {
    const code = (raw ?? '').trim();
    if (!code) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Property 1. An empty allergen list is a claim about a dish, not a default —
 * so it has to be made on purpose.
 */
function assertAllergenIntent(
  codes: string[],
  confirmNoAllergens: boolean | undefined,
): void {
  if (codes.length === 0) {
    if (confirmNoAllergens !== true) {
      throw badRequest(
        'Dieses Gericht würde ohne Allergenangaben gespeichert. Auf einer Speisekarte ist ' +
          'das eine bewusste Entscheidung: bitte ausdrücklich bestätigen ' +
          '(confirmNoAllergens: true), dass das Gericht wirklich keine Allergene enthält.',
      );
    }
    return;
  }

  if (confirmNoAllergens === true) {
    throw badRequest(
      `Widersprüchliche Angabe: „keine Allergene“ wurde bestätigt, gleichzeitig sind ` +
        `Allergene angegeben (${codes.join(', ')}). Bitte nur eines von beidem senden.`,
    );
  }
}

/**
 * Property 2's typo guard — and the one place decision D2 could be undone, so
 * read this before changing it.
 *
 * D2 stores codes in a plain `text[]` with NO foreign key, precisely so a code
 * with no legend row stays representable: Portofino's own menu has printed
 * codes we could not resolve, and the honest render is "unbekannt", never a
 * dropped allergen. A database constraint here would have forced the loader to
 * drop or invent.
 *
 * The editor still refuses an unknown letter, because on a form `x` typed for
 * `a` is how an allergen silently becomes the wrong allergen. The refusal is a
 * VALIDATION rule with two deliberate escapes:
 *
 *   - the owner can add the legend entry in one step (POST /api/admin/menu/allergens)
 *     and then save;
 *   - a code the item ALREADY carries is always accepted, so an existing
 *     unresolved code stays readable and re-savable and no edit is ever blocked
 *     by data we inherited.
 *
 * Nothing here ever removes a code from the submitted list.
 */
async function assertCodesAreKnown(
  tx: Tx,
  codes: string[],
  alreadyStored: string[],
): Promise<void> {
  if (codes.length === 0) return;

  const rows = await tx
    .select({ code: allergenLegend.code })
    .from(allergenLegend)
    .where(inArray(allergenLegend.code, codes));
  const known = new Set(rows.map((r) => r.code));
  for (const code of alreadyStored) known.add(code);

  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw badRequest(
      `Der Allergen-Code „${unknown[0]}“ steht nicht in der Allergen-Legende. ` +
        'Bitte den Tippfehler korrigieren — oder den Code einmal unter „Allergene“ ' +
        'anlegen und dann erneut speichern. Der Code wird nie stillschweigend entfernt.' +
        (unknown.length > 1 ? ` (Ebenfalls unbekannt: ${unknown.slice(1).join(', ')}.)` : ''),
    );
  }
}

async function assertCategoryExists(tx: Tx, categoryId: string): Promise<void> {
  const id = (categoryId ?? '').trim();
  if (!id) {
    throw badRequest('Jedes Gericht braucht eine Kategorie.');
  }
  const [row] = await tx
    .select({ id: menuCategories.id })
    .from(menuCategories)
    .where(eq(menuCategories.id, id));
  if (!row) {
    throw badRequest(
      `Die Kategorie „${id}“ gibt es nicht. Bitte zuerst die Kategorie anlegen.`,
    );
  }
}

/** An item a diner can see must be an item a diner can buy. */
function assertOrderable(
  available: boolean,
  variantCount: number,
  name: string,
): void {
  if (available && variantCount === 0) {
    throw badRequest(
      `„${name}“ hat keine Größe mit Preis und kann deshalb nicht bestellbar sein. ` +
        'Bitte mindestens eine Variante mit Preis anlegen — oder das Gericht auf ' +
        '„nicht verfügbar“ setzen.',
    );
  }
}

// --- Storage plumbing ------------------------------------------------------

async function countVariants(tx: Tx, itemId: string): Promise<number> {
  const rows = await tx
    .select({ id: menuItemVariants.id })
    .from(menuItemVariants)
    .where(eq(menuItemVariants.itemId, itemId));
  return rows.length;
}

/** Re-read one extra through the same reader the menu routes use. */
async function loadExtra(id: string): Promise<AdminMenuExtra> {
  const menu = await loadAdminMenu();
  const extra = menu.extras.find((e) => e.id === id);
  if (!extra) throw notFound(`Es gibt keine Zutat mit der Kennung „${id}“.`);
  return extra;
}

/** Re-read one item through the same shape the menu routes return. */
async function loadItem(tx: Tx, id: string): Promise<AdminMenuItem> {
  const [row] = await tx.select().from(menuItems).where(eq(menuItems.id, id));
  if (!row) throw notFound(`Es gibt kein Gericht mit der Kennung „${id}“.`);

  const variantRows = await tx
    .select()
    .from(menuItemVariants)
    .where(eq(menuItemVariants.itemId, id))
    .orderBy(asc(menuItemVariants.sortOrder));

  const variants: MenuVariant[] = variantRows.map((v) => ({
    id: v.id,
    label: v.label,
    sortOrder: v.sortOrder,
    price: v.priceCents,
  }));

  return {
    id: row.id,
    ...(row.number ? { number: row.number } : {}),
    name: row.name,
    ...(row.nameEn ? { nameEn: row.nameEn } : {}),
    description: row.description,
    ...(row.descriptionEn ? { descriptionEn: row.descriptionEn } : {}),
    categoryId: row.categoryId,
    variants,
    allergenCodes: row.allergenCodes,
    ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}),
    available: row.available,
    sortOrder: row.sortOrder,
  };
}

/**
 * Turn a constraint violation into an answer the owner can act on, without
 * losing the fact that the whole edit was discarded. Anything unrecognised is
 * re-thrown untouched — a 500 that says "something broke" beats a 400 that
 * invents a reason.
 */
async function withStorageErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError) throw err;

    const code = (err as { code?: string }).code;
    const detail = (err as { detail?: string }).detail;

    if (code === '23505') {
      throw conflict(
        'Die Änderung wurde verworfen, weil eine Kennung bereits vergeben ist. ' +
          'Die bisherige Speisekarte bleibt unverändert.' +
          (detail ? ` (${detail})` : ''),
      );
    }
    if (code === '23503') {
      throw badRequest(
        'Die Änderung wurde verworfen, weil sie sich auf einen Eintrag bezieht, ' +
          'den es nicht (mehr) gibt. Die bisherige Speisekarte bleibt unverändert.' +
          (detail ? ` (${detail})` : ''),
      );
    }
    throw err;
  }
}
