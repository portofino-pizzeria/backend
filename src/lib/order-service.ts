import { randomUUID } from 'node:crypto';

import { desc, eq, inArray } from 'drizzle-orm';

import { config } from '../config.js';
import { now } from './clock.js';
import { refusalFor, shopStatus } from './shop.js';
import { db } from '../db/client.js';
import {
  menuItemVariants,
  menuItems,
  orderLines,
  orders,
  type OrderLineRow,
  type OrderRow,
} from '../db/schema.js';
import type {
  CustomerInfo,
  Fulfilment,
  Order,
  OrderStatus,
  PaymentProvider,
} from '../types.js';
import { badRequest, notFound } from './http-errors.js';

/** Turn DB rows into the public Order shape the mobile app expects. */
export function serializeOrder(row: OrderRow, lines: OrderLineRow[]): Order {
  const customer: CustomerInfo = {};
  if (row.customerName) customer.name = row.customerName;
  if (row.customerPhone) customer.phone = row.customerPhone;
  if (row.customerAddress) customer.address = row.customerAddress;
  if (row.customerNotes) customer.notes = row.customerNotes;

  const order: Order = {
    id: row.id,
    lines: lines.map((l) => ({
      menuItemId: l.menuItemId,
      variantId: l.variantId,
      name: l.name,
      variantLabel: l.variantLabel,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
    })),
    subtotal: row.subtotal,
    deliveryFee: row.deliveryFee,
    total: row.total,
    currency: row.currency,
    fulfilment: row.fulfilment === 'pickup' ? 'pickup' : 'delivery',
    status: row.status as OrderStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };

  if (Object.keys(customer).length > 0) order.customer = customer;

  if (row.paymentProvider) {
    order.payment = { provider: row.paymentProvider as PaymentProvider };
    if (row.paymentReference) order.payment.reference = row.paymentReference;
    if (row.paidAt) order.payment.paidAt = row.paidAt.toISOString();
  }

  return order;
}

async function loadLines(orderId: string): Promise<OrderLineRow[]> {
  return db.select().from(orderLines).where(eq(orderLines.orderId, orderId));
}

export async function getOrder(id: string): Promise<Order | null> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) return null;
  return serializeOrder(row, await loadLines(id));
}

export interface CreateOrderInput {
  items: { menuItemId: string; variantId: string; quantity: number }[];
  /** Defaults to delivery, the only kind of order before pickup existed. */
  fulfilment?: Fulfilment;
  customer?: CustomerInfo;
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const items = input.items ?? [];
  if (items.length === 0) throw badRequest('Order must contain at least one item.');
  const fulfilment: Fulfilment = input.fulfilment ?? 'delivery';

  // Opening hours first: a closed kitchen refuses every order, whatever is in
  // it. A delivery after DELIVERY_UNTIL is refused with the pickup alternative
  // named, because the shop is still open for collection.
  const refusal = refusalFor(fulfilment, shopStatus(now()));
  if (refusal) throw badRequest(refusal);

  for (const it of items) {
    if (!it.menuItemId) throw badRequest('Each item needs a menuItemId.');
    if (!it.variantId) {
      throw badRequest(`Each item needs a variantId (${it.menuItemId}).`);
    }
    if (!Number.isInteger(it.quantity) || it.quantity < 1) {
      throw badRequest(`Invalid quantity for ${it.menuItemId}.`);
    }
  }

  // Look up real prices from the DB — never trust client-supplied prices. The
  // price lives on the variant, so an order that does not name a resolvable
  // variant of the item it claims is rejected outright; there is no fallback
  // price to fall back to, and inventing one would charge a diner the wrong
  // amount.
  const ids = [...new Set(items.map((i) => i.menuItemId))];
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const [menu, variants] = await Promise.all([
    db.select().from(menuItems).where(inArray(menuItems.id, ids)),
    db
      .select()
      .from(menuItemVariants)
      .where(inArray(menuItemVariants.id, variantIds)),
  ]);
  const byId = new Map(menu.map((m) => [m.id, m]));
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const lines = items.map((it) => {
    const m = byId.get(it.menuItemId);
    if (!m) throw badRequest(`Unknown menu item: ${it.menuItemId}.`);
    if (!m.available) throw badRequest(`${m.name} is currently unavailable.`);
    const v = variantById.get(it.variantId);
    if (!v) throw badRequest(`Unknown variant: ${it.variantId}.`);
    if (v.itemId !== m.id) {
      throw badRequest(`Variant ${v.id} does not belong to ${m.name}.`);
    }
    if (m.pickupOnly && fulfilment !== 'pickup') {
      throw badRequest(`${m.name} gibt es nur für Selbstabholer. Bitte Abholung wählen.`);
    }
    return {
      menuItemId: m.id,
      variantId: v.id,
      name: m.name,
      variantLabel: v.label,
      unitPrice: v.priceCents,
      quantity: it.quantity,
    };
  });

  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const deliveryFee = fulfilment === 'delivery' ? config.deliveryFeeCents : 0;
  const total = subtotal + deliveryFee;

  const id = randomUUID();
  const c = input.customer ?? {};

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id,
      subtotal,
      deliveryFee,
      total,
      currency: config.currency,
      status: 'pending_payment',
      fulfilment,
      customerName: c.name ?? null,
      customerPhone: c.phone ?? null,
      // A pickup stores no address even if a client sent one: the kitchen card
      // must not show a delivery address for food nobody delivers.
      customerAddress: fulfilment === 'delivery' ? (c.address ?? null) : null,
      customerNotes: c.notes ?? null,
    });
    await tx.insert(orderLines).values(
      lines.map((l) => ({ orderId: id, ...l })),
    );
  });

  const created = await getOrder(id);
  if (!created) throw new Error('Order vanished immediately after creation.');
  return created;
}

/** Mark an order paid (idempotent — safe to call from both return-URL + webhook). */
export async function markOrderPaid(
  id: string,
  provider: PaymentProvider,
  reference?: string,
): Promise<Order> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw notFound('Order not found.');

  // Only advance out of pending_payment once; don't clobber a later state
  // (e.g. the kitchen already moved it to "preparing").
  if (row.status === 'pending_payment') {
    await db
      .update(orders)
      .set({
        status: 'paid',
        paymentProvider: provider,
        paymentReference: reference ?? row.paymentReference,
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, id));
  }

  const updated = await getOrder(id);
  return updated!;
}

// --- Kitchen operations ----------------------------------------------------

const KITCHEN_ACTIVE: OrderStatus[] = ['paid', 'preparing', 'ready'];

/** Allowed forward transitions the kitchen can drive. Cancel is allowed from
 *  any non-terminal state. */
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['cancelled'],
  paid: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: [],
  cancelled: [],
};

export async function listKitchenOrders(scope: 'active' | 'all'): Promise<Order[]> {
  const rows =
    scope === 'all'
      ? await db.select().from(orders).orderBy(desc(orders.createdAt))
      : await db
          .select()
          .from(orders)
          .where(inArray(orders.status, KITCHEN_ACTIVE))
          .orderBy(desc(orders.createdAt));

  return Promise.all(rows.map((r) => loadLines(r.id).then((l) => serializeOrder(r, l))));
}

export async function setOrderStatus(
  id: string,
  next: OrderStatus,
): Promise<Order> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw notFound('Order not found.');

  const current = row.status as OrderStatus;
  if (current === next) return (await getOrder(id))!;
  if (!NEXT[current].includes(next)) {
    throw badRequest(`Cannot move an order from "${current}" to "${next}".`);
  }

  await db
    .update(orders)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(orders.id, id));

  return (await getOrder(id))!;
}
