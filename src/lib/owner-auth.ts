// The owner guard, shared by both editor surfaces (`/api/admin/menu/*` and
// `/api/admin/shop/*`).
//
// It lived in `routes/admin-menu.ts` while the menu was the only thing the
// owner could edit. Copying it into the shop routes would have made two
// guards that could drift on the one property that matters here, so it moved
// instead — and its German now names the editor generically, because it is one
// editor with two sections to the person using it.

import type { FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../config.js';
import { unauthorized } from './http-errors.js';
import { secretsMatch } from './secrets.js';

/**
 * **It fails CLOSED.**
 *
 * Decision D5 gave this surface its own credential and its own namespace: it
 * writes the allergens and prices a diner reads, and now also the opening
 * hours the server enforces and the address and phone number on the
 * Impressum. So an unset `OWNER_MENU_TOKEN` refuses every admin request
 * instead of opening the editor to the whole internet — a misconfigured
 * deployment loses the editor, never the restaurant's data.
 *
 * When D5 was taken, the kitchen guard (`routes/kitchen.ts`) was the contrast:
 * it skipped its check entirely when `KITCHEN_TOKEN` was unset. It no longer
 * does — it fails closed the same way, and shares `secretsMatch` — so the two
 * guards now differ only in WHICH secret they check, which is what D5 was
 * actually about.
 */
export async function requireOwnerAuth(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!config.ownerMenuToken) {
    throw unauthorized(
      'Der Inhaber-Editor ist auf diesem Server nicht freigeschaltet ' +
        '(OWNER_MENU_TOKEN ist nicht gesetzt). Änderungen werden abgelehnt.',
    );
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !secretsMatch(token, config.ownerMenuToken)) {
    throw unauthorized('Ungültiges Kennwort für den Inhaber-Editor.');
  }
}
