import { config } from '../config.js';
import type { Order } from '../types.js';

// The mock "hosted checkout" is just a backend page the app opens in a browser.
// Visiting it confirms the (fake) payment and shows a friendly page — see the
// GET /checkout/mock handler in src/routes/payments.ts. No real money, no keys.
export function createMockCheckout(order: Order): string {
  const base = config.publicApiUrl.replace(/\/$/, '');
  return `${base}/checkout/mock?order_id=${encodeURIComponent(order.id)}`;
}
