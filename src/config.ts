// Central configuration. Everything is env-driven so the *same* build runs
// locally, in staging, and in production — only the environment differs. Nothing
// here is required to boot in local/mock mode; every value has a default.

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
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

  // Public URL of the customer web app, used as the "back to app" target after
  // hosted checkout. Empty falls back to a built-in confirmation page.
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

  // Shared secret for the kitchen dashboard. Empty disables the check (dev).
  kitchenToken: env('KITCHEN_TOKEN'),

  // Shared secret for the owner's menu editor (/api/admin/menu/*).
  //
  // Deliberately NOT `kitchenToken`, and deliberately NOT skippable when empty.
  // The kitchen guard protects a screen that is already behind the counter and
  // turns itself off in dev; this one guards the surface that writes the
  // allergens and prices a diner reads, from a phone, after close. Empty means
  // every admin write is REFUSED — see `requireOwnerAuth` in
  // routes/admin-menu.ts. Set it to enable the editor.
  ownerMenuToken: env('OWNER_MENU_TOKEN'),

  // Domain constants. Money is always an integer number of cents.
  currency: 'EUR',
  deliveryFeeCents: 299,
} as const;

export const stripeEnabled = Boolean(config.stripe.secretKey);
