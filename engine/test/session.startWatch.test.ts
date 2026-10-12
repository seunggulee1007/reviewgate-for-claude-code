import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import {
  ADAPTIVE_INIT_MIN_MS,
  adaptiveInitTimeout,
  initStallLimit,
  loadStartHistory,
  noteStartDuration,
  saveStartHistory,
  StallWatchdog,
  WaitingOn,
} from "../src/session/startWatch.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §36.7 (audit robustness-05): the init watchdog is a stall timer — every progress signal of the starting
 * CLI restarts it — with an adaptive floor (2 × the longest of the last 3 successful starts, ≥ 45 s), and the session says
 * what it waits on.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("limits (§36.7)", () => {
  it("adaptive = 2 × the longest of the last 3 successful starts, at least 45 s; the setting is a floor, 0 turns it off", () => {
    expect(adaptiveInitTimeout([])).toBe(ADAPTIVE_INIT_MIN_MS);
    expect(ADAPTIVE_INIT_MIN_MS).toBe(45_000);
    expect(adaptiveInitTimeout([3000, 4000])).toBe(45_000);
    expect(adaptiveInitTimeout([18_000, 31_000, 9000])).toBe(62_000);
    // Only the last three count.
    expect(adaptiveInitTimeout([90_000, 10_000, 12_000, 11_000])).toBe(45_000);
    expect(initStallLimit(undefined, [])).toBe(45_000);
    expect(initStallLimit(20_000, [])).toBe(45_000); // Electron always sends 20 000: still the adaptive limit
    expect(initStallLimit(120_000, [30_000])).toBe(120_000);
    expect(initStallLimit(20_000, [40_000])).toBe(80_000);
    expect(initStallLimit(0, [40_000])).toBe(0);
  });

  it("noteStartDuration keeps the last three; the history file lives in a git dir and survives garbage", async () => {
    expect(noteStartDuration([1, 2, 3], 4)).toEqual([2, 3, 4]);
    expect(noteStartDuration([], -5)).toEqual([]);
    expect(noteStartDuration([], Number.NaN)).toEqual([]);
    const dir = realpathSync(makeTempDir("rg-start-history"));
    dirs.push(dir);
    expect(await loadStartHistory(dir)).toEqual([]);
    await saveStartHistory(dir, [1200, 30_000]);
    expect(await loadStartHistory(dir)).toEqual([1200, 30_000]);
  });
});

describe("StallWatchdog", () => {
  it("fires only after the limit passed with no signal; restart() pushes it out; stop() ends it", async () => {
    let fired = 0;
    const w = new StallWatchdog(60, () => (fired += 1));
    await sleep(40);
    w.restart();
    await sleep(40);
    w.restart();
    await sleep(40);
    expect(fired).toBe(0);
    await sleep(60);
    expect(fired).toBe(1);
    w.restart(); // after it fired: nothing more
    await sleep(80);
    expect(fired).toBe(1);
    const s = new StallWatchdog(30, () => (fired += 1));
    s.stop();
    await sleep(50);
    expect(fired).toBe(1);
  });
});

describe("WaitingOn", () => {
  it("names the latest running hook, else a plugin being installed, else unknown", () => {
    const w = new WaitingOn();
    expect(w.current).toBeNull();
    w.note({ kind: "hook", id: "h1", name: "SessionStart:startup" });
    expect(w.current).toEqual({ kind: "hook", name: "SessionStart:startup" });
    w.note({ kind: "hook", id: "h2", name: "SessionStart:resume" });
    expect(w.current).toEqual({ kind: "hook", name: "SessionStart:resume" });
    w.note({ kind: "hook", id: "h2", name: "SessionStart:resume", done: true });
    expect(w.current).toEqual({ kind: "hook", name: "SessionStart:startup" });
    w.note({ kind: "hook", id: "h1", name: "SessionStart:startup", done: true });
    expect(w.current).toEqual({ kind: "unknown", name: null });
    w.note({ kind: "plugin", name: "omc-marketplace" });
    expect(w.current).toEqual({ kind: "plugin", name: "omc-marketplace" });
    w.note({ kind: "plugin", name: null, done: true });
    expect(w.current).toEqual({ kind: "unknown", name: null });
    w.note({ kind: "status", name: "requesting" });
    expect(w.current).toEqual({ kind: "unknown", name: null });
    w.reset();
    expect(w.current).toBeNull();
  });
});

// ------------------------------------------------------------------ ClaudeSession: the watchdog restarts at every progress signal

function sdk(): { queryFn: (a: { options?: Options }) => Query; resolveInit: () => void } {
  let resolveInit: () => void = () => {};
  const init = new Promise<unknown>((r) => (resolveInit = () => r({ commands: [] })));
  let end: () => void = () => {};
  const ended = new Promise<void>((r) => (end = r));
  const queryFn = (): Query =>
    ({
      async next() {
        await ended;
        return { done: true, value: undefined };
      },
      async return() {
        end();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      initializationResult: () => init,
    }) as unknown as Query;
  return { queryFn, resolveInit: () => resolveInit() };
}

function session(events: SessionEvent[], fake: ReturnType<typeof sdk>, initTimeoutMs: number, loadLocalSettings = false, loadUserSettings = true): ClaudeSession {
  return new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings, loadLocalSettings, systemPromptAppend: "", initTimeoutMs, startSlowHintMs: 0 },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: fake.queryFn as never,
  });
}

const feed = (s: ClaudeSession, m: Record<string, unknown>) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage({ uuid: "u", session_id: "s", ...m } as unknown as SDKMessage);

describe("ClaudeSession start progress (§36.7)", () => {
  it("hook / plugin / status signals restart the stall timer and go out as start_progress; a real stall still fires", async () => {
    const events: SessionEvent[] = [];
    const fake = sdk();
    const s = session(events, fake, 80);
    await s.start();
    // Keep it busy for longer than the limit with signals 50 ms apart: no init_timeout.
    for (let i = 0; i < 4; i++) {
      await sleep(50);
      feed(s, { type: "system", subtype: i % 2 === 0 ? "hook_started" : "hook_progress", hook_id: "h1", hook_name: "SessionStart:startup", hook_event: "SessionStart" });
    }
    await sleep(50);
    feed(s, { type: "system", subtype: "plugin_install", status: "installed", name: "omc" });
    await sleep(50);
    feed(s, { type: "system", subtype: "hook_response", hook_id: "h1", hook_name: "SessionStart:startup", hook_event: "SessionStart", outcome: "success" });
    expect(events.filter((e) => e.type === "init_timeout")).toEqual([]);
    expect(events.filter((e) => e.type === "start_progress")).toEqual([
      { type: "start_progress", kind: "hook", id: "h1", name: "SessionStart:startup" },
      { type: "start_progress", kind: "hook", id: "h1", name: "SessionStart:startup" },
      { type: "start_progress", kind: "hook", id: "h1", name: "SessionStart:startup" },
      { type: "start_progress", kind: "hook", id: "h1", name: "SessionStart:startup" },
      { type: "start_progress", kind: "plugin", name: "omc" },
      { type: "start_progress", kind: "hook", id: "h1", name: "SessionStart:startup", done: true },
    ]);
    // Then silence: the stall fires once.
    await sleep(140);
    expect(events.filter((e) => e.type === "init_timeout")).toEqual([{ type: "init_timeout", afterMs: 80 }]);
    await s.dispose();
  });

  it("after initialize the signals are not start progress any more; local settings alone arm the watchdog too", async () => {
    const events: SessionEvent[] = [];
    const fake = sdk();
    const s = session(events, fake, 60);
    await s.start();
    fake.resolveInit();
    await sleep(10);
    feed(s, { type: "system", subtype: "hook_started", hook_id: "h9", hook_name: "SessionStart:compact", hook_event: "SessionStart" });
    await sleep(100);
    expect(events.filter((e) => e.type === "start_progress" || e.type === "init_timeout")).toEqual([]);
    await s.dispose();

    const local: SessionEvent[] = [];
    const l = session(local, sdk(), 40, true, false);
    await l.start();
    await sleep(90);
    expect(local.filter((e) => e.type === "init_timeout")).toEqual([{ type: "init_timeout", afterMs: 40 }]);
    await l.dispose();
  });
});
