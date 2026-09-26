// Extra ingredients ("Zutaten") — the owner prices them per size, the diner
// adds them to a dish, and the server charges the price for the size bought.
//
// Money and allergens again, so the same rules as the dish editor are tested
// here rather than assumed: prices come from the rows and never the client, a
// size with no price is refused rather than charged as zero, and an extra's
// allergen codes cannot be lost silently.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminMenu, AdminMenuExtra, Menu, Order } from '../src/types.js';
import { createTestApp } from './support/app';
import { TEST_OWNER_MENU_TOKEN } from './support/env';
import { seedCategory, seedItem, seedLegend, VALID_CUSTOMER } from './support/fixtures';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const KLEIN = 'klein 22cm';
const GROSS = 'groß 28cm';
const BLECH = 'Blech 30x50cm';

async function admin(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: { authorization: `Bearer ${TEST_OWNER_MENU_TOKEN}` },
  });
  const body = (() => {
    try {
      return res.json() as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  return { statusCode: res.statusCode, body, error: (body.error as string | undefined) ?? '' };
}

async function publicMenu(): Promise<Menu> {
  const res = await app.inject({ method: 'GET', url: '/api/menu' });
  expect(res.statusCode).toBe(200);
  return res.json<Menu>();
}

function postOrder(items: unknown[]) {
  return app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: { items, fulfilment: 'pickup', customer: VALID_CUSTOMER },
  });
}

/** Margherita in three sizes, in the Pizza category, plus a salad in a
 *  category that does not offer extras. */
async function seedPizzeria(): Promise<void> {
  await seedLegend([
    { code: 'a', labelDe: 'Gluten' },
    { code: 'g', labelDe: 'Milch' },
  ]);
  await seedCategory({ id: 'pizza', label: 'Pizza', offersExtras: true });
  await seedCategory({ id: 'salate', label: 'Salate', sortOrder: 1 });
  await seedItem({
    id: 'margherita',
    name: 'Margherita',
    categoryId: 'pizza',
    variants: [
      { id: 'margherita-klein', label: KLEIN, priceCents: 490 },
      { id: 'margherita-gross', label: GROSS, priceCents: 790 },
      { id: 'margherita-blech', label: BLECH, priceCents: 2100 },
    ],
  });
  await seedItem({
    id: 'calzone',
    name: 'Calzone',
    categoryId: 'pizza',
    variants: [{ id: 'calzone-gross', label: GROSS, priceCents: 1090 }],
  });
  await seedItem({
    id: 'insalata',
    name: 'Insalata',
    categoryId: 'salate',
    variants: [{ id: 'insalata-gross', label: 'groß', priceCents: 690 }],
  });
}

async function createKaese(overrides: Record<string, unknown> = {}): Promise<AdminMenuExtra> {
  const res = await admin('POST', '/api/admin/menu/extras', {
    name: 'Käse',
    allergenCodes: ['g'],
    prices: [
      { size: KLEIN, priceCents: 100 },
      { size: GROSS, priceCents: 150 },
      { size: BLECH, priceCents: 300 },
    ],
    ...overrides,
  });
  expect(res.statusCode, res.error).toBe(201);
  return res.body.extra as AdminMenuExtra;
}

describe('the owner prices an extra per size', () => {
  it('stores one price per size and serves it on both menus', async () => {
    await seedPizzeria();
    const extra = await createKaese();

    expect(extra).toMatchObject({
      id: 'kaese',
      name: 'Käse',
      allergenCodes: ['g'],
      available: true,
      prices: [
        { size: KLEIN, price: 100 },
        { size: GROSS, price: 150 },
        { size: BLECH, price: 300 },
      ],
    });

    const menu = await publicMenu();
    expect(menu.extras).toEqual([
      {
        id: 'kaese',
        name: 'Käse',
        allergenCodes: ['g'],
        prices: extra.prices,
      },
    ]);
    expect(menu.categories.find((c) => c.id === 'pizza')?.offersExtras).toBe(true);
    expect(menu.categories.find((c) => c.id === 'salate')?.offersExtras).toBeUndefined();
  });

  it('replaces the whole price list on an update', async () => {
    await seedPizzeria();
    await createKaese();

    const res = await admin('PATCH', '/api/admin/menu/extras/kaese', {
      prices: [{ size: GROSS, priceCents: 200 }],
    });
    expect(res.statusCode, res.error).toBe(200);
    expect((res.body.extra as AdminMenuExtra).prices).toEqual([{ size: GROSS, price: 200 }]);
    // Absent allergens were left exactly as they were.
    expect((res.body.extra as AdminMenuExtra).allergenCodes).toEqual(['g']);
  });

  it('refuses a size no dish on the menu carries — a typo would never apply', async () => {
    await seedPizzeria();
    const res = await admin('POST', '/api/admin/menu/extras', {
      name: 'Käse',
      allergenCodes: ['g'],
      prices: [{ size: 'gross 28cm', priceCents: 150 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('„gross 28cm“ gibt es auf der Speisekarte nicht');
  });

  it('refuses the same size twice, and a zero or fractional price', async () => {
    await seedPizzeria();
    const twice = await admin('POST', '/api/admin/menu/extras', {
      name: 'Käse',
      allergenCodes: ['g'],
      prices: [
        { size: GROSS, priceCents: 150 },
        { size: 'Groß 28cm', priceCents: 160 },
      ],
    });
    expect(twice.statusCode).toBe(400);
    expect(twice.error).toContain('mehr als einen Preis');

    for (const priceCents of [0, 1.5, -100]) {
      const res = await admin('POST', '/api/admin/menu/extras', {
        name: 'Käse',
        allergenCodes: ['g'],
        prices: [{ size: GROSS, priceCents }],
      });
      expect(res.statusCode, String(priceCents)).toBe(400);
    }
  });

  it('refuses an available extra with no price at all', async () => {
    await seedPizzeria();
    const res = await admin('POST', '/api/admin/menu/extras', {
      name: 'Käse',
      allergenCodes: ['g'],
      prices: [],
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('für keine Größe einen Preis');
  });

  it('refuses an extra with no allergens unless that is confirmed', async () => {
    await seedPizzeria();
    const refused = await admin('POST', '/api/admin/menu/extras', {
      name: 'Zwiebeln',
      prices: [{ size: GROSS, priceCents: 100 }],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.error).toContain('confirmNoAllergens');

    const confirmed = await admin('POST', '/api/admin/menu/extras', {
      name: 'Zwiebeln',
      confirmNoAllergens: true,
      prices: [{ size: GROSS, priceCents: 100 }],
    });
    expect(confirmed.statusCode, confirmed.error).toBe(201);
  });

  it('refuses an allergen code that is not in the legend', async () => {
    await seedPizzeria();
    const res = await admin('POST', '/api/admin/menu/extras', {
      name: 'Käse',
      allergenCodes: ['x'],
      prices: [{ size: GROSS, priceCents: 150 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('„x“ steht nicht in der Allergen-Legende');
  });

  it('hides an unavailable extra from diners but not from the editor', async () => {
    await seedPizzeria();
    await createKaese();
    const res = await admin('PATCH', '/api/admin/menu/extras/kaese', { available: false });
    expect(res.statusCode, res.error).toBe(200);

    expect((await publicMenu()).extras).toEqual([]);
    const editor = await admin('GET', '/api/admin/menu');
    expect((editor.body as unknown as AdminMenu).extras.map((e) => e.id)).toEqual(['kaese']);
  });

  it('deletes an extra', async () => {
    await seedPizzeria();
    await createKaese();
    expect((await admin('DELETE', '/api/admin/menu/extras/kaese')).statusCode).toBe(200);
    expect((await publicMenu()).extras).toEqual([]);
    expect((await admin('DELETE', '/api/admin/menu/extras/kaese')).statusCode).toBe(404);
  });

  it('lets the owner switch extras on for a category', async () => {
    await seedPizzeria();
    const res = await admin('PATCH', '/api/admin/menu/categories/salate', { offersExtras: true });
    expect(res.statusCode, res.error).toBe(200);
    const menu = await publicMenu();
    expect(menu.categories.find((c) => c.id === 'salate')?.offersExtras).toBe(true);
  });

  it('refuses a price above 1.000 €', async () => {
    await seedPizzeria();
    const res = await admin('POST', '/api/admin/menu/extras', {
      name: 'Gold',
      confirmNoAllergens: true,
      prices: [{ size: GROSS, priceCents: 100_001 }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('names the extras that still print an allergen whose label is deleted', async () => {
    await seedPizzeria();
    await createKaese();
    const res = await admin('DELETE', '/api/admin/menu/allergens/g');
    expect(res.statusCode, res.error).toBe(200);
    expect(res.body.stillUsedByExtras).toEqual(['kaese']);
    // The code stays on the extra and renders as unresolved, never dropped.
    const menu = await publicMenu();
    expect(menu.extras[0]?.allergenCodes).toEqual(['g']);
    expect(menu.allergenLegend.find((e) => e.code === 'g')?.resolved).toBe(false);
  });

  it('hides an extra from diners once no dish carries any size it is priced for', async () => {
    await seedPizzeria();
    await createKaese({ prices: [{ size: BLECH, priceCents: 300 }] });
    expect((await publicMenu()).extras.map((e) => e.id)).toEqual(['kaese']);

    // The Blech size disappears from the menu: its only dish drops it.
    await admin('PATCH', '/api/admin/menu/items/margherita', {
      variants: [
        { id: 'margherita-klein', label: KLEIN, priceCents: 490 },
        { id: 'margherita-gross', label: GROSS, priceCents: 790 },
      ],
    });
    expect((await publicMenu()).extras).toEqual([]);

    // The owner is not locked out of the extra: a plain rename still saves,
    // and the stored Blech price is kept for the editor to see.
    const res = await admin('PATCH', '/api/admin/menu/extras/kaese', { name: 'Mozzarella' });
    expect(res.statusCode, res.error).toBe(200);
    expect((res.body.extra as AdminMenuExtra).prices).toEqual([{ size: BLECH, price: 300 }]);
  });

  it('does not cap dish prices at the extras cap', async () => {
    await seedPizzeria();
    const res = await admin('PATCH', '/api/admin/menu/items/calzone', {
      variants: [{ id: 'calzone-gross', label: GROSS, priceCents: 150_000 }],
    });
    expect(res.statusCode, res.error).toBe(200);
  });

  it('refuses every extras write without the owner credential', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/menu/extras',
      payload: { name: 'Käse', prices: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('the diner adds extras and pays the price for the size bought', () => {
  it('adds the extra price for that size to the unit price, and snapshots it', async () => {
    await seedPizzeria();
    await createKaese();
    await admin('POST', '/api/admin/menu/extras', {
      name: 'Salami',
      allergenCodes: ['a'],
      prices: [
        { size: GROSS, priceCents: 180 },
        { size: BLECH, priceCents: 400 },
      ],
    });

    const res = await postOrder([
      { menuItemId: 'margherita', variantId: 'margherita-klein', quantity: 1, extraIds: ['kaese'] },
      {
        menuItemId: 'margherita',
        variantId: 'margherita-blech',
        quantity: 2,
        extraIds: ['kaese', 'salami'],
      },
      { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const { order } = res.json<{ order: Order }>();

    expect(order.lines[0]).toMatchObject({
      unitPrice: 490 + 100,
      extras: [{ extraId: 'kaese', name: 'Käse', price: 100 }],
    });
    expect(order.lines[1]).toMatchObject({
      unitPrice: 2100 + 300 + 400,
      quantity: 2,
      extras: [
        { extraId: 'kaese', name: 'Käse', price: 300 },
        { extraId: 'salami', name: 'Salami', price: 400 },
      ],
    });
    // A plain line carries no extras key at all.
    expect(order.lines[2]).not.toHaveProperty('extras');
    expect(order.subtotal).toBe(590 + 2 * 2800 + 790);
    expect(order.total).toBe(order.subtotal); // pickup: no delivery fee
  });

  it('keeps the price charged when the owner later changes it', async () => {
    await seedPizzeria();
    await createKaese();
    const res = await postOrder([
      { menuItemId: 'calzone', variantId: 'calzone-gross', quantity: 1, extraIds: ['kaese'] },
    ]);
    const { order } = res.json<{ order: Order }>();

    await admin('PATCH', '/api/admin/menu/extras/kaese', {
      prices: [{ size: GROSS, priceCents: 999 }],
    });
    const read = await app.inject({ method: 'GET', url: `/api/orders/${order.id}` });
    expect(read.json<{ order: Order }>().order.lines[0]).toMatchObject({
      unitPrice: 1090 + 150,
      extras: [{ extraId: 'kaese', name: 'Käse', price: 150 }],
    });
  });

  it('refuses an extra on a size it has no price for — never free', async () => {
    await seedPizzeria();
    await admin('POST', '/api/admin/menu/extras', {
      name: 'Salami',
      allergenCodes: ['a'],
      prices: [{ size: BLECH, priceCents: 400 }],
    });
    const res = await postOrder([
      { menuItemId: 'margherita', variantId: 'margherita-klein', quantity: 1, extraIds: ['salami'] },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('„Salami“ gibt es nicht zu Margherita');
  });

  it('refuses extras on a dish whose category does not offer them', async () => {
    await seedPizzeria();
    await admin('POST', '/api/admin/menu/extras', {
      name: 'Käse',
      allergenCodes: ['g'],
      prices: [{ size: 'groß', priceCents: 150 }],
    });
    const res = await postOrder([
      { menuItemId: 'insalata', variantId: 'insalata-gross', quantity: 1, extraIds: ['kaese'] },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('keine Extra-Zutaten');
  });

  it('refuses an unknown or unavailable extra, and the same extra twice', async () => {
    await seedPizzeria();
    await createKaese();

    const unknown = await postOrder([
      { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1, extraIds: ['gold'] },
    ]);
    expect(unknown.statusCode).toBe(400);

    const twice = await postOrder([
      {
        menuItemId: 'margherita',
        variantId: 'margherita-gross',
        quantity: 1,
        extraIds: ['kaese', 'kaese'],
      },
    ]);
    expect(twice.statusCode).toBe(400);
    expect(twice.json<{ error: string }>().error).toContain('nur einmal');

    await admin('PATCH', '/api/admin/menu/extras/kaese', { available: false });
    const unavailable = await postOrder([
      { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1, extraIds: ['kaese'] },
    ]);
    expect(unavailable.statusCode).toBe(400);
    expect(unavailable.json<{ error: string }>().error).toContain('gerade nicht verfügbar');
  });

  it('ignores any price a client sends and charges the stored one', async () => {
    await seedPizzeria();
    await createKaese();
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        items: [
          {
            menuItemId: 'margherita',
            variantId: 'margherita-gross',
            quantity: 1,
            extraIds: ['kaese'],
            unitPrice: 1,
            extras: [{ extraId: 'kaese', price: 0 }],
          },
        ],
        fulfilment: 'pickup',
        customer: VALID_CUSTOMER,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ order: Order }>().order.lines[0]?.unitPrice).toBe(790 + 150);
  });
});
