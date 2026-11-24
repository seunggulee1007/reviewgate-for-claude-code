// §48 Windows: a release found before CI attached its Windows installer is looked up again every 3 minutes for at most an
// hour from the first miss, stops once the installer is there, again on a window's focus when the miss is stale, and at
// once from [Check Again] (not twice within a few seconds); nothing by itself while automatic checks are off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_AGAIN_MIN_MS, FOCUS_CHECK_AFTER_MS, InstallerRecheck, RECHECK_EVERY_MS, RECHECK_FOR_MS } from "./updateRecheck";

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

/** A recheck whose check answers at once: `missing` says whether the installer is still not attached. */
function harness() {
  let missing: string | null = "0.6.0";
  let auto = true;
  let checks = 0;
  const r: InstallerRecheck = new InstallerRecheck({
    check: () => {
      checks++;
      r.checked(missing);
    },
    now: () => Date.now(),
    auto: () => auto,
  });
  return { r, checks: () => checks, setMissing: (v: string | null) => (missing = v), setAuto: (v: boolean) => (auto = v) };
}

describe("looking again for the Windows installer (§48 Windows)", () => {
  it("every 3 minutes while it is missing, for at most an hour, then the normal schedule", async () => {
    const h = harness();
    h.r.checked("0.6.0");
    expect(h.r.watching).toBe(true);
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS - 1);
    expect(h.checks()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(RECHECK_FOR_MS);
    expect(h.checks()).toBe(RECHECK_FOR_MS / RECHECK_EVERY_MS);
    expect(h.r.watching).toBe(false);
    await vi.advanceTimersByTimeAsync(RECHECK_FOR_MS);
    expect(h.checks()).toBe(RECHECK_FOR_MS / RECHECK_EVERY_MS);
  });

  it("stops once the installer is attached", async () => {
    const h = harness();
    h.r.checked("0.6.0");
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS * 2);
    expect(h.checks()).toBe(2);
    h.setMissing(null);
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS);
    expect(h.checks()).toBe(3);
    expect(h.r.watching).toBe(false);
    await vi.advanceTimersByTimeAsync(RECHECK_FOR_MS);
    expect(h.checks()).toBe(3);
  });

  it("a newer release without its installer starts its own hour", async () => {
    const h = harness();
    h.r.checked("0.6.0");
    await vi.advanceTimersByTimeAsync(RECHECK_FOR_MS);
    expect(h.r.watching).toBe(false);
    h.setMissing("0.6.1");
    h.r.checked("0.6.1");
    expect(h.r.watching).toBe(true);
    const before = h.checks();
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS);
    expect(h.checks()).toBe(before + 1);
  });

  it("automatic checks off: nothing by itself, Check Again still checks", async () => {
    const h = harness();
    h.setAuto(false);
    h.r.checked("0.6.0");
    expect(h.r.watching).toBe(false);
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS * 3);
    h.r.focused();
    expect(h.checks()).toBe(0);
    h.r.checkAgain();
    expect(h.checks()).toBe(1);
  });

  it("a window's focus checks a miss older than 3 minutes; Check Again is not repeated within a few seconds", async () => {
    const h = harness();
    h.r.checked("0.6.0");
    h.r.stop(); // the timer aside: only focus and the button
    h.r.focused();
    expect(h.checks()).toBe(0);
    vi.setSystemTime(RECHECK_EVERY_MS);
    h.r.focused();
    expect(h.checks()).toBe(1);
    h.r.checkAgain();
    expect(h.checks()).toBe(1);
    vi.setSystemTime(RECHECK_EVERY_MS + CHECK_AGAIN_MIN_MS);
    h.r.checkAgain();
    expect(h.checks()).toBe(2);
    // The installer found: focus does nothing any more.
    h.setMissing(null);
    vi.setSystemTime(RECHECK_EVERY_MS * 2);
    h.r.checkAgain();
    expect(h.checks()).toBe(3);
    vi.setSystemTime(RECHECK_EVERY_MS * 5);
    h.r.focused();
    expect(h.checks()).toBe(3);
  });

  it("a focus an hour after the last check looks again, sooner or with automatic checks off does not", () => {
    const h = harness();
    h.setMissing(null);
    h.r.focused(); // before the first check: the launch check is coming
    expect(h.checks()).toBe(0);
    h.r.checked(null);
    vi.setSystemTime(FOCUS_CHECK_AFTER_MS - 1);
    h.r.focused();
    expect(h.checks()).toBe(0);
    h.setAuto(false);
    vi.setSystemTime(FOCUS_CHECK_AFTER_MS * 3);
    h.r.focused();
    expect(h.checks()).toBe(0);
    h.setAuto(true);
    h.r.focused();
    expect(h.checks()).toBe(1);
    h.r.focused(); // the check just ended: nothing again
    expect(h.checks()).toBe(1);
    vi.setSystemTime(FOCUS_CHECK_AFTER_MS * 4);
    h.r.focused();
    expect(h.checks()).toBe(2);
  });
});
