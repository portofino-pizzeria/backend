import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],

    // Creates/migrates the test database once per run, and fails the run
    // loudly if no Postgres answers.
    globalSetup: ['test/global-setup.ts'],

    // Points src/config.ts at the test database and truncates between tests.
    setupFiles: ['test/support/setup.ts'],

    // Every test file shares one database and truncates between tests, so
    // files must not run concurrently against it.
    fileParallelism: false,

    // The first file pays for the connection handshake; migrations happen in
    // globalSetup, which gets the longer budget.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
