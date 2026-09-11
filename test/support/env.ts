// Side-effect module: points the production config at the TEST database and
// makes the suite hermetic against whatever happens to be in the developer's
// shell.
//
// This MUST be the first import of `test/support/setup.ts`. `src/config.ts`
// reads `process.env.DATABASE_URL` once, at module evaluation, and
// `src/db/client.ts` opens its connection pool from it at module evaluation
// too — so the assignment below has to happen before anything under `src/` is
// imported. ES module imports are evaluated in source order, which is what
// makes "import this first" a guarantee rather than a hope.

import { resolveTestDatabaseUrl } from './database';

/** The owner-editor credential the suite runs with. */
export const TEST_OWNER_MENU_TOKEN = 'test-owner-menu-token';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = resolveTestDatabaseUrl();

// Tests must not depend on the shell. An inherited KITCHEN_TOKEN would make
// the kitchen routes demand a bearer token; an inherited STRIPE_SECRET_KEY
// would flip the payments module off its mock provider and start reaching for
// the network.
delete process.env.KITCHEN_TOKEN;
// With no token the kitchen guard now fails CLOSED, so the suite opts out
// explicitly to exercise the routes at all — the same shape as the
// OWNER_MENU_TOKEN line below, and the reason the opt-out exists.
// `test/kitchen-auth.test.ts` turns it back off, in a controlled way, for the
// fail-closed test itself.
process.env.KITCHEN_AUTH_DISABLED = '1';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

// The owner's menu editor fails CLOSED when its credential is unset (as the
// kitchen guard now does too) — so the suite has to *set* one in
// order to exercise the routes at all. `test/admin-menu.test.ts` clears it
// again, in a controlled way, for the fail-closed test itself.
process.env.OWNER_MENU_TOKEN = TEST_OWNER_MENU_TOKEN;

// `commit` on /api/health is baked into the IMAGE at build time, so under test
// it must read its documented "built without one" value rather than whatever a
// CI runner happens to export. Without this, `test/health.test.ts` would go
// green or red depending on the shell it was started from.
delete process.env.COMMIT_SHA;
