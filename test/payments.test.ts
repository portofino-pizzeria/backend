// The hosted-checkout result pages: `/checkout/mock`, `/checkout/return` and
// `/checkout/cancel`. On the web's same-tab payment path the page IS the app's
// tab, so its one link has to lead back to the order the diner just paid for —
// in German, and without ever reflecting query input it has not validated.

import { readFile } from 'node:fs/promises';

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

/** The same, keeping the access token D3 returns alongside the order. */
async function placeOrderWithToken(): Promise<{ order: Order; accessToken: string }> {
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
  return res.json<{ order: Order; accessToken: string }>();
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

// ---------------------------------------------------------------------------
// D3's inverse gate: the payment return path must NOT carry the order access
// token.
//
// An earlier draft of the plan had the return URL carry it, so the page a diner
// lands on after paying would show their own details. That would hand the
// capability to Stripe, to the backend's own request log and to browser history
// — recreating exactly the leak D3 closes. The diner's device already holds the
// token from the `POST /api/orders` response, so it needs no help from the
// redirect.
// ---------------------------------------------------------------------------

describe('the payment return path carries no order access token (D3)', () => {
  it('keeps the token out of every result page and its links', async () => {
    const { order, accessToken } = await placeOrderWithToken();

    const pages = await Promise.all(
      [
        `/checkout/mock?order_id=${order.id}`,
        `/checkout/cancel?order_id=${order.id}`,
        `/checkout/return?order_id=${order.id}&session_id=cs_test_x`,
      ].map((url) => withConfig({ publicWebUrl: WEB }, () => get(url))),
    );

    for (const res of pages) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(accessToken);
      // Not just the literal value — no token-shaped parameter at all.
      expect(res.body).not.toMatch(/access[_-]?token/i);
    }
  });

  it("builds Stripe's success and cancel URLs from the order id alone", async () => {
    // Stripe is disabled under test, so `createStripeCheckout` cannot be
    // driven end to end here without a network call. What can be asserted, and
    // what would actually regress, is the shape of the two URLs it builds: read
    // the module and check that neither one grew a token parameter.
    const source = await readFile(
      new URL('../src/payments/stripe.ts', import.meta.url),
      'utf8',
    );

    const successUrl = /success_url:\s*`([^`]*)`/.exec(source)?.[1];
    const cancelUrl = /cancel_url:\s*`([^`]*)`/.exec(source)?.[1];

    expect(successUrl).toBe(
      '${base}/checkout/return?order_id=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}',
    );
    expect(cancelUrl).toBe(
      '${base}/checkout/cancel?order_id=${encodeURIComponent(order.id)}',
    );
    // And the module never reaches for the capability at all.
    expect(source).not.toMatch(/accessToken|access_token/);
  });
});
