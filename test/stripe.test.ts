// Stripe is live: the mock checkout must be unreachable, and the webhook must
// only mark an order paid once Stripe says the money has arrived.
//
// No network is involved. Every case here either refuses before Stripe is
// called, or feeds the webhook an event signed locally with the same helper
// Stripe's own SDK tests use (`generateTestHeaderString`).

import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
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

const LIVE = { stripe: { secretKey: 'sk_test_dummy', webhookSecret: 'whsec_test_dummy' } };

function live<T>(run: () => Promise<T>): Promise<T> {
  return withConfig(LIVE, run);
}

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

describe('with Stripe configured, the mock cannot confirm a payment', () => {
  it('GET /checkout/mock is gone and the order stays unpaid', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      app.inject({ method: 'GET', url: `/checkout/mock?order_id=${order.id}` }),
    );
    expect(res.statusCode).toBe(404);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it.each(['mock', 'paypal'] as const)(
    'POST /api/payments/checkout refuses provider %s',
    async (provider) => {
      const order = await placeOrder();
      const res = await live(() =>
        app.inject({
          method: 'POST',
          url: '/api/payments/checkout',
          payload: { orderId: order.id, provider },
        }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('/checkout/mock');
      expect(await orderStatus(order.id)).toBe('pending_payment');
    },
  );

  it('providers reports no mock fallback', async () => {
    const res = await live(() => app.inject({ method: 'GET', url: '/api/payments/providers' }));
    expect(res.json()).toEqual({ stripe: true, paypal: false, mockFallback: false });
  });

  it('without Stripe the mock fallback is still offered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/payments/providers' });
    expect(res.json()).toEqual({ stripe: false, paypal: false, mockFallback: true });
  });
});

async function payment(id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/orders/${id}` });
  return res.json<{ order: Order }>().order.payment;
}

async function cancel(id: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/kitchen/orders/${id}/status`,
    payload: { status: 'cancelled' },
  });
  expect(res.statusCode).toBe(200);
}

describe('POST /webhooks/stripe', () => {
  interface SessionShape {
    orderId?: string;
    clientReferenceId?: string;
    paymentStatus?: 'paid' | 'unpaid';
    amountTotal?: number;
    currency?: string;
  }

  /** A signed-able event for a Checkout Session paying `order` in full. */
  function sessionEvent(type: string, order: Order, over: SessionShape = {}): string {
    const orderId = 'orderId' in over ? over.orderId : order.id;
    return JSON.stringify({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      object: 'event',
      type,
      data: {
        object: {
          id: 'cs_test_session',
          object: 'checkout.session',
          client_reference_id: over.clientReferenceId ?? orderId ?? null,
          metadata: orderId ? { orderId } : {},
          payment_status: over.paymentStatus ?? 'paid',
          amount_total: over.amountTotal ?? order.total,
          currency: over.currency ?? 'eur',
        },
      },
    });
  }

  function deliver(payload: string, secret = LIVE.stripe.webhookSecret) {
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    return app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });
  }

  it('marks the order paid on a completed, paid session, referenced by session id', async () => {
    const order = await placeOrder();
    const res = await live(() => deliver(sessionEvent('checkout.session.completed', order)));
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('paid');
    expect((await payment(order.id))?.reference).toBe('cs_test_session');
  });

  it('does NOT mark it paid while a delayed payment is still unpaid', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      deliver(sessionEvent('checkout.session.completed', order, { paymentStatus: 'unpaid' })),
    );
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('marks it paid when the delayed payment succeeds', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      deliver(sessionEvent('checkout.session.async_payment_succeeded', order)),
    );
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('paid');
  });

  it('acknowledges a failed delayed payment and leaves the order unpaid', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      deliver(sessionEvent('checkout.session.async_payment_failed', order, { paymentStatus: 'unpaid' })),
    );
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('refuses a session that paid less than the order total', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      deliver(sessionEvent('checkout.session.completed', order, { amountTotal: order.total - 1 })),
    );
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('refuses a session in another currency', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      deliver(sessionEvent('checkout.session.completed', order, { currency: 'usd' })),
    );
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('refuses a session naming the order only by client_reference_id (a Payment Link)', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      deliver(
        sessionEvent('checkout.session.completed', order, {
          orderId: undefined,
          clientReferenceId: order.id,
        }),
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('leaves a cancelled order cancelled when payment arrives late', async () => {
    const order = await placeOrder();
    await cancel(order.id);
    const res = await live(() => deliver(sessionEvent('checkout.session.completed', order)));
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('cancelled');
  });

  it('answers 400 to a bad signature and changes nothing', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      deliver(sessionEvent('checkout.session.completed', order), 'whsec_wrong'),
    );
    expect(res.statusCode).toBe(400);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('answers 503 while the webhook secret is missing, and accepts the same event once it is set', async () => {
    const order = await placeOrder();
    const payload = sessionEvent('checkout.session.completed', order);
    const res = await withConfig(
      { stripe: { secretKey: LIVE.stripe.secretKey, webhookSecret: '' } },
      () => deliver(payload),
    );
    expect(res.statusCode).toBe(503);
    expect(await orderStatus(order.id)).toBe('pending_payment');

    // Once wired, the SAME redelivered event confirms the order.
    expect((await live(() => deliver(payload))).statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('paid');
  });

  it('answers 503 before looking at the signature, which cannot be checked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(503);
  });

  it('answers 503 with no Stripe key at all', async () => {
    const order = await placeOrder();
    const res = await deliver(sessionEvent('checkout.session.completed', order));
    expect(res.statusCode).toBe(503);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('acknowledges an event for an order it never issued', async () => {
    const order = await placeOrder();
    const res = await live(() =>
      deliver(
        sessionEvent('checkout.session.completed', order, {
          orderId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });
});
