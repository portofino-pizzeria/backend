// `/api/health` is not just a liveness probe. App Runner points its own health
// check at it (infra/backend-service.tf), and the deploy workflow asserts on
// its `commit` field to prove the image it pushed is the one serving traffic —
// so the field's presence and its degraded value are both contract.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '../src/db/client.js';
import { shopProfile } from '../src/db/schema.js';
import { refreshLegalStatus } from '../src/lib/legal-status.js';
import { createTestApp } from './support/app';
import { withConfig } from './support/config';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

async function getHealth(): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  return res.json<Record<string, unknown>>();
}

describe('GET /api/health', () => {
  // NB: this does NOT pin "answers without a database". It cannot — the shared
  // harness opens a pool and truncates every table before each test, so the
  // suite needs Postgres to reach this line at all. That property is real and
  // deliberate (`src/index.ts` serves before it migrates, so App Runner's health
  // check passes while the DB is still coming up) and it is currently untested;
  // testing it needs a fixture that points the pool at an unreachable host.
  it('answers 200 with status ok', async () => {
    expect(await getHealth()).toMatchObject({ status: 'ok' });
  });

  it('carries a build commit', async () => {
    const body = await getHealth();
    expect(body).toHaveProperty('commit');
    expect(typeof body.commit).toBe('string');
    expect(body.commit).not.toBe('');
  });

  it('degrades to "unknown" when the image was built without COMMIT_SHA', async () => {
    // The literal, not `config.commit` — a test written against the value it is
    // meant to pin proves nothing. `test/support/env.ts` deletes COMMIT_SHA, so
    // this is the no-build-arg path, which must never throw and never 500.
    expect((await getHealth()).commit).toBe('unknown');
  });

  // `kitchen` reports how the kitchen guard is armed, so the deploy workflow
  // can refuse to call a deployment verified while `/api/kitchen/*` is either
  // open to the internet or refusing everything. Literals, not
  // `kitchenAuthMode()` — the workflow matches on these exact strings.
  describe('the kitchen field', () => {
    it('reads "auth-disabled" under the suite’s own environment', async () => {
      // `test/support/env.ts` clears KITCHEN_TOKEN and sets
      // KITCHEN_AUTH_DISABLED=1 — the local-dev shape, and the one that must
      // never reach production. The field is how a deploy would notice.
      expect((await getHealth()).kitchen).toBe('auth-disabled');
    });

    it('reads "token" when KITCHEN_TOKEN is set — the only deployed value', async () => {
      await withConfig({ kitchenToken: 'kuechen-geheimnis' }, async () => {
        expect((await getHealth()).kitchen).toBe('token');
      });
      // A set token wins even with the opt-out also present: the guard still
      // requires the bearer (test/kitchen-auth.test.ts pins that), so the
      // report must say so too.
      await withConfig(
        { kitchenToken: 'kuechen-geheimnis', kitchenAuthDisabled: true },
        async () => {
          expect((await getHealth()).kitchen).toBe('token');
        },
      );
    });

    it('reads "unconfigured" when there is neither a token nor the opt-out', async () => {
      await withConfig({ kitchenToken: '', kitchenAuthDisabled: false }, async () => {
        expect((await getHealth()).kitchen).toBe('unconfigured');
      });
    });

    it('never carries the token itself', async () => {
      await withConfig({ kitchenToken: 'kuechen-geheimnis' }, async () => {
        const res = await app.inject({ method: 'GET', url: '/api/health' });
        expect(res.body).not.toContain('kuechen-geheimnis');
      });
    });
  });

  // `legal` reports whether the Impressum (§ 5 DDG) is complete, so a deploy
  // can warn about a public app that carries an incomplete one. It is served
  // from an in-process cache and NEVER from a query — this route is App
  // Runner's health check and answers before the database is up at all.
  describe('the legal field', () => {
    it('reads "unknown" before anything has been loaded', async () => {
      // `test/support/setup.ts` resets the cache before every test, which is
      // the state a freshly started process is in: it has not read the
      // database yet, and it says so rather than guessing.
      expect((await getHealth()).legal).toBe('unknown');
    });

    it('reads "incomplete" and names what is missing', async () => {
      await refreshLegalStatus();
      const body = await getHealth();
      expect(body.legal).toBe('incomplete');
      expect(body.legalMissing).toEqual(['legalOwnerName', 'email']);
    });

    it('reads "complete" once the owner has supplied the facts', async () => {
      await db
        .update(shopProfile)
        .set({ legalOwnerName: 'Mario Rossi', email: 'info@portofino-essen.de' });
      await refreshLegalStatus();

      const body = await getHealth();
      expect(body.legal).toBe('complete');
      expect(body).not.toHaveProperty('legalMissing');
    });

    it('still answers 200 when the shop rules cannot be read at all', async () => {
      // No `shop_profile` row: `loadShopRules()` throws a 503 for every order
      // route, and the health check must be unmoved by it. A health check that
      // could fail on the database would take the whole service out of
      // rotation over a legal-notice warning.
      await db.delete(shopProfile);
      await refreshLegalStatus();

      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok', legal: 'unknown' });
    });

    it('keeps the last known answer when a later read fails', async () => {
      await db
        .update(shopProfile)
        .set({ legalOwnerName: 'Mario Rossi', email: 'info@portofino-essen.de' });
      await refreshLegalStatus();
      expect((await getHealth()).legal).toBe('complete');

      await db.delete(shopProfile);
      await refreshLegalStatus();
      expect((await getHealth()).legal).toBe('complete');
    });
  });
});
