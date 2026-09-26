import Stripe from 'stripe';

import { config, stripeEnabled } from '../config.js';
import { now } from '../lib/clock.js';
import type { Order } from '../types.js';

// One lazily-created client. Only constructed when a (test-mode) key is present,
// and rebuilt if the key changes (the test suite patches it at runtime).
let client: { key: string; stripe: Stripe } | null = null;
function stripe(): Stripe {
  if (!stripeEnabled()) throw new Error('Stripe is not configured.');
  const key = config.stripe.secretKey;
  if (client?.key !== key) client = { key, stripe: new Stripe(key) };
  return client.stripe;
}

function apiBase(): string {
  return config.publicApiUrl.replace(/\/$/, '');
}

/**
 * How long a hosted checkout stays payable. Stripe's default is 24 hours, which
 * would let a session opened before closing be paid the next day. 30 minutes is
 * Stripe's minimum: the checkout route refuses to open a session outside the
 * hours, and this bounds how far past them one can still be paid.
 */
const SESSION_TTL_SECONDS = 30 * 60;

/** Create a Stripe Checkout Session for an order and return its hosted URL. */
export async function createStripeCheckout(order: Order): Promise<string> {
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
    order.lines.map((l) => ({
      quantity: l.quantity,
      price_data: {
        currency: order.currency.toLowerCase(),
        unit_amount: l.unitPrice,
        // The extras are in `unit_amount`, so the Stripe receipt names them —
        // otherwise a diner reads "Margherita 9,40 €" for a 7,90 € pizza.
        product_data: {
          name: l.extras?.length
            ? `${l.name} + ${l.extras.map((e) => e.name).join(', ')}`
            : l.name,
        },
      },
    }));

  if (order.deliveryFee > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: order.currency.toLowerCase(),
        unit_amount: order.deliveryFee,
        product_data: { name: 'Delivery' },
      },
    });
  }

  const base = apiBase();
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    client_reference_id: order.id,
    metadata: { orderId: order.id },
    expires_at: Math.floor(now().getTime() / 1000) + SESSION_TTL_SECONDS,
    success_url: `${base}/checkout/return?order_id=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel?order_id=${encodeURIComponent(order.id)}`,
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL.');
  return session.url;
}

/**
 * A Checkout Session Stripe reports as paid, reduced to what confirming an
 * order needs. Only a session this API created counts: it must carry
 * `metadata.orderId`. `client_reference_id` alone is NOT accepted — a Stripe
 * Payment Link lets the payer set it in the URL, so paying for one cheap item
 * with `?client_reference_id=<another order>` would otherwise confirm that
 * order. The amount is checked against the order separately (`matchesOrder`).
 */
export interface PaidSession {
  sessionId: string;
  orderId: string;
  amountTotal: number | null;
  currency: string | null;
}

function paidSession(session: Stripe.Checkout.Session): PaidSession | null {
  const orderId = session.metadata?.orderId;
  if (session.payment_status !== 'paid' || !orderId) return null;
  return {
    sessionId: session.id,
    orderId,
    amountTotal: session.amount_total,
    currency: session.currency,
  };
}

/** Whether a paid session paid exactly this order's total, in its currency. */
export function matchesOrder(paid: PaidSession, order: Order): boolean {
  return (
    paid.orderId === order.id &&
    paid.amountTotal === order.total &&
    paid.currency?.toLowerCase() === order.currency.toLowerCase()
  );
}

/**
 * Retrieve a session directly from Stripe (used by the success return URL).
 * Verifying with Stripe — rather than trusting the redirect — means the "paid"
 * flip is authoritative even without webhooks. Null when it is not (yet) paid,
 * or when Stripe has no such session (the id comes from the query string).
 */
export async function retrievePaidSession(sessionId: string): Promise<PaidSession | null> {
  try {
    return paidSession(await stripe().checkout.sessions.retrieve(sessionId));
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError) return null;
    throw err;
  }
}

/**
 * Verify + parse a Stripe webhook (production-grade confirmation path).
 * Returns null when the signature does not verify — the caller answers 400, so
 * Stripe shows the delivery as failed rather than as a server error.
 */
export function parseWebhook(rawBody: Buffer, signature: string): Stripe.Event | null {
  if (!config.stripe.webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  }
  try {
    return stripe().webhooks.constructEvent(
      rawBody,
      signature,
      config.stripe.webhookSecret,
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeSignatureVerificationError) return null;
    throw err;
  }
}

/**
 * What a webhook event means for an order.
 *
 * `checkout.session.completed` fires when the diner finishes the hosted page,
 * which for a delayed method (SEPA debit) is BEFORE the money arrives: its
 * `payment_status` is then `unpaid`, and the confirmation comes later as
 * `checkout.session.async_payment_succeeded` — or never, as
 * `checkout.session.async_payment_failed`. Marking the order paid on
 * `completed` alone would send an unpaid order to the kitchen.
 */
export type WebhookOutcome =
  | { kind: 'paid'; session: PaidSession }
  | { kind: 'failed'; orderId: string | null; sessionId: string }
  | { kind: 'ignored' };

export function webhookOutcome(event: Stripe.Event): WebhookOutcome {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = paidSession(event.data.object);
      return session ? { kind: 'paid', session } : { kind: 'ignored' };
    }
    case 'checkout.session.async_payment_failed':
      return {
        kind: 'failed',
        orderId: event.data.object.metadata?.orderId ?? null,
        sessionId: event.data.object.id,
      };
    default:
      return { kind: 'ignored' };
  }
}
