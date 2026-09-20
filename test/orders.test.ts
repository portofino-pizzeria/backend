import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import { sql } from '../src/db/client.js';
import type { Order } from '../src/types.js';
import { createTestApp } from './support/app';
import {
  deleteMenuItem,
  VALID_CUSTOMER,
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

/**
 * Posts an order, supplying VALID_CUSTOMER unless the payload names its own
 * `customer` key — including an explicit `undefined`, which is how a test asks
 * for the customer to be absent. See VALID_CUSTOMER for why the default exists.
 */
function postOrder(payload: OrderPayload) {
  const body = 'customer' in payload ? payload : { ...payload, customer: VALID_CUSTOMER };
  return app.inject({ method: 'POST', url: '/api/orders', payload: body });
}

/** The whole `POST /api/orders` body — the one place the access token (D3) is served. */
async function placeOrder(
  payload: OrderPayload,
): Promise<{ order: Order; accessToken: string }> {
  const res = await postOrder(payload);
  expect(res.statusCode).toBe(200);
  return res.json<{ order: Order; accessToken: string }>();
}

async function createOrder(payload: OrderPayload): Promise<Order> {
  return (await placeOrder(payload)).order;
}

/**
 * Read an order back. With no `accessToken` this is the tokenless read every
 * pre-D3 client makes — the non-personal shape. Pass the token to get the
 * customer block.
 */
async function readOrder(id: string, accessToken?: string): Promise<Order> {
  const res = await getOrderRaw(id, accessToken);
  expect(res.statusCode).toBe(200);
  return res.json<{ order: Order }>().order;
}

function getOrderRaw(id: string, accessToken?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/orders/${id}`,
    ...(accessToken === undefined
      ? {}
      : { headers: { authorization: `Bearer ${accessToken}` } }),
  });
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

describe('POST /api/orders requires contact details', () => {
  // Every order is a delivery. Before this rule an order with no name, phone
  // or address was accepted, confirmed to the diner and sent to the kitchen as
  // a blank card nobody could deliver or call about.
  const oneLine = {
    items: [{ menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 }],
  };

  async function rejection(customer: unknown): Promise<string> {
    await seedMargherita();
    const res = await postOrder({ ...oneLine, customer });
    expect(res.statusCode).toBe(400);
    return res.json<{ error: string }>().error;
  }

  it('refuses an order with no customer block at all', async () => {
    expect(await rejection(undefined)).toBe(
      'Bitte Name, Telefonnummer und Lieferadresse angeben.',
    );
  });

  it.each([
    ['name', 'Bitte einen Namen angeben.'],
    ['phone', 'Bitte eine Telefonnummer angeben.'],
    ['address', 'Bitte eine Lieferadresse angeben.'],
  ] as const)('refuses a missing %s', async (field, message) => {
    const { [field]: _omitted, ...rest } = VALID_CUSTOMER;
    expect(await rejection(rest)).toBe(message);
  });

  // Exact messages, not a prefix match: a whitespace-only phone also trips the
  // digit rule, and only the FIRST issue surfaces, so a /^Bitte / assertion
  // would pass on the wrong one.
  const MISSING = {
    name: 'Bitte einen Namen angeben.',
    phone: 'Bitte eine Telefonnummer angeben.',
    address: 'Bitte eine Lieferadresse angeben.',
  } as const;

  it.each(['name', 'phone', 'address'] as const)(
    'refuses a %s that is only whitespace',
    async (field) => {
      expect(await rejection({ ...VALID_CUSTOMER, [field]: '   ' })).toBe(MISSING[field]);
    },
  );

  it.each(['name', 'address'] as const)(
    'refuses a %s made only of zero-width characters',
    async (field) => {
      // trim() keeps these, and they render as nothing on the kitchen card.
      const invisible = String.fromCodePoint(0x200b, 0x200d, 0x2060);
      expect(await rejection({ ...VALID_CUSTOMER, [field]: invisible })).toBe(MISSING[field]);
    },
  );

  // Two rules, each with inputs only IT decides:
  //  - stripped by INVISIBLE: soft hyphen, invisible separator, and the Hangul
  //    filler — a LETTER by category, so the readability rule would accept it;
  //  - NOT in INVISIBLE, caught only by the letter-or-digit rule: the Mongolian
  //    vowel separator (a format character trim() keeps) and a lone combining
  //    grapheme joiner.
  it.each([
    ['name', 0x00ad],
    ['name', 0x2063],
    ['address', 0x3164],
    ['name', 0x180e],
    ['address', 0x034f],
  ] as const)('refuses a %s that renders as nothing (code point %s)', async (field, codePoint) => {
    expect(
      await rejection({ ...VALID_CUSTOMER, [field]: String.fromCodePoint(codePoint) }),
    ).toBe(MISSING[field]);
  });

  // Boundaries, so a changed threshold goes red.
  it('refuses a phone number with 5 digits', async () => {
    expect(await rejection({ ...VALID_CUSTOMER, phone: '12 34 5' })).toBe(
      'Bitte eine gültige Telefonnummer angeben.',
    );
  });

  it('accepts a phone number with exactly 6 digits, and fields at their length limits', async () => {
    await seedMargherita();
    const order = await createOrder({
      ...oneLine,
      customer: { name: 'A'.repeat(200), phone: '12 34 56', address: 'B'.repeat(500) },
    });
    expect(order.customer?.phone).toBe('12 34 56');
    expect(order.customer?.name).toHaveLength(200);
    expect(order.customer?.address).toHaveLength(500);
  });

  it('answers a null customer block in German, like a missing one', async () => {
    expect(await rejection(null)).toBe('Bitte Name, Telefonnummer und Lieferadresse angeben.');
  });

  // One rejection per case: rejection() seeds the menu, and the database is
  // reset per test rather than per call.
  it.each([
    ['name', null],
    ['phone', 12345678],
  ] as const)('answers a wrong-typed %s in German', async (field, value) => {
    expect(await rejection({ ...VALID_CUSTOMER, [field]: value })).toBe(MISSING[field]);
  });

  it.each([
    ['name', 201, 'Der Name ist zu lang (höchstens 200 Zeichen).'],
    ['phone', 51, 'Die Telefonnummer ist zu lang (höchstens 50 Zeichen).'],
    ['address', 501, 'Die Lieferadresse ist zu lang (höchstens 500 Zeichen).'],
  ] as const)('answers an over-long %s in German', async (field, length, message) => {
    expect(await rejection({ ...VALID_CUSTOMER, [field]: '1'.repeat(length) })).toBe(message);
  });

  it.each(['+49 …', '0201', '12-34'])(
    'refuses a phone number with too few digits (%j)',
    async (phone) => {
      expect(await rejection({ ...VALID_CUSTOMER, phone })).toBe(
        'Bitte eine gültige Telefonnummer angeben.',
      );
    },
  );

  it('writes nothing for a refused order', async () => {
    await rejection({ ...VALID_CUSTOMER, address: '' });
    const kitchen = await app.inject({ method: 'GET', url: '/api/kitchen/orders?scope=all' });
    expect(kitchen.json<{ orders: Order[] }>().orders).toEqual([]);
  });

  it('accepts a complete customer and stores the values cleaned and trimmed', async () => {
    await seedMargherita();
    const order = await createOrder({
      ...oneLine,
      customer: {
        name: `  Anna${String.fromCodePoint(0x200b)}  `,
        phone: ' +49 201 5415883 ',
        address: ' Teststraße 7 ',
      },
    });
    expect(order.customer).toEqual({
      name: 'Anna',
      phone: '+49 201 5415883',
      address: 'Teststraße 7',
    });
  });
});

describe('GET /api/orders/:id', () => {
  it('returns a created order to a caller holding its access token', async () => {
    await seedMargherita();
    const { order: created, accessToken } = await placeOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
      ],
      customer: { name: 'Anna', phone: '0201 5415883', address: 'Teststraße 7, 45127 Essen' },
    });

    const read = await readOrder(created.id, accessToken);

    expect(read).toEqual(created);
    expect(read.customer).toEqual({
      name: 'Anna',
      phone: '0201 5415883',
      address: 'Teststraße 7, 45127 Essen',
    });
    expect(read.customerRedacted).toBeUndefined();
  });

  it('404s an unknown order id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/orders/00000000-0000-0000-0000-000000000000',
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// D3 — the order read stops handing out personal data.
//
// Before this, `GET /api/orders/:id` was unauthenticated and returned the name,
// phone number and delivery address to anyone holding the order link — and the
// link travels through Stripe metadata, the payment return URL and browser
// history. The id stays an identifier; the access token is the capability.
// ---------------------------------------------------------------------------

describe('GET /api/orders/:id — the access token (D3)', () => {
  const ANNA = {
    name: 'Anna',
    phone: '0201 5415883',
    address: 'Teststraße 7, 45127 Essen',
    notes: 'Bitte zweimal klingeln',
  };

  async function annasOrder() {
    await seedMargherita();
    return placeOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
      ],
      customer: ANNA,
    });
  }

  it('mints a fresh, high-entropy token per order and returns it once', async () => {
    const first = await annasOrder();
    const second = await placeOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
      ],
      customer: ANNA,
    });

    expect(first.accessToken).toEqual(expect.any(String));
    // 32 bytes, base64url: 43 characters, no padding, no `+` or `/`.
    expect(first.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.accessToken).not.toBe(first.accessToken);
    // The token is not the id, and the id is not the token.
    expect(first.accessToken).not.toBe(first.order.id);
  });

  it('withholds the customer block without a token, and SAYS it withheld it', async () => {
    const { order } = await annasOrder();

    const read = await readOrder(order.id);

    expect(read.customer).toBeUndefined();
    expect(read.customerRedacted).toBe(true);
    // Everything non-personal is still there — this is a degradation, not a
    // refusal. The order screen must still render status, lines and totals.
    expect(read.id).toBe(order.id);
    expect(read.status).toBe('pending_payment');
    expect(read.fulfilment).toBe('delivery');
    expect(read.lines).toEqual(order.lines);
    expect(read.subtotal).toBe(order.subtotal);
    expect(read.deliveryFee).toBe(order.deliveryFee);
    expect(read.total).toBe(order.total);
    expect(read.createdAt).toBe(order.createdAt);
  });

  it('never serialises the token itself into the order shape', async () => {
    const { order, accessToken } = await annasOrder();

    const withToken = await readOrder(order.id, accessToken);
    const withoutToken = await readOrder(order.id);

    expect(JSON.stringify(withToken)).not.toContain(accessToken);
    expect(JSON.stringify(withoutToken)).not.toContain(accessToken);
    expect(JSON.stringify(order)).not.toContain(accessToken);
  });

  it('refuses a token that is presented and wrong', async () => {
    const { order } = await annasOrder();

    const res = await getOrderRaw(order.id, 'not-the-right-token-at-all-0000000000000');

    expect(res.statusCode).toBe(401);
    // And it does not leak the block on the way out.
    expect(res.body).not.toContain('Teststraße');
    expect(res.body).not.toContain('0201 5415883');
  });

  it("refuses another order's token", async () => {
    const mine = await annasOrder();
    const theirs = await placeOrder({
      items: [
        { menuItemId: 'margherita', variantId: 'margherita-gross', quantity: 1 },
      ],
      customer: ANNA,
    });

    const res = await getOrderRaw(mine.order.id, theirs.accessToken);

    expect(res.statusCode).toBe(401);
  });

  it('treats a malformed or empty Authorization header as "no token", not a wrong one', async () => {
    const { order } = await annasOrder();

    // A proxy that strips or mangles the header must degrade to the redacted
    // read, not break the order screen with a 401.
    for (const authorization of ['', 'Bearer ', 'Bearer    ', 'Basic abc', 'garbage']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/orders/${order.id}`,
        headers: { authorization },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ order: Order }>().order.customerRedacted).toBe(true);
    }
  });

  it('still 404s an unknown id, with or without a token', async () => {
    const { accessToken } = await annasOrder();
    const unknown = '00000000-0000-0000-0000-000000000000';

    expect((await getOrderRaw(unknown)).statusCode).toBe(404);
    expect((await getOrderRaw(unknown, accessToken)).statusCode).toBe(404);
  });

  it('stores the token the API accepts, under a NOT NULL column', async () => {
    const { order, accessToken } = await annasOrder();

    const [column] = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_name = 'orders' and column_name = 'access_token'
    `;
    // NOT NULL is what makes "every order has a capability" a schema fact
    // rather than a hope — the migration backfills before it adds this.
    expect(column?.is_nullable).toBe('NO');

    const [row] = await sql<{ access_token: string }[]>`
      select access_token from orders where id = ${order.id}
    `;
    expect(row.access_token).toBe(accessToken);
  });

  // The migration's real backfill — against a table that already has orders —
  // lives in `test/migration-backfill.test.ts`, which stands up a scratch
  // database for it. The suite's own database is created empty, so nothing
  // here could exercise it.

  it('serves the token from POST and from nowhere else', async () => {
    const { order, accessToken } = await annasOrder();

    // Every other surface that serves this order, in one place. If any of them
    // ever starts echoing the capability, this fails.
    const elsewhere = await Promise.all([
      getOrderRaw(order.id),
      getOrderRaw(order.id, accessToken),
      app.inject({ method: 'GET', url: '/api/kitchen/orders?scope=all' }),
      app.inject({
        method: 'POST',
        url: '/api/payments/checkout',
        payload: { orderId: order.id, provider: 'mock' },
      }),
      app.inject({ method: 'GET', url: `/checkout/mock?order_id=${order.id}` }),
      app.inject({ method: 'GET', url: `/checkout/cancel?order_id=${order.id}` }),
    ]);

    for (const res of elsewhere) {
      // The status assertion is what stops this guard passing vacuously: if
      // the kitchen board started 401ing, or checkout started 400ing on the
      // opening hours, an error body trivially "does not contain" the token
      // and the guard would silently stop guarding.
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(accessToken);
    }
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
