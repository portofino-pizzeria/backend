// Opening hours, from the footer of portofino-essen.de (see src/lib/shop.ts).
// Every instant here is written in UTC with its Berlin wall time beside it, so
// a failure names the local moment a diner would have been refused.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setNowForTests } from '../src/lib/clock.js';
import { berlinTime, hoursOn, nrwHolidays, refusalFor, shopStatus } from '../src/lib/shop.js';
import { createTestApp } from './support/app';

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
    const d = hoursOn(2026, 9, 15);
    expect([d.weekday, d.pickup, d.delivery]).toEqual([2, null, null]);
  });

  it('weekdays open 12:00, weekends 13:00, all close 22:30, delivery until 22:00', () => {
    expect(hoursOn(2026, 9, 14)).toMatchObject({
      pickup: { open: '12:00', close: '22:30' },
      delivery: { open: '12:00', close: '22:00' },
    });
    expect(hoursOn(2026, 9, 19)).toMatchObject({
      pickup: { open: '13:00', close: '22:30' },
      delivery: { open: '13:00', close: '22:00' },
    });
  });

  it('a weekday holiday takes the weekend hours', () => {
    // Tag der Deutschen Einheit 2029 is a Wednesday.
    expect(hoursOn(2029, 10, 3)).toMatchObject({
      holiday: 'Tag der Deutschen Einheit',
      pickup: { open: '13:00', close: '22:30' },
    });
  });

  it('a holiday on a Tuesday stays a Ruhetag', () => {
    // 1. Weihnachtstag 2029 is a Tuesday.
    const d = hoursOn(2029, 12, 25);
    expect([d.weekday, d.holiday, d.pickup]).toEqual([2, '1. Weihnachtstag', null]);
  });
});

describe('status now', () => {
  it('Wednesday 18:00: both taken, with their end times', () => {
    const s = shopStatus(new Date('2026-09-16T16:00:00Z'));
    expect(s.pickup).toEqual({ available: true, until: '22:30' });
    expect(s.delivery).toEqual({ available: true, until: '22:00' });
  });

  it('Wednesday 22:15: delivery refused naming pickup, pickup still taken', () => {
    const s = shopStatus(new Date('2026-09-16T20:15:00Z'));
    expect(s.pickup.available).toBe(true);
    expect(s.delivery.available).toBe(false);
    expect(refusalFor('delivery', s)).toContain('Abholung ist noch bis 22:30 Uhr möglich');
    expect(refusalFor('pickup', s)).toBeNull();
  });

  it('Wednesday 22:30 sharp: closed, next Thursday 12:00', () => {
    const s = shopStatus(new Date('2026-09-16T20:30:00Z'));
    expect(s.pickup).toEqual({
      available: false,
      next: { date: '2026-09-17', weekday: 'Donnerstag', time: '12:00' },
    });
    expect(refusalFor('pickup', s)).toBe(
      'Wir haben gerade geschlossen und nehmen keine Bestellungen an. Wieder möglich ab Donnerstag, 12:00 Uhr.',
    );
  });

  it('Monday 23:00: the next opening skips the Tuesday Ruhetag', () => {
    const s = shopStatus(new Date('2026-09-14T21:00:00Z'));
    expect(s.delivery.next).toEqual({ date: '2026-09-16', weekday: 'Mittwoch', time: '12:00' });
  });

  it('Saturday 12:30: not yet open, opens 13:00 the same day', () => {
    const s = shopStatus(new Date('2026-09-19T10:30:00Z'));
    expect(s.pickup.next).toEqual({ date: '2026-09-19', weekday: 'Samstag', time: '13:00' });
  });
});

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
});
