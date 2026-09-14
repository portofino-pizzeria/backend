import { fileURLToPath } from 'node:url';

import { db, sql } from './client.js';
import { loadMenuDataset, type MenuDataset } from './menu-dataset.js';
import {
  allergenLegend,
  menuCategories,
  menuItemVariants,
  menuItems,
} from './schema.js';

interface SeedSummary {
  legendCodes: number;
  categories: number;
  items: number;
  variants: number;
  emptyCategories: string[];
}

function buildSummary(dataset: MenuDataset): SeedSummary {
  const itemCountByCategory = new Map<string, number>();
  for (const category of dataset.categories) itemCountByCategory.set(category.id, 0);
  for (const item of dataset.items) {
    itemCountByCategory.set(
      item.categoryId,
      (itemCountByCategory.get(item.categoryId) ?? 0) + 1,
    );
  }
  // Three categories on the real site (Hähnchenbrust, Rumpsteak, Dessert) are
  // published with zero items — real headings the owner will fill from the
  // editor later, not a capture failure. Reported, never treated as invalid.
  const emptyCategories = dataset.categories
    .filter((category) => (itemCountByCategory.get(category.id) ?? 0) === 0)
    .map((category) => category.id);

  return {
    legendCodes: dataset.allergenLegend.length,
    categories: dataset.categories.length,
    items: dataset.items.length,
    variants: dataset.items.reduce((n, item) => n + item.variants.length, 0),
    emptyCategories,
  };
}

/**
 * Sort key for one printed item number. `"76a"` is a real number, so the
 * numeric part and the letter suffix are compared separately — otherwise
 * string ordering puts `"109"` before `"76"` and `"76b"` before `"76a"` only
 * by luck.
 */
function numberKey(number: string): [number, string] {
  const match = /^(\d+)(.*)$/.exec(number.trim());
  if (!match) return [Number.MAX_SAFE_INTEGER, number.trim()];
  return [Number(match[1]), match[2].trim()];
}

/**
 * Per-category presentation order, keyed by item id.
 *
 * The capture records the order the website's own DOM happened to use, and on
 * five of the thirteen non-empty categories that order does not follow the
 * printed numbers — Pizza comes back 6, 5, 4, 3, 2, 1, 7, 8… A diner asking
 * for "die 1" then finds it sixth in the list, which reads as a broken menu
 * and is the drift `audience_profile/owner-operator` calls worse than having
 * no app at all.
 *
 * `domain_spec/menu` (1) makes the number identity rather than decoration, so
 * the number is what the menu is ordered by. Items Portofino prints no number
 * for (drinks, Angebote, sauces) keep their captured order and follow the
 * numbered ones — `mexikanisch` is the one category that mixes both.
 *
 * This is derived at load time on purpose: `data/menu.json` stays a faithful
 * record of what the site served, and the presentation decision lives in code
 * where it is reviewable. Once loaded, the column is the owner's to reorder
 * from the editor.
 */
function presentationOrder(items: MenuDataset['items']): Map<string, number> {
  const byCategory = new Map<string, MenuDataset['items']>();
  for (const item of items) {
    const list = byCategory.get(item.categoryId) ?? [];
    list.push(item);
    byCategory.set(item.categoryId, list);
  }

  const order = new Map<string, number>();
  for (const list of byCategory.values()) {
    const sorted = [...list].sort((a, b) => {
      // Numbered items first, in printed-number order.
      if (Boolean(a.number) !== Boolean(b.number)) return a.number ? -1 : 1;
      if (a.number && b.number) {
        const [an, as_] = numberKey(a.number);
        const [bn, bs] = numberKey(b.number);
        if (an !== bn) return an - bn;
        if (as_ !== bs) return as_ < bs ? -1 : 1;
      }
      // Unnumbered items — and exact ties — keep the captured order.
      return a.sortOrder - b.sortOrder;
    });
    sorted.forEach((item, index) => order.set(item.id, index));
  }
  return order;
}

/**
 * Replaces the menu tables wholesale with the captured Portofino dataset
 * (`backend/data/menu.json`). Idempotent — safe to run any number of times,
 * including on every server boot, since `index.ts` calls this as part of its
 * DB-init retry loop.
 *
 * Validates the whole dataset (see menu-dataset.ts) before opening a
 * transaction, then clears and reloads `menu_categories`, `allergen_legend`,
 * `menu_items` and `menu_item_variants` in one transaction so a reader never
 * observes a half-loaded menu. `orders` / `order_lines` are never touched —
 * order history must survive a reseed, which is exactly why those tables
 * reference menu ids by plain text rather than a foreign key (see the
 * comment on `orderLines` in schema.ts).
 *
 * Returns the number of items seeded. `index.ts` logs this value directly
 * (`Database ready (${seeded} menu items)`), so the return type stays a
 * plain number rather than the richer summary printed below.
 */
export async function seedMenu(): Promise<number> {
  const dataset = loadMenuDataset();
  const summary = buildSummary(dataset);

  await db.transaction(async (tx) => {
    // FK-safe delete order: variants depend on items, items depend on
    // categories. `allergen_legend` has no FK relationship to any of these —
    // it's deleted last only for symmetry with the insert order below.
    await tx.delete(menuItemVariants);
    await tx.delete(menuItems);
    await tx.delete(menuCategories);
    await tx.delete(allergenLegend);

    if (dataset.allergenLegend.length > 0) {
      await tx.insert(allergenLegend).values(
        // The capture carries no sortOrder for legend entries (only
        // categories/items/variants do) — the array index preserves the
        // order the source's own legend block renders in.
        dataset.allergenLegend.map((entry, index) => ({
          code: entry.code,
          labelDe: entry.labelDe,
          labelEn: entry.labelEn,
          sortOrder: index,
        })),
      );
    }

    if (dataset.categories.length > 0) {
      await tx.insert(menuCategories).values(
        dataset.categories.map((category) => ({
          id: category.id,
          label: category.labelDe, // JSON key is labelDe; column is label.
          labelEn: category.labelEn,
          sortOrder: category.sortOrder,
        })),
      );
    }

    const menuOrder = presentationOrder(dataset.items);
    const pickupOnly = new Set(dataset.pickup?.pickupOnlyOffers ?? []);

    if (dataset.items.length > 0) {
      await tx.insert(menuItems).values(
        dataset.items.map((item) => ({
          id: item.id,
          number: item.number,
          name: item.name,
          nameEn: item.nameEn,
          // The column is NOT NULL default '' — a handful of real items
          // (sauces, Pommes) print no description at all; map null to the
          // schema's own empty-string default rather than inventing text.
          description: item.description ?? '',
          descriptionEn: item.descriptionEn,
          categoryId: item.categoryId,
          allergenCodes: item.allergenCodes, // Verbatim — never filtered.
          imageUrl: null, // Not in the capture; the owner adds these later.
          available: item.available,
          pickupOnly: pickupOnly.has(item.id),
          sortOrder: menuOrder.get(item.id) ?? item.sortOrder,
        })),
      );
    }

    const variantRows = dataset.items.flatMap((item) =>
      item.variants.map((variant) => ({
        id: variant.id,
        itemId: item.id,
        label: variant.label,
        sortOrder: variant.sortOrder,
        priceCents: variant.priceCents, // JSON key matches; column is price_cents.
      })),
    );
    if (variantRows.length > 0) {
      await tx.insert(menuItemVariants).values(variantRows);
    }
  });

  console.log(
    [
      'Menu seeded from data/menu.json:',
      `  allergen legend : ${summary.legendCodes}`,
      `  categories      : ${summary.categories}`,
      `  items           : ${summary.items}`,
      `  variants        : ${summary.variants}`,
      summary.emptyCategories.length > 0
        ? `  empty categories: ${summary.emptyCategories.join(', ')} ` +
          '(real headings with no published items — expected)'
        : '  empty categories: none',
    ].join('\n'),
  );

  return summary.items;
}

// Allow running standalone: `npm run db:seed`. Compared via fileURLToPath
// rather than a raw string template — on Windows `import.meta.url` is a
// `file:///C:/...` URL with forward slashes while `process.argv[1]` is a
// native `C:\...` path, so `` `file://${process.argv[1]}` `` never matches
// and this guard would silently never fire.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedMenu()
    .then(() => sql.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
