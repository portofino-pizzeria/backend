// The delivery area the owner sets: a list of postcodes, enforced on every
// delivery order, served to the app, editable and undoable like every other
// shop fact. An empty list restricts nothing.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deliveryAreaRefusal, normalisePostcodes, postcodesIn } from '../src/lib/delivery-area.js';
import type { AdminShop } from '../src/lib/shop-admin-service.js';
import type { Order } from '../src/types.js';
import { createTestApp } from './support/app';
import { TEST_OWNER_MENU_TOKEN } from './support/env';
import { seedCategory, seedItem, VALID_CUSTOMER } from './support/fixtures';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const AUTH = { authorization: `Bearer ${TEST_OWNER_MENU_TOKEN}` };
const LINE = [{ menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 }];

async function seedMargherita(): Promise<void> {
  await seedCategory({ id: 'pizza', label: 'Pizza' });
  await seedItem({
    id: 'margherita',
    name: 'Margherita',
    categoryId: 'pizza',
    variants: [{ id: 'margherita-gross', label: 'groß', priceCents: 790 }],
  });
}

async function readShop(): Promise<AdminShop> {
  const res = await app.inject({ method: 'GET', url: '/api/admin/shop', headers: AUTH });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AdminShop>();
}

async function setArea(postcodes: string[]) {
  const { version } = await readShop();
  return app.inject({
    method: 'PUT',
    url: '/api/admin/shop/delivery-area',
    headers: AUTH,
    payload: { postcodes, version },
  });
}

function order(fulfilment: 'delivery' | 'pickup', address?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: {
      fulfilment,
      items: LINE,
      customer: { ...VALID_CUSTOMER, ...(address === undefined ? {} : { address }) },
    },
  });
}

describe('the rules', () => {
  it('stores a clean, sorted, de-duplicated list', () => {
    expect(normalisePostcodes([' 45239', '45219', '45219', ''])).toEqual(['45219', '45239']);
  });

  it('refuses the whole list over one typo, naming it', () => {
    expect(() => normalisePostcodes(['45219', '4523'])).toThrow(/„4523“ ist keine Postleitzahl/);
  });

  it('reads the postcode out of a free-text address, not a house number', () => {
    expect(postcodesIn('Hauptstr. 108, 45219 Essen')).toEqual(['45219']);
    expect(postcodesIn('Ringstraße 1234')).toEqual([]);
    expect(postcodesIn('Weg 1, 452190 Essen')).toEqual([]);
  });

  it('an empty area restricts nothing', () => {
    expect(deliveryAreaRefusal([], 'irgendwo ohne Postleitzahl')).toBeNull();
  });

  it('asks for the postcode when the address has none', () => {
    expect(deliveryAreaRefusal(['45219'], 'Hauptstr. 108, Essen')).toMatch(/Postleitzahl an/);
  });

  it('refuses a postcode outside the area, naming the area and pickup', () => {
    const refusal = deliveryAreaRefusal(['45219', '45239'], 'Teststraße 7, 45127 Essen');
    expect(refusal).toBe(
      'Nach 45127 liefern wir leider nicht. Wir liefern in die Postleitzahlen 45219, 45239. ' +
        'Abholung ist natürlich möglich.',
    );
  });
});

describe('PUT /api/admin/shop/delivery-area', () => {
  it('saves the area, and both the editor and the public shop serve it', async () => {
    const res = await setArea(['45239', '45219']);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<AdminShop>().profile.deliveryPostcodes).toEqual(['45219', '45239']);

    const pub = await app.inject({ method: 'GET', url: '/api/shop' });
    expect(pub.json<{ deliveryPostcodes: string[] }>().deliveryPostcodes).toEqual(['45219', '45239']);
  });

  it('refuses a malformed postcode and stores nothing', async () => {
    const res = await setArea(['45219', 'Kettwig']);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/„Kettwig“ ist keine Postleitzahl/);
    expect((await readShop()).profile.deliveryPostcodes).toEqual([]);
  });

  it('needs the owner credential', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/shop/delivery-area',
      payload: { postcodes: ['45219'], version: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('is undoable like every other shop write', async () => {
    const saved = await setArea(['45219']);
    expect(saved.statusCode, saved.body).toBe(200);
    const undone = await app.inject({
      method: 'POST',
      url: '/api/admin/shop/undo',
      headers: AUTH,
      payload: { version: saved.json<AdminShop>().version },
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json<AdminShop>().profile.deliveryPostcodes).toEqual([]);
  });
});

describe('orders against the delivery area', () => {
  it('with no area set, any delivery address is taken (as before)', async () => {
    await seedMargherita();
    expect((await order('delivery', 'Irgendwo 1, 10115 Berlin')).statusCode).toBe(200);
  });

  it('takes a delivery to a postcode in the area', async () => {
    await seedMargherita();
    await setArea(['45219', '45127']);
    const res = await order('delivery', 'Teststraße 7, 45127 Essen');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ order: Order }>().order.status).toBe('pending_payment');
  });

  it('refuses a delivery outside the area, before any order exists', async () => {
    await seedMargherita();
    await setArea(['45219']);
    const res = await order('delivery', 'Teststraße 7, 45127 Essen');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/Nach 45127 liefern wir leider nicht/);
  });

  it('refuses a delivery address with no postcode while an area is set', async () => {
    await seedMargherita();
    await setArea(['45219']);
    const res = await order('delivery', 'Hauptstr. 108, Essen');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/Postleitzahl an/);
  });

  it('never restricts a pickup', async () => {
    await seedMargherita();
    await setArea(['45219']);
    const res = await order('pickup', 'Irgendwo 1, 10115 Berlin');
    expect(res.statusCode, res.body).toBe(200);
  });
});
