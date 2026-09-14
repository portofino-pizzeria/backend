// Lieferung / Abholung, and the opening hours an order is checked against.
// The clock is pinned to Wednesday 18:00 in Essen by ./support/setup unless a
// test moves it.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import { setNowForTests } from '../src/lib/clock.js';
import type { Order } from '../src/types.js';
import { createTestApp } from './support/app';
import { seedCategory, seedItem, VALID_CUSTOMER } from './support/fixtures';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const GROSS = 790;
const LINE = [{ menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 }];
const PICKUP_CUSTOMER = { name: 'Anna Beispiel', phone: '0201 5415883' };

async function seedMargherita(): Promise<void> {
  await seedCategory({ id: 'pizza', label: 'Pizza' });
  await seedItem({
    id: 'margherita',
    number: '1',
    name: 'Margherita',
    categoryId: 'pizza',
    variants: [{ id: 'margherita-gross', label: 'groß', priceCents: GROSS }],
  });
}

function postOrder(payload: Record<string, unknown>) {
  const body = 'customer' in payload ? payload : { ...payload, customer: VALID_CUSTOMER };
  return app.inject({ method: 'POST', url: '/api/orders', payload: body });
}

async function createOrder(payload: Record<string, unknown>): Promise<Order> {
  const res = await postOrder(payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ order: Order }>().order;
}

describe('Lieferung / Abholung', () => {
  it('a pickup pays no delivery fee and needs no address', async () => {
    await seedMargherita();
    const order = await createOrder({ fulfilment: 'pickup', items: LINE, customer: PICKUP_CUSTOMER });
    expect(order.fulfilment).toBe('pickup');
    expect(order.deliveryFee).toBe(0);
    expect(order.total).toBe(GROSS);
    expect(order.customer?.address).toBeUndefined();
  });

  it('a pickup stores no address even when one is sent', async () => {
    await seedMargherita();
    const order = await createOrder({ fulfilment: 'pickup', items: LINE, customer: VALID_CUSTOMER });
    expect(order.customer?.address).toBeUndefined();
  });

  it('an order without `fulfilment` is a delivery, as every order was before', async () => {
    await seedMargherita();
    const order = await createOrder({ items: LINE });
    expect(order.fulfilment).toBe('delivery');
    expect(order.deliveryFee).toBe(config.deliveryFeeCents);
    expect(order.total).toBe(GROSS + config.deliveryFeeCents);
  });

  it('a delivery still requires an address', async () => {
    await seedMargherita();
    const res = await postOrder({ fulfilment: 'delivery', items: LINE, customer: PICKUP_CUSTOMER });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bitte eine Lieferadresse angeben.');
  });

  it('a delivery refuses an address of only invisible characters', async () => {
    await seedMargherita();
    const res = await postOrder({
      fulfilment: 'delivery',
      items: LINE,
      customer: { ...PICKUP_CUSTOMER, address: '​ ㅤ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bitte eine Lieferadresse angeben.');
  });

  it('a pickup still requires a phone number', async () => {
    await seedMargherita();
    const res = await postOrder({ fulfilment: 'pickup', items: LINE, customer: { name: 'Anna Beispiel' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bitte eine Telefonnummer angeben.');
  });

  it('refuses an unknown fulfilment in German', async () => {
    await seedMargherita();
    const res = await postOrder({ fulfilment: 'drone', items: LINE });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bitte Lieferung oder Abholung wählen.');
  });

  it('a pickup-only offer cannot be delivered, and can be collected', async () => {
    await seedCategory({ id: 'angebote', label: 'Angebote' });
    await seedItem({
      id: 'mittwochs-angebot-1',
      name: 'Mittwochs-Angebot 1',
      categoryId: 'angebote',
      pickupOnly: true,
      variants: [{ id: 'mittwochs-angebot-1-normal', label: 'normal', priceCents: 890 }],
    });
    const items = [{ menuItemId: 'mittwochs-angebot-1', variantId: 'mittwochs-angebot-1-normal', quantity: 1 }];
    const refused = await postOrder({ fulfilment: 'delivery', items });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe(
      'Mittwochs-Angebot 1 gibt es nur für Selbstabholer. Bitte Abholung wählen.',
    );
    const ok = await createOrder({ fulfilment: 'pickup', items, customer: PICKUP_CUSTOMER });
    expect(ok.total).toBe(890);
  });

  it('the public menu marks a pickup-only item, and only that one', async () => {
    await seedItem({ id: 'nur-abholung', name: 'Nur Abholung', pickupOnly: true });
    await seedItem({ id: 'normal', name: 'Normal' });
    const res = await app.inject({ method: 'GET', url: '/api/menu' });
    const items = res.json().items as { id: string; pickupOnly?: boolean }[];
    expect(items.find((i) => i.id === 'nur-abholung')?.pickupOnly).toBe(true);
    expect(items.find((i) => i.id === 'normal')?.pickupOnly).toBeUndefined();
  });
});

describe('pickup and the address field', () => {
  it('a pickup that sends address: null is accepted', async () => {
    await seedMargherita();
    const order = await createOrder({
      fulfilment: 'pickup',
      items: LINE,
      customer: { ...PICKUP_CUSTOMER, address: null },
    });
    expect(order.fulfilment).toBe('pickup');
  });

  it('a pickup is not refused for an over-long address it discards', async () => {
    await seedMargherita();
    const order = await createOrder({
      fulfilment: 'pickup',
      items: LINE,
      customer: { ...PICKUP_CUSTOMER, address: 'x'.repeat(501) },
    });
    expect(order.customer?.address).toBeUndefined();
  });

  it('a delivery is still refused for an over-long address', async () => {
    await seedMargherita();
    const res = await postOrder({
      fulfilment: 'delivery',
      items: LINE,
      customer: { ...PICKUP_CUSTOMER, address: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Die Lieferadresse ist zu lang (höchstens 500 Zeichen).');
  });
});

describe('opening hours at payment time', () => {
  it('refuses to start payment for a delivery created before 22:00 once 22:00 has passed', async () => {
    await seedMargherita();
    setNowForTests(new Date('2026-09-16T19:59:00Z')); // Wednesday 21:59
    const order = await createOrder({ fulfilment: 'delivery', items: LINE });
    setNowForTests(new Date('2026-09-16T20:20:00Z')); // Wednesday 22:20
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/checkout',
      payload: { orderId: order.id, provider: 'mock' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Lieferungen nehmen wir heute nur bis 22:00 Uhr an.');
  });

  it('still starts payment for a pickup at 22:20', async () => {
    await seedMargherita();
    setNowForTests(new Date('2026-09-16T20:20:00Z'));
    const order = await createOrder({ fulfilment: 'pickup', items: LINE, customer: PICKUP_CUSTOMER });
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/checkout',
      payload: { orderId: order.id, provider: 'mock' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('opening hours at order time', () => {
  it('refuses every order on the Tuesday Ruhetag, naming when to come back', async () => {
    await seedMargherita();
    setNowForTests(new Date('2026-09-15T16:00:00Z'));
    for (const fulfilment of ['delivery', 'pickup']) {
      const res = await postOrder({ fulfilment, items: LINE });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(
        'Wir haben gerade geschlossen und nehmen keine Bestellungen an. Wieder möglich ab Mittwoch, 12:00 Uhr.',
      );
    }
  });

  it('after 22:00 refuses a delivery but takes a pickup', async () => {
    await seedMargherita();
    setNowForTests(new Date('2026-09-16T20:15:00Z')); // Wednesday 22:15
    const delivery = await postOrder({ fulfilment: 'delivery', items: LINE });
    expect(delivery.statusCode).toBe(400);
    expect(delivery.json().error).toContain('Lieferungen nehmen wir heute nur bis 22:00 Uhr an.');
    const pickup = await postOrder({ fulfilment: 'pickup', items: LINE, customer: PICKUP_CUSTOMER });
    expect(pickup.statusCode).toBe(200);
  });

  it('writes nothing when it refuses', async () => {
    await seedMargherita();
    setNowForTests(new Date('2026-09-15T16:00:00Z'));
    await postOrder({ fulfilment: 'pickup', items: LINE, customer: PICKUP_CUSTOMER });
    const res = await app.inject({ method: 'GET', url: '/api/kitchen/orders?scope=all' });
    expect(res.json().orders).toEqual([]);
  });

  it('the kitchen sees how each order is fulfilled', async () => {
    await seedMargherita();
    await createOrder({ fulfilment: 'pickup', items: LINE, customer: PICKUP_CUSTOMER });
    const res = await app.inject({ method: 'GET', url: '/api/kitchen/orders?scope=all' });
    expect(res.json().orders[0].fulfilment).toBe('pickup');
  });
});
