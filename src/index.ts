import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { config, kitchenAuthMode } from './config.js';
import { runMigrations } from './db/migrate.js';
import { seedMenu } from './db/seed.js';
import { startRetentionSweeps } from './lib/retention.js';

async function main() {
  const app = await buildApp();

  // Start serving immediately so the platform health check (/api/health, which
  // doesn't touch the DB) passes even while the database is still coming up.
  await app.listen({ port: config.port, host: '0.0.0.0' });
  logKitchenAuthMode(app);

  // The same build marker /api/health serves, in the service log: App Runner
  // keeps logs per revision, so a log that names its commit is the fastest
  // answer to "which artifact wrote this line" — and "unknown" here is the
  // tell for an image built without --build-arg COMMIT_SHA.
  app.log.info(`Portofino API listening on :${config.port}, commit ${config.commit}`);

  // Then bring the schema up + seed, retrying while the DB becomes reachable —
  // a freshly-provisioned Aurora endpoint can take a bit to resolve/accept
  // connections. Safe on every boot: migrations apply only what is pending,
  // and seedMenu() loads data/menu.json only into a database that has never
  // had a menu — it never overwrites the owner's edits (see seed.ts).
  await initDatabase(app);

  // Retention (D4) — AFTER initDatabase returns, deliberately. initDatabase
  // retries up to 20 times and serves anyway on total failure, so a delete
  // sweep called from inside that loop could run 20 times in a single boot.
  // Here it runs once per boot and then on its interval, and the
  // `retention_runs` marker is what stops "once per boot" becoming "on every
  // deploy" on a service that redeploys on every merge to master.
  startRetentionSweeps(app.log);
}

/**
 * Say, once, at boot, how the kitchen guard is armed. Both non-`token` modes
 * are wrong in a deployed environment — one serves customer PII to anyone, the
 * other refuses the kitchen dashboard outright — and a log line at start is
 * the earliest place an operator reading a deploy can see either.
 */
function logKitchenAuthMode(app: FastifyInstance): void {
  switch (kitchenAuthMode()) {
    case 'token':
      return;
    case 'auth-disabled':
      app.log.warn(
        'Kitchen auth is DISABLED (KITCHEN_AUTH_DISABLED=1): /api/kitchen/* serves ' +
          'customer names, phone numbers and addresses unauthenticated. Local dev only.',
      );
      return;
    case 'unconfigured':
      app.log.warn(
        'KITCHEN_TOKEN is not set: every /api/kitchen/* request is refused. Set it ' +
          '(or, in local dev only, KITCHEN_AUTH_DISABLED=1) to serve the kitchen dashboard.',
      );
      return;
  }
}

async function initDatabase(app: FastifyInstance): Promise<void> {
  const attempts = 20;
  const delayMs = 6000;
  for (let i = 1; i <= attempts; i++) {
    try {
      await runMigrations();
      const seeded = await seedMenu();
      app.log.info(`Database ready (${seeded} menu items).`);
      return;
    } catch (err) {
      app.log.warn(
        `DB init attempt ${i}/${attempts} failed: ${(err as Error).message}`,
      );
      if (i === attempts) {
        app.log.error('Database init failed after all retries; serving anyway.');
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
