import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { db, sql } from './client.js';

// Applies any pending SQL migrations in ./drizzle. Run with `npm run db:migrate`
// (and automatically on server boot — see src/index.ts).
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
}

// Allow running standalone: `tsx src/db/migrate.ts`. Compared via
// fileURLToPath, as `seed.ts` does: on Windows `import.meta.url` is a
// `file:///C:/...` URL while `process.argv[1]` is a native `C:\...` path, so a
// raw `file://${process.argv[1]}` template never matches and
// `npm run db:migrate` exited 0 having applied nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied.');
      return sql.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
