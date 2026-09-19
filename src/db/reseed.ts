// `npm run db:reseed -- --force` — the deliberate full reset of the menu.
//
// Deletes the four menu tables, reloads them from `data/menu.json` and
// rewrites the `menu` row in `dataset_seeds` (see `reseedMenu()` in seed.ts).
// Every edit the owner made in the menu editor is erased. That used to happen
// on every boot; now it happens only when someone types this command with the
// flags below, so the flags are the whole safety of it:
//
//  - `--force` is always required. A bare `npm run db:reseed`, run by habit
//    or by a script that meant `db:seed`, refuses.
//  - With `NODE_ENV=production` it also requires
//    `--i-know-this-erases-owner-edits`. `NODE_ENV` is `production` in the
//    Dockerfile, so this is the guard for a shell opened inside a deployed
//    container, where the menu is the owner's and not a fixture.
//
// A refusal prints why and exits non-zero, so a script that chained it stops.
// The argument check is the pure `checkReseedArgs()` so it is unit-tested
// without a process to spawn.

import { fileURLToPath } from 'node:url';

import { sql } from './client.js';
import { reseedMenu } from './seed.js';

export const FORCE_FLAG = '--force';
export const PRODUCTION_FLAG = '--i-know-this-erases-owner-edits';

export type ReseedArgsCheck = { ok: true } | { ok: false; message: string };

/**
 * Decides whether a reseed may run, from the command-line arguments (without
 * the node/script prefix) and `NODE_ENV`. Pure: no I/O, no process access.
 */
export function checkReseedArgs(
  args: readonly string[],
  nodeEnv: string | undefined,
): ReseedArgsCheck {
  if (!args.includes(FORCE_FLAG)) {
    return {
      ok: false,
      message: [
        'Refusing to reseed the menu without --force.',
        'A reseed deletes every menu row and reloads data/menu.json, erasing every',
        "edit made in the owner's menu editor. To bootstrap an empty database, use",
        '`npm run db:seed` (it never overwrites an existing menu). To really reset:',
        '  npm run db:reseed -- --force',
      ].join('\n'),
    };
  }
  if (nodeEnv === 'production' && !args.includes(PRODUCTION_FLAG)) {
    return {
      ok: false,
      message: [
        `Refusing to reseed the menu with NODE_ENV=production without ${PRODUCTION_FLAG}.`,
        "In production the menu is the owner's: a reseed erases every edit made in",
        'the menu editor since the database was seeded, and no snapshot restores',
        'them selectively. If that is really intended:',
        `  npm run db:reseed -- ${FORCE_FLAG} ${PRODUCTION_FLAG}`,
      ].join('\n'),
    };
  }
  return { ok: true };
}

// Windows-safe entry guard — see the comment at the bottom of seed.ts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = checkReseedArgs(process.argv.slice(2), process.env.NODE_ENV);
  if (!check.ok) {
    console.error(check.message);
    // The pool opened when client.ts was imported; close it so the refusal
    // exits promptly instead of waiting on idle connections.
    void sql.end().finally(() => process.exit(2));
  } else {
    reseedMenu()
      .then(() => sql.end())
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Reseed failed:', err);
        process.exit(1);
      });
  }
}
