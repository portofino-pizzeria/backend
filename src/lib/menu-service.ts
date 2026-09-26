// Reading the menu.
//
// Shared by the public route (`GET /api/menu`) and the owner's editor
// (`GET /api/admin/menu`) so the two can never drift. The editor has to show
// the owner exactly what a diner sees — the same variant ordering, the same
// allergen resolution, the same "unbekannt" for a code with no legend row —
// plus the rows a diner is not shown (unavailable items). Two hand-written
// readers would eventually disagree about one of those, and on this surface a
// disagreement means the owner edits a menu that is not the menu.

import { asc, eq, inArray } from 'drizzle-orm';

import { db } from '../db/client.js';
import {
  allergenLegend,
  menuCategories,
  menuExtraPrices,
  menuExtras,
  menuItemVariants,
  menuItems,
} from '../db/schema.js';
import type {
  AdminMenu,
  AdminMenuExtra,
  AdminMenuItem,
  AllergenLegendEntry,
  Menu,
  MenuCategory,
  MenuExtraPrice,
  MenuVariant,
} from '../types.js';

/** Label shown for an allergen code Portofino prints but we cannot resolve.
 *  German, because the menu is German-authoritative. Never omit the code. */
export const UNRESOLVED_LABEL_DE = 'unbekannt';
export const UNRESOLVED_LABEL_EN = 'unknown';

/**
 * The key an extra's price is matched on: a variant label, trimmed and
 * lower-cased, so "Groß 28cm" and "groß 28cm" are one size. Used by the
 * editor's validation and by order pricing alike — one rule, one place.
 */
export function sizeKey(label: string): string {
  return label.trim().toLocaleLowerCase('de-DE');
}

/** The price of `extra` on the variant labelled `variantLabel`, or `null`
 *  when the extra is not offered on that size. */
export function extraPriceFor(
  prices: MenuExtraPrice[],
  variantLabel: string,
): number | null {
  const key = sizeKey(variantLabel);
  return prices.find((p) => sizeKey(p.size) === key)?.price ?? null;
}

export interface LoadMenuOptions {
  /** The editor needs the rows the public menu filters out. */
  includeUnavailable?: boolean;
}

/**
 * The whole menu, with variants attached and every printed allergen code
 * carrying a legend entry — a real one where we have it, an explicit
 * `resolved: false` / "unbekannt" entry where we do not. Codes are never
 * dropped: silently omitting allergen information is the worst failure
 * available on this surface.
 */
export async function loadMenu(
  options: LoadMenuOptions = {},
): Promise<AdminMenu> {
  const itemQuery = db.select().from(menuItems);
  const [categoryRows, itemRows, legendRows, extraRows, extraPriceRows] = await Promise.all([
    db.select().from(menuCategories).orderBy(asc(menuCategories.sortOrder)),
    // Both branches order identically. `sortOrder` alone is not a total order —
    // two items may share one — and without the `id` tiebreaker Postgres is
    // free to return a tie in any order it likes, differently between calls.
    // That would let the owner's editor (which always had the tiebreaker) and
    // the diner's menu present the same card deck in two different orders.
    options.includeUnavailable
      ? itemQuery.orderBy(asc(menuItems.sortOrder), asc(menuItems.id))
      : itemQuery
          .where(eq(menuItems.available, true))
          .orderBy(asc(menuItems.sortOrder), asc(menuItems.id)),
    db.select().from(allergenLegend).orderBy(asc(allergenLegend.sortOrder)),
    db.select().from(menuExtras).orderBy(asc(menuExtras.sortOrder), asc(menuExtras.id)),
    db.select().from(menuExtraPrices),
  ]);

  const itemIds = itemRows.map((r) => r.id);
  const variantRows = itemIds.length
    ? await db
        .select()
        .from(menuItemVariants)
        .where(inArray(menuItemVariants.itemId, itemIds))
        .orderBy(asc(menuItemVariants.sortOrder))
    : [];

  const variantsByItem = new Map<string, MenuVariant[]>();
  for (const v of variantRows) {
    const list = variantsByItem.get(v.itemId) ?? [];
    list.push({
      id: v.id,
      label: v.label,
      sortOrder: v.sortOrder,
      price: v.priceCents,
    });
    variantsByItem.set(v.itemId, list);
  }

  const categories: MenuCategory[] = categoryRows.map((c) => ({
    id: c.id,
    label: c.label,
    ...(c.labelEn ? { labelEn: c.labelEn } : {}),
    sortOrder: c.sortOrder,
    ...(c.offersExtras ? { offersExtras: true } : {}),
  }));

  const items: AdminMenuItem[] = itemRows.map((r) => ({
    id: r.id,
    ...(r.number ? { number: r.number } : {}),
    name: r.name,
    ...(r.nameEn ? { nameEn: r.nameEn } : {}),
    description: r.description,
    ...(r.descriptionEn ? { descriptionEn: r.descriptionEn } : {}),
    categoryId: r.categoryId,
    variants: variantsByItem.get(r.id) ?? [],
    allergenCodes: r.allergenCodes,
    ...(r.imageUrl ? { imageUrl: r.imageUrl } : {}),
    ...(r.pickupOnly ? { pickupOnly: true } : {}),
    available: r.available,
    sortOrder: r.sortOrder,
  }));

  // Filtered like the items, so the diner's legend never carries a code that
  // only an unavailable extra prints.
  const extras = buildExtras(
    options.includeUnavailable ? extraRows : extraRows.filter((e) => e.available),
    extraPriceRows,
    variantRows,
  );

  return {
    categories,
    items,
    // Extras print allergen codes too, so an unresolved one on an extra gets
    // its "unbekannt" entry exactly like one on a dish.
    allergenLegend: buildLegend(legendRows, [...items, ...extras]),
    extras,
  };
}

/**
 * Extras with their prices, each price list smallest size first (klein, groß,
 * Blech) so the editor and the diner read the columns the same way round.
 *
 * "Smallest" is the lowest price the menu charges for a dish in that size.
 * A variant's `sortOrder` cannot answer it: it is a position within ONE dish,
 * and a Calzone sold only "groß 28cm" puts groß at position 0, tied with every
 * pizza's klein.
 */
function buildExtras(
  extraRows: {
    id: string;
    name: string;
    nameEn: string | null;
    allergenCodes: string[];
    available: boolean;
    sortOrder: number;
  }[],
  priceRows: { extraId: string; sizeLabel: string; priceCents: number }[],
  variantRows: { label: string; priceCents: number }[],
): AdminMenuExtra[] {
  const sizeRank = new Map<string, number>();
  for (const v of variantRows) {
    const key = sizeKey(v.label);
    sizeRank.set(key, Math.min(sizeRank.get(key) ?? v.priceCents, v.priceCents));
  }
  const rank = (size: string) => sizeRank.get(sizeKey(size)) ?? Number.MAX_SAFE_INTEGER;

  const pricesByExtra = new Map<string, MenuExtraPrice[]>();
  for (const p of priceRows) {
    const list = pricesByExtra.get(p.extraId) ?? [];
    list.push({ size: p.sizeLabel, price: p.priceCents });
    pricesByExtra.set(p.extraId, list);
  }

  return extraRows.map((e) => ({
    id: e.id,
    name: e.name,
    ...(e.nameEn ? { nameEn: e.nameEn } : {}),
    allergenCodes: e.allergenCodes,
    prices: (pricesByExtra.get(e.id) ?? []).sort(
      (a, b) => rank(a.size) - rank(b.size) || a.size.localeCompare(b.size, 'de'),
    ),
    available: e.available,
    sortOrder: e.sortOrder,
  }));
}

/** The public payload: the same menu with the owner-only fields removed. */
export function toPublicMenu(menu: AdminMenu): Menu {
  const liveSizes = new Set(
    menu.items.flatMap((item) => item.variants.map((v) => sizeKey(v.label))),
  );
  return {
    categories: menu.categories,
    items: menu.items.map((item) => {
      const { available: _available, sortOrder: _sortOrder, ...rest } = item;
      return rest;
    }),
    allergenLegend: menu.allergenLegend,
    // An extra with no price for any size a dish is sold in (its only size was
    // renamed away) cannot be bought on anything — so a diner is not shown it.
    extras: menu.extras
      .filter((extra) => extra.available && extra.prices.some((p) => liveSizes.has(sizeKey(p.size))))
      .map(({ available: _available, sortOrder: _sortOrder, ...rest }) => rest),
  };
}

/**
 * Every legend row, plus one flagged entry per code that appears on a returned
 * item and has no row. `resolved: false` is how an unresolved code stays
 * visible instead of vanishing — see the comment on `allergenLegend` in
 * `db/schema.ts` for why the column deliberately has no foreign key.
 */
function buildLegend(
  legendRows: { code: string; labelDe: string; labelEn: string | null }[],
  items: { allergenCodes: string[] }[],
): AllergenLegendEntry[] {
  const legend: AllergenLegendEntry[] = legendRows.map((l) => ({
    code: l.code,
    label: l.labelDe,
    ...(l.labelEn ? { labelEn: l.labelEn } : {}),
    resolved: true,
  }));

  const known = new Set(legendRows.map((l) => l.code));
  const unresolved = new Set<string>();
  for (const item of items) {
    for (const code of item.allergenCodes) {
      if (!known.has(code)) unresolved.add(code);
    }
  }
  for (const code of [...unresolved].sort()) {
    legend.push({
      code,
      label: UNRESOLVED_LABEL_DE,
      labelEn: UNRESOLVED_LABEL_EN,
      resolved: false,
    });
  }

  return legend;
}
