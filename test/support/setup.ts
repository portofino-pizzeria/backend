// Per-test-file setup. Registered as vitest's `setupFiles`, so it runs before
// the test file's own module graph is evaluated.

// MUST stay first — see the comment in ./env. It redirects `src/config.ts` at
// the test database before `src/db/client.ts` opens its pool.
import './env';

import { afterAll, beforeEach } from 'vitest';

import { config } from '../../src/config.js';
import { sql } from '../../src/db/client.js';
import { seedShop } from '../../src/db/seed-shop.js';
import { setNowForTests } from '../../src/lib/clock.js';
import { resetLegalStatusForTests } from '../../src/lib/legal-status.js';
import { resolveTestDatabaseUrl } from './database';
import { resetFixtureCounters } from './fixtures';

const expectedUrl = resolveTestDatabaseUrl();

// A cheap, loud assertion that the import-ordering trick above actually held.
// If `src/config.ts` ever gets imported before `./env` — by a new setup file,
// or by vitest changing evaluation order — this turns a silent
// "the tests just truncated the dev database" into a failed run.
if (config.databaseUrl !== expectedUrl) {
  throw new Error(
    [
      'The test harness is NOT pointed at the test database.',
      `  config.databaseUrl = ${config.databaseUrl}`,
      `  expected           = ${expectedUrl}`,
      '',
      "This means src/config.ts was evaluated before test/support/env.ts ran.",
      "Check that `import './env';` is the first import in this file.",
    ].join('\n'),
  );
}

/** Cached so the catalogue query runs once per test file, not once per test. */
let truncateStatement: string | null = null;

async function truncateAll(): Promise<void> {
  if (truncateStatement === null) {
    // Derived from the live catalogue rather than a hard-coded list, so a table
    // added by a later phase is truncated without anyone remembering to come
    // back here. The drizzle migration journal lives in its own schema and is
    // therefore untouched.
    const rows = await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'
    `;
    truncateStatement = rows.length
      ? `truncate table ${rows
          .map((r) => `"public"."${r.tablename}"`)
          .join(', ')} restart identity cascade`
      : '';
  }
  if (truncateStatement) await sql.unsafe(truncateStatement);
}

/**
 * Where every test is, in time, unless it moves the clock itself: a Wednesday
 * at 18:00 in Essen, when both delivery and pickup orders are taken. Without a
 * pinned clock the order tests would pass or fail by the time of day they ran.
 */
export const OPEN_FOR_EVERYTHING = new Date('2026-09-16T16:00:00Z');

beforeEach(async () => {
  await truncateAll();
  // AFTER the truncate, on purpose: the restaurant's facts are rows now, and
  // the truncate above removes them — including anything a migration inserted.
  // Every test therefore starts from the same shop a freshly-seeded production
  // database has, by the same code path (`seedShop()`), instead of from a
  // database where `GET /api/shop` would 503. A test that wants different
  // hours edits these rows; one that wants none deletes them.
  await seedShop();
  resetFixtureCounters();
  setNowForTests(OPEN_FOR_EVERYTHING);
  // The /api/health legal cache is process-global and outlives a truncate, so
  // it is put back to "nothing loaded yet" here rather than leaking one test's
  // Impressum into the next one's health read.
  resetLegalStatusForTests();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});
