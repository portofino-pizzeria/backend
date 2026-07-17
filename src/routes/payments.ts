import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config, stripeEnabled } from '../config.js';
import { badRequest, notFound } from '../lib/http-errors.js';
import { getOrder, markOrderPaid } from '../lib/order-service.js';
import { paymentProviders, startCheckout } from '../payments/index.js';
import { confirmStripeSession, parseWebhook } from '../payments/stripe.js';

const checkoutSchema = z.object({
  orderId: z.string().min(1),
  provider: z.enum(['stripe', 'paypal', 'mock']),
});

// A small self-contained result page shown inside the app's in-app browser
// after (mock or real) checkout. Links back to the web app if configured.
function resultPage(opts: {
  emoji: string;
  title: string;
  sub: string;
}): string {
  const back = config.publicWebUrl
    ? `<a class="btn" href="${config.publicWebUrl}">Return to Portofino</a>`
    : `<p class="hint">You can close this window and return to the app.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${opts.title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px;
    background: #faf7f2; color: #1c1917; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #faf7f2; } }
  .card { max-width: 420px; text-align: center; }
  .emoji { font-size: 64px; line-height: 1; }
  h1 { font-size: 22px; margin: 16px 0 8px; }
  p { color: #78716c; margin: 0 0 20px; }
  .btn { display: inline-block; background: #1c1917; color: #faf7f2; text-decoration: none;
    padding: 12px 20px; border-radius: 12px; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .btn { background: #faf7f2; color: #1c1917; } }
  .hint { font-size: 14px; }
</style></head><body><div class="card">
  <div class="emoji">${opts.emoji}</div>
  <h1>${opts.title}</h1>
  <p>${opts.sub}</p>
  ${back}
</div></body></html>`;
}

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/payments/providers -> { stripe, paypal, mockFallback }
  app.get('/api/payments/providers', async () => paymentProviders());

  // POST /api/payments/checkout -> { url, provider }
  app.post('/api/payments/checkout', async (req) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid checkout request.');

    const order = await getOrder(parsed.data.orderId);
    if (!order) throw notFound('Order not found.');
    if (order.status !== 'pending_payment') {
      throw badRequest('This order has already been paid or is not payable.');
    }

    return startCheckout(order, parsed.data.provider);
  });

  // --- Hosted checkout result pages (opened in the app's browser) ----------

  // Mock checkout: visiting the page confirms the (fake) payment.
  app.get<{ Querystring: { order_id?: string } }>(
    '/checkout/mock',
    async (req, reply) => {
      const id = req.query.order_id;
      if (!id) throw badRequest('Missing order_id.');
      await markOrderPaid(id, 'mock', `mock_${Date.now()}`);
      return reply
        .type('text/html')
        .send(
          resultPage({
            emoji: '✅',
            title: 'Payment complete',
            sub: 'This was a test payment — no money changed hands. Your order is confirmed.',
          }),
        );
    },
  );

  // Stripe success return: verify with Stripe, then mark paid.
  app.get<{ Querystring: { order_id?: string; session_id?: string } }>(
    '/checkout/return',
    async (req, reply) => {
      const { order_id: orderId, session_id: sessionId } = req.query;
      if (!orderId || !sessionId) throw badRequest('Missing order_id/session_id.');

      let paid = false;
      if (stripeEnabled) {
        const result = await confirmStripeSession(sessionId);
        paid = result.paid && result.orderId === orderId;
        if (paid) await markOrderPaid(orderId, 'stripe', sessionId);
      }

      return reply.type('text/html').send(
        paid
          ? resultPage({
              emoji: '✅',
              title: 'Payment received',
              sub: 'Thank you! Your order is confirmed and heading to the kitchen.',
            })
          : resultPage({
              emoji: '⏳',
              title: 'Finishing up',
              sub: 'We’re confirming your payment. Head back to the app — your order will update automatically.',
            }),
      );
    },
  );

  // Stripe cancel.
  app.get('/checkout/cancel', async (_req, reply) =>
    reply.type('text/html').send(
      resultPage({
        emoji: '↩️',
        title: 'Checkout cancelled',
        sub: 'No payment was taken. You can return to the app and try again.',
      }),
    ),
  );

  // --- Stripe webhook (production-grade confirmation) ----------------------
  // Encapsulated so the raw-body parser only applies to this route.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );

    scope.post('/webhooks/stripe', async (req, reply) => {
      const sig = req.headers['stripe-signature'];
      if (!sig || typeof sig !== 'string') throw badRequest('Missing signature.');

      const event = parseWebhook(req.body as Buffer, sig);
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as { metadata?: { orderId?: string }; client_reference_id?: string | null };
        const orderId = session.metadata?.orderId ?? session.client_reference_id ?? null;
        if (orderId) await markOrderPaid(orderId, 'stripe', event.id);
      }
      return reply.send({ received: true });
    });
  });
}
