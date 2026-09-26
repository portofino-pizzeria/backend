import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Menu } from '../src/types.js';
import { createTestApp } from './support/app';
import { seedCategory, seedItem, seedLegend } from './support/fixtures';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

async function getMenu(): Promise<Menu> {
  const res = await app.inject({ method: 'GET', url: '/api/menu' });
  expect(res.statusCode).toBe(200);
  return res.json<Menu>();
}

describe('GET /api/menu — shape', () => {
  it('returns categories, items and the allergen legend', async () => {
    await seedCategory({ id: 'pizza', label: 'Pizza', sortOrder: 0 });
    await seedItem({
      id: 'margherita',
      number: '1',
      name: 'Margherita',
      description: 'Tomaten, Käse',
      categoryId: 'pizza',
      allergenCodes: ['a'],
      variants: [
        { id: 'margherita-klein', label: 'klein', priceCents: 490 },
        { id: 'margherita-gross', label: 'groß', priceCents: 790 },
      ],
    });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);

    const menu = await getMenu();

    expect(Object.keys(menu).sort()).toEqual([
      'allergenLegend',
      'categories',
      'extras',
      'items',
    ]);
    expect(menu.categories).toEqual([
      { id: 'pizza', label: 'Pizza', sortOrder: 0 },
    ]);
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]).toMatchObject({
      id: 'margherita',
      number: '1',
      name: 'Margherita',
      description: 'Tomaten, Käse',
      categoryId: 'pizza',
      allergenCodes: ['a'],
    });
  });

  it('omits optional fields rather than returning nulls', async () => {
    await seedItem({ id: 'schlicht', name: 'Schlicht', number: null });

    const menu = await getMenu();
    const item = menu.items[0];

    expect(item.number).toBeUndefined();
    expect(item.nameEn).toBeUndefined();
    expect(item.imageUrl).toBeUndefined();
    expect('number' in item).toBe(false);
  });

  it('returns the German label as authoritative and the English one alongside', async () => {
    await seedCategory({ id: 'salate', label: 'Salate', labelEn: 'Salads' });
    await seedItem({
      id: 'bauernsalat',
      name: 'Bauernsalat',
      nameEn: 'Farmer salad',
      categoryId: 'salate',
    });

    const menu = await getMenu();

    expect(menu.categories[0]).toEqual({
      id: 'salate',
      label: 'Salate',
      labelEn: 'Salads',
      sortOrder: 0,
    });
    expect(menu.items[0].name).toBe('Bauernsalat');
    expect(menu.items[0].nameEn).toBe('Farmer salad');
  });
});

describe('GET /api/menu — ordering', () => {
  it('returns categories in sortOrder, not insertion order', async () => {
    await seedCategory({ id: 'dessert', label: 'Dessert', sortOrder: 30 });
    await seedCategory({ id: 'pizza', label: 'Pizza', sortOrder: 10 });
    await seedCategory({ id: 'salate', label: 'Salate', sortOrder: 20 });

    const menu = await getMenu();

    expect(menu.categories.map((c) => c.id)).toEqual([
      'pizza',
      'salate',
      'dessert',
    ]);
  });

  it('returns items in sortOrder, not insertion order', async () => {
    await seedItem({ id: 'dritter', name: 'Dritter', sortOrder: 30 });
    await seedItem({ id: 'erster', name: 'Erster', sortOrder: 10 });
    await seedItem({ id: 'zweiter', name: 'Zweiter', sortOrder: 20 });

    const menu = await getMenu();

    expect(menu.items.map((i) => i.id)).toEqual(['erster', 'zweiter', 'dritter']);
  });

  it('returns each item its own variants, in sortOrder', async () => {
    await seedItem({
      id: 'margherita',
      name: 'Margherita',
      variants: [
        { id: 'm-blech', label: 'Blech', sortOrder: 3, priceCents: 2100 },
        { id: 'm-klein', label: 'klein', sortOrder: 1, priceCents: 490 },
        { id: 'm-gross', label: 'groß', sortOrder: 2, priceCents: 790 },
      ],
    });
    await seedItem({
      id: 'schnitzel',
      name: 'Schnitzel',
      variants: [
        { id: 's-pute', label: 'Pute', sortOrder: 2, priceCents: 1390 },
        { id: 's-schwein', label: 'Schwein', sortOrder: 1, priceCents: 1190 },
      ],
    });

    const menu = await getMenu();
    const byId = new Map(menu.items.map((i) => [i.id, i]));

    expect(byId.get('margherita')?.variants.map((v) => v.label)).toEqual([
      'klein',
      'groß',
      'Blech',
    ]);
    expect(byId.get('margherita')?.variants.map((v) => v.price)).toEqual([
      490, 790, 2100,
    ]);
    expect(byId.get('schnitzel')?.variants.map((v) => v.label)).toEqual([
      'Schwein',
      'Pute',
    ]);
  });
});

describe('GET /api/menu — availability', () => {
  it('filters out an unavailable item', async () => {
    await seedItem({ id: 'verfuegbar', name: 'Verfügbar', available: true });
    await seedItem({ id: 'ausverkauft', name: 'Ausverkauft', available: false });

    const menu = await getMenu();

    expect(menu.items.map((i) => i.id)).toEqual(['verfuegbar']);
  });

  it('does not return the variants of an unavailable item', async () => {
    await seedItem({
      id: 'ausverkauft',
      name: 'Ausverkauft',
      available: false,
      variants: [{ id: 'a-gross', label: 'groß', priceCents: 790 }],
    });

    const menu = await getMenu();

    expect(menu.items).toEqual([]);
  });
});

describe('GET /api/menu — variants', () => {
  it('still returns an item that has no variants at all', async () => {
    await seedItem({ id: 'ohne-variante', name: 'Ohne Variante', variants: [] });

    const menu = await getMenu();

    expect(menu.items.map((i) => i.id)).toEqual(['ohne-variante']);
    expect(menu.items[0].variants).toEqual([]);
  });

  it('returns an item with exactly one variant as a one-element list', async () => {
    await seedItem({
      id: 'calzone',
      name: 'Calzone',
      variants: [{ id: 'calzone-gross', label: 'groß', priceCents: 1090 }],
    });

    const menu = await getMenu();

    expect(menu.items[0].variants).toEqual([
      { id: 'calzone-gross', label: 'groß', sortOrder: 0, price: 1090 },
    ]);
  });
});

describe('GET /api/menu — allergen resolution', () => {
  it('flags an allergen code with no legend row as unresolved, and never drops it', async () => {
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    // "d" and "i" are printed on Portofino's real menu and have never been
    // resolved to a legal label. They must survive to the diner as "unbekannt".
    await seedItem({ id: 'tonno', name: 'Tonno', allergenCodes: ['a', 'd'] });

    const menu = await getMenu();
    const byCode = new Map(menu.allergenLegend.map((e) => [e.code, e]));

    expect(menu.items[0].allergenCodes).toEqual(['a', 'd']);
    expect(byCode.get('d')).toEqual({
      code: 'd',
      label: 'unbekannt',
      labelEn: 'unknown',
      resolved: false,
    });
    expect(byCode.get('a')).toEqual({
      code: 'a',
      label: 'Glutenhaltiges Getreide',
      resolved: true,
    });
  });

  it('gives every allergen code on every returned item a legend entry', async () => {
    await seedLegend([
      { code: 'a', labelDe: 'Glutenhaltiges Getreide' },
      { code: 'V', labelDe: 'Vegetarisch' },
    ]);
    await seedItem({ id: 'eins', name: 'Eins', allergenCodes: ['a', 'i'] });
    await seedItem({ id: 'zwei', name: 'Zwei', allergenCodes: ['V', 'd', 'i'] });

    const menu = await getMenu();
    const known = new Set(menu.allergenLegend.map((e) => e.code));

    // This is the invariant the whole surface rests on: a code a diner can see
    // on an item can always be looked up in the legend they are shown.
    for (const item of menu.items) {
      for (const code of item.allergenCodes) {
        expect(known).toContain(code);
      }
    }
    expect(
      menu.allergenLegend.filter((e) => !e.resolved).map((e) => e.code),
    ).toEqual(['d', 'i']);
  });

  it('does not invent unresolved entries for codes no visible item carries', async () => {
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
    // The unavailable item is filtered out, so its "z" never reaches the legend.
    await seedItem({
      id: 'versteckt',
      name: 'Versteckt',
      available: false,
      allergenCodes: ['z'],
    });
    await seedItem({ id: 'sichtbar', name: 'Sichtbar', allergenCodes: ['a'] });

    const menu = await getMenu();

    expect(menu.allergenLegend.map((e) => e.code)).toEqual(['a']);
  });

  it('returns a legend row even when no item uses it', async () => {
    await seedLegend([
      { code: 'a', labelDe: 'Glutenhaltiges Getreide', labelEn: 'Cereals' },
      { code: 'c', labelDe: 'Eier' },
    ]);
    await seedItem({ id: 'ohne-codes', name: 'Ohne Codes', allergenCodes: [] });

    const menu = await getMenu();

    expect(menu.allergenLegend).toEqual([
      {
        code: 'a',
        label: 'Glutenhaltiges Getreide',
        labelEn: 'Cereals',
        resolved: true,
      },
      { code: 'c', label: 'Eier', resolved: true },
    ]);
  });

  it('returns the legend in sortOrder with unresolved codes appended', async () => {
    await seedLegend([
      { code: 'c', labelDe: 'Eier', sortOrder: 2 },
      { code: 'a', labelDe: 'Glutenhaltiges Getreide', sortOrder: 1 },
    ]);
    await seedItem({ id: 'alles', name: 'Alles', allergenCodes: ['c', 'd'] });

    const menu = await getMenu();

    expect(menu.allergenLegend.map((e) => e.code)).toEqual(['a', 'c', 'd']);
    expect(menu.allergenLegend.map((e) => e.resolved)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe('GET /api/menu — empty database', () => {
  it('returns empty lists rather than failing', async () => {
    const menu = await getMenu();

    expect(menu).toEqual({ categories: [], items: [], allergenLegend: [], extras: [] });
  });
});
