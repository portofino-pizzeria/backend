// The menu bootstrap (`seedMenu()`, src/db/seed.ts) and the guard on the
// deliberate reset (`npm run db:reseed`, src/db/reseed.ts).
//
// Every boot calls `seedMenu()`. Until the `dataset_seeds` marker existed it
// deleted and reloaded the menu tables each time, erasing every edit the owner
// made in the menu editor on every deploy. These tests pin the replacement:
// the dataset is loaded once per database, and after that nothing a boot does
// writes to the menu. The harness truncates every public table before each
// test, so each test starts from a fresh, empty database.

import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import { loadMenuDataset } from '../src/db/menu-dataset.js';
import {
  checkReseedArgs,
  FORCE_FLAG,
  PRODUCTION_FLAG,
  reseedCommand,
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

  it('adopts a menu the owner emptied before the marker existed', async () => {
    // A pre-marker database (today's production) whose owner deleted every
    // dish in the editor. Deleting a dish never touches the allergen legend,
    // and the editor refuses to delete a category that still holds dishes —
    // so both tables survive an emptied menu, and the database has plainly
    // had a menu even though `menu_items` is empty.
    await seedMenu();
    await db.delete(datasetSeeds);
    await db.delete(menuItemVariants);
    await db.delete(menuItems);

    const before = await tableCounts();
    expect(before.items).toBe(0);
    expect(before.categories).toBeGreaterThan(0);
    expect(before.legend).toBeGreaterThan(0);

    // What the next deploy does. Deciding "fresh database" from `menu_items`
    // alone would send the loader at primary keys that already exist: the
    // transaction would abort on the first legend row and every one of
    // `initDatabase`'s twenty boot attempts would fail the same way.
    const reported = await seedMenu();

    expect(reported).toBe(0);
    expect(await menuMarker()).toBeDefined();
    // And the captured menu is NOT brought back over the owner's decision.
    expect((await tableCounts()).items).toBe(0);
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

describe("the deploy guard's seed marker", () => {
  it('still names a migration that exists', () => {
    // `.github/workflows/deploy.yml` refuses to ship a commit that lacks this
    // file, because lacking it means "this code reseeds the menu on every
    // boot". The path is a stand-in for a property of the CODE, and nothing
    // else pins it: `npm run db:generate` rewrites `drizzle/`, and a squash or
    // renumber would remove it. The workflow does check `origin/master` first
    // and reports its own marker going missing as a repo-shape change rather
    // than as a rollback — but only at deploy time, on master, after the merge.
    // This moves that failure into the pull request that renumbers.
    const marker = fileURLToPath(
      new URL('../drizzle/0004_dataset_seeds.sql', import.meta.url),
    );
    expect(
      existsSync(marker),
      'drizzle/0004_dataset_seeds.sql is gone. It is the marker ' +
        '.github/workflows/deploy.yml uses to tell pre-seed-marker code from ' +
        'current code — update `seed_marker` there and the references in ' +
        'README.md to whatever now carries the seed-once behaviour.',
    ).toBe(true);
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

  it('points db:reseed:dist at the file the build actually emits', () => {
    // `reseedCommand()` is a pure string, and until CI gained a build step
    // nothing anywhere produced `dist/` — so the one reseed spelling that
    // works inside the container was asserted by prose alone. This pins the
    // script against the build config that decides where the file lands, and
    // needs no build to do it.
    const repoRoot = new URL('../', import.meta.url);
    const read = (name: string): string =>
      readFileSync(fileURLToPath(new URL(name, repoRoot)), 'utf8');

    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    // tsconfig.build.json is JSONC — comments today, and a trailing comma or
    // a block comment is legal there tomorrow. Use TypeScript's own reader
    // rather than a regex, so this test fails on the thing it is about and not
    // on a comment style.
    const parsed = ts.parseConfigFileTextToJson(
      'tsconfig.build.json',
      read('tsconfig.build.json'),
    );
    expect(parsed.error, JSON.stringify(parsed.error)).toBeUndefined();
    const buildConfig = parsed.config as {
      compilerOptions: { rootDir: string; outDir: string };
    };

    const { rootDir, outDir } = buildConfig.compilerOptions;
    const emitted = posix.join(
      outDir,
      posix.relative(rootDir, 'src/db/reseed.ts').replace(/\.ts$/, '.js'),
    );
    expect(pkg.scripts['db:reseed:dist']).toBe(`node ${emitted}`);

    // And when a build HAS run — always, in CI, which now builds before it
    // tests — the file the script names is really there.
    if (existsSync(fileURLToPath(new URL(outDir, repoRoot)))) {
      expect(existsSync(fileURLToPath(new URL(emitted, repoRoot)))).toBe(true);
    }
  });

  it('names the command that can actually run where it refused', () => {
    // The deployed image has no `tsx`, no `src/` and no `.env`, so the
    // `db:reseed` spelling cannot run there; `db:reseed:dist` runs the
    // compiled file that IS in the image.
    expect(reseedCommand('production')).toBe('npm run db:reseed:dist --');
    expect(reseedCommand('development')).toBe('npm run db:reseed --');
    expect(reseedCommand(undefined)).toBe('npm run db:reseed --');

    const inProduction = checkReseedArgs([], 'production');
    expect(inProduction.ok).toBe(false);
    if (!inProduction.ok) {
      // Both flags, because typing only --force there is refused by the very
      // next gate — a refusal must not name a command that is itself refused.
      expect(inProduction.message).toContain(
        `npm run db:reseed:dist -- ${FORCE_FLAG} ${PRODUCTION_FLAG}`,
      );
      // …and does not point at the two `tsx` scripts that are not in the image.
      expect(inProduction.message).not.toContain('npm run db:seed');
    }

    // The second gate — the message an operator in the container actually
    // reaches, having typed the first one's suggestion.
    const forceOnly = checkReseedArgs([FORCE_FLAG], 'production');
    expect(forceOnly.ok).toBe(false);
    if (!forceOnly.ok) {
      expect(forceOnly.message).toContain(
        `npm run db:reseed:dist -- ${FORCE_FLAG} ${PRODUCTION_FLAG}`,
      );
      expect(forceOnly.message).not.toContain('npm run db:reseed --');
    }

    const locally = checkReseedArgs([], 'development');
    expect(locally.ok).toBe(false);
    if (!locally.ok) {
      expect(locally.message).toContain('npm run db:reseed -- --force');
      expect(locally.message).toContain('npm run db:seed');
    }
  });
});
