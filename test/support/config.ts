// Patch `config` for the duration of one test and put it back.
//
// `config` is a frozen-looking `as const` literal but a plain object at
// runtime, and every value is read ONCE from the environment at module
// evaluation — so a test that needs a different credential (the fail-closed
// tests cannot be written any other way) has to mutate it in place. Shared by
// `test/kitchen-auth.test.ts`, `test/admin-menu.test.ts` and
// `test/health.test.ts` so the three cannot drift on how they restore it.

import { config } from '../../src/config.js';

export interface MutableCredentials {
  kitchenToken: string;
  kitchenAuthDisabled: boolean;
  ownerMenuToken: string;
}

const mutableConfig = config as unknown as MutableCredentials;

export async function withConfig<T>(
  patch: Partial<MutableCredentials>,
  run: () => Promise<T>,
): Promise<T> {
  const saved: MutableCredentials = {
    kitchenToken: mutableConfig.kitchenToken,
    kitchenAuthDisabled: mutableConfig.kitchenAuthDisabled,
    ownerMenuToken: mutableConfig.ownerMenuToken,
  };
  Object.assign(mutableConfig, patch);
  try {
    return await run();
  } finally {
    Object.assign(mutableConfig, saved);
  }
}
