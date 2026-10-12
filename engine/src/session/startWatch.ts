import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionsWaitingOn } from "../protocol.js";
import { readJSON, writeAtomicJSON } from "../review/persist.js";
import type { StartProgress } from "./events.js";

/**
 * §36.7 (audit robustness-05): the start of a session with the user's extensions waits while the CLI makes progress and
 * falls back (§16) only when it stalls. Before, a fixed 20 s watchdog dropped plugins, MCP servers and hooks on a merely
 * slow start (load 100+: five SessionStart hooks took 18 s, the CLI answered at 20.03 s). Now:
 * - the watchdog is a stall timer: every progress signal (`hook_started` / `hook_progress` / `hook_response`, `status`,
 *   `plugin_install`) restarts it (CLI 2.1.309 runs SessionStart hooks before it answers initialize, and reports them);
 * - its limit is max(`settings.extensionsInitTimeoutMs`, adaptive), adaptive = 2 × the longest of the last 3 successful
 *   starts with user settings, at least 45 s — kept per repository in `<git common dir>/reviewgate/extensions-start.json`;
 * - `session.extensionsWaitingOn` names what the start waits on.
 */

export const ADAPTIVE_INIT_MIN_MS = 45_000;
/** The default floor (`settings.extensionsInitTimeoutMs` absent): what the fixed watchdog used to be (§16). */
export const INIT_TIMEOUT_FLOOR_MS = 20_000;
const HISTORY_KEPT = 3;
export const START_HISTORY_FILE = join("reviewgate", "extensions-start.json");

type StartHistoryFile = { version: 1; durations: number[]; savedAt: string };

/** 2 × the longest of the last 3 successful starts (ms), at least 45 s. */
export function adaptiveInitTimeout(history: readonly number[]): number {
  const recent = history.slice(-HISTORY_KEPT);
  return Math.max(ADAPTIVE_INIT_MIN_MS, recent.length > 0 ? 2 * Math.max(...recent) : 0);
}

/** The stall limit of a start: the setting is a floor (default 20 000), `0` turns the watchdog off. */
export function initStallLimit(setting: number | undefined, history: readonly number[]): number {
  const floor = setting ?? INIT_TIMEOUT_FLOOR_MS;
  if (floor <= 0) return 0;
  return Math.max(floor, adaptiveInitTimeout(history));
}

/** The history with one more successful start (≥ 0 ms; the last three are kept). */
export function noteStartDuration(history: readonly number[], ms: number): number[] {
  if (!Number.isFinite(ms) || ms < 0) return [...history];
  return [...history, Math.round(ms)].slice(-HISTORY_KEPT);
}

export async function loadStartHistory(gitDir: string): Promise<number[]> {
  const f = await readJSON<Partial<StartHistoryFile>>(join(gitDir, START_HISTORY_FILE));
  if (!f || f.version !== 1 || !Array.isArray(f.durations)) return [];
  return f.durations.filter((d): d is number => typeof d === "number" && Number.isFinite(d) && d >= 0).slice(-HISTORY_KEPT);
}

export async function saveStartHistory(gitDir: string, durations: readonly number[]): Promise<void> {
  await mkdir(join(gitDir, "reviewgate"), { recursive: true });
  await writeAtomicJSON(join(gitDir, START_HISTORY_FILE), { version: 1, durations: durations.slice(-HISTORY_KEPT), savedAt: new Date().toISOString() } satisfies StartHistoryFile);
}

/** A timer that fires once after `ms` without a `restart()`; `stop()` (or firing) ends it for good. */
export class StallWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(
    private readonly ms: number,
    private readonly onStall: () => void,
  ) {
    this.restart();
  }

  restart(): void {
    if (this.done) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.done = true;
      this.onStall();
    }, this.ms);
    this.timer.unref?.();
  }

  stop(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * `session.extensionsWaitingOn` from the start's progress signals: the latest hook still running (by its hook id), else a
 * plugin install in progress, else `unknown` (the CLI works on something it does not report: MCP servers, settings).
 * null before any signal.
 */
export class WaitingOn {
  private readonly hooks = new Map<string, string | null>();
  private plugin: string | null | undefined;
  private seen = false;

  note(p: StartProgress): void {
    this.seen = true;
    if (p.kind === "hook") {
      const key = p.id ?? p.name ?? "";
      this.hooks.delete(key);
      if (!p.done) this.hooks.set(key, p.name);
    } else if (p.kind === "plugin") {
      this.plugin = p.done ? undefined : p.name;
    }
  }

  get current(): ExtensionsWaitingOn | null {
    if (!this.seen) return null;
    const hooks = [...this.hooks.values()];
    if (hooks.length > 0) return { kind: "hook", name: hooks[hooks.length - 1] ?? null };
    if (this.plugin !== undefined) return { kind: "plugin", name: this.plugin };
    return { kind: "unknown", name: null };
  }

  reset(): void {
    this.hooks.clear();
    this.plugin = undefined;
    this.seen = false;
  }
}
