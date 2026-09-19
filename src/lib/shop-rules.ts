// The restaurant's rules as the request path sees them: one value, loaded once
// per request from `shop_profile`, `shop_weekly_hours` and `shop_special_days`.
//
// `src/lib/shop.ts` stays pure and takes this value as a required argument. It
// is required on purpose: a default would be a second source of truth, and the
// first time the owner edited a closing time the two would disagree — the
// exact drift `audience_profile/owner-operator` calls worse than no app at all.

import { asc } from 'drizzle-orm';

import { db } from '../db/client.js';
import {
  shopProfile,
  shopSpecialDays,
  shopWeeklyHours,
  type ShopProfileRow,
  type ShopSpecialDayRow,
  type ShopWeeklyHoursRow,
} from '../db/schema.js';
import { serviceUnavailable } from './http-errors.js';
import type { Window } from './shop.js';

/** Where and how to reach the shop. */
export interface ShopIdentity {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  /** Exactly as the shop prints it. */
  phoneDisplay: string;
  /** The same number, dialable — derived on the server from `phoneDisplay`. */
  phoneE164: string;
  timeZone: string;
}

/** The Impressum facts. Every one of them may legitimately be unknown. */
export interface ShopLegalFacts {
  legalOwnerName: string | null;
  legalForm: string | null;
  email: string | null;
  vatId: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  /** ISO timestamp of the last confirmed save, or `null`. */
  confirmedAt: string | null;
}

/**
 * One day that does not follow the weekly table. Exactly one of `date` and
 * `monthDay` is set; `open === null` on a recurring row means "the weekday's
 * normal opening" (D4), and `deliveryUntil === null` means "the shop-wide
 * delivery cut-off applies, clamped to this day's closing time".
 */
export interface SpecialDayRule {
  /** Absent on a draft row that has not been stored (`/preview`). */
  id?: number;
  date: string | null;
  monthDay: string | null;
  closed: boolean;
  open: string | null;
  close: string | null;
  deliveryUntil: string | null;
  /** German, shown to diners. */
  note: string;
  /** `false` = seeded default the owner has not confirmed yet. */
  confirmed: boolean;
}

/** Everything the hours logic needs to answer "is the shop open?". */
export interface ShopRules {
  shop: ShopIdentity;
  /** ISO weekday (1 = Monday … 7 = Sunday) -> window, or `null` = Ruhetag. */
  weekly: Record<number, Window | null>;
  /** The window a public holiday takes ("Sa, So u. Feiertage"). */
  holiday: Window;
  /** The last moment a delivery order is taken, unless a special day says otherwise. */
  deliveryUntil: string;
  /** While true, a Ruhetag stays closed on a public holiday (decision D1). */
  ruhetagBeatsHoliday: boolean;
  specialDays: SpecialDayRule[];
  legal: ShopLegalFacts;
}

/** The time zone every computation happens in. Not owner-editable. */
export const SHOP_TIME_ZONE = 'Europe/Berlin';

/** Build the rules value from the three tables' rows. */
export function rulesFromRows(
  profile: ShopProfileRow,
  weekly: ShopWeeklyHoursRow[],
  specialDays: ShopSpecialDayRow[],
): ShopRules {
  const week: Record<number, Window | null> = {};
  for (let weekday = 1; weekday <= 7; weekday += 1) week[weekday] = null;
  for (const row of weekly) {
    week[row.weekday] =
      row.open && row.close ? { open: row.open, close: row.close } : null;
  }

  return {
    shop: {
      name: profile.name,
      street: profile.street,
      postalCode: profile.postalCode,
      city: profile.city,
      phoneDisplay: profile.phoneDisplay,
      phoneE164: profile.phoneE164,
      timeZone: SHOP_TIME_ZONE,
    },
    weekly: week,
    holiday: { open: profile.holidayOpen, close: profile.holidayClose },
    deliveryUntil: profile.deliveryUntil,
    ruhetagBeatsHoliday: profile.ruhetagBeatsHoliday,
    specialDays: specialDays.map(specialDayRule),
    legal: {
      legalOwnerName: profile.legalOwnerName,
      legalForm: profile.legalForm,
      email: profile.email,
      vatId: profile.vatId,
      registerCourt: profile.registerCourt,
      registerNumber: profile.registerNumber,
      confirmedAt: profile.legalConfirmedAt
        ? profile.legalConfirmedAt.toISOString()
        : null,
    },
  };
}

export function specialDayRule(row: ShopSpecialDayRow): SpecialDayRule {
  return {
    id: row.id,
    date: row.date,
    monthDay: row.monthDay,
    closed: row.closed,
    open: row.open,
    close: row.close,
    deliveryUntil: row.deliveryUntil,
    note: row.note,
    confirmed: row.confirmed,
  };
}

/**
 * The sentence a diner reads when the rules cannot be loaded. Orders and the
 * payment re-check then fail CLOSED: an order taken for a kitchen whose hours
 * we could not read is the failure the owner cannot absorb, while a diner
 * turned away for a minute costs one order.
 */
const UNAVAILABLE =
  'Wir können die Öffnungszeiten gerade nicht prüfen und nehmen deshalb keine ' +
  'Bestellungen an. Bitte versuche es in ein paar Minuten noch einmal.';

/**
 * Read the shop's rules. One read per request — the route, the order service
 * and the payment re-check each call it once and pass the value down.
 *
 * Throws a 503 when the profile row is missing (a database that has never been
 * seeded) or the read fails. There is deliberately no fallback to the seeded
 * defaults here: that would answer with hours nobody in the restaurant chose.
 */
export async function loadShopRules(): Promise<ShopRules> {
  let profile: ShopProfileRow | undefined;
  let weekly: ShopWeeklyHoursRow[];
  let specialDays: ShopSpecialDayRow[];
  try {
    [[profile], weekly, specialDays] = await Promise.all([
      db.select().from(shopProfile),
      db.select().from(shopWeeklyHours).orderBy(asc(shopWeeklyHours.weekday)),
      db.select().from(shopSpecialDays).orderBy(asc(shopSpecialDays.id)),
    ]);
  } catch {
    throw serviceUnavailable(UNAVAILABLE);
  }

  if (!profile) throw serviceUnavailable(UNAVAILABLE);
  return rulesFromRows(profile, weekly, specialDays);
}
