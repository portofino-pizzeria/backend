// The owner's restaurant editor — `/api/admin/shop/*`.
//
// This is a safety surface: what it stores is what the server ENFORCES, so a
// wrong value here takes orders for a closed kitchen or refuses orders the
// shop wanted. The five properties of decision D5 each have their own
// `describe` below, spelled out in the test names so a failure says which one
// broke:
//
//   1. each part is saved whole
//   2. impossible states are refused
//   3. closing the whole week needs a confirmation
//   4. two phones cannot overwrite each other (optimistic concurrency)
//   5. every write is undoable
//
// Nothing here is skipped.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setNowForTests } from '../src/lib/clock.js';
import type { AdminShop, ShopPreview } from '../src/lib/shop-admin-service.js';
import { createTestApp } from './support/app';
import { withConfig } from './support/config';
import { TEST_OWNER_MENU_TOKEN } from './support/env';
import { seedCategory, seedItem, VALID_CUSTOMER } from './support/fixtures';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

interface Response {
  statusCode: number;
  body: string;
  error: string;
  json: <T = unknown>() => T;
}

/** One authenticated editor request. */
async function admin(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  token: string | null = TEST_OWNER_MENU_TOKEN,
): Promise<Response> {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  return {
    statusCode: res.statusCode,
    body: res.body,
    error: (res.json<{ error?: string }>() ?? {}).error ?? '',
    json: <T,>() => res.json<T>(),
  };
}

async function readShop(): Promise<AdminShop> {
  const res = await admin('GET', '/api/admin/shop');
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AdminShop>();
}

/** The seven weekdays as they are seeded, ready to be edited by a test. */
async function currentWeekly(): Promise<AdminShop['weekly']> {
  return (await readShop()).weekly;
}

function hoursBody(shop: AdminShop, patch: Partial<Record<string, unknown>> = {}) {
  return {
    weekly: shop.weekly,
    deliveryUntil: shop.profile.deliveryUntil,
    holidayOpen: shop.profile.holidayOpen,
    holidayClose: shop.profile.holidayClose,
    ruhetagBeatsHoliday: shop.profile.ruhetagBeatsHoliday,
    version: shop.version,
    ...patch,
  };
}

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

// --- The guard --------------------------------------------------------------

describe('the owner guard on the restaurant editor', () => {
  it('refuses every request when OWNER_MENU_TOKEN is unset', async () => {
    await withConfig({ ownerMenuToken: '' }, async () => {
      const read = await admin('GET', '/api/admin/shop');
      expect(read.statusCode).toBe(401);
      expect(read.error).toContain('OWNER_MENU_TOKEN');

      const write = await admin('PUT', '/api/admin/shop/profile', {
        name: 'Geschmuggelt',
        street: 'Nirgendwo 1',
        postalCode: '45219',
        city: 'Essen',
        phoneDisplay: '02054 15883',
        version: 1,
      });
      expect(write.statusCode).toBe(401);
    });

    // The refused write changed nothing.
    expect((await readShop()).profile.name).toBe('Portofino Pizzeria');
  });

  it('rejects a wrong token and a missing header', async () => {
    expect((await admin('GET', '/api/admin/shop', undefined, 'falsch')).statusCode).toBe(401);
    expect((await admin('GET', '/api/admin/shop', undefined, null)).statusCode).toBe(401);
  });
});

// --- What the editor reads --------------------------------------------------

describe('GET /api/admin/shop', () => {
  it('serves the seeded shop, its version, and the two unconfirmed D4 rows', async () => {
    const shop = await readShop();
    expect(shop.version).toBe(1);
    expect(shop.canUndo).toBe(false);
    expect(shop.profile).toEqual({
      name: 'Portofino Pizzeria',
      street: 'Hauptstr. 108',
      postalCode: '45219',
      city: 'Essen',
      phoneDisplay: '02054 – 15 88 3',
      phoneE164: '+49205415883',
      deliveryUntil: '22:00',
      holidayOpen: '13:00',
      holidayClose: '22:30',
      ruhetagBeatsHoliday: true,
    });
    expect(shop.weekly).toHaveLength(7);
    expect(shop.weekly[1]).toEqual({ weekday: 2, open: null, close: null });
    expect(shop.specialDays.map((d) => [d.monthDay, d.confirmed])).toEqual([
      ['12-24', false],
      ['12-31', false],
    ]);
  });
});

// --- D5.1 Each part is saved whole -----------------------------------------

describe('D5.1 — each part is saved whole', () => {
  it('writes all seven weekdays in one request', async () => {
    const shop = await readShop();
    const weekly = shop.weekly.map((day) => ({ ...day, open: day.open ? '11:00' : null }));
    const res = await admin('PUT', '/api/admin/shop/hours', hoursBody(shop, { weekly }));
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json<AdminShop>();
    expect(saved.weekly.filter((d) => d.open === '11:00')).toHaveLength(6);
    expect(saved.weekly.find((d) => d.weekday === 2)).toEqual({
      weekday: 2,
      open: null,
      close: null,
    });
  });

  it('refuses a week that is not all seven days', async () => {
    const shop = await readShop();
    const res = await admin(
      'PUT',
      '/api/admin/shop/hours',
      hoursBody(shop, { weekly: shop.weekly.slice(0, 6) }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('ganze Woche');
  });

  it('writes a whole holiday — 62 days — in one request and bumps the version once', async () => {
    const shop = await readShop();
    // 1 November onwards: the longest "Urlaub eintragen" the editor offers,
    // 62 dated rows written in ONE transaction.
    const holiday = Array.from({ length: 62 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10),
      closed: true,
      note: 'Betriebsferien',
    }));

    const res = await admin('POST', '/api/admin/shop/special-days', {
      days: holiday,
      version: shop.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json<AdminShop>();
    expect(saved.specialDays.filter((d) => d.note === 'Betriebsferien')).toHaveLength(62);
    expect(saved.version).toBe(shop.version + 1);
  });

  it('rejects the whole batch when one row is invalid', async () => {
    const shop = await readShop();
    const res = await admin('POST', '/api/admin/shop/special-days', {
      days: [
        { date: '2026-12-05', closed: true, note: 'Ruhetag' },
        { date: '2026-12-06', closed: false, open: '18:00', close: '14:00', note: 'Kaputt' },
        { date: '2026-12-07', closed: true, note: 'Ruhetag' },
      ],
      version: shop.version,
    });
    expect(res.statusCode).toBe(400);

    const after = await readShop();
    expect(after.specialDays).toHaveLength(2); // only the two seeded rows
    expect(after.version).toBe(shop.version);
  });
});

// --- D5.2 Impossible states are refused -------------------------------------

describe('D5.2 — impossible states are refused', () => {
  it('a time that is not HH:MM', async () => {
    const shop = await readShop();
    const res = await admin(
      'PUT',
      '/api/admin/shop/hours',
      hoursBody(shop, { deliveryUntil: '22.00' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('HH:MM');
  });

  it('a window that closes at or before it opens', async () => {
    const shop = await readShop();
    const weekly = shop.weekly.map((day) =>
      day.weekday === 1 ? { weekday: 1, open: '22:00', close: '12:00' } : day,
    );
    const res = await admin('PUT', '/api/admin/shop/hours', hoursBody(shop, { weekly }));
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Schließzeit');
  });

  it('a delivery cut-off after the closing time', async () => {
    const shop = await readShop();
    const res = await admin('POST', '/api/admin/shop/special-days', {
      days: [
        {
          date: '2026-12-05',
          closed: false,
          open: '12:00',
          close: '14:00',
          deliveryUntil: '15:00',
          note: 'Kurzer Tag',
        },
      ],
      version: shop.version,
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Lieferung bis');
  });

  it('a delivery cut-off BEFORE the opening is allowed and means no delivery', async () => {
    setNowForTests(new Date('2026-09-16T16:00:00Z')); // Wednesday, 18:00
    const shop = await readShop();
    const res = await admin('POST', '/api/admin/shop/special-days', {
      days: [
        {
          date: '2026-09-19', // the coming Saturday
          closed: false,
          open: '13:00',
          close: '16:00',
          deliveryUntil: '11:00',
          note: 'Nur Abholung',
        },
      ],
      version: shop.version,
    });
    expect(res.statusCode, res.body).toBe(200);

    const day = (await admin('POST', '/api/admin/shop/preview', {}))
      .json<ShopPreview>()
      .days.find((d) => d.date === '2026-09-19');
    expect(day).toMatchObject({
      pickup: { open: '13:00', close: '16:00' },
      delivery: null,
      special: 'Nur Abholung',
    });
  });

  it('a dated special day in the past', async () => {
    const shop = await readShop();
    const res = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ date: '2020-01-02', closed: true, note: 'Zu spät' }],
      version: shop.version,
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Vergangenheit');
  });

  it('a special day with both a date and a day of the year, or with neither', async () => {
    const shop = await readShop();
    const both = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ date: '2026-12-05', monthDay: '12-05', closed: true, note: 'Beides' }],
      version: shop.version,
    });
    expect(both.statusCode).toBe(400);
    expect(both.error).toContain('genau eines von beiden');

    const neither = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ closed: true, note: 'Keins' }],
      version: shop.version,
    });
    expect(neither.statusCode).toBe(400);
  });

  it('two rows for the same date — in one batch, and against a stored row', async () => {
    const shop = await readShop();
    const inBatch = await admin('POST', '/api/admin/shop/special-days', {
      days: [
        { date: '2026-12-05', closed: true, note: 'Einmal' },
        { date: '2026-12-05', closed: true, note: 'Nochmal' },
      ],
      version: shop.version,
    });
    expect(inBatch.statusCode).toBe(400);
    expect(inBatch.error).toContain('2026-12-05');

    const first = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ date: '2026-12-05', closed: true, note: 'Einmal' }],
      version: shop.version,
    });
    expect(first.statusCode, first.body).toBe(200);

    const again = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ date: '2026-12-05', closed: true, note: 'Nochmal' }],
      version: first.json<AdminShop>().version,
    });
    expect(again.statusCode).toBe(400);
  });

  it('two rows for the same day of the year', async () => {
    const shop = await readShop();
    const res = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ monthDay: '12-24', closed: true, note: 'Doppelt' }],
      version: shop.version,
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('12-24');
  });
});

// --- D5.3 Closing the whole week needs a confirmation -----------------------

describe('D5.3 — closing all seven weekdays needs confirmAllClosed', () => {
  const allClosed = () =>
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open: null, close: null }));

  it('refuses it without the confirmation', async () => {
    const shop = await readShop();
    const res = await admin(
      'PUT',
      '/api/admin/shop/hours',
      hoursBody(shop, { weekly: allClosed() }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('bestätigen');
    expect((await readShop()).weekly.filter((d) => d.open)).toHaveLength(6);
  });

  it('accepts it with confirmAllClosed: true', async () => {
    const shop = await readShop();
    const res = await admin(
      'PUT',
      '/api/admin/shop/hours',
      hoursBody(shop, { weekly: allClosed(), confirmAllClosed: true }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<AdminShop>().weekly.every((d) => d.open === null)).toBe(true);
  });
});

// --- D5.4 The phone number --------------------------------------------------

describe('D5.4 — the phone number is normalised on the server', () => {
  it('derives +49205415883 from "02054 – 15 88 3"', async () => {
    const shop = await readShop();
    const res = await admin('PUT', '/api/admin/shop/profile', {
      name: 'Portofino Pizzeria',
      street: 'Hauptstr. 108',
      postalCode: '45219',
      city: 'Essen',
      phoneDisplay: '02054 – 15 88 3',
      version: shop.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<AdminShop>().profile.phoneE164).toBe('+49205415883');
  });

  it('accepts 0049 and +49 spellings of the same number', async () => {
    for (const phoneDisplay of ['0049 2054 15883', '+49 (2054) 15-88-3']) {
      const shop = await readShop();
      const res = await admin('PUT', '/api/admin/shop/profile', {
        name: shop.profile.name,
        street: shop.profile.street,
        postalCode: shop.profile.postalCode,
        city: shop.profile.city,
        phoneDisplay,
        version: shop.version,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<AdminShop>().profile.phoneE164).toBe('+49205415883');
    }
  });

  it('refuses a number that is not a dialable German one', async () => {
    const shop = await readShop();
    const res = await admin('PUT', '/api/admin/shop/profile', {
      name: shop.profile.name,
      street: shop.profile.street,
      postalCode: shop.profile.postalCode,
      city: shop.profile.city,
      phoneDisplay: 'ruf einfach an',
      version: shop.version,
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('Telefonnummer');
  });
});

// --- D5.5 Optimistic concurrency -------------------------------------------

describe('D5.5 — a stale version is refused with 409', () => {
  it('answers exactly the sentence the editor shows', async () => {
    const shop = await readShop();
    const first = await admin(
      'PUT',
      '/api/admin/shop/hours',
      hoursBody(shop, { deliveryUntil: '21:00' }),
    );
    expect(first.statusCode, first.body).toBe(200);

    // The second phone still holds the version it read before the first saved.
    const second = await admin(
      'PUT',
      '/api/admin/shop/hours',
      hoursBody(shop, { deliveryUntil: '20:00' }),
    );
    expect(second.statusCode).toBe(409);
    expect(second.error).toBe('Inzwischen hat jemand anderes gespeichert – bitte neu laden.');
    expect((await readShop()).profile.deliveryUntil).toBe('21:00');
  });

  it('every kind of write bumps the one counter', async () => {
    let shop = await readShop();
    expect(shop.version).toBe(1);

    const days = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ date: '2026-12-05', closed: true, note: 'Ruhetag' }],
      version: shop.version,
    });
    expect(days.json<AdminShop>().version).toBe(2);

    shop = await readShop();
    const profile = await admin('PUT', '/api/admin/shop/profile', {
      name: 'Pizzeria Portofino',
      street: shop.profile.street,
      postalCode: shop.profile.postalCode,
      city: shop.profile.city,
      phoneDisplay: shop.profile.phoneDisplay,
      version: shop.version,
    });
    expect(profile.json<AdminShop>().version).toBe(3);
  });
});

// --- D5.6 Undo --------------------------------------------------------------

describe('D5.6 — every write is undoable', () => {
  it('a save followed by undo returns exactly the state before the save', async () => {
    const before = await readShop();
    const saved = await admin(
      'PUT',
      '/api/admin/shop/hours',
      hoursBody(before, {
        weekly: before.weekly.map((d) => ({ ...d, open: d.open ? '10:00' : null })),
        deliveryUntil: '19:00',
      }),
    );
    expect(saved.statusCode, saved.body).toBe(200);

    const undone = await admin('POST', '/api/admin/shop/undo', {
      version: saved.json<AdminShop>().version,
    });
    expect(undone.statusCode, undone.body).toBe(200);

    // Everything but the version — which only ever goes forward, so that a
    // second editor still finds out it is looking at an old page.
    const { version: _v, canUndo: _c, ...restored } = undone.json<AdminShop>();
    const { version: _v2, canUndo: _c2, ...original } = before;
    expect(restored).toEqual(original);
  });

  it('undoes a special day the same way it undoes a week', async () => {
    const before = await readShop();
    const saved = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ date: '2026-12-05', closed: true, note: 'Doch nicht' }],
      version: before.version,
    });
    expect(saved.json<AdminShop>().specialDays).toHaveLength(3);

    const undone = await admin('POST', '/api/admin/shop/undo', {
      version: saved.json<AdminShop>().version,
    });
    expect(undone.json<AdminShop>().specialDays).toEqual(before.specialDays);
  });

  it('a second undo is a redo', async () => {
    const before = await readShop();
    const saved = await admin(
      'PUT',
      '/api/admin/shop/hours',
      hoursBody(before, { deliveryUntil: '19:00' }),
    );
    const undone = await admin('POST', '/api/admin/shop/undo', {
      version: saved.json<AdminShop>().version,
    });
    expect(undone.json<AdminShop>().profile.deliveryUntil).toBe('22:00');

    const redone = await admin('POST', '/api/admin/shop/undo', {
      version: undone.json<AdminShop>().version,
    });
    expect(redone.json<AdminShop>().profile.deliveryUntil).toBe('19:00');
  });

  it('says so when there is nothing to undo', async () => {
    const shop = await readShop();
    expect(shop.canUndo).toBe(false);
    const res = await admin('POST', '/api/admin/shop/undo', { version: shop.version });
    expect(res.statusCode).toBe(400);
    expect(res.error).toBe('Es gibt nichts rückgängig zu machen.');
  });

  it('undoes a holiday entered yesterday, after midnight has passed', async () => {
    // The "no dated day in the past" rule is about NEW entries. An undo that
    // refused to restore a snapshot because the day has since passed would
    // fail exactly when a mistaken Urlaub most needs taking back.
    setNowForTests(new Date('2026-09-16T16:00:00Z'));
    const before = await readShop();
    const saved = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ date: '2026-09-16', closed: true, note: 'Versehen' }],
      version: before.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);

    setNowForTests(new Date('2026-09-20T16:00:00Z')); // four days later
    const undone = await admin('POST', '/api/admin/shop/undo', {
      version: saved.json<AdminShop>().version,
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json<AdminShop>().specialDays).toEqual(before.specialDays);
  });

  it('reports canUndo once a change exists', async () => {
    const shop = await readShop();
    await admin('PUT', '/api/admin/shop/hours', hoursBody(shop, { deliveryUntil: '21:45' }));
    expect((await readShop()).canUndo).toBe(true);
  });
});

// --- D5.7 The preview -------------------------------------------------------

describe('D5.7 — the preview writes nothing', () => {
  it('leaves the stored shop untouched', async () => {
    const before = await readShop();
    const res = await admin('POST', '/api/admin/shop/preview', {
      deliveryUntil: '19:00',
      weekly: before.weekly.map((d) => ({ ...d, open: d.open ? '10:00' : null })),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await readShop()).toEqual(before);
  });

  it('returns the printed hours, the status and today plus seven days', async () => {
    setNowForTests(new Date('2026-09-16T16:00:00Z')); // Wednesday, 18:00
    const preview = (
      await admin('POST', '/api/admin/shop/preview', {})
    ).json<ShopPreview>();
    expect(preview.days).toHaveLength(8);
    expect(preview.days[0]?.date).toBe('2026-09-16');
    expect(preview.days[7]?.date).toBe('2026-09-23');
    expect(preview.display).toEqual([
      { days: 'Montag, Mittwoch – Freitag', hours: '12:00 – 22:30 Uhr' },
      { days: 'Samstag, Sonntag und Feiertage', hours: '13:00 – 22:30 Uhr' },
      { days: 'Dienstag', hours: 'Ruhetag' },
    ]);
  });

  it('shows the same status the public route serves after saving the same draft', async () => {
    setNowForTests(new Date('2026-09-16T19:30:00Z')); // Wednesday, 21:30
    const shop = await readShop();
    const draft = {
      weekly: shop.weekly.map((d) => (d.weekday === 3 ? { ...d, close: '21:45' } : d)),
      deliveryUntil: '21:15',
      holidayOpen: shop.profile.holidayOpen,
      holidayClose: shop.profile.holidayClose,
      ruhetagBeatsHoliday: shop.profile.ruhetagBeatsHoliday,
    };

    const preview = (
      await admin('POST', '/api/admin/shop/preview', draft)
    ).json<ShopPreview>();

    const saved = await admin('PUT', '/api/admin/shop/hours', {
      ...draft,
      version: shop.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const publicBody = await app
      .inject({ method: 'GET', url: '/api/shop' })
      .then((res) => res.json<{ status: unknown; hours: unknown }>());
    expect(preview.status).toEqual(publicBody.status);
    expect(preview.display).toEqual(publicBody.hours);
  });

  it('refuses a draft that could not be saved either', async () => {
    const res = await admin('POST', '/api/admin/shop/preview', { deliveryUntil: '25:00' });
    expect(res.statusCode).toBe(400);
  });
});

// --- Special days reach the diner ------------------------------------------

describe('a special day the owner enters reaches the order route', () => {
  it('a day marked closed refuses orders on that date, in German', async () => {
    await seedMargherita();
    const shop = await readShop();
    const saved = await admin('POST', '/api/admin/shop/special-days', {
      days: [{ date: '2026-09-17', closed: true, note: 'Betriebsausflug' }],
      version: shop.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);

    setNowForTests(new Date('2026-09-17T16:00:00Z')); // Thursday, 18:00
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { items: LINE, customer: VALID_CUSTOMER },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Wir haben gerade geschlossen');

    // And the day is announced to diners ahead of time.
    setNowForTests(new Date('2026-09-16T16:00:00Z'));
    const shopBody = await app
      .inject({ method: 'GET', url: '/api/shop' })
      .then((r) => r.json<{ specialDays: { date: string; special: string }[] }>());
    expect(shopBody.specialDays[0]).toMatchObject({
      date: '2026-09-17',
      special: 'Betriebsausflug',
    });
  });

  it('editing a pre-filled row confirms it', async () => {
    const shop = await readShop();
    const heiligabend = shop.specialDays.find((d) => d.monthDay === '12-24');
    expect(heiligabend?.confirmed).toBe(false);

    const res = await admin(
      'PATCH',
      `/api/admin/shop/special-days/${heiligabend?.id}`,
      {
        monthDay: '12-24',
        closed: false,
        open: null,
        close: '15:00',
        deliveryUntil: '14:30',
        note: 'Heiligabend: geöffnet bis 15:00 Uhr',
        version: shop.version,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json<AdminShop>().specialDays.find((d) => d.monthDay === '12-24');
    expect(saved).toMatchObject({ confirmed: true, close: '15:00', deliveryUntil: '14:30' });
  });

  it('deletes a special day by id', async () => {
    const shop = await readShop();
    const silvester = shop.specialDays.find((d) => d.monthDay === '12-31');
    const res = await admin(
      'DELETE',
      `/api/admin/shop/special-days/${silvester?.id}?version=${shop.version}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<AdminShop>().specialDays.map((d) => d.monthDay)).toEqual(['12-24']);
  });

  it('refuses a delete that names a row that is not there', async () => {
    const shop = await readShop();
    const res = await admin('DELETE', `/api/admin/shop/special-days/9999?version=${shop.version}`);
    expect(res.statusCode).toBe(404);
  });
});

// --- The Impressum ----------------------------------------------------------

describe('PUT /api/admin/shop/legal', () => {
  const FACTS = {
    legalOwnerName: 'Mario Rossi',
    legalForm: 'Einzelunternehmen',
    email: 'info@portofino-essen.de',
  };

  it('refuses a save that is not confirmed', async () => {
    const shop = await readShop();
    const res = await admin('PUT', '/api/admin/shop/legal', {
      ...FACTS,
      confirmed: false,
      version: shop.version,
    });
    expect(res.statusCode).toBe(400);
    expect(res.error).toContain('bestätigen');
    expect((await readShop()).legal.legalOwnerName).toBeNull();
  });

  it('stores the facts, stamps the confirmation, and is the only writer of the email', async () => {
    const shop = await readShop();
    const res = await admin('PUT', '/api/admin/shop/legal', {
      ...FACTS,
      confirmed: true,
      version: shop.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const legal = res.json<AdminShop>().legal;
    expect(legal).toMatchObject({ ...FACTS, vatId: null });
    expect(legal.confirmedAt).toBeTruthy();

    // The profile write carries no email and must not clear it.
    const after = await readShop();
    const saved = await admin('PUT', '/api/admin/shop/profile', {
      name: 'Portofino Pizzeria',
      street: 'Hauptstr. 108',
      postalCode: '45219',
      city: 'Essen',
      phoneDisplay: '02054 – 15 88 3',
      version: after.version,
    });
    expect(saved.json<AdminShop>().legal.email).toBe(FACTS.email);
  });

  it('refuses an email that is not one', async () => {
    const shop = await readShop();
    const res = await admin('PUT', '/api/admin/shop/legal', {
      ...FACTS,
      email: 'info at portofino',
      confirmed: true,
      version: shop.version,
    });
    expect(res.statusCode).toBe(400);
  });

  it('shows on GET /api/shop, with the register fields omitted while unset', async () => {
    const shop = await readShop();
    await admin('PUT', '/api/admin/shop/legal', {
      ...FACTS,
      confirmed: true,
      version: shop.version,
    });

    const body = await app
      .inject({ method: 'GET', url: '/api/shop' })
      .then((res) => res.json<{ legal: Record<string, unknown> }>());
    expect(body.legal).toEqual({
      ownerName: 'Mario Rossi',
      legalForm: 'Einzelunternehmen',
      email: 'info@portofino-essen.de',
      complete: true,
      missing: [],
    });
    expect(body.legal).not.toHaveProperty('vatId');
    expect(body.legal).not.toHaveProperty('registerCourt');
  });

  it('carries the VAT id and the register entry once they are set', async () => {
    const shop = await readShop();
    await admin('PUT', '/api/admin/shop/legal', {
      ...FACTS,
      vatId: 'DE123456789',
      registerCourt: 'Amtsgericht Essen',
      registerNumber: 'HRB 12345',
      confirmed: true,
      version: shop.version,
    });

    const body = await app
      .inject({ method: 'GET', url: '/api/shop' })
      .then((res) => res.json<{ legal: Record<string, unknown> }>());
    expect(body.legal).toMatchObject({
      vatId: 'DE123456789',
      registerCourt: 'Amtsgericht Essen',
      registerNumber: 'HRB 12345',
    });
  });
});
