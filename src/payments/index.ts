import { config, stripeEnabled } from '../config.js';
import type { Order, PaymentProvider } from '../types.js';
import { createMockCheckout } from './mock.js';
import { createStripeCheckout } from './stripe.js';

export interface CheckoutResult {
  url: string;
  provider: PaymentProvider;
}

/** What the app shows on the checkout screen (see mobile getPaymentProviders). */
export function paymentProviders() {
  return {
    stripe: stripeEnabled,
    paypal: false, // not integrated yet — the app falls back to mock
    mockFallback: true,
  };
}

/**
 * Start hosted checkout for an order. If the requested provider is configured
 * with real (test-mode) keys we use it; otherwise we fall back to a built-in
 * mock checkout that still completes the flow — exactly the behaviour the app's
 * "mock mode" copy describes.
 */
export async function startCheckout(
  order: Order,
  requested: PaymentProvider,
): Promise<CheckoutResult> {
  if (requested === 'stripe' && stripeEnabled) {
    const url = await createStripeCheckout(order);
    return { url, provider: 'stripe' };
  }

  // paypal isn't integrated, and stripe with no keys → mock.
  return { url: createMockCheckout(order), provider: 'mock' };
}

export { config };
