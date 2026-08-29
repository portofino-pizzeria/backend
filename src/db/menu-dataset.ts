// Loads and validates the captured Portofino menu (backend/data/menu.json)
// into the shape the seed loader writes to the database.
//
// Two validation passes run before anything touches the database:
//
//  1. Structural (zod) — the JSON has the fields and types the loader
//     expects at all. A malformed capture fails here with a path-addressed
//     message. Every schema below uses `.passthrough()` because the capture
//     carries provenance/source fields (postId, sourceUrl, captureMethod,
//     ...) the loader doesn't need — those are left alone, not stripped.
//
//  2. Semantic (validateSemantics) — the cross-record business invariants
//     the DB schema and the read path (`GET /api/menu`) depend on: every
//     item's categoryId resolves to a real category, every id is unique
//     within its table, every variant has a non-negative integer price,
//     every item has at least one variant. These can't be expressed as a
//     single zod schema because they reference *other* records, so this pass
//     collects every violation across the whole dataset and throws once,
//     naming every offending id — not just the first problem found.
//
// `loadMenuDataset()` is the only export seed.ts needs; the dataset never
// reaches seedMenu()'s transaction unless both passes succeed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const MENU_DATA_PATH = fileURLToPath(
  new URL('../../data/menu.json', import.meta.url),
);

const legendEntrySchema = z
  .object({
    code: z.string().min(1),
    labelDe: z.string().min(1),
    labelEn: z.string().nullable(),
  })
  .passthrough();

const categorySchema = z
  .object({
    id: z.string().min(1),
    labelDe: z.string().min(1),
    labelEn: z.string().nullable(),
    sortOrder: z.number().int(),
  })
  .passthrough();

// `priceCents` is deliberately just `z.number()`, not `.int()`: rejecting a
// non-integer price here would still fail loudly, but with a path like
// `items.42.variants.1.priceCents` instead of the item's actual id.
// validateSemantics() re-checks it and names the offending item/variant.
const variantSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    sortOrder: z.number().int(),
    priceCents: z.number(),
  })
  .passthrough();

const itemSchema = z
  .object({
    id: z.string().min(1),
    number: z.string().nullable(),
    categoryId: z.string().min(1),
    name: z.string().min(1),
    // Null for 11 real items (sauces, Pommes, a couple of soups) that the
    // site simply prints with no descriptive text — not a capture defect.
    // Mapped to the schema's own `''` default at insert time (seed.ts),
    // never invented here.
    description: z.string().nullable(),
    nameEn: z.string().nullable(),
    descriptionEn: z.string().nullable(),
    // Loaded verbatim and validated no further here: an allergen code with no
    // legend row is a deliberate, supported state (resolved at read time as
    // "unbekannt" — see the comment on `allergenLegend` in schema.ts), not a
    // loader error. Dropping an unresolved code would be the worst failure
    // available on this surface.
    allergenCodes: z.array(z.string()),
    available: z.boolean(),
    sortOrder: z.number().int(),
    variants: z.array(variantSchema),
  })
  .passthrough();

const datasetSchema = z
  .object({
    allergenLegend: z.array(legendEntrySchema),
    categories: z.array(categorySchema),
    items: z.array(itemSchema),
  })
  .passthrough();

export type LegendEntry = z.infer<typeof legendEntrySchema>;
export type Category = z.infer<typeof categorySchema>;
export type Variant = z.infer<typeof variantSchema>;
export type Item = z.infer<typeof itemSchema>;
export type MenuDataset = z.infer<typeof datasetSchema>;

function parseShape(raw: unknown, path: string): MenuDataset {
  const result = datasetSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(
      `Menu dataset at ${path} does not match the expected shape ` +
        `(${lines.length} problem${lines.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
    );
  }
  return result.data;
}

function validateSemantics(dataset: MenuDataset): void {
  const problems: string[] = [];

  const categoryIds = new Set<string>();
  for (const category of dataset.categories) {
    if (categoryIds.has(category.id)) {
      problems.push(`Duplicate category id "${category.id}".`);
    }
    categoryIds.add(category.id);
  }

  const legendCodes = new Set<string>();
  for (const entry of dataset.allergenLegend) {
    if (legendCodes.has(entry.code)) {
      problems.push(`Duplicate allergen legend code "${entry.code}".`);
    }
    legendCodes.add(entry.code);
  }

  const itemIds = new Set<string>();
  const variantIds = new Set<string>();
  for (const item of dataset.items) {
    if (itemIds.has(item.id)) {
      problems.push(`Duplicate item id "${item.id}".`);
    }
    itemIds.add(item.id);

    if (!categoryIds.has(item.categoryId)) {
      problems.push(
        `Item "${item.id}" references unknown category "${item.categoryId}".`,
      );
    }

    if (item.variants.length === 0) {
      problems.push(`Item "${item.id}" has zero variants.`);
    }

    for (const variant of item.variants) {
      if (variantIds.has(variant.id)) {
        problems.push(`Duplicate variant id "${variant.id}" (item "${item.id}").`);
      }
      variantIds.add(variant.id);

      if (!Number.isInteger(variant.priceCents) || variant.priceCents < 0) {
        problems.push(
          `Item "${item.id}" variant "${variant.id}" has a non-integer or ` +
            `negative priceCents: ${variant.priceCents}.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Menu dataset failed validation (${problems.length} problem${
        problems.length === 1 ? '' : 's'
      }):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

/**
 * Reads, structurally validates and semantically validates the captured
 * menu at `path` (defaults to `backend/data/menu.json`). Throws — naming
 * every problem found, not just the first — rather than returning a
 * partially-valid dataset. Never touches the database.
 */
export function loadMenuDataset(path: string = MENU_DATA_PATH): MenuDataset {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Could not read/parse menu dataset at ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const dataset = parseShape(raw, path);
  validateSemantics(dataset);
  return dataset;
}
