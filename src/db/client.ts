import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { config } from '../config.js';
import * as schema from './schema.js';

// Managed Postgres (Aurora/RDS) requires TLS; local dev Postgres does not.
// `require` uses TLS without CA verification — what the RDS endpoint needs
// without shipping the RDS CA bundle.
//
// Precedence: an explicit `sslmode` in the URL wins (so the prod URL's
// `?sslmode=require` is authoritative, and a container test can force
// `?sslmode=disable`); otherwise fall back to a localhost heuristic.
function resolveSsl(url: string): 'require' | false {
  if (/[?&]sslmode=disable/.test(url)) return false;
  if (/[?&]sslmode=(require|verify-full|verify-ca|prefer)/.test(url)) return 'require';
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  return isLocal ? false : 'require';
}

// A single shared connection pool for the process.
export const sql = postgres(config.databaseUrl, {
  max: 10,
  ssl: resolveSsl(config.databaseUrl),
});

export const db = drizzle(sql, { schema });
