// Bootstraps the restaurant's own facts — address, phone, weekly hours, the
// holiday window and the two D4 special days — into a database that has none.
//
// Sibling of `seed.ts` and the same discipline: it writes ONCE, into an empty
// shop, in one transaction under an advisory lock. Everything after that
// belongs to the owner's editor. The marker here is the `shop_profile` row
// itself rather than a `dataset_seeds` entry: the profile is a singleton the
// shop cannot work without, so "is it there" is the same question.

import { count, sql as drizzleSql } from 'drizzle-orm';

import { DEFAULT_SHOP_RULES } from '../lib/shop-defaults.js';
import { db } from './client.js';
import { shopProfile, shopSpecialDays, shopWeeklyHours } from './schema.js';

/** The transaction handle drizzle passes to a `db.transaction` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialises every writer of the shop bootstrap for the length of its
 * transaction — two instances booting at once (a deploy overlapping the old
 * revision, an App Runner scale-out) would otherwise both see "no profile" and
 * both insert. Transaction-scoped, so a crashed process cannot leak it.
 */
async function lockShopSeed(tx: Tx): Promise<void> {
  await tx.execute(
    drizzleSql`select pg_advisory_xact_lock(hashtext('portofino:shop_profile:seed'))`,
  );
}

export type SeedShopOutcome = 'seeded' | 'owner-authored';

/**
 * Insert the defaults when, and only when, the `shop_profile` row is absent.
 *
 * Called from `initDatabase` on every boot (after `seedMenu()`) and from the
 * test harness after its per-test truncate. Never from a migration: the
 * harness truncates every public table before every test, so rows a migration
 * inserted would be gone before the first assertion — seeding from code is
 * what makes a fresh database and a test database reach the same state by the
 * same path.
 */
export async function seedShop(): Promise<SeedShopOutcome> {
  return db.transaction(async (tx): Promise<SeedShopOutcome> => {
    await lockShopSeed(tx);

    const [existing] = await tx.select({ n: count() }).from(shopProfile);
    if (Number(existing?.n ?? 0) > 0) return 'owner-authored';

    const rules = DEFAULT_SHOP_RULES;
    await tx.insert(shopProfile).values({
      id: 1,
      name: rules.shop.name,
      street: rules.shop.street,
      postalCode: rules.shop.postalCode,
      city: rules.shop.city,
      phoneDisplay: rules.shop.phoneDisplay,
      phoneE164: rules.shop.phoneE164,
      email: rules.legal.email,
      deliveryUntil: rules.deliveryUntil,
      holidayOpen: rules.holiday.open,
      holidayClose: rules.holiday.close,
      ruhetagBeatsHoliday: rules.ruhetagBeatsHoliday,
      legalOwnerName: rules.legal.legalOwnerName,
      legalForm: rules.legal.legalForm,
      vatId: rules.legal.vatId,
      registerCourt: rules.legal.registerCourt,
      registerNumber: rules.legal.registerNumber,
      version: 1,
    });

    await tx.insert(shopWeeklyHours).values(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
        const window = rules.weekly[weekday] ?? null;
        return { weekday, open: window?.open ?? null, close: window?.close ?? null };
      }),
    );

    if (rules.specialDays.length > 0) {
      await tx.insert(shopSpecialDays).values(
        rules.specialDays.map((day) => ({
          date: day.date,
          monthDay: day.monthDay,
          closed: day.closed,
          open: day.open,
          close: day.close,
          deliveryUntil: day.deliveryUntil,
          note: day.note,
          confirmed: day.confirmed,
        })),
      );
    }

    return 'seeded';
  });
}
