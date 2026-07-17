import { defineConfig } from 'drizzle-kit';

const url =
  process.env.DATABASE_URL ??
  'postgres://portofino:portofino@localhost:5432/portofino';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
