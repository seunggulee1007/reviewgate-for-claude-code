// MARK: wave4 w4-install — audit daily-08
// Coming back to the window ran `git status` on every worktree at once (30 in acme) with a 2 s limit: all of them
// timed out under the load they made, and the workbench menu never showed a dirty (●) mark. Now: four at a time, a
// generous timeout, a recent answer reused, the last known value kept on a timeout, and a scan already running joined.
import { worktreeDirty } from "./worktrees.js";

export type DirtyCheck = (path: string, timeoutMs: number) => Promise<boolean | null>;

/** At most this many `git status` at once. */
export const DIRTY_SCAN_LIMIT = 4;
/** Per worktree; a large monorepo's status under load takes seconds, not milliseconds. */
export const DIRTY_SCAN_TIMEOUT_MS = 15_000;
/** An answer younger than this is reused when the window comes back (an explicit refresh always re-checks). */
export const DIRTY_SCAN_FRESH_MS = 20_000;

/** Runs `fn` over `items`, never more than `limit` at once. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export type DirtyScannerOptions = {
  check?: DirtyCheck;
  limit?: number;
  timeoutMs?: number;
  freshMs?: number;
  now?: () => number;
};

export class DirtyScanner {
  /** `at` 0: never answered (a timeout keeps the value but not the time, so the next scan tries again). */
  private readonly cache = new Map<string, { value: boolean | null; at: number }>();
  private inflight: { key: string; done: Promise<void> } | null = null;
  private readonly check: DirtyCheck;
  private readonly limit: number;
  private readonly timeoutMs: number;
  private readonly freshMs: number;
  private readonly now: () => number;

  constructor(opts: DirtyScannerOptions = {}) {
    this.check = opts.check ?? worktreeDirty;
    this.limit = opts.limit ?? DIRTY_SCAN_LIMIT;
    this.timeoutMs = opts.timeoutMs ?? DIRTY_SCAN_TIMEOUT_MS;
    this.freshMs = opts.freshMs ?? DIRTY_SCAN_FRESH_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The last known value; undefined when this path was never checked. */
  cached(path: string): boolean | null | undefined {
    return this.cache.get(path)?.value;
  }

  /**
   * Checks `paths` (`limit` at a time); `onResult` fires per answer with the value to show. A scan of the same paths
   * still running is joined. `force` (an explicit refresh) re-checks answers that are still fresh.
   */
  scan(paths: readonly string[], onResult: (path: string, dirty: boolean | null) => void, opts: { force?: boolean } = {}): Promise<void> {
    const key = paths.join("\0");
    if (this.inflight?.key === key) return this.inflight.done;
    const done = this.run(paths, onResult, opts.force === true).finally(() => {
      if (this.inflight?.done === done) this.inflight = null;
    });
    this.inflight = { key, done };
    return done;
  }

  private async run(paths: readonly string[], onResult: (path: string, dirty: boolean | null) => void, force: boolean): Promise<void> {
    const started = this.now();
    const due = paths.filter((p) => {
      const hit = this.cache.get(p);
      return force || !hit || hit.at === 0 || started - hit.at >= this.freshMs;
    });
    await mapLimit(due, this.limit, async (path) => {
      let answer: boolean | null;
      try {
        answer = await this.check(path, this.timeoutMs);
      } catch {
        answer = null;
      }
      const prev = this.cache.get(path);
      const value = answer === null && prev !== undefined && prev.value !== null ? prev.value : answer;
      this.cache.set(path, { value, at: answer === null ? 0 : this.now() });
      try {
        onResult(path, value);
      } catch {
        // the caller's bookkeeping must not stop the other checks
      }
    });
  }
}
