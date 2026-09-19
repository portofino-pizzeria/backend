// The menu bootstrap (`seedMenu()`, src/db/seed.ts) and the guard on the
// deliberate reset (`npm run db:reseed`, src/db/reseed.ts).
//
// Every boot calls `seedMenu()`. Until the `dataset_seeds` marker existed it
// deleted and reloaded the menu tables each time, erasing every edit the owner
// made in the menu editor on every deploy. These tests pin the replacement:
// the dataset is loaded once per database, and after that nothing a boot does
// writes to the menu. The harness truncates every public table before each
// test, so each test starts from a fresh, empty database.

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import { loadMenuDataset } from '../src/db/menu-dataset.js';
import {
  checkReseedArgs,
  FORCE_FLAG,
  PRODUCTION_FLAG,
} from '../src/db/reseed.js';
import {
  allergenLegend,
  datasetSeeds,
  menuCategories,
  menuItemVariants,
  menuItems,
} from '../src/db/schema.js';
import { reseedMenu, seedMenu } from '../src/db/seed.js';
import { createTestApp } from './support/app';
import { TEST_OWNER_MENU_TOKEN } from './support/env';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const dataset = loadMenuDataset();
const datasetVariants = dataset.items.reduce((n, i) => n + i.variants.length, 0);
/** A real dataset item to edit. */
const target = dataset.items[0];

async function tableCounts() {
  return {
    legend: (await db.select().from(allergenLegend)).length,
    categories: (await db.select().from(menuCategories)).length,
    items: (await db.select().from(menuItems)).length,
    variants: (await db.select().from(menuItemVariants)).length,
  };
}

async function menuMarker() {
  const rows = await db
    .select()
    .from(datasetSeeds)
    .where(eq(datasetSeeds.name, 'menu'));
  return rows[0];
}

async function itemName(id: string): Promise<string | undefined> {
  const rows = await db.select().from(menuItems).where(eq(menuItems.id, id));
  return rows[0]?.name;
}

/** Renames an item the way the owner does: through the editor's API. */
async function renameThroughEditor(id: string, name: string): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/admin/menu/items/${encodeURIComponent(id)}`,
    payload: { name },
    headers: { authorization: `Bearer ${TEST_OWNER_MENU_TOKEN}` },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('seedMenu() — the menu is seeded once per database', () => {
  it('loads the full dataset into an empty database and writes the marker', async () => {
    expect(await menuMarker()).toBeUndefined();

    const seeded = await seedMenu();

    expect(seeded).toBe(dataset.items.length);
    expect(await tableCounts()).toEqual({
      legend: dataset.allergenLegend.length,
      categories: dataset.categories.length,
      items: dataset.items.length,
      variants: datasetVariants,
    });
    const marker = await menuMarker();
    expect(marker).toBeDefined();
    expect(marker!.seededAt).toBeInstanceOf(Date);
  });

  it("keeps an owner's edit across the next boot", async () => {
    await seedMenu();
    await renameThroughEditor(target.id, 'Vom Inhaber umbenannt');
    const markerBefore = await menuMarker();

    // What every deploy, restart and scale-out does.
    const reported = await seedMenu();

    expect(await itemName(target.id)).toBe('Vom Inhaber umbenannt');
    expect(reported).toBe(dataset.items.length);
    // The marker is not rewritten either: it records the first seed.
    expect((await menuMarker())!.seededAt).toEqual(markerBefore!.seededAt);
  });

  it('adopts a menu that predates the marker without rewriting it', async () => {
    // Today's production: items in the tables, no `dataset_seeds` row.
    await seedMenu();
    await renameThroughEditor(target.id, 'Vor dem Marker bearbeitet');
    await db.delete(datasetSeeds);
    expect(await menuMarker()).toBeUndefined();

    const reported = await seedMenu();

    expect(await menuMarker()).toBeDefined();
    expect(await itemName(target.id)).toBe('Vor dem Marker bearbeitet');
    expect(reported).toBe(dataset.items.length);
    expect(await tableCounts()).toMatchObject({ items: dataset.items.length });
  });

  it('does not bring the menu back after the owner deleted every item', async () => {
    await seedMenu();
    await db.delete(menuItemVariants);
    await db.delete(menuItems);

    const reported = await seedMenu();

    expect(reported).toBe(0);
    expect((await tableCounts()).items).toBe(0);
    expect((await tableCounts()).variants).toBe(0);
    expect(await menuMarker()).toBeDefined();
  });

  it('seeds exactly once when two boots race on an empty database', async () => {
    // Two instances starting together: the advisory lock serialises them, so
    // one loads the dataset and the other finds the marker.
    const [a, b] = await Promise.all([seedMenu(), seedMenu()]);

    expect(a).toBe(dataset.items.length);
    expect(b).toBe(dataset.items.length);
    expect((await tableCounts()).items).toBe(dataset.items.length);
  });
});

describe('reseedMenu() — the deliberate reset', () => {
  it('replaces owner edits with the dataset and rewrites the marker', async () => {
    await seedMenu();
    await renameThroughEditor(target.id, 'Wird zurückgesetzt');
    const markerBefore = await menuMarker();

    const loaded = await reseedMenu();

    expect(loaded).toBe(dataset.items.length);
    expect(await itemName(target.id)).toBe(target.name);
    expect(await tableCounts()).toEqual({
      legend: dataset.allergenLegend.length,
      categories: dataset.categories.length,
      items: dataset.items.length,
      variants: datasetVariants,
    });
    expect((await menuMarker())!.seededAt.getTime()).toBeGreaterThanOrEqual(
      markerBefore!.seededAt.getTime(),
    );
  });
});

describe('checkReseedArgs() — the guard on `npm run db:reseed`', () => {
  it('refuses without --force', () => {
    const check = checkReseedArgs([], 'development');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain('--force');

    // The production flag alone is not a substitute for --force.
    expect(checkReseedArgs([PRODUCTION_FLAG], 'production').ok).toBe(false);
  });

  it('refuses --force in production without the second flag', () => {
    const check = checkReseedArgs([FORCE_FLAG], 'production');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain(PRODUCTION_FLAG);
  });

  it('allows both flags in production', () => {
    expect(checkReseedArgs([FORCE_FLAG, PRODUCTION_FLAG], 'production')).toEqual({
      ok: true,
    });
  });

  it('allows --force outside production', () => {
    expect(checkReseedArgs([FORCE_FLAG], 'development')).toEqual({ ok: true });
    expect(checkReseedArgs([FORCE_FLAG], undefined)).toEqual({ ok: true });
    expect(checkReseedArgs([FORCE_FLAG], 'test')).toEqual({ ok: true });
  });
});
