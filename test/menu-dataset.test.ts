// The real capture, loaded exactly as every server boot loads it. Nothing
// else in the suite reads `data/menu.json`: the route tests seed their own
// fixtures. A dataset that fails validation stops the menu seeding on every
// boot, so it must fail here first.

import { describe, expect, it } from 'vitest';

import { loadMenuDataset } from '../src/db/menu-dataset.js';

describe('data/menu.json', () => {
  it('passes the loader validation a server boot runs', () => {
    expect(() => loadMenuDataset()).not.toThrow();
  });

  it('names the two Mittwochs-Angebote as pickup-only, by ids that exist', () => {
    const dataset = loadMenuDataset();
    const ids = new Set(dataset.items.map((i) => i.id));
    const pickupOnly = dataset.pickup?.pickupOnlyOffers ?? [];
    expect(pickupOnly).toEqual(['angebote-mittwochs-angebot-1', 'angebote-mittwochs-angebot-2']);
    for (const id of pickupOnly) expect(ids.has(id)).toBe(true);
  });
});
