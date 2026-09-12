// The owner's menu editor — `/api/admin/menu/*`.
//
// This is a safety surface: it writes the allergens and prices a diner reads.
// A typecheck is not a gate for it. The four properties named in
// `domain_spec/menu` (8) each have their own `describe` below, spelled out in
// the test names so a failure says which property broke:
//
//   1. allergens cannot be lost silently
//   2. validation refuses impossible states
//   3. an interrupted edit leaves the previous good version live
//   4. a half-saved item never reaches a diner
//
// Nothing here is skipped. A skipped test is a lie in a green suite.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminMenu, Menu, Order } from '../src/types.js';
import { createTestApp } from './support/app';
import { withConfig } from './support/config';
import { TEST_OWNER_MENU_TOKEN } from './support/env';
import {
  seedCategory,
  seedItem,
  seedLegend,
  seedLegendEntry,
  VALID_CUSTOMER,
} from './support/fixtures';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

interface AdminResponse {
  statusCode: number;
  body: string;
  error: string;
  json: <T = unknown>() => T;
}

/** One authenticated editor request. */
async function admin(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  token: string | null = TEST_OWNER_MENU_TOKEN,
): Promise<AdminResponse> {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  return {
    statusCode: res.statusCode,
    body: res.body,
    error: (() => {
      try {
        return (res.json() as { error?: string }).error ?? '';
      } catch {
        return '';
      }
    })(),
    json: <T,>() => res.json() as T,
  };
}

async function publicMenu(): Promise<Menu> {
  const res = await app.inject({ method: 'GET', url: '/api/menu' });
  expect(res.statusCode).toBe(200);
  return res.json<Menu>();
}

async function adminMenu(): Promise<AdminMenu> {
  const res = await admin('GET', '/api/admin/menu');
  expect(res.statusCode).toBe(200);
  return res.json<AdminMenu>();
}

/** The whole diner-visible menu as a single string, for the "byte-for-byte
 *  unchanged" assertions. */
async function publicMenuSnapshot(): Promise<string> {
  return JSON.stringify(await publicMenu());
}

// ---------------------------------------------------------------------------

describe('the owner credential (D5) — its own secret, and it fails closed', () => {
  it('refuses every admin request when OWNER_MENU_TOKEN is unset', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({ id: 'margherita', name: 'Margherita', allergenCodes: ['a'] });
    const before = await publicMenuSnapshot();

    await withConfig({ ownerMenuToken: '' }, async () => {
      const read = await admin('GET', '/api/admin/menu');
      expect(read.statusCode).toBe(401);
      expect(read.error).toContain('OWNER_MENU_TOKEN');

      const write = await admin('POST', '/api/admin/menu/items', {
        name: 'Geschmuggelt',
        categoryId: 'pizza',
        allergenCodes: ['a'],
        variants: [{ label: 'groß', priceCents: 990 }],
      });
      expect(write.statusCode).toBe(401);

      const patch = await admin('PATCH', '/api/admin/menu/items/margherita', {
        name: 'Umbenannt',
      });
      expect(patch.statusCode).toBe(401);

      const remove = await admin('DELETE', '/api/admin/menu/items/margherita');
      expect(remove.statusCode).toBe(401);
    });

    // Unlike the kitchen guard, an unset credential opens nothing.
    expect(await publicMenuSnapshot()).toBe(before);
  });

  it('rejects a wrong token', async () => {
    const res = await admin('GET', '/api/admin/menu', undefined, 'falsch');
    expect(res.statusCode).toBe(401);
    expect(res.error).toContain('Ungültiges Kennwort');
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await admin('GET', '/api/admin/menu', undefined, null);
    expect(res.statusCode).toBe(401);
  });

  it('does not accept the kitchen token', async () => {
    await withConfig({ kitchenToken: 'kuechen-geheimnis' }, async () => {
      const res = await admin(
        'GET',
        '/api/admin/menu',
        undefined,
        'kuechen-geheimnis',
      );
      expect(res.statusCode).toBe(401);
    });
  });

  it('accepts the owner token', async () => {
    const res = await admin('GET', '/api/admin/menu');
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/admin/menu — the editor reads what the diner cannot', () => {
  it('includes items the public menu filters out', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedItem({ id: 'sichtbar', name: 'Sichtbar', available: true });
    await seedItem({ id: 'versteckt', name: 'Versteckt', available: false });

    expect((await publicMenu()).items.map((i) => i.id)).toEqual(['sichtbar']);

    const menu = await adminMenu();
    expect(menu.items.map((i) => i.id).sort()).toEqual(['sichtbar', 'versteckt']);
    expect(menu.items.find((i) => i.id === 'versteckt')?.available).toBe(false);
  });

  it('resolves allergen codes exactly as the public menu does', async () => {
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({ id: 'tonno', name: 'Tonno', allergenCodes: ['a', 'z'] });

    const menu = await adminMenu();
    expect(menu.allergenLegend).toContainEqual({
      code: 'z',
      label: 'unbekannt',
      labelEn: 'unknown',
      resolved: false,
    });
  });

  it('returns categories, items and the legend — the public domain shapes', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedItem({ id: 'margherita', name: 'Margherita' });

    const menu = await adminMenu();
    expect(Object.keys(menu).sort()).toEqual([
      'allergenLegend',
      'categories',
      'items',
    ]);
    expect(menu.items[0]).toMatchObject({
      id: 'margherita',
      name: 'Margherita',
      variants: [{ id: 'margherita-normal', label: 'normal', price: 990 }],
    });
  });
});

// ---------------------------------------------------------------------------

describe('safety property 1 — allergens cannot be lost silently', () => {
  beforeAll(() => {});

  async function seedTonno() {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([
      { code: 'a', labelDe: 'Glutenhaltiges Getreide' },
      { code: 'd', labelDe: 'Senf' },
    ]);
    return seedItem({
      id: 'tonno',
      name: 'Tonno',
      categoryId: 'pizza',
      allergenCodes: ['a', 'd'],
      variants: [{ id: 'tonno-gross', label: 'groß', priceCents: 890 }],
    });
  }

  it('property 1: an update that does not mention allergenCodes leaves them untouched', async () => {
    await seedTonno();

    const res = await admin('PATCH', '/api/admin/menu/items/tonno', {
      name: 'Tonno e Cipolla',
      variants: [{ id: 'tonno-gross', label: 'groß', priceCents: 990 }],
    });

    expect(res.statusCode).toBe(200);
    const item = (await publicMenu()).items.find((i) => i.id === 'tonno');
    expect(item?.name).toBe('Tonno e Cipolla');
    expect(item?.allergenCodes).toEqual(['a', 'd']);
  });

  it('property 1: clearing the allergens without the explicit confirmation is refused', async () => {
    await seedTonno();
    const before = await publicMenuSnapshot();

    const res = await admin('PATCH', '/api/admin/menu/items/tonno', {
      allergenCodes: [],
    });

    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('confirmNoAllergens');
    expect(await publicMenuSnapshot()).toBe(before);
  });

  it('property 1: clearing the allergens IS possible as a deliberate, confirmed act', async () => {
    await seedTonno();

    const res = await admin('PATCH', '/api/admin/menu/items/tonno', {
      allergenCodes: [],
      confirmNoAllergens: true,
    });

    expect(res.statusCode).toBe(200);
    const item = (await publicMenu()).items.find((i) => i.id === 'tonno');
    expect(item?.allergenCodes).toEqual([]);
  });

  it('property 1: creating an item with no allergen data needs the same confirmation', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });

    const forgot = await admin('POST', '/api/admin/menu/items', {
      name: 'Rumpsteak',
      categoryId: 'pizza',
      variants: [{ label: 'normal', priceCents: 1890 }],
    });
    expect(forgot.statusCode).toBe(400);
    expect(forgot.error).toContain('confirmNoAllergens');
    expect((await adminMenu()).items).toHaveLength(0);

    const deliberate = await admin('POST', '/api/admin/menu/items', {
      name: 'Rumpsteak',
      categoryId: 'pizza',
      allergenCodes: [],
      confirmNoAllergens: true,
      variants: [{ label: 'normal', priceCents: 1890 }],
    });
    expect(deliberate.statusCode).toBe(201);
    expect((await adminMenu()).items).toHaveLength(1);
  });

  it('property 1: refuses a request that both confirms "no allergens" and names some', async () => {
    await seedTonno();
    const before = await publicMenuSnapshot();

    const res = await admin('PATCH', '/api/admin/menu/items/tonno', {
      allergenCodes: ['a'],
      confirmNoAllergens: true,
    });

    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Widersprüchliche Angabe');
    expect(await publicMenuSnapshot()).toBe(before);
  });

  it('property 1: deleting a legend entry removes a label, never the code on a dish', async () => {
    await seedTonno();

    const res = await admin('DELETE', '/api/admin/menu/allergens/d');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ stillUsedBy: string[] }>().stillUsedBy).toEqual(['tonno']);

    const menu = await publicMenu();
    expect(menu.items[0]?.allergenCodes).toEqual(['a', 'd']);
    expect(menu.allergenLegend).toContainEqual({
      code: 'd',
      label: 'unbekannt',
      labelEn: 'unknown',
      resolved: false,
    });
  });
});

// ---------------------------------------------------------------------------

describe('safety property 2 — validation refuses impossible states', () => {
  async function base() {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
  }

  function newItem(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Testgericht',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ label: 'groß', priceCents: 990 }],
      ...overrides,
    };
  }

  it('property 2: refuses a variant with no price', async () => {
    await base();
    const res = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ variants: [{ label: 'groß' }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Preis');
    expect((await adminMenu()).items).toHaveLength(0);
  });

  it('property 2: refuses a price with no variant', async () => {
    await base();
    const res = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ variants: [{ label: '   ', priceCents: 990 }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Preis ohne Variante');
    expect((await adminMenu()).items).toHaveLength(0);
  });

  it('property 2: refuses a duplicate variant label on one item', async () => {
    await base();
    const res = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({
        variants: [
          { label: 'groß', priceCents: 990 },
          { label: 'groß', priceCents: 1290 },
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('mehrfach vor');
    expect((await adminMenu()).items).toHaveLength(0);
  });

  it('property 2: refuses a negative price', async () => {
    await base();
    const res = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ variants: [{ label: 'groß', priceCents: -100 }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('größer als 0');
    expect((await adminMenu()).items).toHaveLength(0);
  });

  it('property 2: refuses a non-integer price', async () => {
    await base();
    const res = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ variants: [{ label: 'groß', priceCents: 9.9 }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('ganze Zahl in Cent');
    expect((await adminMenu()).items).toHaveLength(0);
  });

  it('property 2: refuses an item with no category, and one naming a category that does not exist', async () => {
    await base();

    const missing = await admin('POST', '/api/admin/menu/items', {
      name: 'Ohne Kategorie',
      allergenCodes: ['a'],
      variants: [{ label: 'groß', priceCents: 990 }],
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.error).toContain('Kategorie');

    const unknown = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ categoryId: 'gibtsnicht' }),
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.error).toContain('gibtsnicht');

    expect((await adminMenu()).items).toHaveLength(0);
  });

  it('property 2: refuses an item with zero variants being made available', async () => {
    await base();

    const onCreate = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ variants: [], available: true }),
    );
    expect(onCreate.statusCode).toBe(400);
    expect(onCreate.error).toContain('nicht bestellbar sein');

    // The same rule on the toggle: an item with nothing to buy cannot be
    // switched on.
    await seedItem({
      id: 'leer',
      name: 'Leer',
      categoryId: 'pizza',
      available: false,
      variants: [],
    });
    const onToggle = await admin(
      'POST',
      '/api/admin/menu/items/leer/available',
      { available: true },
    );
    expect(onToggle.statusCode).toBe(400);
    expect(onToggle.error).toContain('nicht bestellbar sein');
    expect(
      (await adminMenu()).items.find((i) => i.id === 'leer')?.available,
    ).toBe(false);

    // …and on an update that would empty an available item's variant list.
    await seedItem({
      id: 'voll',
      name: 'Voll',
      categoryId: 'pizza',
      variants: [{ id: 'voll-gross', label: 'groß', priceCents: 990 }],
    });
    const onUpdate = await admin('PATCH', '/api/admin/menu/items/voll', {
      variants: [],
    });
    expect(onUpdate.statusCode).toBe(400);
    expect(
      (await publicMenu()).items.find((i) => i.id === 'voll')?.variants,
    ).toHaveLength(1);
  });

  it('property 2: refuses an unknown allergen letter (the typo guard)', async () => {
    await base();
    const res = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ allergenCodes: ['a', 'x'] }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('„x“');
    expect(res.error).toContain('Legende');
    expect((await adminMenu()).items).toHaveLength(0);
  });

  it('property 2: the owner can satisfy that refusal in one step, without a redeploy', async () => {
    await base();

    const added = await admin('POST', '/api/admin/menu/allergens', {
      code: 'x',
      labelDe: 'Sellerie',
      labelEn: 'Celery',
      sortOrder: 9,
    });
    expect(added.statusCode).toBe(201);

    const res = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ allergenCodes: ['a', 'x'] }),
    );
    expect(res.statusCode).toBe(201);

    const menu = await publicMenu();
    expect(menu.items[0]?.allergenCodes).toEqual(['a', 'x']);
    expect(menu.allergenLegend).toContainEqual({
      code: 'x',
      label: 'Sellerie',
      labelEn: 'Celery',
      resolved: true,
    });
  });

  it('property 2: an allergen code already stored with no legend row stays re-savable (D2)', async () => {
    await base();
    // The real menu ships codes we could not resolve. D2 keeps them
    // representable on purpose — so the typo guard must never make an
    // inherited code un-editable.
    await seedItem({
      id: 'geerbt',
      name: 'Geerbt',
      categoryId: 'pizza',
      allergenCodes: ['a', 'q'],
      variants: [{ id: 'geerbt-gross', label: 'groß', priceCents: 990 }],
    });

    expect(
      (await publicMenu()).allergenLegend.find((e) => e.code === 'q'),
    ).toEqual({ code: 'q', label: 'unbekannt', labelEn: 'unknown', resolved: false });

    const res = await admin('PATCH', '/api/admin/menu/items/geerbt', {
      name: 'Geerbt neu',
      allergenCodes: ['a', 'q'],
    });
    expect(res.statusCode).toBe(200);

    const item = (await publicMenu()).items.find((i) => i.id === 'geerbt');
    expect(item?.name).toBe('Geerbt neu');
    expect(item?.allergenCodes).toEqual(['a', 'q']);
  });

  it('property 2: refuses a second item claiming an id that is already taken', async () => {
    await base();
    await seedItem({ id: 'margherita', name: 'Margherita', categoryId: 'pizza' });

    const res = await admin(
      'POST',
      '/api/admin/menu/items',
      newItem({ id: 'margherita', name: 'Margherita Zwei' }),
    );
    expect(res.statusCode).toBe(409);
    expect((await publicMenu()).items.find((i) => i.id === 'margherita')?.name).toBe(
      'Margherita',
    );
  });
});

// ---------------------------------------------------------------------------

describe('safety property 3 — an interrupted edit leaves the previous good version live', () => {
  it('property 3: a write that fails part-way leaves GET /api/menu byte-for-byte unchanged', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza', sortOrder: 0 });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({
      id: 'margherita',
      number: '1',
      name: 'Margherita',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [
        { id: 'margherita-klein', label: 'klein', priceCents: 490 },
        { id: 'margherita-gross', label: 'groß', priceCents: 790 },
      ],
    });
    await seedItem({
      id: 'calzone',
      number: '13',
      name: 'Calzone',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ id: 'calzone-gross', label: 'groß', priceCents: 1090 }],
    });

    const before = await publicMenuSnapshot();

    // The edit renames the item, reprices one size, drops another and adds a
    // third — and the third names a variant id that already belongs to Calzone.
    // The rename, the delete and the reprice all reach the database before the
    // insert fails on the primary key. Everything must come back.
    const res = await admin('PATCH', '/api/admin/menu/items/margherita', {
      name: 'Margherita Speciale',
      variants: [
        { id: 'margherita-klein', label: 'klein', priceCents: 590 },
        { id: 'calzone-gross', label: 'Blech', priceCents: 2100 },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.error).toContain('bleibt unverändert');
    expect(await publicMenuSnapshot()).toBe(before);
  });

  it('property 3: the failed edit leaves the other item it touched intact too', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({
      id: 'margherita',
      name: 'Margherita',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ id: 'margherita-gross', label: 'groß', priceCents: 790 }],
    });
    await seedItem({
      id: 'calzone',
      name: 'Calzone',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ id: 'calzone-gross', label: 'groß', priceCents: 1090 }],
    });

    await admin('PATCH', '/api/admin/menu/items/margherita', {
      name: 'Kaputt',
      variants: [{ id: 'calzone-gross', label: 'groß', priceCents: 1 }],
    });

    const menu = await publicMenu();
    const calzone = menu.items.find((i) => i.id === 'calzone');
    expect(calzone?.variants).toEqual([
      { id: 'calzone-gross', label: 'groß', sortOrder: 0, price: 1090 },
    ]);
    expect(menu.items.find((i) => i.id === 'margherita')?.name).toBe('Margherita');
  });
});

// ---------------------------------------------------------------------------

describe('safety property 4 — a half-saved item never reaches a diner', () => {
  it('property 4: an item whose variants fail to write does not appear at all', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({
      id: 'calzone',
      name: 'Calzone',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ id: 'calzone-gross', label: 'groß', priceCents: 1090 }],
    });

    const before = await publicMenuSnapshot();

    const res = await admin('POST', '/api/admin/menu/items', {
      id: 'tonno',
      name: 'Tonno',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [
        { id: 'tonno-klein', label: 'klein', priceCents: 590 },
        // Already Calzone's. The item row is written before this fails.
        { id: 'calzone-gross', label: 'groß', priceCents: 990 },
      ],
    });

    expect(res.statusCode).toBe(409);

    // Not on the menu with no prices, not on the menu with one price, not
    // anywhere: the whole item is gone.
    const menu = await publicMenu();
    expect(menu.items.find((i) => i.id === 'tonno')).toBeUndefined();
    expect(JSON.stringify(menu)).toBe(before);

    // And not hidden in the editor's own view either.
    expect((await adminMenu()).items.map((i) => i.id)).toEqual(['calzone']);
  });

  it('property 4: the diner never sees a new name against the old prices', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({
      id: 'margherita',
      name: 'Margherita',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ id: 'margherita-gross', label: 'groß', priceCents: 790 }],
    });

    const res = await admin('PATCH', '/api/admin/menu/items/margherita', {
      name: 'Margherita Speciale',
      variants: [{ id: 'margherita-gross', label: 'groß', priceCents: 890 }],
    });
    expect(res.statusCode).toBe(200);

    const item = (await publicMenu()).items.find((i) => i.id === 'margherita');
    expect(item?.name).toBe('Margherita Speciale');
    expect(item?.variants).toEqual([
      { id: 'margherita-gross', label: 'groß', sortOrder: 0, price: 890 },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('editing the menu never rewrites order history', () => {
  it('keeps the ordered name, size and price after the editor changes all three', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({
      id: 'margherita',
      name: 'Margherita',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ id: 'margherita-gross', label: 'groß', priceCents: 790 }],
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        customer: VALID_CUSTOMER,
        items: [
          { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 2 },
        ],
      },
    });
    expect(created.statusCode).toBe(200);
    const order = created.json<{ order: Order }>().order;
    expect(order.lines[0]).toMatchObject({
      name: 'Margherita',
      variantLabel: 'groß',
      unitPrice: 790,
    });

    const edited = await admin('PATCH', '/api/admin/menu/items/margherita', {
      name: 'Margherita DOP',
      variants: [{ id: 'margherita-gross', label: 'Blech', priceCents: 2400 }],
    });
    expect(edited.statusCode).toBe(200);

    const reread = await app.inject({ method: 'GET', url: `/api/orders/${order.id}` });
    expect(reread.json<{ order: Order }>().order.lines[0]).toEqual({
      menuItemId: 'margherita',
      variantId: 'margherita-gross',
      name: 'Margherita',
      variantLabel: 'groß',
      unitPrice: 790,
      quantity: 2,
    });
  });

  it('survives the ordered item being deleted through the editor', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({
      id: 'margherita',
      name: 'Margherita',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ id: 'margherita-gross', label: 'groß', priceCents: 790 }],
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        customer: VALID_CUSTOMER,
        items: [
          { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
        ],
      },
    });
    const order = created.json<{ order: Order }>().order;

    const deleted = await admin('DELETE', '/api/admin/menu/items/margherita');
    expect(deleted.statusCode).toBe(200);
    expect((await publicMenu()).items).toHaveLength(0);

    const reread = await app.inject({ method: 'GET', url: `/api/orders/${order.id}` });
    expect(reread.statusCode).toBe(200);
    expect(reread.json<{ order: Order }>().order.lines[0]).toMatchObject({
      name: 'Margherita',
      variantLabel: 'groß',
      unitPrice: 790,
    });
  });
});

// ---------------------------------------------------------------------------

describe('items — the everyday edits', () => {
  beforeAll(() => {});

  it('creates an item in an empty category, which is the editor\'s first job', async () => {
    // Hähnchenbrust, Rumpsteak and Dessert exist as rows with no items: the
    // owner's own website has those three sections empty, so the editor is the
    // only route to that content.
    await seedCategory({ id: 'dessert', label: 'Dessert', sortOrder: 90 });
    await seedLegend([{ code: 'g', labelDe: 'Milch und Laktose' }]);

    expect((await publicMenu()).items).toHaveLength(0);

    const res = await admin('POST', '/api/admin/menu/items', {
      name: 'Tiramisu',
      categoryId: 'dessert',
      description: 'Hausgemacht',
      allergenCodes: ['g'],
      variants: [{ label: 'Portion', priceCents: 450 }],
    });

    expect(res.statusCode).toBe(201);
    const item = res.json<{ item: { id: string } }>().item;
    expect(item.id).toBe('tiramisu');

    const menu = await publicMenu();
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]).toMatchObject({
      id: 'tiramisu',
      name: 'Tiramisu',
      categoryId: 'dessert',
      allergenCodes: ['g'],
      variants: [
        { id: 'tiramisu-portion', label: 'Portion', sortOrder: 0, price: 450 },
      ],
    });
  });

  it('takes an item off the menu and puts it back without losing anything', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({
      id: 'margherita',
      name: 'Margherita',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [{ id: 'margherita-gross', label: 'groß', priceCents: 790 }],
    });

    const off = await admin('POST', '/api/admin/menu/items/margherita/available', {
      available: false,
    });
    expect(off.statusCode).toBe(200);
    expect((await publicMenu()).items).toHaveLength(0);

    const on = await admin('POST', '/api/admin/menu/items/margherita/available', {
      available: true,
    });
    expect(on.statusCode).toBe(200);
    expect((await publicMenu()).items[0]).toMatchObject({
      id: 'margherita',
      allergenCodes: ['a'],
      variants: [{ id: 'margherita-gross', label: 'groß', sortOrder: 0, price: 790 }],
    });
  });

  it('404s an edit of an item that does not exist', async () => {
    const res = await admin('PATCH', '/api/admin/menu/items/gibtsnicht', {
      name: 'Neu',
    });
    expect(res.statusCode).toBe(404);
  });

  it('adds, reprices and removes sizes in one edit', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    await seedItem({
      id: 'margherita',
      name: 'Margherita',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [
        { id: 'margherita-klein', label: 'klein', priceCents: 490 },
        { id: 'margherita-gross', label: 'groß', priceCents: 790 },
      ],
    });

    const res = await admin('PATCH', '/api/admin/menu/items/margherita', {
      variants: [
        { id: 'margherita-gross', label: 'groß', priceCents: 850 },
        { label: 'Blech', priceCents: 2100 },
      ],
    });
    expect(res.statusCode).toBe(200);

    expect((await publicMenu()).items[0]?.variants).toEqual([
      { id: 'margherita-gross', label: 'groß', sortOrder: 0, price: 850 },
      { id: 'margherita-blech', label: 'Blech', sortOrder: 1, price: 2100 },
    ]);
  });
});

describe('categories — data, so the owner never waits for a redeploy (D4)', () => {
  it('creates, renames and reorders categories', async () => {
    const created = await admin('POST', '/api/admin/menu/categories', {
      label: 'Hähnchenbrust',
      sortOrder: 10,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ category: { id: string } }>().category.id).toBe(
      'haehnchenbrust',
    );

    await admin('POST', '/api/admin/menu/categories', {
      id: 'pizza',
      label: 'Pizzen',
      sortOrder: 20,
    });

    const renamed = await admin('PATCH', '/api/admin/menu/categories/pizza', {
      label: 'Pizza',
      labelEn: 'Pizza',
    });
    expect(renamed.statusCode).toBe(200);

    const reordered = await admin('POST', '/api/admin/menu/categories/reorder', {
      ids: ['pizza', 'haehnchenbrust'],
    });
    expect(reordered.statusCode).toBe(200);
    expect((await publicMenu()).categories).toEqual([
      { id: 'pizza', label: 'Pizza', labelEn: 'Pizza', sortOrder: 0 },
      { id: 'haehnchenbrust', label: 'Hähnchenbrust', sortOrder: 1 },
    ]);
  });

  it('refuses a reorder that does not name every category', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza', sortOrder: 0 });
    await seedCategory({ id: 'salate', label: 'Salate', sortOrder: 1 });

    const res = await admin('POST', '/api/admin/menu/categories/reorder', {
      ids: ['pizza'],
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('salate');
    expect((await publicMenu()).categories.map((c) => c.id)).toEqual([
      'pizza',
      'salate',
    ]);
  });

  it('deletes an empty category and refuses one that still holds dishes', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedCategory({ id: 'dessert', label: 'Dessert', sortOrder: 1 });
    await seedItem({ id: 'margherita', name: 'Margherita', categoryId: 'pizza' });

    const held = await admin('DELETE', '/api/admin/menu/categories/pizza');
    expect(held.statusCode).toBe(409);
    expect(held.error).toContain('1 Gericht');

    const empty = await admin('DELETE', '/api/admin/menu/categories/dessert');
    expect(empty.statusCode).toBe(200);
    expect((await publicMenu()).categories.map((c) => c.id)).toEqual(['pizza']);
  });
});

describe('the allergen legend', () => {
  it('adds an entry and relabels an existing one', async () => {
    await seedLegendEntry({ code: 'd', labelDe: 'unbekannt' });

    const res = await admin('POST', '/api/admin/menu/allergens', {
      code: 'd',
      labelDe: 'Senf',
      labelEn: 'Mustard',
      sortOrder: 4,
    });
    expect(res.statusCode).toBe(201);

    await seedItem({ id: 'tonno', name: 'Tonno', allergenCodes: ['d'] });
    expect((await publicMenu()).allergenLegend).toContainEqual({
      code: 'd',
      label: 'Senf',
      labelEn: 'Mustard',
      resolved: true,
    });
  });

  it('refuses an empty code and an empty German label', async () => {
    const noCode = await admin('POST', '/api/admin/menu/allergens', {
      code: '  ',
      labelDe: 'Senf',
    });
    expect(noCode.statusCode).toBe(400);

    const noLabel = await admin('POST', '/api/admin/menu/allergens', {
      code: 'd',
      labelDe: '   ',
    });
    expect(noLabel.statusCode).toBe(400);

    expect((await adminMenu()).allergenLegend).toHaveLength(0);
  });

  it('404s deleting an entry that is not there', async () => {
    const res = await admin('DELETE', '/api/admin/menu/allergens/zz');
    expect(res.statusCode).toBe(404);
  });
});
