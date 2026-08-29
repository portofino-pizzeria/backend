// Route-level tests drive the real Fastify instance through `app.inject()` —
// no port binding, no HTTP client, no flake, and the real error handler.

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';

/** Build the production app with logging off. Close it in `afterAll`. */
export async function createTestApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}
