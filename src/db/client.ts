import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { config } from '../config.js';
import * as schema from './schema.js';

// Managed Postgres (Aurora/RDS) requires TLS; local dev Postgres does not.
// `require` uses TLS without CA verification, which is what the RDS endpoint
// needs without shipping the RDS CA bundle.
const isLocal =
  config.databaseUrl.includes('localhost') ||
  config.databaseUrl.includes('127.0.0.1');

// A single shared connection pool for the process.
export const sql = postgres(config.databaseUrl, {
  max: 10,
  ssl: isLocal ? false : 'require',
});

export const db = drizzle(sql, { schema });
