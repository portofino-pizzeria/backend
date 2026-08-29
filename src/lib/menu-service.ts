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
  menuItemVariants,
  menuItems,
} from '../db/schema.js';
import type {
  AdminMenu,
  AdminMenuItem,
  AllergenLegendEntry,
  Menu,
  MenuCategory,
  MenuVariant,
} from '../types.js';

/** Label shown for an allergen code Portofino prints but we cannot resolve.
 *  German, because the menu is German-authoritative. Never omit the code. */
export const UNRESOLVED_LABEL_DE = 'unbekannt';
export const UNRESOLVED_LABEL_EN = 'unknown';

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
  const [categoryRows, itemRows, legendRows] = await Promise.all([
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
    available: r.available,
    sortOrder: r.sortOrder,
  }));

  return {
    categories,
    items,
    allergenLegend: buildLegend(legendRows, items),
  };
}

/** The public payload: the same menu with the owner-only fields removed. */
export function toPublicMenu(menu: AdminMenu): Menu {
  return {
    categories: menu.categories,
    items: menu.items.map((item) => {
      const { available: _available, sortOrder: _sortOrder, ...rest } = item;
      return rest;
    }),
    allergenLegend: menu.allergenLegend,
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
