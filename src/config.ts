// Central configuration. Everything is env-driven so the *same* build runs
// locally, in staging, and in production — only the environment differs. Nothing
// here is required to boot in local/mock mode; every value has a default.

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

const port = Number(env('PORT', '4000'));

export const config = {
  port,

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

  // Domain constants. Money is always an integer number of cents.
  currency: 'EUR',
  deliveryFeeCents: 299,
} as const;

export const stripeEnabled = Boolean(config.stripe.secretKey);
