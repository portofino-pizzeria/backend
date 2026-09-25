import { config, mockPaymentsAllowed, stripeEnabled } from '../config.js';
import { badRequest } from '../lib/http-errors.js';
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
    stripe: stripeEnabled(),
    paypal: false, // not integrated yet — served by the mock while that is allowed
    // False once Stripe is live: the mock would hand out free orders. The app's
    // checkout offers PayPal only while this (or `paypal`) is true.
    mockFallback: mockPaymentsAllowed(),
  };
}

/**
 * Start hosted checkout for an order.
 *
 * With Stripe configured, only Stripe is payable: `mock` and the
 * not-yet-integrated `paypal` are REFUSED, because both are served by the mock,
 * which confirms a payment without taking one. With no provider configured
 * (local dev, a pre-keys staging link) every request falls back to the mock so
 * the order -> pay -> kitchen flow still completes.
 */
export async function startCheckout(
  order: Order,
  requested: PaymentProvider,
): Promise<CheckoutResult> {
  if (stripeEnabled()) {
    if (requested !== 'stripe') {
      throw badRequest('Diese Zahlungsart ist nicht verfügbar. Bitte mit Karte (Stripe) bezahlen.');
    }
    const url = await createStripeCheckout(order);
    return { url, provider: 'stripe' };
  }

  if (!mockPaymentsAllowed()) {
    // Unreachable today (mock is allowed exactly when Stripe is off); kept so a
    // future provider cannot silently re-open the mock by changing one rule.
    throw badRequest('Keine Zahlungsart verfügbar.');
  }
  return { url: createMockCheckout(order), provider: 'mock' };
}

export { config };
