import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config, mockPaymentsAllowed, paymentsMode, stripeEnabled } from '../config.js';
import { now } from '../lib/clock.js';
import { badRequest, notFound, serviceUnavailable } from '../lib/http-errors.js';
import { loadShopRules } from '../lib/shop-rules.js';
import { refusalFor, shopStatus } from '../lib/shop.js';
import { getOrder, markOrderPaid } from '../lib/order-service.js';
import { paymentProviders, startCheckout } from '../payments/index.js';
import {
  matchesOrder,
  parseWebhook,
  retrievePaidSession,
  webhookOutcome,
  type PaidSession,
} from '../payments/stripe.js';

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
  /* The tenant's declared palette (domain_spec/visual-system; mobile
     src/constants/theme.ts), light-only as the design is. A label on the gold
     fill is ink, never white: white on #d4a574 is 2.23:1 and fails AA. */
  :root { color-scheme: light; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px;
    background: #ffffff; color: #1a1a1a; }
  .card { max-width: 420px; text-align: center; }
  .emoji { font-size: 64px; line-height: 1; }
  h1 { font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
    font-size: 22px; margin: 16px 0 8px; }
  p { color: #666666; margin: 0 0 20px; }
  /* THE BORDER IS NOT DECORATION. The gold fill measures 2.01:1 against the
     cream and 2.23:1 against this white ground, and the link carries no
     underline, so the fill was the only thing saying "this is a control" —
     WCAG 2.2 SC 1.4.11 wants 3:1 for the boundary of one. The edge is the
     design's --chart-2 brown darkened to clear AA (mobile theme.ts calls it
     brandText): 5.04:1 here. Text contrast is unaffected — the ink label
     stays at 7.82:1 on the gold. */
  .btn { display: inline-block; background: #d4a574; color: #1a1a1a; text-decoration: none;
    border: 1px solid #826b4f;
    padding: 12px 20px; border-radius: 8px; font-weight: 600;
    transition: background-color 150ms; }
  .btn:hover, .btn:active { background: #c49464; }
  /* The page's one control, and a keyboard had nothing to go on. Ink reads
     unambiguously on both the gold and the white, so one ring serves wherever
     focus lands. */
  .btn:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 3px; }
  .hint { font-size: 14px; }
  .btn + .hint { margin-top: 16px; }
</style></head><body><div class="card">
  <div class="emoji">${escapeHtml(opts.emoji)}</div>
  <h1>${escapeHtml(opts.title)}</h1>
  <p>${escapeHtml(opts.sub)}</p>
  ${back}
</div></body></html>`;
}

/**
 * Mark an order paid from a session Stripe says is paid — only when that
 * session paid THIS order's total. Returns whether the order is now paid.
 *
 * Both confirmation paths (the return page and the webhook) come through here
 * and record the SESSION id, so `paymentReference` is the same whichever lands
 * first, and is what the Stripe dashboard searches by for a refund.
 */
async function settle(log: FastifyBaseLogger, paid: PaidSession): Promise<boolean> {
  let order = await getOrder(paid.orderId);
  if (!order) {
    // e.g. a `stripe trigger` test event.
    log.warn({ sessionId: paid.sessionId, orderId: paid.orderId }, 'stripe: paid session for an unknown order');
    return false;
  }
  if (!matchesOrder(paid, order)) {
    log.error(
      {
        sessionId: paid.sessionId,
        orderId: order.id,
        paid: { amount: paid.amountTotal, currency: paid.currency },
        expected: { amount: order.total, currency: order.currency },
      },
      'stripe: paid session does not match the order total — NOT marking paid',
    );
    return false;
  }
  if (order.status === 'pending_payment') {
    const result = await markOrderPaid(order.id, 'stripe', paid.sessionId);
    if (result.advanced) return true;
    // Lost a race (the other confirmation path, or a kitchen cancel): judge
    // the order as it is now.
    order = result.order;
  }
  // Already confirmed by the other path (return page vs webhook).
  if (order.payment?.reference === paid.sessionId) return order.status !== 'cancelled';
  // Money arrived for an order no longer awaiting it (e.g. the kitchen
  // cancelled it first). The order is left alone; refund from the dashboard.
  log.error(
    { sessionId: paid.sessionId, orderId: order.id, status: order.status },
    'stripe: payment received for an order that is not awaiting payment — refund it',
  );
  return false;
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
    const rules = await loadShopRules();
    const refusal = refusalFor(order.fulfilment, shopStatus(rules, now()));
    if (refusal) throw badRequest(refusal);

    return startCheckout(order, parsed.data.provider);
  });

  // --- Hosted checkout result pages (opened in the app's browser) ----------

  // Mock checkout: visiting the page confirms the (fake) payment. It does not
  // exist once a real provider is configured — see `mockPaymentsAllowed`.
  app.get<{ Querystring: { order_id?: string } }>(
    '/checkout/mock',
    async (req, reply) => {
      if (!mockPaymentsAllowed()) throw notFound('Not found.');
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
      if (stripeEnabled()) {
        const session = await retrievePaidSession(sessionId);
        // The query names the order; the session must be for that same one.
        paid = !!session && session.orderId === orderId && (await settle(req.log, session));
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
      // Without both secrets no event can be verified, so this comes before the
      // signature check. 503, not a thrown 500: if an endpoint IS registered in
      // Stripe, Stripe retries a failed event for up to ~3 days, so wiring the
      // secret in that window still confirms the orders. `warn`, not `error`:
      // the route is public, and boot + deploy already carry the loud signal.
      if (paymentsMode() !== 'stripe') {
        req.log.warn(
          { payments: paymentsMode() },
          'stripe: webhook received but STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are not both set',
        );
        throw serviceUnavailable('Stripe webhook is not configured.');
      }
      const sig = req.headers['stripe-signature'];
      if (!sig || typeof sig !== 'string') throw badRequest('Missing signature.');

      const event = parseWebhook(req.body as Buffer, sig);
      if (!event) throw badRequest('Invalid signature.');
      // Always acknowledged once the signature verifies: an error status would
      // make Stripe redeliver the event for days without changing the outcome.
      const outcome = webhookOutcome(event);
      if (outcome.kind === 'paid') {
        await settle(req.log, outcome.session);
      } else if (outcome.kind === 'failed') {
        req.log.warn(
          { sessionId: outcome.sessionId, orderId: outcome.orderId },
          'stripe: delayed payment failed — order stays unpaid',
        );
      }
      return reply.send({ received: true });
    });
  });
}
