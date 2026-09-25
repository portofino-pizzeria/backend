// `/checkout/return` with Stripe configured: the other confirmation path. The
// one network call it makes — retrieving the Checkout Session — is replaced by
// a stub, so what is under test is what the route does with Stripe's answer.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaidSession } from '../src/payments/stripe.js';
import type { Order } from '../src/types.js';
import { createTestApp } from './support/app';
import { withConfig } from './support/config';
import { VALID_CUSTOMER, seedCategory, seedItem } from './support/fixtures';

const retrieved = vi.hoisted(() => ({ session: null as PaidSession | null }));

vi.mock('../src/payments/stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/payments/stripe.js')>()),
  retrievePaidSession: async () => retrieved.session,
}));

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  retrieved.session = null;
});

const LIVE = { stripe: { secretKey: 'sk_test_dummy', webhookSecret: 'whsec_test_dummy' } };

beforeEach(async () => {
  await seedCategory({ id: 'pizza', label: 'Pizza' });
  await seedItem({
    id: 'margherita',
    name: 'Margherita',
    categoryId: 'pizza',
    variants: [{ id: 'margherita-klein', label: 'klein', priceCents: 490 }],
  });
});

async function placeOrder(): Promise<Order> {
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
  return res.json<{ order: Order }>().order.status;
}

function returnPage(orderId: string) {
  return withConfig(LIVE, () =>
    app.inject({
      method: 'GET',
      url: `/checkout/return?order_id=${orderId}&session_id=cs_test_session`,
    }),
  );
}

function paidFor(order: Order, over: Partial<PaidSession> = {}): PaidSession {
  return {
    sessionId: 'cs_test_session',
    orderId: order.id,
    amountTotal: order.total,
    currency: 'eur',
    ...over,
  };
}

describe('GET /checkout/return with Stripe configured', () => {
  it('confirms a session that paid the order in full', async () => {
    const order = await placeOrder();
    retrieved.session = paidFor(order);
    const res = await returnPage(order.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Zahlung erhalten');
    expect(await orderStatus(order.id)).toBe('paid');
  });

  it('still says paid when the same session already confirmed the order', async () => {
    const order = await placeOrder();
    retrieved.session = paidFor(order);
    await returnPage(order.id);
    const again = await returnPage(order.id);
    expect(again.body).toContain('Zahlung erhalten');
  });

  it('does not tell the diner "paid" for an order the kitchen cancelled', async () => {
    const order = await placeOrder();
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/kitchen/orders/${order.id}/status`,
      payload: { status: 'cancelled' },
    });
    expect(cancel.statusCode).toBe(200);
    retrieved.session = paidFor(order);
    const res = await returnPage(order.id);
    expect(res.body).not.toContain('Zahlung erhalten');
    expect(await orderStatus(order.id)).toBe('cancelled');
  });

  it('waits while Stripe does not report the session paid', async () => {
    const order = await placeOrder();
    const res = await returnPage(order.id);
    expect(res.body).toContain('Zahlung wird bestätigt');
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('refuses a paid session that belongs to a different order', async () => {
    const order = await placeOrder();
    const other = await placeOrder();
    retrieved.session = paidFor(other);
    const res = await returnPage(order.id);
    expect(res.body).toContain('Zahlung wird bestätigt');
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });

  it('refuses a session that paid less than the order total', async () => {
    const order = await placeOrder();
    retrieved.session = paidFor(order, { amountTotal: 1 });
    const res = await returnPage(order.id);
    expect(res.body).toContain('Zahlung wird bestätigt');
    expect(await orderStatus(order.id)).toBe('pending_payment');
  });
});
