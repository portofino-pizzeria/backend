import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { badRequest, notFound } from '../lib/http-errors.js';
import { createOrder, readOrderForCaller } from '../lib/order-service.js';

/** Digits a phone number must contain. See the `phone` rule below. */
export const MIN_PHONE_DIGITS = 6;

/**
 * Characters `String.prototype.trim` keeps that still render as nothing: soft
 * hyphen, zero-width space/joiners, LRM/RLM, the word joiner and invisible
 * operators, and the Hangul fillers. A name of only these reaches the kitchen
 * as a card that looks blank but is not flagged as missing.
 *
 * The Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) have to be named here:
 * they are general category Lo, a LETTER, so the READABLE rule below accepts
 * them. Measured — a U+3164 address passed that rule on its own.
 */
const INVISIBLE = /[\u00AD\u115F\u1160\u200B-\u200F\u2060-\u2064\u3164\uFFA0]/g;

/**
 * A required free-text field. Invisible characters are stripped and the rest
 * trimmed before the checks run, so neither whitespace nor zero-width
 * characters count as a value — and the stored value is the cleaned one.
 *
 * Every failure carries a German message, including the type and length
 * failures zod would otherwise report in English: the checkout shows this text
 * to the diner verbatim.
 */
function requiredText(max: number, message: string, tooLong: string) {
  return z
    .string({ required_error: message, invalid_type_error: message })
    .transform((value) => value.replace(INVISIBLE, '').trim())
    .pipe(z.string().min(1, message).max(max, tooLong));
}

/**
 * A value a person could read. INVISIBLE names the common zero-width
 * characters, but the set of code points that render as nothing is open-ended
 * (combining-mark-only strings, other format characters, ...).
 * Rather than chase that list, a name or address must contain at least one
 * letter or digit in any script.
 *
 * Deliberately NOT mirrored in the mobile checkout, which strips INVISIBLE and
 * trims but does not rely on Unicode property escapes in Hermes. For these
 * exotic inputs the diner sees this German refusal from the server instead of
 * a disabled button — the enforcement is here either way.
 */
const READABLE = /[\p{L}\p{N}]/u;

// A line names an item *and* the variant of it being bought. Prices live on
// the variant, so an item without a variant is not something the server can
// price — the door rejects it here rather than letting order-service guess.
const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        menuItemId: z
          .string({ required_error: 'Each item needs a menuItemId.' })
          .min(1, 'Each item needs a menuItemId.'),
        variantId: z
          .string({
            required_error:
              'Each item needs a variantId (which size or variant is being ordered).',
          })
          .min(1, 'Each item needs a variantId.'),
        quantity: z.number().int().min(1).max(50),
      }),
    )
    .min(1),
  // Lieferung or Abholung, as portofino-essen.de offers. Absent means delivery,
  // which is what every order was before pickup existed — so an older client
  // that sends no `fulfilment` keeps its meaning.
  fulfilment: z
    .enum(['delivery', 'pickup'], {
      errorMap: () => ({ message: 'Bitte Lieferung oder Abholung wählen.' }),
    })
    .default('delivery'),
  // A name and a phone number are required for BOTH: the kitchen calls about
  // either kind of order. These fields used to be optional, and an order with
  // everything blank was accepted, confirmed to the diner as "Zahlung
  // erhalten", and sent to the kitchen as a blank card. The address is required
  // for a delivery only — see the refinement below.
  //
  // Messages are German because the mobile checkout shows this text to the
  // diner verbatim.
  customer: z.object(
    {
      name: requiredText(200, 'Bitte einen Namen angeben.', 'Der Name ist zu lang (höchstens 200 Zeichen).').refine(
        (value) => READABLE.test(value),
        'Bitte einen Namen angeben.',
      ),
      phone: requiredText(
        50,
        'Bitte eine Telefonnummer angeben.',
        'Die Telefonnummer ist zu lang (höchstens 50 Zeichen).',
      ).refine(
        // A floor, not a format check: it rejects the placeholder ("+49 …")
        // and fat-fingered fragments without pretending to validate numbering
        // plans.
        (value) => (value.match(/\d/g) ?? []).length >= MIN_PHONE_DIGITS,
        'Bitte eine gültige Telefonnummer angeben.',
      ),
      // Optional at this layer; required for a delivery by the refinement on
      // the whole order. An empty or invisible-only address counts as absent.
      // `null` counts as absent too: a client sending `address: null` on a
      // pickup must not be refused for an address the order does not need.
      address: z.preprocess(
        (value) => (value === null ? undefined : value),
        z
          .string({ invalid_type_error: 'Bitte eine Lieferadresse angeben.' })
          .transform((value) => value.replace(INVISIBLE, '').trim())
          .optional(),
      ),
      notes: z.string().max(1000).optional(),
    },
    {
      required_error: 'Bitte Name, Telefonnummer und Lieferadresse angeben.',
      // `customer: null` or a non-object: same answer as a missing block.
      invalid_type_error: 'Bitte Name, Telefonnummer und Lieferadresse angeben.',
    },
  ),
}).superRefine((order, ctx) => {
  // The address matters only for a delivery. A pickup's address is discarded
  // before storage, so it is neither required nor length-checked.
  if (order.fulfilment !== 'delivery') return;
  const address = order.customer.address ?? '';
  if (!READABLE.test(address)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customer', 'address'],
      message: 'Bitte eine Lieferadresse angeben.',
    });
  } else if (address.length > 500) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customer', 'address'],
      message: 'Die Lieferadresse ist zu lang (höchstens 500 Zeichen).',
    });
  }
});

/**
 * The order access token, out of an `Authorization: Bearer` header — NOT out of
 * a query parameter (decision D3).
 *
 * A query parameter would be written straight into the CloudWatch request log
 * (Fastify's `req` serializer logs `url` on every incoming request), into
 * browser history via the web same-tab path's `history.replaceState`, and into
 * the `Referer` of anything the page links to. Those three leaks are precisely
 * what this capability exists to close, so the capability must not travel
 * through them.
 *
 * `null` means "the caller presented nothing" — an empty or malformed
 * `Authorization` header is treated as nothing rather than as a wrong guess, so
 * a proxy that strips or mangles the header degrades to the redacted read
 * instead of a 401.
 */
function bearerToken(header: string | undefined): string | null {
  const value = header ?? '';
  if (!value.startsWith('Bearer ')) return null;
  const token = value.slice(7).trim();
  return token.length > 0 ? token : null;
}

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/orders -> { order, accessToken }
  //
  // `accessToken` is returned exactly once, here (D3). Nothing else ever serves
  // it: not `GET /api/orders/:id`, not the kitchen board, not the Stripe return
  // URL.
  app.post('/api/orders', async (req) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid order.');
    }
    const { order, accessToken } = await createOrder(parsed.data);
    return { order, accessToken };
  });

  // GET /api/orders/:id -> { order }
  //
  // Split read (D3): with the order's access token in an `Authorization:
  // Bearer` header the customer block is included; without one it is withheld
  // and the response says so with `customerRedacted: true`; with a WRONG token
  // the read is refused 401. See `readOrderForCaller` for why those are three
  // outcomes rather than two.
  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req) => {
    const order = await readOrderForCaller(
      req.params.id,
      bearerToken(req.headers.authorization),
    );
    if (!order) throw notFound('Order not found.');
    return { order };
  });
}
