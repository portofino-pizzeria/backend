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
//    Dockerfile, so this branch guards the one place `NODE_ENV=production`
//    could ever be set for this script, where the menu is the owner's and
//    not a fixture — see the note below on whether anything can reach it.
//
// IN A DEPLOYED CONTAINER THE COMMAND IS `npm run db:reseed:dist`, not
// `db:reseed`. The runtime image carries the COMPILED tree and nothing else:
// `npm prune --omit=dev` removes `tsx`, `src/` is never copied into the
// runtime stage, and `.env` is in `.dockerignore` (the platform supplies
// `DATABASE_URL` as a real environment variable). So the `db:reseed` spelling
// — `tsx --env-file=.env src/db/reseed.ts` — cannot run there at all, which
// for a while left the production guard above written for a command nobody
// could type on the one surface it names. `db:reseed:dist` runs
// `dist/db/reseed.js`, reaches the same `checkReseedArgs()` with the same two
// flags, and is what the README documents:
//
//   npm run db:reseed:dist -- --force --i-know-this-erases-owner-edits
//
// A refusal prints why and exits non-zero, so a script that chained it stops.
// The argument check is the pure `checkReseedArgs()` so it is unit-tested
// without a process to spawn.
//
// THIS FIXES THE SPELLING, NOT REACHABILITY. Fixing what you would type does
// not mean there is anywhere to type it: AWS App Runner (../infra/backend-
// service.tf) gives no exec/shell/SSM access into a running instance — there
// is no `aws apprunner exec` — and the Aurora cluster is `publicly_accessible
// = false`, with a security group that admits Postgres only from the App
// Runner VPC connector's own security group (../infra/database.tf,
// ../infra/network.tf). That excludes every OTHER path too, not just a
// container shell: a laptop or a GitHub Actions runner pointed at the real
// DATABASE_URL cannot open the TCP connection either, whatever credentials it
// holds. So the `NODE_ENV=production` branch above has no exercisable path
// today, from inside the deployed container or outside it. Reaching it needs
// a one-off admin task placed IN the private subnets (an ECS/Fargate
// `run-task` is the usual shape) that does not exist in ../infra yet. That is
// infrastructure work this repo cannot do on its own, so it is not implied
// by this fix.

import { fileURLToPath } from 'node:url';

import { sql } from './client.js';
import { reseedMenu } from './seed.js';

export const FORCE_FLAG = '--force';
export const PRODUCTION_FLAG = '--i-know-this-erases-owner-edits';

export type ReseedArgsCheck = { ok: true } | { ok: false; message: string };

/**
 * How this reseed is spelled where it is being refused.
 *
 * `NODE_ENV=production` means the deployed container, and there the `db:reseed`
 * script cannot run at all: `tsx` is pruned from the image, `src/` is not
 * copied into the runtime stage and `.env` is in `.dockerignore`. A refusal
 * that told an operator to type `npm run db:reseed -- --force` there would send
 * them at a command that fails for a reason that has nothing to do with the
 * guard. `db:reseed:dist` runs the compiled `dist/db/reseed.js`, which is what
 * is actually in the image.
 */
export function reseedCommand(nodeEnv: string | undefined): string {
  return nodeEnv === 'production'
    ? 'npm run db:reseed:dist --'
    : 'npm run db:reseed --';
}

/**
 * `NODE_ENV=production` is a proxy for "inside the image", not a synonym for
 * it: an operator can set it in a source checkout to point a reseed at the
 * production database, and there `dist/` may not have been built. Saying so in
 * the refusal costs one line and stops the suggestion failing with
 * `Cannot find module` — which would be the same "names a command that cannot
 * run here" this whole message exists to end, just mirrored.
 */
const SOURCE_CHECKOUT_NOTE =
  '(In a source checkout rather than the container, `npm run build` first.)';

/**
 * Decides whether a reseed may run, from the command-line arguments (without
 * the node/script prefix) and `NODE_ENV`. Pure: no I/O, no process access.
 */
export function checkReseedArgs(
  args: readonly string[],
  nodeEnv: string | undefined,
): ReseedArgsCheck {
  const command = reseedCommand(nodeEnv);

  if (!args.includes(FORCE_FLAG)) {
    return {
      ok: false,
      message: [
        'Refusing to reseed the menu without --force.',
        'A reseed deletes every menu row and reloads data/menu.json, erasing every',
        "edit made in the owner's menu editor.",
        // Only outside production: `db:seed` is a `tsx` script and is not in
        // the runtime image either, and a boot seeds an empty database anyway.
        ...(nodeEnv === 'production'
          ? []
          : [
              'To bootstrap an empty database, use `npm run db:seed` (it never',
              'overwrites an existing menu).',
            ]),
        'To really reset:',
        // In production BOTH flags, not just --force: printing the one-flag
        // form there would name a command the very next gate refuses, which
        // is the same "the message points at something that cannot run" the
        // `command` above exists to end.
        ...(nodeEnv === 'production'
          ? [`  ${command} ${FORCE_FLAG} ${PRODUCTION_FLAG}`, SOURCE_CHECKOUT_NOTE]
          : [`  ${command} ${FORCE_FLAG}`]),
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
        `  ${command} ${FORCE_FLAG} ${PRODUCTION_FLAG}`,
        SOURCE_CHECKOUT_NOTE,
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
