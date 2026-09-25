import { randomBytes, randomUUID } from 'node:crypto';

import { and, desc, eq, inArray } from 'drizzle-orm';

import { config } from '../config.js';
import { now } from './clock.js';
import { loadShopRules } from './shop-rules.js';
import { secretsMatch } from './secrets.js';
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
  CreatedOrder,
  CustomerInfo,
  Fulfilment,
  Order,
  OrderStatus,
  PaymentProvider,
} from '../types.js';
import { badRequest, notFound, unauthorized } from './http-errors.js';

/**
 * Mint an order access token (decision D3): 32 bytes of CSPRNG randomness,
 * base64url so it survives a header, a URL and a JSON string unescaped.
 *
 * 256 bits is far more than the 122 a UUID carries, and deliberately so — this
 * value IS the authorisation, where the id is merely a name.
 */
export function newOrderAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

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

/**
 * The same order with the customer block withheld and the withholding declared
 * (decision D3). See `Order.customerRedacted` for why the flag is not optional
 * in spirit: silently omitting the block is indistinguishable from an order
 * that has none, and the app renders that as an error.
 */
export function redactCustomer(order: Order): Order {
  const { customer: _withheld, ...rest } = order;
  return { ...rest, customerRedacted: true };
}

/**
 * The read behind `GET /api/orders/:id` (decision D3).
 *
 * Three outcomes, deliberately distinct:
 *
 * - **No token presented** → the non-personal order, `customerRedacted: true`.
 *   This is the shape every pre-D3 client, every second device and every
 *   browser that cleared its site data gets. It is a degradation, not a
 *   refusal: status, lines, totals, fulfilment and timestamps are all there.
 * - **The right token** → the full order, customer block included.
 * - **A token that is presented and WRONG** → `401`. A caller that produced a
 *   credential and got it wrong is not the same as one that produced none, and
 *   answering it with the redacted shape would quietly mask a client bug (a
 *   stale token in device storage) as a privacy feature.
 *
 * An unknown id is `null` here and `404` at the route — the pre-existing
 * behaviour, unchanged. The id is an unguessable UUID, so the 404 leaks
 * nothing a request for a known id would not.
 */
export async function readOrderForCaller(
  id: string,
  presentedToken: string | null,
): Promise<Order | null> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) return null;

  const order = serializeOrder(row, await loadLines(id));
  if (presentedToken === null) return redactCustomer(order);

  // Constant-time, via the same helper the kitchen and owner guards use — a
  // `===` here would be a timing oracle on a live capability.
  if (!secretsMatch(presentedToken, row.accessToken)) {
    throw unauthorized(
      'Dieser Bestell-Zugangsschlüssel ist ungültig. Öffne die Bestellung auf dem Gerät, ' +
        'mit dem du sie aufgegeben hast.',
    );
  }

  return order;
}

export interface CreateOrderInput {
  items: { menuItemId: string; variantId: string; quantity: number }[];
  /** Defaults to delivery, the only kind of order before pickup existed. */
  fulfilment?: Fulfilment;
  customer?: CustomerInfo;
}

export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const items = input.items ?? [];
  if (items.length === 0) throw badRequest('Order must contain at least one item.');
  const fulfilment: Fulfilment = input.fulfilment ?? 'delivery';

  // Opening hours first: a closed kitchen refuses every order, whatever is in
  // it. A delivery after the day's last delivery time is refused with the
  // pickup alternative named, because the shop is still open for collection.
  // The rules are read here, once per order, from the rows the owner edits —
  // and an unreadable shop is a 503, never an accepted order (shop-rules.ts).
  const rules = await loadShopRules();
  const refusal = refusalFor(fulfilment, shopStatus(rules, now()));
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
  const accessToken = newOrderAccessToken();
  const c = input.customer ?? {};

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id,
      accessToken,
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
  // The one and only time the access token leaves the server (D3). The caller
  // is the device that just typed the name, phone and address into the form,
  // so handing it the capability to read them back costs nothing it did not
  // already hold.
  return { order: created, accessToken };
}

/**
 * Mark an order paid (idempotent — safe to call from both return-URL + webhook).
 *
 * Only advances out of `pending_payment`, and the check is IN the UPDATE, not a
 * read before it: a kitchen cancel landing between a read and a write would
 * otherwise be overwritten by `paid`. `advanced` says whether this call moved
 * the order, so a caller can tell "paid now" from "was already something else".
 */
export async function markOrderPaid(
  id: string,
  provider: PaymentProvider,
  reference?: string,
): Promise<{ order: Order; advanced: boolean }> {
  const moved = await db
    .update(orders)
    .set({
      status: 'paid',
      paymentProvider: provider,
      ...(reference ? { paymentReference: reference } : {}),
      paidAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(orders.id, id), eq(orders.status, 'pending_payment')))
    .returning({ id: orders.id });

  const order = await getOrder(id);
  if (!order) throw notFound('Order not found.');
  return { order, advanced: moved.length > 0 };
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
