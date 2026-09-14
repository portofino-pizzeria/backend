// Patch `config` for the duration of one test and put it back.
//
// `config` is a frozen-looking `as const` literal but a plain object at
// runtime, and every value is read ONCE from the environment at module
// evaluation — so a test that needs a different credential or URL (the
// fail-closed tests cannot be written any other way) has to mutate it in
// place. Shared by every test that patches config, so they cannot drift on how
// they restore it.

import { config } from '../../src/config.js';

export interface MutableConfig {
  kitchenToken: string;
  kitchenAuthDisabled: boolean;
  ownerMenuToken: string;
  publicWebUrl: string;
}

const mutableConfig = config as unknown as MutableConfig;

export async function withConfig<T>(
  patch: Partial<MutableConfig>,
  run: () => Promise<T>,
): Promise<T> {
  const saved: MutableConfig = {
    kitchenToken: mutableConfig.kitchenToken,
    kitchenAuthDisabled: mutableConfig.kitchenAuthDisabled,
    ownerMenuToken: mutableConfig.ownerMenuToken,
    publicWebUrl: mutableConfig.publicWebUrl,
  };
  Object.assign(mutableConfig, patch);
  try {
    return await run();
  } finally {
    Object.assign(mutableConfig, saved);
  }
}
