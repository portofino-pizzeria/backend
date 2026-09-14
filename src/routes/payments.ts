import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config, stripeEnabled } from '../config.js';
import { now } from '../lib/clock.js';
import { badRequest, notFound } from '../lib/http-errors.js';
import { refusalFor, shopStatus } from '../lib/shop.js';
import { getOrder, markOrderPaid } from '../lib/order-service.js';
import { paymentProviders, startCheckout } from '../payments/index.js';
import { confirmStripeSession, parseWebhook } from '../payments/stripe.js';

const checkoutSchema = z.object({
  orderId: z.string().min(1),
  provider: z.enum(['stripe', 'paypal', 'mock']),
});

/** The order ids the API issues: `randomUUID()` in order-service. */
const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where "Zu deiner Bestellung" points, or null when there is no safe answer.
 * The id comes from the query string, so it must match the shape the service
 * issues before it may become a link — never loosen the pattern to "anything".
 */
function orderLink(orderId: string | undefined): string | null {
  const base = config.publicWebUrl.replace(/\/+$/, '');
  if (!base || !orderId || !ORDER_ID.test(orderId)) return null;
  return `${base}/order/${encodeURIComponent(orderId)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A small self-contained result page shown after (mock or real) checkout — in
// the app's in-app browser, the web popup, or, on the web's same-tab path, the
// app's own tab. Its one link leads back to the order it concerns.
function resultPage(opts: {
  emoji: string;
  title: string;
  sub: string;
  orderId?: string;
}): string {
  const link = orderLink(opts.orderId);
  const back = link
    ? `<a class="btn" href="${escapeHtml(link)}">Zu deiner Bestellung</a>
  <p class="hint">Du kannst dieses Fenster auch schließen – deine Bestellung aktualisiert sich von selbst.</p>`
    : `<p class="hint">Du kannst dieses Fenster jetzt schließen.</p>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(opts.title)}</title>
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
  .btn + .hint { margin-top: 16px; }
</style></head><body><div class="card">
  <div class="emoji">${escapeHtml(opts.emoji)}</div>
  <h1>${escapeHtml(opts.title)}</h1>
  <p>${escapeHtml(opts.sub)}</p>
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
    // The hours again, at the moment money is about to be taken. An order
    // created at 21:59 and paid at 22:20 would otherwise reach the kitchen as a
    // paid delivery after the last delivery time; after payment nothing can
    // refuse it.
    const refusal = refusalFor(order.fulfilment, shopStatus(now()));
    if (refusal) throw badRequest(refusal);

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
            title: 'Testzahlung abgeschlossen',
            sub: 'Es wurde kein Geld bewegt. Deine Bestellung ist bestätigt und geht in die Küche.',
            orderId: id,
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
              // The order screen's own words for `paid` (mobile
              // src/app/order/[id].tsx STATUS_COPY) — keep them identical.
              title: 'Zahlung erhalten',
              sub: 'Deine Bestellung ist bestätigt und geht in die Küche.',
              orderId,
            })
          : resultPage({
              emoji: '⏳',
              title: 'Zahlung wird bestätigt',
              sub: 'Wir bestätigen gerade deine Zahlung. Deine Bestellung aktualisiert sich von selbst.',
              orderId,
            }),
      );
    },
  );

  // Stripe cancel. Stripe's cancel_url carries the order id; a missing or
  // malformed one renders the page without a link — cancel never fails. The
  // copy promises no retry: the order screen offers no way to pay again yet.
  app.get<{ Querystring: { order_id?: string } }>(
    '/checkout/cancel',
    async (req, reply) =>
      reply.type('text/html').send(
        resultPage({
          emoji: '↩️',
          title: 'Bezahlung abgebrochen',
          sub: 'Es wurde nichts abgebucht. Deine Bestellung ist angelegt, aber noch nicht bezahlt, und wird erst nach der Bezahlung zubereitet.',
          orderId: req.query.order_id,
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
