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

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = resolveTestDatabaseUrl();

// Tests must not depend on the shell. An inherited KITCHEN_TOKEN would make
// the kitchen routes demand a bearer token; an inherited STRIPE_SECRET_KEY
// would flip the payments module off its mock provider and start reaching for
// the network.
delete process.env.KITCHEN_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
