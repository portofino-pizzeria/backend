// Central configuration. Everything is env-driven so the *same* build runs
// locally, in staging, and in production — only the environment differs. Nothing
// here is required to boot in local/mock mode; every value has a default.

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

/**
 * A whole number of periods within `[1, max]`, or the documented default.
 *
 * Every rejected value falls back rather than propagating, and each rejection
 * is a failure mode somebody would otherwise have to debug from behaviour:
 *
 * - **Not a number** (a misspelling, an empty string) would be `NaN`, which
 *   makes every age comparison false and silently disables the sweep.
 * - **Zero or negative** would clear every order's phone number the first time
 *   the sweep ran.
 * - **Absurdly large** is not harmless either. An interval above ~2^31 ms
 *   overflows `setInterval`, which Node clamps to 1 ms — turning the sweep
 *   into a hot loop of database round trips — and a large enough year count
 *   makes the cutoff an Invalid Date, whose query fails on every run.
 *
 * A rejection is logged, not swallowed: an operator who set the variable
 * deliberately needs to know it did not take.
 */
export function positiveIntFromEnv(
  key: string,
  fallback: number,
  max = 1_000_000,
): number {
  const raw = env(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= max) return parsed;
  console.warn(
    `${key}="${raw}" is not a whole number between 1 and ${max}; using ${fallback}.`,
  );
  return fallback;
}

const port = Number(env('PORT', '4000'));

/**
 * The git commit this image was built from.
 *
 * Baked into the image at BUILD time (`Dockerfile`: `ARG COMMIT_SHA` ->
 * `ENV COMMIT_SHA`), not supplied at run time — the point is to identify the
 * artifact, and a value the platform could set per-deploy would not do that.
 *
 * Degrades to `'unknown'` rather than throwing: a local `docker build`, a
 * `npm run dev`, or a build that simply forgot the `--build-arg` must still
 * boot and still serve `/api/health`. A deploy pipeline asserting on this
 * field treats `'unknown'` as "not the commit I pushed" and fails there, which
 * is the right place for that failure — not at container start.
 */
const commit = env('COMMIT_SHA', 'unknown');

export const config = {
  port,
  commit,

  databaseUrl: env(
    'DATABASE_URL',
    'postgres://portofino:portofino@localhost:5432/portofino',
  ),

  // Public URL the API answers on. Used to build payment return URLs. Falls
  // back to localhost for dev.
  publicApiUrl: env('PUBLIC_API_URL', `http://localhost:${port}`),

  // Public URL of the customer web app: the base of the "Zu deiner Bestellung"
  // link (`<base>/order/<id>`) on the payment result pages. Empty renders those
  // pages with no link, only a hint to close the window.
  publicWebUrl: env('PUBLIC_WEB_URL', ''),

  // CORS allow-list. Empty array = allow all (fine for local + a private
  // staging link; lock down before real production).
  corsOrigins: env('CORS_ORIGINS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  stripe: {
    secretKey: env('STRIPE_SECRET_KEY'),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  },

  // Shared secret for the kitchen dashboard. REQUIRED in any deployed
  // environment: empty does not disable the check, it makes the guard refuse
  // every request (see `kitchenAuthDisabled` for the one, explicit, exception).
  kitchenToken: env('KITCHEN_TOKEN'),

  /**
   * Explicit opt-out from the kitchen guard, for local dev and the test suite.
   *
   * The guard fails CLOSED when `KITCHEN_TOKEN` is unset. It did not used to:
   * an unset token skipped the check entirely, which put
   * `GET /api/kitchen/orders` — every order's customer NAME, PHONE and
   * DELIVERY ADDRESS — on the open internet for any deployment that forgot to
   * set one. The old comment called that "defensible for a screen already
   * behind the counter", but it is the API that is exposed, not the screen.
   *
   * Deliberately an opt-OUT rather than a `NODE_ENV !== 'production'` check.
   * `NODE_ENV` is set to `production` in the Dockerfile, so keying on it would
   * work — right up until an environment fails to set it, and then the failure
   * mode is a wide-open PII endpoint. An affirmative `1` is required to
   * disable the check, so a missing or misconfigured variable fails SAFE.
   */
  kitchenAuthDisabled: env('KITCHEN_AUTH_DISABLED') === '1',

  // Shared secret for the owner's menu editor (/api/admin/menu/*).
  //
  // Deliberately NOT `kitchenToken` (decision D5): this one guards the surface
  // that writes the allergens and prices a diner reads, from a phone, after
  // close, and it must not be unlocked by the same secret a kitchen screen
  // holds. Like the kitchen guard it fails CLOSED — empty means every admin
  // write is REFUSED, with no opt-out at all — see `requireOwnerAuth` in
  // routes/admin-menu.ts. Set it to enable the editor.
  ownerMenuToken: env('OWNER_MENU_TOKEN'),

  /**
   * How long order data is kept (decision D4). Every value is configurable
   * because only one of them is a technical decision.
   *
   * - `contactMonths` (6) — after this, `customer_phone`, `customer_address`
   *   and `customer_notes` are overwritten with NULL. Long enough for a
   *   delivery dispute or a chargeback; none of it belongs in a tax record.
   * - `orderYears` (10) — after this the order, its lines and the customer
   *   NAME are deleted outright. §147 AO / §257 HGB. **The exact period is the
   *   owner's tax advisor's call**, which is why it is a value and not a
   *   constant; it defaults to the LONGER reading because keeping a record too
   *   long is recoverable and deleting it early is not.
   * - `sweepIntervalHours` (24) — the floor between two sweeps, enforced by
   *   the `retention_runs` marker rather than by a timer, so a restart-heavy
   *   deploy model makes the sweep run at most this often rather than never.
   *
   * Deleting a column is not deleting the data: Aurora's automated backups
   * retain 7 days (`infra/database.tf`), so a NULLed phone number stays
   * recoverable from a backup for up to a week after the sweep. The privacy
   * policy has to SAY that rather than imply an instant deletion.
   */
  // Each cap is the point past which the value stops meaning anything: 1200
  // months and 100 years are both far beyond any retention obligation, and an
  // interval above a year would overflow `setInterval`.
  retention: {
    contactMonths: positiveIntFromEnv('RETENTION_CONTACT_MONTHS', 6, 1200),
    orderYears: positiveIntFromEnv('RETENTION_ORDER_YEARS', 10, 100),
    sweepIntervalHours: positiveIntFromEnv(
      'RETENTION_SWEEP_INTERVAL_HOURS',
      24,
      24 * 365,
    ),
  },

  // Domain constants. Money is always an integer number of cents.
  currency: 'EUR',
  deliveryFeeCents: 299,
} as const;

export const stripeEnabled = Boolean(config.stripe.secretKey);

/**
 * How the kitchen guard will behave, from the two values above.
 *
 * - `token`: `KITCHEN_TOKEN` is set; every kitchen request must carry it.
 * - `auth-disabled`: no token and `KITCHEN_AUTH_DISABLED=1` — the kitchen
 *   routes serve customer PII to anyone. Local dev and CI only.
 * - `unconfigured`: no token and no opt-out — every kitchen request is refused.
 *
 * Reported by `/api/health` so the deploy pipeline can assert on it, and
 * logged at boot. A function rather than a constant because the test suite
 * patches `config` at runtime and reads the mode back.
 */
export type KitchenAuthMode = 'token' | 'auth-disabled' | 'unconfigured';

export function kitchenAuthMode(): KitchenAuthMode {
  if (config.kitchenToken) return 'token';
  return config.kitchenAuthDisabled ? 'auth-disabled' : 'unconfigured';
}
