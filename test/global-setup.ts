// Runs once per `npm test`, before any test file.
//
// 1. Proves a Postgres server is actually reachable — and fails the run with a
//    readable message if it is not, rather than skipping.
// 2. Creates the test database if it does not exist.
// 3. Drops and recreates its schema, then applies `backend/drizzle/*.sql`.
//
// Step 3 is what makes "a clean, migrated schema" true rather than "whatever
// the last run left behind": migrations are re-applied from zero every run, so
// a stale column or a hand-edited table cannot survive into a green suite.
// It is safe because `resolveTestDatabaseUrl()` has already refused any
// database that does not look like a test database.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import {
  databaseName,
  maintenanceDatabaseUrl,
  resolveSsl,
  resolveTestDatabaseUrl,
  unreachableMessage,
} from './support/database';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

async function ensureDatabaseExists(testUrl: string): Promise<void> {
  const name = databaseName(testUrl);
  const adminUrl = maintenanceDatabaseUrl(testUrl);
  const admin = postgres(adminUrl, {
    max: 1,
    ssl: resolveSsl(adminUrl),
    onnotice: () => {},
    connect_timeout: 10,
  });

  try {
    const existing = await admin`
      select 1 from pg_database where datname = ${name}
    `;
    if (existing.length === 0) {
      // Identifiers cannot be parameterised; the name came from a URL we have
      // already validated, and is quoted here.
      await admin.unsafe(`create database "${name.replace(/"/g, '""')}"`);
    }
  } catch (err) {
    throw new Error(unreachableMessage(adminUrl, err), { cause: err });
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function resetAndMigrate(testUrl: string): Promise<void> {
  const sql = postgres(testUrl, {
    max: 1,
    ssl: resolveSsl(testUrl),
    onnotice: () => {},
    connect_timeout: 10,
  });

  try {
    // `drizzle` holds the migration journal; dropping it too is what forces a
    // full re-apply rather than a no-op "already up to date".
    await sql.unsafe('drop schema if exists drizzle cascade');
    await sql.unsafe('drop schema if exists public cascade');
    await sql.unsafe('create schema public');

    await migrate(drizzle(sql), { migrationsFolder });
  } catch (err) {
    throw new Error(unreachableMessage(testUrl, err), { cause: err });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export default async function globalSetup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl();
  await ensureDatabaseExists(testUrl);
  await resetAndMigrate(testUrl);
}
