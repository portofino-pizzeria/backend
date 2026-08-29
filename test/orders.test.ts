import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import type { Order } from '../src/types.js';
import { createTestApp } from './support/app';
import {
  deleteMenuItem,
  seedCategory,
  seedItem,
  updateMenuItem,
  updateMenuVariant,
} from './support/fixtures';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const KLEIN = 490;
const GROSS = 790;

/** "1 Margherita 4.90/7.90" — the shape most of the real menu has. */
async function seedMargherita(): Promise<void> {
  await seedCategory({ id: 'pizza', label: 'Pizza' });
  await seedItem({
    id: 'margherita',
    number: '1',
    name: 'Margherita',
    categoryId: 'pizza',
    variants: [
      { id: 'margherita-klein', label: 'klein', priceCents: KLEIN },
      { id: 'margherita-gross', label: 'groß', priceCents: GROSS },
    ],
  });
}

type OrderPayload = Record<string, unknown>;

function postOrder(payload: OrderPayload) {
  return app.inject({ method: 'POST', url: '/api/orders', payload });
}

async function createOrder(payload: OrderPayload): Promise<Order> {
  const res = await postOrder(payload);
  expect(res.statusCode).toBe(200);
  return res.json<{ order: Order }>().order;
}

async function readOrder(id: string): Promise<Order> {
  const res = await app.inject({ method: 'GET', url: `/api/orders/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json<{ order: Order }>().order;
}

describe('POST /api/orders — server-side pricing', () => {
  it('prices a groß variant at the groß price', async () => {
    await seedMargherita();

    const order = await createOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
      ],
    });

    expect(order.lines).toEqual([
      {
        menuItemId: 'margherita',
        variantId: 'margherita-gross',
        name: 'Margherita',
        variantLabel: 'groß',
        unitPrice: GROSS,
        quantity: 1,
      },
    ]);
    expect(order.subtotal).toBe(GROSS);
    expect(order.deliveryFee).toBe(config.deliveryFeeCents);
    expect(order.total).toBe(GROSS + config.deliveryFeeCents);
    expect(order.status).toBe('pending_payment');
  });

  it('prices a klein variant of the same item at the klein price', async () => {
    await seedMargherita();

    const order = await createOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-klein', quantity: 1 },
      ],
    });

    expect(order.lines[0].unitPrice).toBe(KLEIN);
    expect(order.lines[0].variantLabel).toBe('klein');
    expect(order.subtotal).toBe(KLEIN);
  });

  it('ignores a client-supplied price', async () => {
    await seedMargherita();

    const order = await createOrder({
      items: [
        {
          menuItemId: 'margherita',
          variantId: 'margherita-gross',
          quantity: 1,
          // A hostile or stale client sending its own numbers. The server must
          // read the price out of the database and nowhere else.
          unitPrice: 1,
          price: 1,
        },
      ],
      // ...and it must not be able to set the totals either.
      subtotal: 1,
      total: 1,
      deliveryFee: 0,
    });

    expect(order.lines[0].unitPrice).toBe(GROSS);
    expect(order.subtotal).toBe(GROSS);
    expect(order.deliveryFee).toBe(config.deliveryFeeCents);
    expect(order.total).toBe(GROSS + config.deliveryFeeCents);
  });

  it('multiplies by quantity and sums across lines', async () => {
    await seedMargherita();

    const order = await createOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 2 },
        { menuItemId: 'margherita', variantId: 'margherita-klein', quantity: 3 },
      ],
    });

    const expectedSubtotal = GROSS * 2 + KLEIN * 3;
    expect(order.lines).toHaveLength(2);
    expect(order.subtotal).toBe(expectedSubtotal);
    expect(order.total).toBe(expectedSubtotal + config.deliveryFeeCents);
  });

  it('keeps two sizes of the same item as two distinct lines', async () => {
    await seedMargherita();

    const order = await createOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-klein', quantity: 1 },
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
      ],
    });

    expect(order.lines.map((l) => l.variantLabel).sort()).toEqual([
      'groß',
      'klein',
    ]);
    expect(order.subtotal).toBe(KLEIN + GROSS);
  });
});

describe('POST /api/orders — refusals', () => {
  async function expectBadRequest(
    payload: OrderPayload,
    messageMatch: RegExp,
  ): Promise<void> {
    const res = await postOrder(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(messageMatch);
  }

  it('rejects an unknown variantId', async () => {
    await seedMargherita();

    await expectBadRequest(
      {
        items: [
          { menuItemId: 'margherita', variantId: 'gibt-es-nicht', quantity: 1 },
        ],
      },
      /Unknown variant/i,
    );
  });

  it('rejects a variantId that belongs to a different item', async () => {
    await seedMargherita();
    await seedItem({
      id: 'salami',
      name: 'Salami',
      categoryId: 'pizza',
      variants: [{ id: 'salami-gross', label: 'groß', priceCents: 990 }],
    });

    await expectBadRequest(
      {
        items: [
          { menuItemId: 'margherita', variantId: 'salami-gross', quantity: 1 },
        ],
      },
      /does not belong to/i,
    );
  });

  it('rejects a line with no variantId at the zod door', async () => {
    await seedMargherita();

    const res = await postOrder({
      items: [{ menuItemId: 'margherita', quantity: 1 }],
    });

    expect(res.statusCode).toBe(400);
    // The exact message the request schema carries — proof the rejection
    // happened at the door, before order-service was ever asked to price it.
    expect(res.json<{ error: string }>().error).toBe(
      'Each item needs a variantId (which size or variant is being ordered).',
    );
  });

  it('rejects an empty variantId', async () => {
    await seedMargherita();

    await expectBadRequest(
      { items: [{ menuItemId: 'margherita', variantId: '', quantity: 1 }] },
      /variantId/i,
    );
  });

  it('rejects an unknown menuItemId', async () => {
    await seedMargherita();

    await expectBadRequest(
      {
        items: [
          { menuItemId: 'gibt-es-nicht', variantId: 'margherita-gross', quantity: 1 },
        ],
      },
      /Unknown menu item/i,
    );
  });

  it('rejects an unavailable item', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza' });
    await seedItem({
      id: 'ausverkauft',
      name: 'Ausverkauft',
      categoryId: 'pizza',
      available: false,
      variants: [{ id: 'ausverkauft-gross', label: 'groß', priceCents: 790 }],
    });

    await expectBadRequest(
      {
        items: [
          {
            menuItemId: 'ausverkauft',
            variantId: 'ausverkauft-gross',
            quantity: 1,
          },
        ],
      },
      /currently unavailable/i,
    );
  });

  it('rejects an order with no lines', async () => {
    await seedMargherita();

    const res = await postOrder({ items: [] });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-positive quantity', async () => {
    await seedMargherita();

    const res = await postOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 0 },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('writes no order at all when one line is bad', async () => {
    await seedMargherita();

    const res = await postOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
        { menuItemId: 'margherita', variantId: 'gibt-es-nicht', quantity: 1 },
      ],
    });
    expect(res.statusCode).toBe(400);

    const kitchen = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders?scope=all',
    });
    expect(kitchen.statusCode).toBe(200);
    expect(kitchen.json<{ orders: Order[] }>().orders).toEqual([]);
  });
});

describe('GET /api/orders/:id', () => {
  it('returns a created order', async () => {
    await seedMargherita();
    const created = await createOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
      ],
      customer: { name: 'Anna', phone: '0201 5415883' },
    });

    const read = await readOrder(created.id);

    expect(read).toEqual(created);
    expect(read.customer).toEqual({ name: 'Anna', phone: '0201 5415883' });
  });

  it('404s an unknown order id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/orders/00000000-0000-0000-0000-000000000000',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('order lines are snapshots, not references', () => {
  it('keeps name, variantLabel and unitPrice after the menu is edited', async () => {
    await seedMargherita();
    const created = await createOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 2 },
      ],
    });

    // The owner edits the menu after the order was placed — exactly what the
    // Phase 4 editor will do, from a phone, after close.
    await updateMenuItem('margherita', { name: 'Margherita Speciale' });
    await updateMenuVariant('margherita-gross', {
      label: 'Familie',
      priceCents: 1590,
    });

    const read = await readOrder(created.id);

    expect(read.lines).toEqual([
      {
        menuItemId: 'margherita',
        variantId: 'margherita-gross',
        name: 'Margherita',
        variantLabel: 'groß',
        unitPrice: GROSS,
        quantity: 2,
      },
    ]);
    expect(read.subtotal).toBe(GROSS * 2);
    expect(read.total).toBe(GROSS * 2 + config.deliveryFeeCents);
  });

  it('survives the ordered item being deleted from the menu', async () => {
    await seedMargherita();
    const created = await createOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-klein', quantity: 1 },
      ],
    });

    // `order_lines.menu_item_id` / `variant_id` are not foreign keys on
    // purpose: removing a menu row must not rewrite or delete history.
    await deleteMenuItem('margherita');

    const read = await readOrder(created.id);

    expect(read.lines[0]).toMatchObject({
      name: 'Margherita',
      variantLabel: 'klein',
      unitPrice: KLEIN,
    });
  });
});
