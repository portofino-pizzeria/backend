import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestApp } from './support/app';
import { withConfig } from './support/config';

/**
 * The kitchen guard fails CLOSED.
 *
 * `GET /api/kitchen/orders` returns every order's customer name, phone number
 * and delivery address. The guard used to skip its check entirely when
 * `KITCHEN_TOKEN` was unset, so any deployment that forgot to set one served
 * that data to anyone who asked. These tests pin the fix.
 *
 * The suite as a whole runs with `KITCHEN_AUTH_DISABLED=1` (see
 * `test/support/env.ts`), so each case here restores the real default around
 * itself rather than relying on ambient state.
 */

async function getKitchenOrders(headers: Record<string, string> = {}) {
  const app = await createTestApp();
  try {
    return await app.inject({
      method: 'GET',
      url: '/api/kitchen/orders?scope=active',
      headers,
    });
  } finally {
    await app.close();
  }
}

describe('kitchen auth', () => {
  it('REFUSES when no token is configured and the opt-out is off', async () => {
    await withConfig({ kitchenToken: '', kitchenAuthDisabled: false }, async () => {
      const res = await getKitchenOrders();
      expect(res.statusCode).toBe(401);
      // The body must not carry order data of any kind.
      expect(res.body).not.toContain('"orders"');
    });
  });

  describe('the opt-out is parsed as exactly "1"', () => {
    // `config` reads the environment ONCE at module evaluation, so the parse
    // cannot be reached through the shared instance — a fresh copy of the
    // module is imported for each value. `withConfig` patches the boolean; only
    // this pins the string that produces it, so a truthiness regression
    // (`Boolean(env(...))`, `=== 'true'`) goes red here and nowhere else.
    const saved = process.env.KITCHEN_AUTH_DISABLED;

    afterEach(() => {
      if (saved === undefined) delete process.env.KITCHEN_AUTH_DISABLED;
      else process.env.KITCHEN_AUTH_DISABLED = saved;
      vi.resetModules();
    });

    async function parsedOptOut(value: string | undefined): Promise<boolean> {
      if (value === undefined) delete process.env.KITCHEN_AUTH_DISABLED;
      else process.env.KITCHEN_AUTH_DISABLED = value;
      vi.resetModules();
      const fresh = await import('../src/config.js');
      return fresh.config.kitchenAuthDisabled;
    }

    it('"1" disables the guard', async () => {
      expect(await parsedOptOut('1')).toBe(true);
      // `env()` trims, so whitespace around the 1 is still the 1.
      expect(await parsedOptOut(' 1 ')).toBe(true);
    });

    it.each([undefined, '', '0', 'true', 'yes', 'on', 'disabled', '11'])(
      'anything else (%j) leaves it armed',
      async (value) => {
        expect(await parsedOptOut(value)).toBe(false);
      },
    );
  });

  it('allows the explicit local-dev opt-out', async () => {
    await withConfig({ kitchenToken: '', kitchenAuthDisabled: true }, async () => {
      expect((await getKitchenOrders()).statusCode).toBe(200);
    });
  });

  it('requires the bearer token when one IS configured, opt-out notwithstanding', async () => {
    // The opt-out must not become a bypass for a server that HAS a token.
    await withConfig(
      { kitchenToken: 'kuechen-geheimnis', kitchenAuthDisabled: true },
      async () => {
        expect((await getKitchenOrders()).statusCode).toBe(401);
        const ok = await getKitchenOrders({ authorization: 'Bearer kuechen-geheimnis' });
        expect(ok.statusCode).toBe(200);
        const wrong = await getKitchenOrders({ authorization: 'Bearer falsch' });
        expect(wrong.statusCode).toBe(401);
        // Same length as the real token, one byte off — the arm `timingSafeEqual`
        // itself decides, as opposed to the length check above it.
        const close = await getKitchenOrders({ authorization: 'Bearer kuechen-geheimniS' });
        expect(close.statusCode).toBe(401);
        // A prefix of the real token: the compare must not accept a partial match.
        const prefix = await getKitchenOrders({ authorization: 'Bearer kuechen' });
        expect(prefix.statusCode).toBe(401);
        // An empty bearer never matches, even an (impossible) empty token.
        const empty = await getKitchenOrders({ authorization: 'Bearer ' });
        expect(empty.statusCode).toBe(401);
      },
    );
  });
});
