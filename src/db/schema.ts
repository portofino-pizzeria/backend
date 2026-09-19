import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Menu categories are data, not a closed union — the owner adds and reorders
// them from the editor rather than through a redeploy. `label` is German and
// authoritative; `labelEn` is a nullable addition.
export const menuCategories = pgTable('menu_categories', {
  id: text('id').primaryKey(), // human-readable slug, e.g. "pizza"
  label: text('label').notNull(), // German — authoritative
  labelEn: text('label_en'), // optional translation
  sortOrder: integer('sort_order').notNull().default(0),
});

// The allergen legend: code -> German label -> optional English label.
//
// `menu_items.allergen_codes` deliberately does NOT carry a foreign key into
// this table. Portofino's own menu prints codes we cannot resolve ("d", "i"),
// and an FK would make an unresolved code *unrepresentable* — forcing the menu
// loader to either drop it (silently hiding allergen information, the worst
// failure available on this surface) or invent a legal-sounding label. Storing
// the codes verbatim lets the read path resolve what it can and say "unbekannt"
// for the rest.
export const allergenLegend = pgTable('allergen_legend', {
  code: text('code').primaryKey(), // verbatim as printed, e.g. "a", "V", "1"
  labelDe: text('label_de').notNull(), // German — authoritative
  labelEn: text('label_en'), // optional translation
  sortOrder: integer('sort_order').notNull().default(0),
});

// The menu. `id` is a human-readable slug (e.g. "margherita") because the mobile
// app's UI Bridge ids are derived from it (menu-add-<id>).
//
// Content is German-authoritative: `name` / `description` are the German text
// as printed, `nameEn` / `descriptionEn` are nullable additions. A missing
// translation renders the German, never a gap. Item names are proper nouns and
// are not translated at all.
//
// There is no `price` column: a purchasable price belongs to a variant (see
// `menuItemVariants`), because most items on the real menu have two or three.
export const menuItems = pgTable('menu_items', {
  id: text('id').primaryKey(),
  // The number printed on the menu. Text, not an integer: "76a", "76b", "76c"
  // and "109a" are real item numbers. Nullable because an unnumbered item is a
  // fact about the source document, not a reason to invent a number.
  number: text('number'),
  name: text('name').notNull(), // German — authoritative
  nameEn: text('name_en'),
  description: text('description').notNull().default(''), // German — authoritative
  descriptionEn: text('description_en'),
  categoryId: text('category_id')
    .notNull()
    .references(() => menuCategories.id),
  // Allergen codes verbatim as printed on the menu, resolved against
  // `allergenLegend` at read time. See the comment on that table.
  allergenCodes: text('allergen_codes')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  imageUrl: text('image_url'),
  available: boolean('available').notNull().default(true),
  // Offers the restaurant sells only to diners who collect ("für
  // Selbstabholer"): an order containing one must be a pickup. Seeded from
  // `data/menu.json` `pickup.pickupOnlyOffers`.
  pickupOnly: boolean('pickup_only').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

// One row per real purchasable thing: "Margherita klein", "Margherita groß",
// "Schnitzel Schwein". A single-price item is a single variant. The price is
// NOT NULL, so "a size with no price" cannot be stored at all — and order lines
// reference a variant, so pricing stays server-side.
export const menuItemVariants = pgTable(
  'menu_item_variants',
  {
    id: text('id').primaryKey(), // slug, e.g. "margherita-gross"
    itemId: text('item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    label: text('label').notNull(), // German — "klein", "groß", "Blech", "Schwein"
    sortOrder: integer('sort_order').notNull().default(0),
    priceCents: integer('price_cents').notNull(),
  },
  (t) => ({
    itemIdx: index('menu_item_variants_item_id_idx').on(t.itemId),
    itemLabelUnique: uniqueIndex('menu_item_variants_item_id_label_unique').on(
      t.itemId,
      t.label,
    ),
  }),
);

// One row per placed order. Money fields are all integer cents.
export const orders = pgTable('orders', {
  id: text('id').primaryKey(), // uuid string, generated in app code
  subtotal: integer('subtotal').notNull(),
  deliveryFee: integer('delivery_fee').notNull(),
  total: integer('total').notNull(),
  currency: text('currency').notNull().default('EUR'),
  status: text('status').notNull().default('pending_payment'), // OrderStatus
  // 'delivery' | 'pickup'. Every order before pickup existed was a delivery,
  // so that is the default the migration backfills.
  fulfilment: text('fulfilment').notNull().default('delivery'),

  customerName: text('customer_name'),
  customerPhone: text('customer_phone'),
  customerAddress: text('customer_address'),
  customerNotes: text('customer_notes'),

  paymentProvider: text('payment_provider'), // PaymentProvider
  paymentReference: text('payment_reference'),
  paidAt: timestamp('paid_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Line items, snapshotted at order time (name, variant label and unitPrice
// copied so historical orders are stable even if the menu later changes — a
// past order still reads "Margherita, groß"). `menuItemId` / `variantId` are
// deliberately not foreign keys: the menu row may be edited away, and that must
// not rewrite or delete history.
export const orderLines = pgTable('order_lines', {
  id: serial('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  menuItemId: text('menu_item_id').notNull(),
  variantId: text('variant_id').notNull(),
  name: text('name').notNull(),
  variantLabel: text('variant_label').notNull(),
  unitPrice: integer('unit_price').notNull(), // cents
  quantity: integer('quantity').notNull(),
});

// One row per dataset that has been bootstrapped into this database, written
// in the same transaction as the bootstrap itself (see `seedMenu()` in
// seed.ts). Its presence means "this dataset was loaded once; from here on the
// rows belong to whoever edits them" — for `menu`, the owner's editor.
//
// It deliberately records only *that* and *when*, never a version or hash of
// the dataset file: a marker that compared datasets would reseed on the first
// edit to `data/menu.json` and erase every owner edit, which is exactly what
// this table exists to stop.
export const datasetSeeds = pgTable('dataset_seeds', {
  name: text('name').primaryKey(), // e.g. "menu"
  seededAt: timestamp('seeded_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- The restaurant's own facts --------------------------------------------
//
// These used to be code constants in `src/lib/shop.ts`, which meant that
// changing a closing time took a developer, a PR and a deploy. They are rows
// now, owned by the owner's editor. Nothing here is seeded by a migration: the
// test harness truncates every public table before every test, so
// migration-inserted rows would be invisible to the suite. `seedShop()`
// (src/db/seed-shop.ts) writes the defaults from code instead, so a fresh
// database and a test database reach the same state by the same path.
//
// Times are `HH:MM` wall-clock strings in Europe/Berlin — the same shape the
// API serves and the editor edits. They are deliberately not `time` columns:
// nothing here does date arithmetic in SQL, and a `time` round-trips through
// the driver as `22:30:00`, which would then have to be trimmed on the way out.

/**
 * The single row of shop-wide facts, `id = 1`. A CHECK pins the id, so "two
 * profiles" is unrepresentable rather than a race waiting to happen.
 *
 * `version` is the optimistic-concurrency counter for the WHOLE editor
 * (profile, weekly hours and special days alike): every write bumps it, and a
 * write that carries a stale one is refused with 409. One counter, because the
 * owner edits one restaurant from one phone and a second tab must not be able
 * to overwrite what the first just saved.
 */
export const shopProfile = pgTable(
  'shop_profile',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    street: text('street').notNull(),
    postalCode: text('postal_code').notNull(),
    city: text('city').notNull(),
    /** Exactly as the shop prints it, e.g. "02054 – 15 88 3". */
    phoneDisplay: text('phone_display').notNull(),
    /** The same number, dialable. Derived on the SERVER from `phoneDisplay`. */
    phoneE164: text('phone_e164').notNull(),
    /** Impressum contact. Written only by `PUT /api/admin/shop/legal`. */
    email: text('email'),
    /** "Lieferzeit bis 22.00 Uhr" — the last moment a delivery order is taken. */
    deliveryUntil: text('delivery_until').notNull(),
    /** "Sa, So u. Feiertage" — the window a public holiday takes. */
    holidayOpen: text('holiday_open').notNull(),
    holidayClose: text('holiday_close').notNull(),
    /** While true, a Ruhetag stays closed on a public holiday (decision D1). */
    ruhetagBeatsHoliday: boolean('ruhetag_beats_holiday').notNull().default(true),

    // The Impressum (§ 5 DDG). All nullable: none of these facts appears in any
    // document this repository can read, and inventing a legal name or a VAT id
    // would be worse than reporting the gap — which `/api/health` does.
    legalOwnerName: text('legal_owner_name'),
    legalForm: text('legal_form'),
    vatId: text('vat_id'),
    registerCourt: text('register_court'),
    registerNumber: text('register_number'),
    /** Stamped when the owner ticks "korrekt und vollständig". */
    legalConfirmedAt: timestamp('legal_confirmed_at', { withTimezone: true }),

    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    onlyRow: check('shop_profile_singleton', sql`${t.id} = 1`),
  }),
);

/**
 * One row per ISO weekday (1 = Monday … 7 = Sunday). `open` and `close` are
 * NULL **together** and mean Ruhetag — a CHECK makes "an opening time with no
 * closing time" impossible, because that state has no honest answer for a
 * diner asking whether the shop is open.
 */
export const shopWeeklyHours = pgTable(
  'shop_weekly_hours',
  {
    weekday: integer('weekday').primaryKey(),
    open: text('open'),
    close: text('close'),
  },
  (t) => ({
    weekdayRange: check(
      'shop_weekly_hours_weekday_range',
      sql`${t.weekday} between 1 and 7`,
    ),
    bothOrNeither: check(
      'shop_weekly_hours_both_or_neither',
      sql`(${t.open} is null) = (${t.close} is null)`,
    ),
  }),
);

/**
 * A day that does not follow the weekly table: either a one-off `date`
 * (`YYYY-MM-DD`) or a `month_day` (`MM-DD`) that recurs every year. Exactly one
 * of the two is set — a CHECK, because a row that is both or neither could not
 * be resolved against a calendar at all.
 *
 * `open` may be NULL only on a recurring row that is open, and means "the
 * weekday's normal opening" (decision D4: Heiligabend closes early but opens
 * when it always does). `confirmed` is false on the two seeded D4 rows until
 * the owner saves them once — the editor shows them as "Vorbelegt – bitte
 * prüfen", because no source states Portofino's real hours on those days.
 */
export const shopSpecialDays = pgTable(
  'shop_special_days',
  {
    id: serial('id').primaryKey(),
    date: text('date'),
    monthDay: text('month_day'),
    closed: boolean('closed').notNull().default(false),
    open: text('open'),
    close: text('close'),
    deliveryUntil: text('delivery_until'),
    note: text('note').notNull().default(''),
    confirmed: boolean('confirmed').notNull().default(true),
  },
  (t) => ({
    datedXorRecurring: check(
      'shop_special_days_date_xor_month_day',
      sql`(${t.date} is null) <> (${t.monthDay} is null)`,
    ),
    // An open day must say when it closes. `open` may be missing only on a
    // recurring row, where it means "the weekday's normal opening".
    openNeedsClose: check(
      'shop_special_days_open_needs_close',
      sql`${t.closed} or (${t.close} is not null and (${t.open} is not null or ${t.monthDay} is not null))`,
    ),
    // Partial, because the two columns are exclusive: one unique index over
    // both would let the same date in twice (NULLs never collide).
    dateUnique: uniqueIndex('shop_special_days_date_unique')
      .on(t.date)
      .where(sql`${t.date} is not null`),
    monthDayUnique: uniqueIndex('shop_special_days_month_day_unique')
      .on(t.monthDay)
      .where(sql`${t.monthDay} is not null`),
  }),
);

/**
 * The editor's history, one row per successful shop write. `before` and
 * `after` are WHOLE-SHOP snapshots rather than a diff, so one undo reverses
 * any kind of write — a week changed, a special day created, a profile saved —
 * with no per-entity replay logic to get wrong. The undo is itself recorded as
 * a change, which makes a second undo a redo.
 */
export const adminChanges = pgTable('admin_changes', {
  id: serial('id').primaryKey(),
  entity: text('entity').notNull(), // 'shop'
  before: jsonb('before'),
  after: jsonb('after'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export type MenuCategoryRow = typeof menuCategories.$inferSelect;
export type AllergenLegendRow = typeof allergenLegend.$inferSelect;
export type MenuItemRow = typeof menuItems.$inferSelect;
export type MenuItemVariantRow = typeof menuItemVariants.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;
export type ShopProfileRow = typeof shopProfile.$inferSelect;
export type ShopWeeklyHoursRow = typeof shopWeeklyHours.$inferSelect;
export type ShopSpecialDayRow = typeof shopSpecialDays.$inferSelect;
