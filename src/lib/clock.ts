// The one place order handling asks "what time is it". Opening hours make the
// answer load-bearing, so the test suite pins it: without that, the order tests
// would fail every Tuesday and every night after 22:30.

let fixed: Date | null = null;

export function now(): Date {
  return fixed ? new Date(fixed.getTime()) : new Date();
}

/** Test-only: pin the clock (`null` restores real time). */
export function setNowForTests(instant: Date | null): void {
  fixed = instant;
}
