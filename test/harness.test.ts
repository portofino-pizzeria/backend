// Tests of the test harness itself. If these go red, nothing else in the suite
// means anything: a suite that silently ran against the wrong database, or one
// whose tests leak state into each other, can be green and worthless.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import type { Menu } from '../src/types.js';
import { createTestApp } from './support/app';
import {
  databaseName,
  resolveTestDatabaseUrl,
} from './support/database';
import { seedItem, seedLegend } from './support/fixtures';

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

describe('database target', () => {
  it('runs against a database whose name marks it as a test database', () => {
    expect(databaseName(config.databaseUrl)).toMatch(/test/i);
  });

  it('has redirected the production config at the test database', () => {
    expect(config.databaseUrl).toBe(resolveTestDatabaseUrl());
  });
});

describe('resolveTestDatabaseUrl', () => {
  it('refuses a database that does not look like a test database', () => {
    expect(() =>
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: 'postgres://portofino:portofino@localhost:5432/portofino',
      }),
    ).toThrow(/Refusing to run the test suite/);
  });

  it('allows the refusal to be overridden explicitly', () => {
    const url = 'postgres://portofino:portofino@localhost:5432/portofino';
    expect(
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: url,
        ALLOW_UNSAFE_TEST_DATABASE: '1',
      }),
    ).toBe(url);
  });

  it('falls back to a _test database on the local dev Postgres', () => {
    expect(databaseName(resolveTestDatabaseUrl({}))).toBe('portofino_test');
  });
});

describe('isolation between tests', () => {
  // These two run in order within this file; the second is the assertion that
  // matters — it must not see anything the first one wrote.
  it('sees what it seeded', async () => {
    await seedItem({ id: 'eins', name: 'Eins' });
    await seedItem({ id: 'zwei', name: 'Zwei' });
    await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);

    const menu = await getMenu();

    expect(menu.items).toHaveLength(2);
    expect(menu.allergenLegend).toHaveLength(1);
    expect(menu.categories).toHaveLength(1);
  });

  it('starts the next test from an empty database', async () => {
    const menu = await getMenu();

    expect(menu).toEqual({ categories: [], items: [], allergenLegend: [] });
  });
});

describe('fixture defaults', () => {
  it('gives an item one priced variant when none is asked for', async () => {
    const item = await seedItem({ name: 'Standard' });

    expect(item.id).toBe('standard');
    expect(item.variants).toHaveLength(1);
    expect(item.variants[0].priceCents).toBeGreaterThan(0);
  });

  it('generates a unique id per item when none is given', async () => {
    const first = await seedItem();
    const second = await seedItem();

    expect(first.id).not.toBe(second.id);
  });

  it('creates the category an item names', async () => {
    await seedItem({ categoryId: 'nudeln' });

    const menu = await getMenu();

    expect(menu.categories.map((c) => c.id)).toEqual(['nudeln']);
  });
});
