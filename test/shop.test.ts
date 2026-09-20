// Opening hours. The values come from the footer of portofino-essen.de and are
// now ROWS the owner edits (src/db/seed-shop.ts seeds them from
// src/lib/shop-defaults.ts); the pure functions take them as an argument, and
// these tests pass `DEFAULT_SHOP_RULES` so they stay free of the database.
// Every instant here is written in UTC with its Berlin wall time beside it, so
// a failure names the local moment a diner would have been refused.

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import { shopProfile, shopSpecialDays, shopWeeklyHours } from '../src/db/schema.js';
import { setNowForTests } from '../src/lib/clock.js';
import { DEFAULT_SHOP_RULES } from '../src/lib/shop-defaults.js';
import {
  berlinTime,
  displayHours,
  hoursOn,
  nrwHolidays,
  refusalFor,
  shopStatus,
} from '../src/lib/shop.js';
import { createTestApp } from './support/app';
import { seedCategory, seedItem, VALID_CUSTOMER } from './support/fixtures';

const RULES = DEFAULT_SHOP_RULES;

describe('Berlin wall time', () => {
  it('follows summer time (UTC+2)', () => {
    const t = berlinTime(new Date('2026-09-16T19:59:00Z'));
    expect([t.date, t.weekday, t.minutes]).toEqual(['2026-09-16', 3, 21 * 60 + 59]);
  });

  it('follows winter time (UTC+1)', () => {
    const t = berlinTime(new Date('2026-12-02T21:30:00Z'));
    expect([t.date, t.weekday, t.minutes]).toEqual(['2026-12-02', 3, 22 * 60 + 30]);
  });

  it('crosses midnight into the Berlin date, not the UTC one', () => {
    const t = berlinTime(new Date('2026-09-15T22:30:00Z'));
    expect([t.date, t.weekday]).toEqual(['2026-09-16', 3]);
  });
});

describe('NRW public holidays', () => {
  it('derives the Easter-based holidays for 2026 (Easter Sunday 5 April)', () => {
    const h = nrwHolidays(2026);
    expect(h.get('2026-04-03')).toBe('Karfreitag');
    expect(h.get('2026-04-06')).toBe('Ostermontag');
    expect(h.get('2026-05-14')).toBe('Christi Himmelfahrt');
    expect(h.get('2026-05-25')).toBe('Pfingstmontag');
    expect(h.get('2026-06-04')).toBe('Fronleichnam');
    expect(h.size).toBe(11);
  });

  it('does not treat Heiligabend or Silvester as holidays', () => {
    const h = nrwHolidays(2026);
    expect(h.has('2026-12-24')).toBe(false);
    expect(h.has('2026-12-31')).toBe(false);
  });
});

describe('the windows of one day', () => {
  it('Tuesday is a Ruhetag', () => {
    const d = hoursOn(RULES, 2026, 9, 15);
    expect([d.weekday, d.pickup, d.delivery]).toEqual([2, null, null]);
  });

  it('weekdays open 12:00, weekends 13:00, all close 22:30, delivery until 22:00', () => {
    expect(hoursOn(RULES, 2026, 9, 14)).toMatchObject({
      pickup: { open: '12:00', close: '22:30' },
      delivery: { open: '12:00', close: '22:00' },
    });
    expect(hoursOn(RULES, 2026, 9, 19)).toMatchObject({
      pickup: { open: '13:00', close: '22:30' },
      delivery: { open: '13:00', close: '22:00' },
    });
  });

  it('a weekday holiday takes the weekend hours', () => {
    // Tag der Deutschen Einheit 2029 is a Wednesday.
    expect(hoursOn(RULES, 2029, 10, 3)).toMatchObject({
      holiday: 'Tag der Deutschen Einheit',
      pickup: { open: '13:00', close: '22:30' },
    });
  });

  it('a holiday on a Tuesday stays a Ruhetag', () => {
    // 1. Weihnachtstag 2029 is a Tuesday.
    const d = hoursOn(RULES, 2029, 12, 25);
    expect([d.weekday, d.holiday, d.pickup]).toEqual([2, '1. Weihnachtstag', null]);
  });
});

describe('status now', () => {
  it('Wednesday 18:00: both taken, with their end times', () => {
    const s = shopStatus(RULES, new Date('2026-09-16T16:00:00Z'));
    expect(s.pickup).toEqual({ available: true, until: '22:30' });
    expect(s.delivery).toEqual({ available: true, until: '22:00' });
  });

  it('Wednesday 22:15: delivery refused naming pickup, pickup still taken', () => {
    const s = shopStatus(RULES, new Date('2026-09-16T20:15:00Z'));
    expect(s.pickup.available).toBe(true);
    expect(s.delivery.available).toBe(false);
    expect(refusalFor('delivery', s)).toContain('Abholung ist noch bis 22:30 Uhr möglich');
    expect(refusalFor('pickup', s)).toBeNull();
  });

  it('Wednesday 22:30 sharp: closed, next Thursday 12:00', () => {
    const s = shopStatus(RULES, new Date('2026-09-16T20:30:00Z'));
    expect(s.pickup).toEqual({
      available: false,
      next: { date: '2026-09-17', weekday: 'Donnerstag', time: '12:00' },
    });
    expect(refusalFor('pickup', s)).toBe(
      'Wir haben gerade geschlossen und nehmen keine Bestellungen an. Wieder möglich ab Donnerstag, 12:00 Uhr.',
    );
  });

  it('Monday 23:00: the next opening skips the Tuesday Ruhetag', () => {
    const s = shopStatus(RULES, new Date('2026-09-14T21:00:00Z'));
    expect(s.delivery.next).toEqual({ date: '2026-09-16', weekday: 'Mittwoch', time: '12:00' });
  });

  it('Saturday 12:30: not yet open, opens 13:00 the same day', () => {
    const s = shopStatus(RULES, new Date('2026-09-19T10:30:00Z'));
    expect(s.pickup.next).toEqual({ date: '2026-09-19', weekday: 'Samstag', time: '13:00' });
  });
});

// --- The printed table is derived, not written twice (decision D3) ----------

describe('displayHours', () => {
  // The literal is `HOURS_DISPLAY` as it stood at bdaaeac, before the constant
  // was replaced by this function. Deriving it from the same rows the server
  // enforces is the whole point: a printed line that disagrees with the
  // enforced hours is a lie a diner acts on.
  it('prints exactly what the hand-written constant printed', () => {
    expect(displayHours(RULES)).toEqual([
      { days: 'Montag, Mittwoch – Freitag', hours: '12:00 – 22:30 Uhr' },
      { days: 'Samstag, Sonntag und Feiertage', hours: '13:00 – 22:30 Uhr' },
      { days: 'Dienstag', hours: 'Ruhetag' },
    ]);
  });

  it('gives the holiday window its own row when no weekday matches it', () => {
    const rows = displayHours({ ...RULES, holiday: { open: '15:00', close: '20:00' } });
    expect(rows).toContainEqual({ days: 'Feiertage', hours: '15:00 – 20:00 Uhr' });
  });

  it('lists two days, ranges three or more, and puts Ruhetage last', () => {
    const rows = displayHours({
      ...RULES,
      weekly: {
        1: null,
        2: null,
        3: { open: '12:00', close: '22:30' },
        4: { open: '12:00', close: '22:30' },
        5: { open: '12:00', close: '22:30' },
        6: { open: '12:00', close: '22:30' },
        7: { open: '13:00', close: '22:30' },
      },
    });
    expect(rows[0]).toEqual({ days: 'Mittwoch – Samstag', hours: '12:00 – 22:30 Uhr' });
    expect(rows[rows.length - 1]).toEqual({ days: 'Montag, Dienstag', hours: 'Ruhetag' });
  });
});

// --- The two pre-filled special days (decision D4) --------------------------

describe('Heiligabend and Silvester', () => {
  it('Heiligabend on a Wednesday closes at 14:00 and delivers until 13:30', () => {
    // 24 December 2025 is a Wednesday: the weekday opens at 12:00 as usual.
    const d = hoursOn(RULES, 2025, 12, 24);
    expect(d).toMatchObject({
      special: 'Heiligabend: geöffnet bis 14:00 Uhr, Lieferung bis 13:30 Uhr',
      pickup: { open: '12:00', close: '14:00' },
      delivery: { open: '12:00', close: '13:30' },
    });
  });

  it('refuses a delivery at 13:31 and names 13:30, with pickup still open', () => {
    // 13:31 Berlin on 24 December 2025 (winter time, UTC+1).
    const s = shopStatus(RULES, new Date('2025-12-24T12:31:00Z'));
    expect(s.pickup.available).toBe(true);
    expect(s.delivery.available).toBe(false);
    expect(refusalFor('delivery', s)).toContain(
      'Lieferungen nehmen wir heute nur bis 13:30 Uhr an',
    );
  });

  it('refuses a pickup at 14:00 sharp', () => {
    const s = shopStatus(RULES, new Date('2025-12-24T13:00:00Z'));
    expect(s.pickup.available).toBe(false);
    expect(refusalFor('pickup', s)).toContain('Wir haben gerade geschlossen');
  });

  it('the sentence diners read is composed from the label and the hours now enforced', () => {
    // The owner's row carries the LABEL "Silvester" and a closing time. Move
    // the closing time and the sentence moves with it — a stored sentence
    // would still promise 18:00 in front of a door that shuts at 17:00 (D3).
    const moved = {
      ...RULES,
      specialDays: RULES.specialDays.map((s) =>
        s.monthDay === '12-31' ? { ...s, close: '17:00', deliveryUntil: '16:30' } : s,
      ),
    };
    expect(hoursOn(moved, 2025, 12, 31).special).toBe(
      'Silvester: geöffnet bis 17:00 Uhr, Lieferung bis 16:30 Uhr',
    );
    const closed = {
      ...RULES,
      specialDays: RULES.specialDays.map((s) =>
        s.monthDay === '12-31' ? { ...s, closed: true, close: null, deliveryUntil: null } : s,
      ),
    };
    expect(hoursOn(closed, 2025, 12, 31).special).toBe('Silvester: geschlossen');
  });

  it('Heiligabend on a Tuesday stays a Ruhetag', () => {
    // 24 December 2024 is a Tuesday. A RECURRING row does not open a Ruhetag
    // while ruhetagBeatsHoliday is set — only a dated row, typed for that one
    // date, can.
    const d = hoursOn(RULES, 2024, 12, 24);
    expect([d.weekday, d.pickup, d.delivery, d.special]).toEqual([2, null, null, undefined]);
  });

  it('Silvester closes at 18:00 and delivers until 17:30', () => {
    // 31 December 2025 is a Wednesday.
    expect(hoursOn(RULES, 2025, 12, 31)).toMatchObject({
      special: 'Silvester: geöffnet bis 18:00 Uhr, Lieferung bis 17:30 Uhr',
      pickup: { open: '12:00', close: '18:00' },
      delivery: { open: '12:00', close: '17:30' },
    });
  });
});

// --- The public route -------------------------------------------------------

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

describe('GET /api/shop', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves the address, phone, printed hours and the live status', async () => {
    setNowForTests(new Date('2026-09-15T16:00:00Z')); // a Tuesday
    const res = await app.inject({ method: 'GET', url: '/api/shop' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      street: 'Hauptstr. 108',
      postalCode: '45219',
      city: 'Essen',
      phoneDisplay: '02054 – 15 88 3',
      phoneE164: '+49205415883',
      deliveryUntil: '22:00',
    });
    expect(body.hours).toHaveLength(3);
    expect(body.status.pickup).toEqual({
      available: false,
      next: { date: '2026-09-16', weekday: 'Mittwoch', time: '12:00' },
    });
  });

  // The whole body, as a literal captured from the behaviour at bdaaeac — when
  // every one of these values was a code constant. Moving them into the
  // database must change NOTHING a diner or the app reads, so this is written
  // out in full rather than matched loosely; `specialDays` and `legal` are the
  // only additions. September carries neither Heiligabend nor Silvester, so
  // the special-day list is legitimately empty here.
  it('answers exactly what it answered before the facts moved into the database', async () => {
    setNowForTests(new Date('2026-09-15T16:00:00Z')); // Tuesday, 18:00 in Essen
    const res = await app.inject({ method: 'GET', url: '/api/shop' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'Portofino Pizzeria',
      street: 'Hauptstr. 108',
      postalCode: '45219',
      city: 'Essen',
      phoneDisplay: '02054 – 15 88 3',
      phoneE164: '+49205415883',
      timeZone: 'Europe/Berlin',
      hours: [
        { days: 'Montag, Mittwoch – Freitag', hours: '12:00 – 22:30 Uhr' },
        { days: 'Samstag, Sonntag und Feiertage', hours: '13:00 – 22:30 Uhr' },
        { days: 'Dienstag', hours: 'Ruhetag' },
      ],
      deliveryUntil: '22:00',
      status: {
        now: '2026-09-15T18:00',
        today: { date: '2026-09-15', weekday: 2, pickup: null, delivery: null },
        pickup: {
          available: false,
          next: { date: '2026-09-16', weekday: 'Mittwoch', time: '12:00' },
        },
        delivery: {
          available: false,
          next: { date: '2026-09-16', weekday: 'Mittwoch', time: '12:00' },
        },
      },
      specialDays: [],
      legal: {
        ownerName: null,
        legalForm: null,
        email: null,
        complete: false,
        missing: ['legalOwnerName', 'email'],
      },
    });
  });

  it('names the special days of the next 30 days, in date order', async () => {
    setNowForTests(new Date('2025-12-15T12:00:00Z')); // 15 December, a Monday
    const body = await app
      .inject({ method: 'GET', url: '/api/shop' })
      .then((res) => res.json());
    expect(body.specialDays.map((d: { date: string; special: string }) => [d.date, d.special])).toEqual([
      ['2025-12-24', 'Heiligabend: geöffnet bis 14:00 Uhr, Lieferung bis 13:30 Uhr'],
      ['2025-12-31', 'Silvester: geöffnet bis 18:00 Uhr, Lieferung bis 17:30 Uhr'],
    ]);
  });
});

// --- The rules really come from the rows ------------------------------------

describe('the hours the order route enforces come from the database', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  function postOrder(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { customer: VALID_CUSTOMER, ...payload },
    });
  }

  it('a dated special day opens a Tuesday, and an order is taken', async () => {
    await seedMargherita();
    await db.insert(shopSpecialDays).values({
      date: '2026-09-15', // a Tuesday, normally the Ruhetag
      closed: false,
      open: '12:00',
      close: '22:30',
      note: 'Sonderöffnung',
    });
    setNowForTests(new Date('2026-09-15T16:00:00Z')); // Tuesday, 18:00

    const res = await postOrder({ items: LINE });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('moving the Ruhetag to Monday refuses on Monday and takes orders on Tuesday', async () => {
    await seedMargherita();
    await db
      .update(shopWeeklyHours)
      .set({ open: null, close: null })
      .where(eq(shopWeeklyHours.weekday, 1));
    await db
      .update(shopWeeklyHours)
      .set({ open: '12:00', close: '22:30' })
      .where(eq(shopWeeklyHours.weekday, 2));

    setNowForTests(new Date('2026-09-14T16:00:00Z')); // Monday, 18:00
    const monday = await postOrder({ items: LINE });
    expect(monday.statusCode).toBe(400);
    expect(monday.json().error).toContain('Wir haben gerade geschlossen');

    setNowForTests(new Date('2026-09-15T16:00:00Z')); // Tuesday, 18:00
    const tuesday = await postOrder({ items: LINE });
    expect(tuesday.statusCode, tuesday.body).toBe(200);
  });

  it('refuses every order with 503 while the shop has no profile row', async () => {
    await seedMargherita();
    await db.delete(shopProfile);

    const res = await postOrder({ items: LINE });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain(
      'Wir können die Öffnungszeiten gerade nicht prüfen',
    );
  });
});
