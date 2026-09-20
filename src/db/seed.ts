import { fileURLToPath } from 'node:url';

import { count, eq, sql as drizzleSql } from 'drizzle-orm';

import { db, sql } from './client.js';
import { loadMenuDataset, type MenuDataset } from './menu-dataset.js';
import {
  allergenLegend,
  datasetSeeds,
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

/** The transaction handle drizzle passes to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The `dataset_seeds` row that records the menu bootstrap. */
const MENU_DATASET = 'menu';

/**
 * Serialises every writer of the menu bootstrap for the length of its
 * transaction. Two instances booting at once (a deploy overlapping the old
 * revision, an App Runner scale-out) would otherwise both see "no marker, no
 * items", both load the dataset, and one would fail on the primary keys — or
 * a reseed would interleave with a boot's check. The lock is
 * transaction-scoped, so the commit or rollback releases it and a crashed
 * process can never leak it.
 */
async function lockMenuDataset(tx: Tx): Promise<void> {
  await tx.execute(
    drizzleSql`select pg_advisory_xact_lock(hashtext('portofino:dataset_seeds:menu'))`,
  );
}

/** How many rows each of the four menu tables holds. */
interface MenuRowCounts {
  legend: number;
  categories: number;
  items: number;
  variants: number;
}

/**
 * The four tables the bootstrap writes — asked about together, because
 * "has this database ever had a menu?" is not the same question as "does it
 * have dishes right now".
 *
 * `menu_items` alone is the wrong test. Deleting a dish in the editor leaves
 * its category heading and every `allergen_legend` row untouched (the editor
 * refuses to delete a category that still holds dishes, and deleting a dish
 * never touches the legend at all), so an owner who emptied the menu leaves a
 * database with zero items and a full legend. Treating that as a FRESH
 * database sends `insertDataset` at primary keys that already exist: the
 * transaction aborts on the first legend row, every one of `initDatabase`'s
 * twenty attempts fails the same way, and the boot gives up — without ever
 * reaching `seedShop()` or `refreshLegalStatus()`, so the shop then refuses
 * every order with a 503 it has no rules to answer. The database this whole
 * change exists to protect is the one that would break.
 */
async function countMenuRows(tx: Tx): Promise<MenuRowCounts> {
  const [legend] = await tx.select({ n: count() }).from(allergenLegend);
  const [categories] = await tx.select({ n: count() }).from(menuCategories);
  const [items] = await tx.select({ n: count() }).from(menuItems);
  const [variants] = await tx.select({ n: count() }).from(menuItemVariants);
  return {
    legend: Number(legend?.n ?? 0),
    categories: Number(categories?.n ?? 0),
    items: Number(items?.n ?? 0),
    variants: Number(variants?.n ?? 0),
  };
}

/**
 * Just the live item count, for the marker path.
 *
 * A database that already carries the marker is the common case — every boot,
 * every scale-out, every restart — and it needs one number, for the log line
 * and the return value. Charging it the four counts of `countMenuRows` would
 * make the frequent path pay for a question only the once-per-database path
 * asks.
 */
async function countMenuItems(tx: Tx): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(menuItems);
  return Number(row?.n ?? 0);
}

/** True when ANY menu table holds a row — see `countMenuRows`. */
function hasMenuRows(rows: MenuRowCounts): boolean {
  return rows.legend + rows.categories + rows.items + rows.variants > 0;
}

/** "12 items", or what is left when the owner has deleted every dish. */
function describeMenuRows(rows: MenuRowCounts): string {
  if (rows.items > 0) return `${rows.items} items`;
  const remains = [
    rows.categories > 0 ? `${rows.categories} categories` : null,
    rows.variants > 0 ? `${rows.variants} variants` : null,
    rows.legend > 0 ? `${rows.legend} allergen legend codes` : null,
  ].filter((part): part is string => part !== null);
  return `no items, ${remains.join(' and ')}`;
}

/**
 * Writes the dataset into the four menu tables. The caller owns the
 * transaction, the lock, and the guarantee that the tables are empty.
 */
async function insertDataset(tx: Tx, dataset: MenuDataset): Promise<void> {
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
}

function logLoaded(heading: string, summary: SeedSummary): void {
  console.log(
    [
      heading,
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
}

type SeedOutcome =
  | { kind: 'loaded'; items: number; summary: SeedSummary }
  | { kind: 'adopted'; rows: MenuRowCounts }
  | { kind: 'owner-authored'; items: number; seededAt: Date };

/**
 * Bootstraps the menu from the captured Portofino dataset
 * (`backend/data/menu.json`) **once per database**, and never again.
 *
 * `index.ts` calls this on every boot, inside its DB-init retry loop. It used
 * to delete and reload the four menu tables each time, which erased every
 * edit the owner made in the menu editor on every deploy, scale-out and
 * restart. Now the database is the source of truth as soon as it has a menu,
 * and a `menu` row in `dataset_seeds` records that it has had one:
 *
 *  - no marker and not one row in any of the four menu tables (a genuinely
 *    fresh database) → load the dataset and write the marker;
 *  - no marker but menu rows present (every database that predates the
 *    marker) → write the marker and nothing else. "Menu rows" is all four
 *    tables, not `menu_items`: an owner who deleted every dish still has the
 *    category headings and the allergen legend, and that database has plainly
 *    had a menu — see `countMenuRows`;
 *  - a marker → write nothing, even when the owner has since deleted every
 *    item. An empty menu is then the owner's doing, and bringing the captured
 *    menu back would be the same erasure in reverse. That is also why the
 *    marker records only *that* the menu was seeded, never which version of
 *    the file: a version check would reseed on the first edit to the file.
 *
 * One pre-marker state is genuinely undecidable and is NOT covered: a database
 * with no marker and all four menu tables empty. The editor can reach it — an
 * empty category may be deleted, and so may a legend row — and from the
 * outside it is identical to a database that has never been seeded. Such a
 * database is treated as fresh and loaded, so an owner who emptied the menu
 * completely BEFORE the marker existed gets the captured menu back once. After
 * the marker it cannot happen: the marker, not the row count, is what says the
 * menu has been seeded.
 *
 * All of it runs in one transaction under an advisory lock
 * (`lockMenuDataset`), so a reader never observes a half-loaded menu and two
 * instances booting at once cannot both load it. The dataset file is read and
 * validated (see menu-dataset.ts) only when it is actually going to be loaded,
 * so a database that already has its menu does not depend on
 * `data/menu.json` at all. `orders` / `order_lines` are never touched.
 *
 * The deliberate full reset is `reseedMenu()` (`npm run db:reseed`), never
 * this function.
 *
 * Returns the number of menu items in the database afterwards — loaded now or
 * already there. `index.ts` logs it as `Database ready (${n} menu items)`, so
 * it has to describe the live menu, not the file.
 */
export async function seedMenu(): Promise<number> {
  const outcome = await db.transaction(async (tx): Promise<SeedOutcome> => {
    await lockMenuDataset(tx);

    const [marker] = await tx
      .select()
      .from(datasetSeeds)
      .where(eq(datasetSeeds.name, MENU_DATASET));
    if (marker) {
      return {
        kind: 'owner-authored',
        items: await countMenuItems(tx),
        seededAt: marker.seededAt,
      };
    }

    const rows = await countMenuRows(tx);

    if (hasMenuRows(rows)) {
      await tx.insert(datasetSeeds).values({ name: MENU_DATASET });
      return { kind: 'adopted', rows };
    }

    const dataset = loadMenuDataset();
    await insertDataset(tx, dataset);
    await tx.insert(datasetSeeds).values({ name: MENU_DATASET });
    return { kind: 'loaded', items: dataset.items.length, summary: buildSummary(dataset) };
  });

  switch (outcome.kind) {
    case 'loaded':
      logLoaded('Menu seeded from data/menu.json (fresh database):', outcome.summary);
      break;
    case 'adopted':
      console.log(
        `Menu already present (${describeMenuRows(outcome.rows)}) — not reseeding. ` +
          'Recorded it as seeded; from now on the database is the menu.',
      );
      break;
    case 'owner-authored':
      console.log(
        `Menu was seeded at ${outcome.seededAt.toISOString()} and is owner-authored ` +
          `since (${outcome.items} items) — not reseeding; data/menu.json is not read.`,
      );
      break;
  }

  return outcome.kind === 'adopted' ? outcome.rows.items : outcome.items;
}

/**
 * The deliberate full reset: deletes the four menu tables, reloads them from
 * `data/menu.json` and rewrites the `menu` marker, in one transaction under
 * the same lock as `seedMenu()`. **Every owner edit is erased.** Only the
 * guarded `npm run db:reseed -- --force` command (reseed.ts) calls it; no
 * boot path does.
 *
 * `orders` / `order_lines` are never touched — order history must survive a
 * reseed, which is exactly why those tables reference menu ids by plain text
 * rather than a foreign key (see the comment on `orderLines` in schema.ts).
 *
 * Returns the number of items loaded.
 */
export async function reseedMenu(): Promise<number> {
  // Validated before the transaction opens: a broken dataset fails here and
  // the live menu is left exactly as it was.
  const dataset = loadMenuDataset();
  const summary = buildSummary(dataset);

  await db.transaction(async (tx) => {
    await lockMenuDataset(tx);

    // FK-safe delete order: variants depend on items, items depend on
    // categories. `allergen_legend` has no FK relationship to any of these —
    // it's deleted last only for symmetry with the insert order.
    await tx.delete(menuItemVariants);
    await tx.delete(menuItems);
    await tx.delete(menuCategories);
    await tx.delete(allergenLegend);

    await insertDataset(tx, dataset);

    await tx
      .insert(datasetSeeds)
      .values({ name: MENU_DATASET })
      .onConflictDoUpdate({
        target: datasetSeeds.name,
        set: { seededAt: drizzleSql`now()` },
      });
  });

  logLoaded('Menu RESEEDED from data/menu.json — every owner edit replaced:', summary);
  return summary.items;
}

// Allow running standalone: `npm run db:seed` — the same seed-once path a boot
// runs. Compared via fileURLToPath rather than a raw string template — on
// Windows `import.meta.url` is a `file:///C:/...` URL with forward slashes
// while `process.argv[1]` is a native `C:\...` path, so
// `` `file://${process.argv[1]}` `` never matches and this guard would
// silently never fire.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedMenu()
    .then(() => sql.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
