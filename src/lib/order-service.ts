import { randomUUID } from 'node:crypto';

import { desc, eq, inArray } from 'drizzle-orm';

import { config } from '../config.js';
import { db } from '../db/client.js';
import {
  menuItems,
  orderLines,
  orders,
  type OrderLineRow,
  type OrderRow,
} from '../db/schema.js';
import type {
  CustomerInfo,
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
      name: l.name,
      unitPrice: l.unitPrice,
      quantity: l.quantity,
    })),
    subtotal: row.subtotal,
    deliveryFee: row.deliveryFee,
    total: row.total,
    currency: row.currency,
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
  items: { menuItemId: string; quantity: number }[];
  customer?: CustomerInfo;
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const items = input.items ?? [];
  if (items.length === 0) throw badRequest('Order must contain at least one item.');

  for (const it of items) {
    if (!it.menuItemId) throw badRequest('Each item needs a menuItemId.');
    if (!Number.isInteger(it.quantity) || it.quantity < 1) {
      throw badRequest(`Invalid quantity for ${it.menuItemId}.`);
    }
  }

  // Look up real prices from the DB — never trust client-supplied prices.
  const ids = [...new Set(items.map((i) => i.menuItemId))];
  const menu = await db
    .select()
    .from(menuItems)
    .where(inArray(menuItems.id, ids));
  const byId = new Map(menu.map((m) => [m.id, m]));

  const lines = items.map((it) => {
    const m = byId.get(it.menuItemId);
    if (!m) throw badRequest(`Unknown menu item: ${it.menuItemId}.`);
    if (!m.available) throw badRequest(`${m.name} is currently unavailable.`);
    return {
      menuItemId: m.id,
      name: m.name,
      unitPrice: m.price,
      quantity: it.quantity,
    };
  });

  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const deliveryFee = config.deliveryFeeCents;
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
      customerName: c.name ?? null,
      customerPhone: c.phone ?? null,
      customerAddress: c.address ?? null,
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
