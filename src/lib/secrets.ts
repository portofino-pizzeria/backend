// Constant-time comparison for the two shared secrets the API checks — the
// kitchen token (`routes/kitchen.ts`) and the owner's menu-editor token
// (`routes/admin-menu.ts`). One helper, so the two guards cannot drift: the
// kitchen guard used to compare with `!==`, which returns at the first
// differing byte and so leaks how much of a guess was right.

import { timingSafeEqual } from 'node:crypto';

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing side-channel, so a wrong-length guess is compared against a
 * same-length buffer and then rejected.
 */
export function secretsMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
