// Where the test suite's database lives, and the guard rails that stop a test
// run from ever touching a development or production database.
//
// Nothing here imports `src/` — this module is loaded *before* the production
// config reads `DATABASE_URL` (see `env.ts`), so pulling in `src/config.ts`
// from here would defeat the whole ordering.

/** Same Postgres server as `npm run db:up`, a different database on it. */
export const DEFAULT_TEST_DATABASE_URL =
  'postgres://portofino:portofino@localhost:5432/portofino_test';

/** Escape hatch for a CI database whose name cannot contain "test". */
const UNSAFE_OVERRIDE = 'ALLOW_UNSAFE_TEST_DATABASE';

function parse(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(
      `TEST_DATABASE_URL is not a valid connection URL: ${url}\n` +
        `Expected something like ${DEFAULT_TEST_DATABASE_URL}`,
    );
  }
}

/** The database name in a Postgres connection URL. */
export function databaseName(url: string): string {
  const name = decodeURIComponent(parse(url).pathname).replace(/^\//, '');
  if (!name) {
    throw new Error(`Connection URL names no database: ${url}`);
  }
  return name;
}

/**
 * The URL the suite runs against: `TEST_DATABASE_URL`, else a `_test` database
 * on the local dev Postgres.
 *
 * Throws — loudly, never silently skipping — if the name does not look like a
 * test database. The fixture DROPs and recreates the public schema on every
 * run, so pointing it at `portofino` would destroy a developer's dev data.
 */
export function resolveTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;
  const name = databaseName(url);

  if (!/test/i.test(name) && env[UNSAFE_OVERRIDE] !== '1') {
    throw new Error(
      [
        `Refusing to run the test suite against database "${name}".`,
        '',
        'The fixture drops and recreates the public schema on every run, so it',
        'only ever points at a database whose name contains "test".',
        '',
        `Set TEST_DATABASE_URL to a test database (default: ${DEFAULT_TEST_DATABASE_URL}),`,
        `or set ${UNSAFE_OVERRIDE}=1 if you genuinely mean this one.`,
      ].join('\n'),
    );
  }

  return url;
}

/**
 * The `postgres` maintenance database on the same server, used to CREATE the
 * test database when it does not exist yet (you cannot create a database from
 * inside a connection to it).
 */
export function maintenanceDatabaseUrl(testUrl: string): string {
  const url = parse(testUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * TLS mode for a connection, mirroring `src/db/client.ts`: an explicit
 * `sslmode` in the URL wins, otherwise localhost means plaintext.
 */
export function resolveSsl(url: string): 'require' | false {
  if (/[?&]sslmode=disable/.test(url)) return false;
  if (/[?&]sslmode=(require|verify-full|verify-ca|prefer)/.test(url)) {
    return 'require';
  }
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  return isLocal ? false : 'require';
}

/** The message shown when no database answers. Deliberately actionable. */
export function unreachableMessage(url: string, cause: unknown): string {
  return [
    `Cannot reach the test database at ${url}`,
    '',
    `  ${(cause as Error).message ?? String(cause)}`,
    '',
    'The suite is integration-shaped on purpose — pricing, availability and',
    'allergen resolution are all resolved in the database, so a mocked Drizzle',
    'would only test the mock. It will not silently skip.',
    '',
    'Start Postgres and try again:',
    '',
    '  cd backend && npm run db:up',
    '',
    'Or point TEST_DATABASE_URL at a reachable Postgres.',
  ].join('\n');
}
