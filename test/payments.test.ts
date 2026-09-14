// The hosted-checkout result pages: `/checkout/mock`, `/checkout/return` and
// `/checkout/cancel`. On the web's same-tab payment path the page IS the app's
// tab, so its one link has to lead back to the order the diner just paid for —
// in German, and without ever reflecting query input it has not validated.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Order } from '../src/types.js';
import { createTestApp } from './support/app';
import { withConfig } from './support/config';
import { VALID_CUSTOMER, seedCategory, seedItem } from './support/fixtures';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const WEB = 'https://web.example';

/** Place a real order through the API, so its id is one the service issued. */
async function placeOrder(): Promise<Order> {
  await seedCategory({ id: 'pizza', label: 'Pizza' });
  await seedItem({
    id: 'margherita',
    name: 'Margherita',
    categoryId: 'pizza',
    variants: [{ id: 'margherita-klein', label: 'klein', priceCents: 490 }],
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/orders',
    payload: {
      items: [{ menuItemId: 'margherita', variantId: 'margherita-klein', quantity: 1 }],
      customer: VALID_CUSTOMER,
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ order: Order }>().order;
}

async function orderStatus(id: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/api/orders/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json<{ order: Order }>().order.status;
}

function get(url: string) {
  return app.inject({ method: 'GET', url });
}

describe('GET /checkout/mock', () => {
  it('confirms the order and links to it, in German', async () => {
    const order = await placeOrder();

    const res = await withConfig({ publicWebUrl: WEB }, () =>
      get(`/checkout/mock?order_id=${order.id}`),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('<html lang="de">');
    expect(res.body).toContain('Testzahlung abgeschlossen');
    expect(res.body).toContain(`href="${WEB}/order/${order.id}"`);
    expect(res.body).toContain('Zu deiner Bestellung');
    expect(await orderStatus(order.id)).toBe('paid');
  });

  it('offers no link when no web app is configured', async () => {
    const order = await placeOrder();

    const res = await withConfig({ publicWebUrl: '' }, () =>
      get(`/checkout/mock?order_id=${order.id}`),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<a');
    expect(res.body).toContain('Du kannst dieses Fenster jetzt schließen.');
  });

  it('does not double the slash when the web URL ends in one', async () => {
    const order = await placeOrder();

    const res = await withConfig({ publicWebUrl: `${WEB}/` }, () =>
      get(`/checkout/mock?order_id=${order.id}`),
    );

    expect(res.body).toContain(`href="${WEB}/order/${order.id}"`);
    expect(res.body).not.toContain('//order/');
  });
});

describe('GET /checkout/cancel', () => {
  it('links to the still-unpaid order', async () => {
    const order = await placeOrder();

    const res = await withConfig({ publicWebUrl: WEB }, () =>
      get(`/checkout/cancel?order_id=${order.id}`),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Bezahlung abgebrochen');
    expect(res.body).toContain(`href="${WEB}/order/${order.id}"`);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('still renders, without a link, when no order id is sent', async () => {
    const res = await withConfig({ publicWebUrl: WEB }, () => get('/checkout/cancel'));

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Bezahlung abgebrochen');
    expect(res.body).not.toContain('<a');
  });

  it('never reflects an order id that is not one the API issues', async () => {
    const hostile = '"><script>alert(1)</script>';

    const res = await withConfig({ publicWebUrl: WEB }, () =>
      get(`/checkout/cancel?order_id=${encodeURIComponent(hostile)}`),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Bezahlung abgebrochen');
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain(hostile);
    expect(res.body).not.toContain('<a');
  });

  it('offers no link for an id that only starts like one', async () => {
    const order = await placeOrder();

    for (const nearMiss of [`${order.id}x`, `${order.id}\n`, `x${order.id}`]) {
      const res = await withConfig({ publicWebUrl: WEB }, () =>
        get(`/checkout/cancel?order_id=${encodeURIComponent(nearMiss)}`),
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('<a');
    }
  });
});

describe('missing parameters', () => {
  it('still answers 400 on /checkout/mock and /checkout/return', async () => {
    expect((await get('/checkout/mock')).statusCode).toBe(400);
    expect((await get('/checkout/return?session_id=cs_test_x')).statusCode).toBe(400);
  });
});

describe('GET /checkout/return', () => {
  it('links to the order while the payment is still being confirmed', async () => {
    // Stripe is disabled under test (test/support/env.ts), so the session can
    // never be confirmed here and the page takes its "not yet" branch.
    const order = await placeOrder();

    const res = await withConfig({ publicWebUrl: WEB }, () =>
      get(`/checkout/return?order_id=${order.id}&session_id=cs_test_x`),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Zahlung wird bestätigt');
    expect(res.body).toContain(`href="${WEB}/order/${order.id}"`);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });
});
