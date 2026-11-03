import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { START_HISTORY_FILE } from "../src/session/startWatch.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §36.7 (audit robustness-05) at the engine: the stall limit (setting = floor, adaptive from the
 * repository's start history), `session.extensionsWaitingOn`, the start history itself, `retry_extensions` and the one
 * automatic retry after a fallback.
 */
const dirs: string[] = [];
const harnesses: Harness[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = tmp("rg-ext-start");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@e.com");
  sh(dir, "config", "user.name", "T");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const historyFile = (dir: string) => join(dir, ".git", START_HISTORY_FILE);

describe("the init watchdog's limit (§36.7)", () => {
  it("max(setting, adaptive): 45 s without history, 2 × the longest recent start with it; 0 still turns it off", async () => {
    const dir = makeRepo();
    const h = harness();
    await h.hello({ loadUserSettings: true, extensionsInitTimeoutMs: 20_000 });
    await h.open(dir);
    expect(h.session().opts.settings.initTimeoutMs).toBe(45_000);
    await h.engine.handle({ type: "close_project" });

    write(dir, ".git/reviewgate/extensions-start.json", JSON.stringify({ version: 1, durations: [30_000, 40_000, 12_000], savedAt: "x" }));
    await h.open(dir);
    expect(h.session().opts.settings.initTimeoutMs).toBe(80_000);
    await h.engine.handle({ type: "set_settings", settings: { extensionsInitTimeoutMs: 0 } });
    await h.engine.request({ type: "restart_session" });
    expect(h.session().opts.settings.initTimeoutMs).toBe(0);
  });

  it("a successful start with user settings is recorded (repository-wide); one without user settings is not", async () => {
    const dir = makeRepo();
    const plain = harness();
    await plain.hello();
    await plain.open(dir);
    await plain.engine.handle({ type: "close_project" });
    await plain.settle();
    expect(existsSync(historyFile(dir))).toBe(false);

    const h = harness();
    await h.hello({ loadUserSettings: true });
    await h.open(dir);
    await h.waitFor(() => existsSync(historyFile(dir)), "history written");
    const saved = JSON.parse(readFileSync(historyFile(dir), "utf8")) as { version: number; durations: number[] };
    expect(saved.version).toBe(1);
    expect(saved.durations).toHaveLength(1);
    expect(saved.durations[0]).toBeGreaterThanOrEqual(0);
  });
});

describe("extensionsWaitingOn (§36.7)", () => {
  it("names what the starting CLI works on; null once it initialized", async () => {
    const dir = makeRepo();
    const h = harness({}, { ready: () => false });
    await h.hello({ loadUserSettings: true });
    let s = await h.open(dir);
    expect(s.session.extensionsWaitingOn ?? null).toBeNull();
    h.session().emit({ type: "start_progress", kind: "hook", id: "h1", name: "SessionStart:startup" });
    s = await h.waitFor((x) => x.session.extensionsWaitingOn != null, "waiting on");
    expect(s.session.extensionsWaitingOn).toEqual({ kind: "hook", name: "SessionStart:startup" });
    h.session().emit({ type: "start_progress", kind: "hook", id: "h1", name: "SessionStart:startup", done: true });
    s = await h.waitFor((x) => x.session.extensionsWaitingOn?.kind === "unknown", "hook done");
    expect(s.session.extensionsWaitingOn).toEqual({ kind: "unknown", name: null });
    h.session().emit({ type: "session_ready" });
    s = await h.waitFor((x) => x.session.extensionsWaitingOn === null, "initialized");
    expect(s.session.ready).toBe(true);
  });
});

describe("retry_extensions and the automatic retry (§36.7)", () => {
  it("refusals: no_session without a project, extensions_on without a fallback, session_busy while a turn runs", async () => {
    const dir = makeRepo();
    const h = harness({ extensionsAutoRetryMs: 0 });
    await h.hello({ loadUserSettings: true });
    await expect(h.engine.request({ type: "retry_extensions" })).rejects.toThrow(/no_session/);
    await h.open(dir);
    await expect(h.engine.request({ type: "retry_extensions" })).rejects.toThrow(/extensions_on/);
    h.session().emit({ type: "init_timeout", afterMs: 45_000 });
    await h.waitFor((x) => h.sessions.length === 2 && x.session.open && !x.session.starting, "fallback");
    await h.engine.handle({ type: "send", text: "busy" });
    await expect(h.engine.request({ type: "retry_extensions" })).rejects.toThrow(/session_busy/);
    h.session().emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "idle", "turn end");
    // Retried: user settings again, the fallback is gone.
    await h.engine.request({ type: "retry_extensions" });
    const s = await h.waitFor((x) => h.sessions.length === 3 && x.session.open && !x.session.starting, "retried");
    expect(h.session().opts.settings.loadUserSettings).toBe(true);
    expect(s.session.extensions?.fallback).toBeNull();
    expect(s.session.extensions?.settingSources).toContain("user");
  });

  it("after a fallback the engine retries once by itself when idle; a timeout during the retry falls back for good", async () => {
    const dir = makeRepo();
    // The first start and the automatic retry hang (never answer initialize); the fallback sessions start fine.
    const h = harness({ extensionsAutoRetryMs: 20 }, { ready: (i) => i !== 0 && i !== 2 });
    await h.hello({ loadUserSettings: true });
    await h.open(dir);
    h.session().emit({ type: "init_timeout", afterMs: 45_000 });
    // fallback session (2), then the automatic retry with user settings (3)
    await h.waitFor(() => h.sessions.length === 3, "automatic retry");
    expect(h.sessions[1]!.opts.settings.loadUserSettings).toBe(false);
    expect(h.sessions[2]!.opts.settings.loadUserSettings).toBe(true);
    await h.waitFor((x) => x.session.open && !x.session.starting, "retry started");
    // The retry hangs too: back to the fallback, and no second automatic retry.
    h.session().emit({ type: "init_timeout", afterMs: 45_000 });
    await h.waitFor((x) => h.sessions.length === 4 && x.session.open && !x.session.starting, "second fallback");
    expect(h.session().opts.settings.loadUserSettings).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.sessions).toHaveLength(4);
    expect(h.engine.state.session.extensions?.fallback).not.toBeNull();
    // The user can still retry by hand.
    await h.engine.request({ type: "retry_extensions" });
    expect(h.sessions).toHaveLength(5);
    expect(h.session().opts.settings.loadUserSettings).toBe(true);
  });

  it("the automatic retry waits while a turn runs", async () => {
    const dir = makeRepo();
    // The idle window must outlast the test seeing the fallback and sending: at 20 ms the retry started first on a slow
    // CI runner, and the fallback was never seen idle.
    const h = harness({ extensionsAutoRetryMs: 300 });
    await h.hello({ loadUserSettings: true });
    await h.open(dir);
    h.session().emit({ type: "init_timeout", afterMs: 45_000 });
    await h.waitFor((x) => h.sessions.length === 2 && x.session.open && !x.session.starting, "fallback");
    await h.engine.handle({ type: "send", text: "work" });
    await new Promise((r) => setTimeout(r, 450)); // past the window: the retry waits for the turn
    expect(h.sessions).toHaveLength(2);
    h.session().emitTurnEnd();
    await h.waitFor(() => h.sessions.length === 3, "retry after the turn");
    expect(h.session().opts.settings.loadUserSettings).toBe(true);
  });
});
