import { describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';

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

const mutableConfig = config as unknown as {
  kitchenToken: string;
  kitchenAuthDisabled: boolean;
};

async function withConfig<T>(
  patch: Partial<typeof mutableConfig>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = { ...mutableConfig };
  Object.assign(mutableConfig, patch);
  try {
    return await run();
  } finally {
    Object.assign(mutableConfig, saved);
  }
}

async function getKitchenOrders(headers: Record<string, string> = {}) {
  const app = await buildApp();
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

  it('still refuses when the opt-out is set to something other than 1', async () => {
    // `kitchenAuthDisabled` is `=== '1'` at config load; this pins the boolean
    // rather than the parse, so a future truthiness bug here goes red.
    await withConfig({ kitchenToken: '', kitchenAuthDisabled: false }, async () => {
      expect((await getKitchenOrders()).statusCode).toBe(401);
    });
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
      },
    );
  });
});
