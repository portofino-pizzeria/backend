// D5 — the owner's data-subject surface.
//
// `/api/admin/orders/search`, `/api/admin/orders/:id/personal-data` and
// `/api/admin/orders/:id/forget`, behind the owner's existing credential.
//
// The property that matters most here is the one `forget` must NOT break:
// erasing a diner's contact details keeps the order, its lines and its totals,
// so the books survive an Art. 17 request and the kitchen board degrades to a
// state it already has rather than to a hole.

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db, sql } from '../src/db/client.js';
import { orderLines, orders } from '../src/db/schema.js';
import { setNowForTests } from '../src/lib/clock.js';
import { newOrderAccessToken } from '../src/lib/order-service.js';
import type { Order, OrderStatus } from '../src/types.js';
import { createTestApp } from './support/app';
import { TEST_OWNER_MENU_TOKEN } from './support/env';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  setNowForTests(null);
});

function owner(
  method: 'GET' | 'POST',
  url: string,
  token: string | null = TEST_OWNER_MENU_TOKEN,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

/** The phone search. POST, with the number in the body — never in the url. */
function search(phone: string, token: string | null = TEST_OWNER_MENU_TOKEN) {
  return owner('POST', '/api/admin/orders/search', token, { phone });
}

let seq = 0;

interface SeedOptions {
  status?: OrderStatus;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
}

async function seedOrder(options: SeedOptions = {}): Promise<string> {
  const id = `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;
  await db.insert(orders).values({
    id,
    accessToken: newOrderAccessToken(),
    subtotal: 790,
    deliveryFee: 299,
    total: 1089,
    currency: 'EUR',
    status: options.status ?? 'ready',
    fulfilment: 'delivery',
    customerName: options.name === undefined ? 'Anna Bergmann' : options.name,
    customerPhone: options.phone === undefined ? '0201 5415883' : options.phone,
    customerAddress:
      options.address === undefined ? 'Teststraße 7, 45127 Essen' : options.address,
    customerNotes: options.notes === undefined ? 'Bitte zweimal klingeln' : options.notes,
    paymentProvider: 'stripe',
    paymentReference: 'cs_test_reference',
  });
  await db.insert(orderLines).values([
    {
      orderId: id,
      menuItemId: 'margherita',
      variantId: 'margherita-gross',
      name: 'Margherita',
      variantLabel: 'groß',
      unitPrice: 790,
      quantity: 1,
    },
  ]);
  return id;
}

// ---------------------------------------------------------------------------

describe('every route fails closed', () => {
  it('401s an unauthenticated call to each of the three', async () => {
    const id = await seedOrder();

    const calls = await Promise.all([
      search('5415883', null),
      owner('GET', `/api/admin/orders/${id}/personal-data`, null),
      owner('POST', `/api/admin/orders/${id}/forget`, null),
    ]);

    for (const res of calls) expect(res.statusCode).toBe(401);
    // And nothing leaked on the way out. The status assertion above is what
    // stops this passing on some other error body.
    for (const res of calls) {
      expect(res.body).not.toContain('Anna Bergmann');
      expect(res.body).not.toContain('Teststraße');
    }
  });

  it('401s a wrong owner token', async () => {
    const id = await seedOrder();
    const res = await owner(
      'GET',
      `/api/admin/orders/${id}/personal-data`,
      'not-the-owner-token',
    );
    expect(res.statusCode).toBe(401);
  });

  it('did not erase anything while refusing', async () => {
    const id = await seedOrder();
    await owner('POST', `/api/admin/orders/${id}/forget`, null);

    const [row] = await db.select().from(orders);
    expect(row.customerName).toBe('Anna Bergmann');
    expect(row.personalDataErasedAt).toBeNull();
    expect(id).toBe(row.id);
  });
});

describe('POST /api/admin/orders/search', () => {
  it('finds a diner by the digits of their phone number', async () => {
    const id = await seedOrder({ phone: '0201 5415883' });

    const res = await search('0201 5415883');

    expect(res.statusCode).toBe(200);
    const hits = res.json<{ orders: { id: string; name: string }[] }>().orders;
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(id);
    expect(hits[0].name).toBe('Anna Bergmann');
  });

  it('matches across the ways one number gets written down', async () => {
    // The same phone, three spellings. A caller reads out the end of their
    // number; the stored value is whatever they typed into checkout.
    await seedOrder({ phone: '+49 201 5415883' });
    await seedOrder({ phone: '0201/5415883' });
    await seedOrder({ phone: '0201-5415883' });

    const res = await search('5415883');

    expect(res.statusCode).toBe(200);
    expect(res.json<{ orders: unknown[] }>().orders).toHaveLength(3);
  });

  it('does not match a different number that merely shares digits', async () => {
    await seedOrder({ phone: '0201 5415883' });

    // A prefix, not a suffix — this is a different phone.
    const res = await search('0201541');

    expect(res.statusCode).toBe(200);
    expect(res.json<{ orders: unknown[] }>().orders).toHaveLength(0);
  });

  it('refuses a fragment too short to be a phone number', async () => {
    const res = await search('541');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Ziffern');
  });

  it('refuses a missing phone field', async () => {
    const res = await owner('POST', '/api/admin/orders/search', TEST_OWNER_MENU_TOKEN, {});
    expect(res.statusCode).toBe(400);
  });

  it('keeps the number out of the url, so it never reaches the request log', async () => {
    // The request logger keeps `url` on every incoming request. A
    // `GET ?phone=…` would write a diner's phone number into the very
    // CloudWatch logs D4 exists to minimise — on the request whose whole
    // purpose is to honour that diner's privacy rights.
    await seedOrder({ phone: '0201 5415883' });

    const viaQuery = await owner(
      'GET',
      '/api/admin/orders/search?phone=5415883',
    );
    expect(viaQuery.statusCode).toBe(404);

    const viaBody = await search('5415883');
    expect(viaBody.statusCode).toBe(200);
  });

  it('skips orders whose phone number has already been erased', async () => {
    const kept = await seedOrder({ phone: '0201 5415883' });
    await seedOrder({ phone: null });

    const res = await search('5415883');
    expect(res.statusCode).toBe(200);
    const hits = res.json<{ orders: { id: string }[] }>().orders;

    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(kept);
  });
});

describe('GET /api/admin/orders/:id/personal-data', () => {
  it('returns every field held about the order', async () => {
    const id = await seedOrder();

    const res = await owner('GET', `/api/admin/orders/${id}/personal-data`);

    expect(res.statusCode).toBe(200);
    const extract = res.json<any>();
    expect(extract.orderId).toBe(id);
    expect(extract.customer).toEqual({
      name: 'Anna Bergmann',
      phone: '0201 5415883',
      address: 'Teststraße 7, 45127 Essen',
      notes: 'Bitte zweimal klingeln',
    });
    expect(extract.order.total).toBe(1089);
    expect(extract.order.lines).toEqual([
      { name: 'Margherita', variantLabel: 'groß', unitPrice: 790, quantity: 1, extras: [] },
    ]);
    expect(extract.payment.provider).toBe('stripe');
    expect(extract.payment.reference).toBe('cs_test_reference');
    expect(extract.personalDataErasedAt).toBeNull();
  });

  it('names Stripe, the device and the backup window — what it cannot contain', async () => {
    const id = await seedOrder();

    const extract = (await owner('GET', `/api/admin/orders/${id}/personal-data`)).json<{
      hinweise: string[];
    }>();

    const all = extract.hinweise.join(' ');
    // An access answer that quietly omits a second controller is incomplete,
    // and the admin screen must not promise more than the endpoint delivers.
    expect(all).toContain('Stripe');
    expect(all).toContain('Angaben merken');
    expect(all).toContain('7 Tage');
    // And why an older order's fields are already empty — without this the
    // extract reads as a bug to whoever is answering the phone.
    expect(all).toContain('6 Monate');
    expect(all).toContain('kein Fehler');
  });

  it('404s an unknown order', async () => {
    const res = await owner(
      'GET',
      '/api/admin/orders/00000000-0000-0000-0000-000000000000/personal-data',
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/admin/orders/:id/forget', () => {
  const ERASABLE: OrderStatus[] = ['pending_payment', 'ready', 'cancelled'];

  for (const status of ERASABLE) {
    it(`erases a "${status}" order`, async () => {
      const id = await seedOrder({ status });

      const res = await owner('POST', `/api/admin/orders/${id}/forget`);

      expect(res.statusCode).toBe(200);
      expect(res.json<{ erased: boolean }>().erased).toBe(true);

      const [row] = await db.select().from(orders);
      expect(row.customerName).toBeNull();
      expect(row.customerPhone).toBeNull();
      expect(row.customerAddress).toBeNull();
      expect(row.customerNotes).toBeNull();
      expect(row.personalDataErasedAt).not.toBeNull();
    });
  }

  it('accepts pending_payment on purpose — an unpaid order strands no food', async () => {
    // An abandoned unpaid order never leaves `pending_payment` except by a
    // kitchen cancel. A terminal-state-only refusal would make exactly those
    // orders permanently un-erasable on request.
    const id = await seedOrder({ status: 'pending_payment' });
    expect((await owner('POST', `/api/admin/orders/${id}/forget`)).statusCode).toBe(200);
  });

  for (const status of ['paid', 'preparing'] as OrderStatus[]) {
    it(`refuses a "${status}" order, in German, and changes nothing`, async () => {
      const id = await seedOrder({ status });

      const res = await owner('POST', `/api/admin/orders/${id}/forget`);

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toMatch(/Lieferung|Zubereitung/);

      const [row] = await db.select().from(orders);
      expect(row.customerName).toBe('Anna Bergmann');
      expect(row.personalDataErasedAt).toBeNull();
    });
  }

  it('keeps the books: totals and every order line survive', async () => {
    const id = await seedOrder();

    await owner('POST', `/api/admin/orders/${id}/forget`);

    const [row] = await db.select().from(orders);
    expect(row.subtotal).toBe(790);
    expect(row.deliveryFee).toBe(299);
    expect(row.total).toBe(1089);
    expect(row.currency).toBe('EUR');
    expect(row.status).toBe('ready');
    // `payment_reference` deliberately stays: it is the link into Stripe's own
    // record, which this endpoint does not reach and does not pretend to.
    expect(row.paymentReference).toBe('cs_test_reference');

    const lines = await db.select().from(orderLines);
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe('Margherita');
    expect(lines[0].unitPrice).toBe(790);
  });

  it('leaves the order visible to the kitchen, in its existing no-contact state', async () => {
    const id = await seedOrder();

    await owner('POST', `/api/admin/orders/${id}/forget`);

    const board = await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders?scope=all',
    });
    expect(board.statusCode).toBe(200);
    const list = board.json<{ orders: Order[] }>().orders;
    const card = list.find((o) => o.id === id);

    expect(card).toBeDefined();
    // `serializeOrder` omits `customer` entirely once all four columns are
    // empty, which is the state the kitchen card already renders as "Keine
    // Kontaktdaten hinterlegt" — a degradation it has, not a hole it does not.
    expect(card!.customer).toBeUndefined();
    expect(card!.total).toBe(1089);
    expect(card!.lines).toHaveLength(1);
  });

  it('says in German what it did not reach', async () => {
    const id = await seedOrder();

    const res = await owner('POST', `/api/admin/orders/${id}/forget`);
    const meldung = res.json<{ meldung: string }>().meldung;

    expect(meldung).toContain('Stripe');
    expect(meldung).toContain('7 Tage');
    expect(meldung).toContain('Gerät');
  });

  it('is idempotent, and does not move the first erasure timestamp', async () => {
    setNowForTests(new Date('2026-09-20T10:00:00.000Z'));
    const id = await seedOrder();

    const first = await owner('POST', `/api/admin/orders/${id}/forget`);
    expect(first.json<{ erased: boolean }>().erased).toBe(true);

    setNowForTests(new Date('2026-09-25T10:00:00.000Z'));
    const second = await owner('POST', `/api/admin/orders/${id}/forget`);

    expect(second.statusCode).toBe(200);
    expect(second.json<{ erased: boolean }>().erased).toBe(false);
    expect(second.json<{ personalDataErasedAt: string }>().personalDataErasedAt).toBe(
      '2026-09-20T10:00:00.000Z',
    );
  });

  it('404s an unknown order', async () => {
    const res = await owner(
      'POST',
      '/api/admin/orders/00000000-0000-0000-0000-000000000000/forget',
    );
    expect(res.statusCode).toBe(404);
  });

  it('does not touch any other order', async () => {
    const target = await seedOrder({ name: 'Anna Bergmann' });
    const bystander = await seedOrder({ name: 'Bert Kowalski' });

    await owner('POST', `/api/admin/orders/${target}/forget`);

    const [row] = await sql<{ customer_name: string | null }[]>`
      select customer_name from orders where id = ${bystander}
    `;
    expect(row.customer_name).toBe('Bert Kowalski');
  });
});
