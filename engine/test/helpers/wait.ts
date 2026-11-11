/**
 * Poll deadline for every "wait until X" in the tests. It only bounds a FAILING test — a passing one returns the moment the
 * condition holds — so it is generous (CI runners stall), yet a bit under the per-test timeout (vitest.config.ts) so the
 * helper's own "timed out waiting for X" message wins over vitest's generic one.
 */
export const WAIT_MS = process.platform === "win32" ? 110_000 : 50_000;
