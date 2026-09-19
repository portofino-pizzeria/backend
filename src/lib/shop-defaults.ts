// What a database that has never seen this restaurant is seeded with.
//
// SOURCE: the footer of https://portofino-essen.de/ as the operator copied it on
// 2026-09-14:
//
//   Adresse         Hauptstr. 108, 45219 Essen
//   Öffnungszeiten  Dienstag Ruhetag
//                   Mo – Fr: 12.00 – 22.30 Uhr
//                   Sa, So u. Feiertage: 13.00 – 22:30 Uhr
//                   Lieferzeit bis 22.00 Uhr
//   Telefon         02054 – 15 88 3
//
// That footer is the authority here. Two older copies disagree with it and are
// NOT used: the WPPizza widget captured into `data/menu.json` `openingHours`
// (closing at 22:00) and `audience_profile/owner-operator` (the same). The
// footer separates the shop closing (22:30) from the last delivery (22:00),
// and the widget does not — which is exactly the difference pickup exists for.
//
// These were code constants (`SHOP`, `WEEKLY`, `HOLIDAY_WINDOW`,
// `DELIVERY_UNTIL`, `RUHETAG_BEATS_HOLIDAY` in `shop.ts`) until the owner got
// an editor. They are DEFAULTS now, not truth: `seedShop()` writes them once
// into an empty database, and from that moment the tables are the truth and
// this file is never read again. Editing it changes nothing in a database that
// has been seeded.

import { SHOP_TIME_ZONE, type ShopRules } from './shop-rules.js';

/**
 * Today's constants, exactly — so that on the day this ships, `GET /api/shop`
 * answers every field with the value it answered before — plus the two
 * recurring rows from decision D4.
 *
 * The D4 rows are the common German-restaurant pattern (early close on
 * Heiligabend and Silvester, the same 30-minute gap to the last delivery the
 * footer's 22:30/22:00 has), NOT a fact about Portofino: no source states its
 * hours on those two days. They are seeded `confirmed: false`, which is what
 * makes the editor show them as "Vorbelegt – bitte prüfen" until the owner
 * saves them once.
 */
export const DEFAULT_SHOP_RULES: ShopRules = {
  shop: {
    name: 'Portofino Pizzeria',
    street: 'Hauptstr. 108',
    postalCode: '45219',
    city: 'Essen',
    phoneDisplay: '02054 – 15 88 3',
    /** The same number, dialable. 02054 is Essen-Kettwig's area code. */
    phoneE164: '+49205415883',
    timeZone: SHOP_TIME_ZONE,
  },
  weekly: {
    1: { open: '12:00', close: '22:30' },
    2: null, // Dienstag Ruhetag
    3: { open: '12:00', close: '22:30' },
    4: { open: '12:00', close: '22:30' },
    5: { open: '12:00', close: '22:30' },
    6: { open: '13:00', close: '22:30' },
    7: { open: '13:00', close: '22:30' },
  },
  /** "Sa, So u. Feiertage" — a public holiday takes the weekend hours. */
  holiday: { open: '13:00', close: '22:30' },
  /** "Lieferzeit bis 22.00 Uhr" — the last moment a delivery order is taken. */
  deliveryUntil: '22:00',
  /**
   * The rule the footer does not settle, decided by the operator on 2026-09-19
   * on the side that cannot leave a diner waiting for food nobody cooks: a
   * public holiday that falls on a Ruhetag stays a Ruhetag. Taking an order for
   * a closed kitchen is the failure the owner cannot absorb; turning a diner
   * away on a day the shop happens to open costs one order. Stored, not
   * hard-coded, so the owner can change it without a developer.
   */
  ruhetagBeatsHoliday: true,
  specialDays: [
    {
      date: null,
      monthDay: '12-24',
      closed: false,
      open: null, // the weekday's normal opening
      close: '14:00',
      deliveryUntil: '13:30',
      note: 'Heiligabend',
      confirmed: false,
    },
    {
      date: null,
      monthDay: '12-31',
      closed: false,
      open: null, // the weekday's normal opening
      close: '18:00',
      deliveryUntil: '17:30',
      note: 'Silvester',
      confirmed: false,
    },
  ],
  /**
   * Nobody's legal name is invented here. The Impressum facts appear in no
   * document this repository can read, so they are seeded NULL and reported as
   * missing by `/api/health` until the owner types them in (decision D6).
   */
  legal: {
    legalOwnerName: null,
    legalForm: null,
    email: null,
    vatId: null,
    registerCourt: null,
    registerNumber: null,
    confirmedAt: null,
  },
};
