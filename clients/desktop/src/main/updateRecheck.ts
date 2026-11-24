/**
 * §48 Windows: a release is published with the Mac's DMG first and CI attaches the Windows installer and its `.sha256`
 * some 10–15 minutes later. A check in that window finds the release without them, so [Install and Restart] is off; this
 * looks again every 3 minutes for at most an hour from the first miss (then the 6-hour schedule goes on), on a window's
 * focus when the miss is older than 3 minutes, and at once from [Check Again] (not twice within a few seconds).
 * Electron-free: main passes the check and the "Check for updates automatically" setting (src/main/update.ts).
 */

export const RECHECK_EVERY_MS = 3 * 60 * 1000;
export const RECHECK_FOR_MS = 60 * 60 * 1000;
/** [Check Again] right after a check does nothing. */
export const CHECK_AGAIN_MIN_MS = 5_000;

export type RecheckDeps = {
  /** One check; its result comes back through `checked`. */
  check(): void;
  now(): number;
  /** "Check for updates automatically" — the timer and the focus look only while it is on. */
  auto(): boolean;
};

export class InstallerRecheck {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The release seen without its installer, since its first such check. */
  private missing: { version: string; since: number } | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: RecheckDeps) {}

  /** After every check: the newest release still lacks its installer (its version), or not (null). */
  checked(missingVersion: string | null): void {
    const now = this.deps.now();
    this.lastAt = now;
    this.stop();
    if (missingVersion === null) {
      this.missing = null;
      return;
    }
    if (this.missing?.version !== missingVersion) this.missing = { version: missingVersion, since: now };
    if (now + RECHECK_EVERY_MS - this.missing.since > RECHECK_FOR_MS) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.deps.auto()) this.deps.check();
    }, RECHECK_EVERY_MS);
    this.timer.unref?.();
  }

  /** Looking again by itself: a miss within its hour while automatic checks are on. */
  get watching(): boolean {
    return this.missing !== null && this.deps.now() - this.missing.since < RECHECK_FOR_MS && this.deps.auto();
  }

  /** A window came to the front: a miss older than 3 minutes is looked up again. */
  focused(): void {
    if (this.missing && this.deps.auto() && this.deps.now() - this.lastAt >= RECHECK_EVERY_MS) this.deps.check();
  }

  /** [Check Again]: a check now, unless one ended a moment ago. */
  checkAgain(): void {
    if (this.deps.now() - this.lastAt >= CHECK_AGAIN_MIN_MS) this.deps.check();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
