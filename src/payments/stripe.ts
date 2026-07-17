import Stripe from 'stripe';

import { config, stripeEnabled } from '../config.js';
import type { Order } from '../types.js';

// One lazily-created client. Only constructed when a (test-mode) key is present.
let client: Stripe | null = null;
function stripe(): Stripe {
  if (!stripeEnabled) throw new Error('Stripe is not configured.');
  if (!client) client = new Stripe(config.stripe.secretKey);
  return client;
}

function apiBase(): string {
  return config.publicApiUrl.replace(/\/$/, '');
}

/** Create a Stripe Checkout Session for an order and return its hosted URL. */
export async function createStripeCheckout(order: Order): Promise<string> {
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
    order.lines.map((l) => ({
      quantity: l.quantity,
      price_data: {
        currency: order.currency.toLowerCase(),
        unit_amount: l.unitPrice,
        product_data: { name: l.name },
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
    success_url: `${base}/checkout/return?order_id=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel?order_id=${encodeURIComponent(order.id)}`,
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL.');
  return session.url;
}

/**
 * Confirm payment by retrieving the session directly from Stripe (used by the
 * success return URL). Verifying with Stripe — rather than trusting the redirect
 * — means the "paid" flip is authoritative even without webhooks.
 */
export async function confirmStripeSession(
  sessionId: string,
): Promise<{ orderId: string | null; paid: boolean }> {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  const orderId =
    (session.metadata?.orderId as string | undefined) ??
    session.client_reference_id ??
    null;
  return { orderId, paid: session.payment_status === 'paid' };
}

/** Verify + parse a Stripe webhook (production-grade confirmation path). */
export function parseWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  if (!config.stripe.webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  }
  return stripe().webhooks.constructEvent(
    rawBody,
    signature,
    config.stripe.webhookSecret,
  );
}
