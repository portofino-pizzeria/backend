import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// The menu. `id` is a human-readable slug (e.g. "margherita") because the mobile
// app's UI Bridge ids are derived from it (menu-add-<id>).
export const menuItems = pgTable('menu_items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(), // MenuCategory
  price: integer('price').notNull(), // cents
  imageUrl: text('image_url'),
  vegetarian: boolean('vegetarian').notNull().default(false),
  spicy: boolean('spicy').notNull().default(false),
  available: boolean('available').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

// One row per placed order. Money fields are all integer cents.
export const orders = pgTable('orders', {
  id: text('id').primaryKey(), // uuid string, generated in app code
  subtotal: integer('subtotal').notNull(),
  deliveryFee: integer('delivery_fee').notNull(),
  total: integer('total').notNull(),
  currency: text('currency').notNull().default('EUR'),
  status: text('status').notNull().default('pending_payment'), // OrderStatus

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

// Line items, snapshotted at order time (name + unitPrice copied so historical
// orders are stable even if the menu later changes).
export const orderLines = pgTable('order_lines', {
  id: serial('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  menuItemId: text('menu_item_id').notNull(),
  name: text('name').notNull(),
  unitPrice: integer('unit_price').notNull(), // cents
  quantity: integer('quantity').notNull(),
});

export type MenuItemRow = typeof menuItems.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderLineRow = typeof orderLines.$inferSelect;
