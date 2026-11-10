// MARK: wave4 w4-install — audit daily-08: the workbench menu's dirty (●) check across many worktrees.
import { describe, expect, it } from "vitest";
import { DirtyScanner, mapLimit } from "../src/git/dirtyScan.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("mapLimit", () => {
  it("never runs more than `limit` at once and visits every item", async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapLimit(Array.from({ length: 30 }, (_, i) => i), 4, async (i) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      seen.push(i);
      running--;
    });
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });
});

describe("DirtyScanner", () => {
  it("checks 30 worktrees four at a time with a generous timeout", async () => {
    let running = 0;
    let peak = 0;
    const timeouts = new Set<number>();
    const scanner = new DirtyScanner({
      check: async (path, timeoutMs) => {
        timeouts.add(timeoutMs);
        running++;
        peak = Math.max(peak, running);
        await tick();
        running--;
        return path.endsWith("7");
      },
    });
    const results = new Map<string, boolean | null>();
    const paths = Array.from({ length: 30 }, (_, i) => `/wt/${i}`);
    await scanner.scan(paths, (p, d) => results.set(p, d));
    expect(peak).toBeLessThanOrEqual(4);
    expect(results.size).toBe(30);
    expect([...results].filter(([, d]) => d === true).map(([p]) => p)).toEqual(["/wt/7", "/wt/17", "/wt/27"]);
    expect([...timeouts].every((t) => t >= 10_000)).toBe(true);
    expect(scanner.cached("/wt/7")).toBe(true);
    expect(scanner.cached("/wt/8")).toBe(false);
    expect(scanner.cached("/nowhere")).toBeUndefined();
  });

  it("keeps a fresh answer, re-checks a stale one or a forced scan, and keeps the last value on a timeout", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    let answer: boolean | null = true;
    const scanner = new DirtyScanner({
      freshMs: 20_000,
      now: () => now,
      check: async (path) => {
        calls.push(path);
        return answer;
      },
    });
    await scanner.scan(["/a", "/b"], () => {});
    expect(calls).toEqual(["/a", "/b"]);
    // Coming back to the window 5 s later: nothing re-runs.
    now += 5_000;
    await scanner.scan(["/a", "/b"], () => {});
    expect(calls).toEqual(["/a", "/b"]);
    // An explicit refresh always re-checks.
    await scanner.scan(["/a"], () => {}, { force: true });
    expect(calls).toEqual(["/a", "/b", "/a"]);
    // 30 s later both are stale; git times out (null) — the last known value stays.
    now += 30_000;
    answer = null;
    const got = new Map<string, boolean | null>();
    await scanner.scan(["/a", "/b"], (p, d) => got.set(p, d));
    expect(got).toEqual(new Map([["/a", true], ["/b", true]]));
    expect(scanner.cached("/b")).toBe(true);
    // …and stays stale, so the next scan tries again.
    answer = false;
    await scanner.scan(["/b"], (p, d) => got.set(p, d));
    expect(got.get("/b")).toBe(false);
  });

  it("joins a scan of the same worktrees that is still running instead of starting a second one", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const scanner = new DirtyScanner({
      check: async () => {
        calls++;
        await gate;
        return false;
      },
    });
    const first = scanner.scan(["/a", "/b"], () => {});
    const second = scanner.scan(["/a", "/b"], () => {});
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });

  it("a throwing result handler does not stop the scan", async () => {
    const scanner = new DirtyScanner({ check: async () => true });
    const seen: string[] = [];
    await scanner.scan(["/a", "/b"], (p) => {
      seen.push(p);
      throw new Error("boom");
    });
    expect(seen.sort()).toEqual(["/a", "/b"]);
  });
});
