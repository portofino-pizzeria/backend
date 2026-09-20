// The owner's data-subject surface — `/api/admin/orders/*` (decision D5).
//
// Art. 15 (Auskunft) and Art. 17 (Löschung) requests arrive by phone, to the
// owner. Until this existed, answering one meant asking a developer to run SQL
// — which is not a process a restaurant can run inside the month the
// regulation allows.
//
// Behind `requireOwnerAuth`, the SAME guard `/api/admin/menu/*` uses: the
// owner's own credential, its own namespace, and it fails CLOSED on an unset
// `OWNER_MENU_TOKEN`. Deliberately not a third guard and deliberately not the
// kitchen's token — this surface reads and erases every diner's contact
// details, which is strictly more than a kitchen screen may do.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { badRequest } from '../lib/http-errors.js';
import { requireOwnerAuth } from '../lib/owner-auth.js';
import {
  findOrdersByPhone,
  forgetOrder,
  personalDataExtract,
} from '../lib/personal-data.js';

const searchQuerySchema = z.object({
  phone: z
    .string({ required_error: 'Bitte eine Telefonnummer angeben.' })
    .min(1, 'Bitte eine Telefonnummer angeben.')
    .max(50),
});

export async function adminPrivacyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireOwnerAuth);

  // GET /api/admin/orders/search?phone=… -> { orders }
  //
  // A phone number is the only identifier a caller can give over the phone:
  // there is no account, no email address and no password anywhere in this
  // system, and nobody reads out an order UUID.
  app.get<{ Querystring: { phone?: string } }>(
    '/api/admin/orders/search',
    async (req) => {
      const parsed = searchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues[0]?.message ?? 'Ungültige Suche.');
      }
      return { orders: await findOrdersByPhone(parsed.data.phone) };
    },
  );

  // GET /api/admin/orders/:id/personal-data -> the Art. 15 extract
  //
  // Everything held about one order, as JSON, including the German `hinweise`
  // naming what this extract cannot contain — Stripe's own record above all.
  // An access answer that quietly omits a second controller is incomplete.
  app.get<{ Params: { id: string } }>(
    '/api/admin/orders/:id/personal-data',
    async (req) => personalDataExtract(req.params.id),
  );

  // POST /api/admin/orders/:id/forget -> Art. 17
  //
  // NULLs the four customer columns and stamps `personal_data_erased_at`,
  // keeping the order, its lines and its totals so the books stay intact.
  // Refused on `paid` and `preparing` only — erasing the address of food the
  // kitchen is cooking would strand it. `pending_payment` is accepted: an
  // abandoned unpaid order never leaves that state except by a kitchen cancel,
  // so refusing it would make those orders permanently un-erasable.
  app.post<{ Params: { id: string } }>(
    '/api/admin/orders/:id/forget',
    async (req) => forgetOrder(req.params.id),
  );
}
