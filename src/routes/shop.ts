import type { FastifyInstance } from 'fastify';

import { now } from '../lib/clock.js';
import { legalMissingFields } from '../lib/legal-status.js';
import { loadShopRules, type ShopLegalFacts } from '../lib/shop-rules.js';
import { displayHours, shopStatus, upcomingSpecialDays } from '../lib/shop.js';
import type { ShopLegal } from '../types.js';

/** How far ahead diners are told about special days. */
const SPECIAL_DAYS_AHEAD = 30;

/**
 * The Impressum block. `vatId` and the register fields are omitted when unset
 * — for an Einzelunternehmen they do not apply, and `null` on the page would
 * read as "missing" rather than "not applicable".
 */
function publicLegal(legal: ShopLegalFacts): ShopLegal {
  const missing = legalMissingFields(legal);
  return {
    ownerName: legal.legalOwnerName,
    legalForm: legal.legalForm,
    email: legal.email,
    ...(legal.vatId ? { vatId: legal.vatId } : {}),
    ...(legal.registerCourt ? { registerCourt: legal.registerCourt } : {}),
    ...(legal.registerNumber ? { registerNumber: legal.registerNumber } : {}),
    complete: missing.length === 0,
    missing,
  };
}

export async function shopRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/shop -> the address, phone, printed hours, the special days a
  // diner should know about, the legal notice, and whether pickup and delivery
  // orders are taken right now. The app renders this status rather than
  // computing its own, so the diner sees the same answer the order route will
  // enforce — and both now come from the same rows the owner edits.
  app.get('/api/shop', async () => {
    const rules = await loadShopRules();
    return {
      ...rules.shop,
      hours: displayHours(rules),
      deliveryUntil: rules.deliveryUntil,
      status: shopStatus(rules, now()),
      specialDays: upcomingSpecialDays(rules, now(), SPECIAL_DAYS_AHEAD),
      legal: publicLegal(rules.legal),
    };
  });
}
