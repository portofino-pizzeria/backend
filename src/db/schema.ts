import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
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

  // The capability that unlocks the customer block on `GET /api/orders/:id`
  // (decision D3). 32 bytes of CSPRNG randomness, base64url, minted at
  // creation and returned exactly once — in the `POST /api/orders` response,
  // to the device that placed the order.
  //
  // It exists because the order ID cannot be the secret: the ID is already in
  // Stripe metadata and `client_reference_id`, in the payment return and cancel
  // URLs, in browser history and on the kitchen board. A capability that leaks
  // through five surfaces is not a capability.
  //
  // It is NEVER serialized into an `Order` — see `serializeOrder`, which does
  // not read this column.
  accessToken: text('access_token').notNull(),

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

export type MenuCategoryRow = typeof menuCategories.$inferSelect;
export type AllergenLegendRow = typeof allergenLegend.$inferSelect;
export type MenuItemRow = typeof menuItems.$inferSelect;
export type MenuItemVariantRow = typeof menuItemVariants.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;
