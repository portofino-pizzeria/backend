// Whether the Impressum is complete, as `/api/health` reports it.
//
// **This is a cache on purpose, and the health route must never query the
// database.** App Runner points its own health check at `/api/health`, and
// `src/index.ts` starts serving BEFORE it migrates and seeds, so a health
// answer that depended on a query would fail while the database is still
// coming up — and a legal-notice gap would take the whole service out of
// rotation. That trade is not worth making for a warning.
//
// So: the cache is filled at the end of `initDatabase`, updated in-process by
// every write that touches the legal fields, and otherwise refreshed in the
// background when a health read finds it older than a minute. The refresh is
// fire-and-forget and swallows its own errors; before the first successful
// load the field honestly reads "unknown".

import { loadShopRules, type ShopLegalFacts } from './shop-rules.js';

export type LegalCompleteness = 'complete' | 'incomplete' | 'unknown';

export interface LegalStatus {
  legal: LegalCompleteness;
  /** The field names still missing. Empty unless `legal === 'incomplete'`. */
  missing: string[];
}

/** How stale the cache may get before a health read triggers a refresh. */
const MAX_AGE_MS = 60_000;

const UNKNOWN: LegalStatus = { legal: 'unknown', missing: [] };

let cached: LegalStatus | null = null;
let cachedAt = 0;
let refreshing = false;

/** A legal field counts as set only when it carries actual text. */
function isSet(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The Impressum fields that are still missing. Only the two § 5 DDG facts that
 * cannot be substituted are required: the owner's legal name and a contact
 * address. A VAT id or a register entry may genuinely not exist for an
 * Einzelunternehmen, so their absence is not a gap.
 */
export function legalMissingFields(legal: ShopLegalFacts): string[] {
  const missing: string[] = [];
  if (!isSet(legal.legalOwnerName)) missing.push('legalOwnerName');
  if (!isSet(legal.email)) missing.push('email');
  return missing;
}

export function legalStatusOf(legal: ShopLegalFacts): LegalStatus {
  const missing = legalMissingFields(legal);
  return missing.length === 0
    ? { legal: 'complete', missing: [] }
    : { legal: 'incomplete', missing };
}

/** Record what a write in this process just stored. Never queries anything. */
export function noteLegalFacts(legal: ShopLegalFacts): void {
  cached = legalStatusOf(legal);
  cachedAt = Date.now();
}

/**
 * Load the status from the database. Awaited once at the end of
 * `initDatabase`; otherwise only ever called in the background.
 *
 * It never throws and never rejects: a failed read leaves the previous answer
 * (or "unknown") in place, because the caller is either a boot sequence that
 * must continue or a health response that must not fail.
 */
export async function refreshLegalStatus(): Promise<void> {
  try {
    const rules = await loadShopRules();
    noteLegalFacts(rules.legal);
  } catch {
    // Deliberately silent: `/api/health` keeps answering, with whatever it
    // knew before. The next refresh tries again.
  }
}

/**
 * What `/api/health` serves. Synchronous and allocation-cheap: it reads the
 * cache, and when that is stale it kicks off a refresh it does not wait for.
 */
export function readLegalStatus(): LegalStatus {
  if (!cached || Date.now() - cachedAt > MAX_AGE_MS) {
    if (!refreshing) {
      refreshing = true;
      // Fire-and-forget. `refreshLegalStatus` already swallows errors; the
      // `.catch` is belt and braces against an unhandled rejection taking the
      // process down for a warning field.
      void refreshLegalStatus()
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    }
  }
  return cached ?? UNKNOWN;
}

/** Test-only: put the cache back to its before-first-load state. */
export function resetLegalStatusForTests(): void {
  cached = null;
  cachedAt = 0;
  refreshing = false;
}
