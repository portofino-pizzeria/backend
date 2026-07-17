import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { db, sql } from './client.js';

// Applies any pending SQL migrations in ./drizzle. Run with `npm run db:migrate`
// (and automatically on server boot — see src/index.ts).
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: './drizzle' });
}

// Allow running standalone: `tsx src/db/migrate.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
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
