import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { db } from '../db/client.js';
import {
  allergenLegend,
  menuCategories,
  menuItemVariants,
  menuItems,
} from '../db/schema.js';
import type {
  AllergenLegendEntry,
  Menu,
  MenuCategory,
  MenuItem,
  MenuVariant,
} from '../types.js';

/** Label shown for an allergen code Portofino prints but we cannot resolve.
 *  German, because the menu is German-authoritative. Never omit the code. */
const UNRESOLVED_LABEL_DE = 'unbekannt';
const UNRESOLVED_LABEL_EN = 'unknown';

export async function menuRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/menu -> { categories, items, allergenLegend }
  app.get('/api/menu', async (): Promise<Menu> => {
    const [categoryRows, itemRows, legendRows] = await Promise.all([
      db.select().from(menuCategories).orderBy(asc(menuCategories.sortOrder)),
      db
        .select()
        .from(menuItems)
        .where(eq(menuItems.available, true))
        .orderBy(asc(menuItems.sortOrder)),
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

    const items: MenuItem[] = itemRows.map((r) => ({
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
    }));

    // Every code printed on a returned item gets a legend entry. A code with no
    // legend row comes back flagged `resolved: false` rather than being dropped
    // — silently omitting allergen information is the worst failure available
    // on this surface.
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

    return { categories, items, allergenLegend: legend };
  });
}
