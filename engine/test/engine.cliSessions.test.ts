import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ListSessionsFn } from "../src/review/cliSessions.js";
import { sessionsIndexPath, type SessionsIndexFile } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §36.9 (audit market-03) at the engine: `cli_sessions` (running from the registry, resumable from the
 * SDK listing) and `cli_session_import` (a new chat of this window that resumes the terminal conversation).
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
  const dir = tmp("rg-cli-sessions");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@e.com");
  sh(dir, "config", "user.name", "T");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** A terminal session in the worktree: our parent (the test runner) is alive and never the engine's child (as §31's test). */
const TERMINAL_PID = process.ppid;

function setup(dir: string, listed: Awaited<ReturnType<ListSessionsFn>>): { h: Harness; calls: unknown[]; config: string } {
  const config = tmp("rg-cli-sessions-config");
  mkdirSync(join(config, "sessions"), { recursive: true });
  writeFileSync(join(config, "sessions", `${TERMINAL_PID}.json`), JSON.stringify({ pid: TERMINAL_PID, sessionId: "term-live", cwd: dir, name: "acme-b4", status: "waiting", entrypoint: "cli" }));
  const calls: unknown[] = [];
  const h = harness({
    env: { CLAUDE_CONFIG_DIR: config },
    listCliSessions: async (o) => {
      calls.push(o);
      return listed;
    },
  });
  return { h, calls, config };
}

describe("cli_sessions (§36.9)", () => {
  it("running from the registry, resumable from the listing without the running ones and the app's own chats; no_project without a project", async () => {
    const dir = makeRepo();
    const { h, calls } = setup(dir, [
      { sessionId: "term-live", summary: "running in a terminal", lastModified: 3000, cwd: dir },
      { sessionId: "old-1", customTitle: "장바구니 합계 수정", summary: "s", lastModified: 2000, cwd: dir },
      { sessionId: "old-2", summary: "Fix the build", lastModified: 1000 },
    ]);
    await h.hello();
    await expect(h.engine.request({ type: "cli_sessions" })).rejects.toThrow(/no_project/);
    const s = await h.open(dir);
    const own = s.sessions.currentId!;
    const reply = await h.engine.request({ type: "cli_sessions" });
    expect(reply.running).toEqual([{ pid: TERMINAL_PID, sessionId: "term-live", name: "acme-b4", cwd: dir, status: "waiting", entrypoint: "cli", sameWorktree: true }]);
    expect(reply.resumable).toEqual([
      { sessionId: "old-1", title: "장바구니 합계 수정", updatedAt: new Date(2000).toISOString(), cwd: dir },
      { sessionId: "old-2", title: "Fix the build", updatedAt: new Date(1000).toISOString(), cwd: null },
    ]);
    expect(calls).toEqual([{ dir, includeWorktrees: true, includeProgrammatic: false, limit: 200 }]);
    expect(reply.resumable.some((r) => r.sessionId === own)).toBe(false);
  });
});

describe("cli_session_import (§36.9)", () => {
  it("a new chat of this window that resumes the conversation: current, imported, empty transcript, resumed by the CLI", async () => {
    const dir = makeRepo();
    const { h } = setup(dir, [{ sessionId: "old-1", customTitle: "장바구니 합계 수정", summary: "s", lastModified: 2000, cwd: `${dir}-1600` }]);
    await h.hello();
    await h.open(dir);
    const before = h.sessions.length;
    const restoresBefore = h.ofType("transcript_restore").length;
    await h.engine.request({ type: "cli_session_import", sessionId: "old-1" });
    const s = await h.waitFor((x) => x.sessions.currentId === "old-1" && x.session.open && !x.session.starting, "imported chat current");
    expect(h.sessions.length).toBe(before + 1);
    expect(h.session().opts.settings.resumeSessionId).toBe("old-1");
    const meta = s.sessions.list.find((m) => m.id === "old-1")!;
    expect(meta).toMatchObject({ title: "장바구니 합계 수정", cliKnown: true, turns: 0, imported: { cwd: `${dir}-1600` } });
    expect(Number.isNaN(Date.parse(meta.imported!.at))).toBe(false);
    expect(s.sessions.openTabIds).toContain("old-1");
    expect(h.ofType("transcript_restore").slice(restoresBefore)).toEqual([{ type: "transcript_restore", items: [] }]);
    // Persisted with the chat list (a reopen keeps `imported`).
    await h.engine.handle({ type: "close_project" });
    await h.settle();
    const index = JSON.parse(readFileSync(sessionsIndexPath(join(dir, ".git")), "utf8")) as SessionsIndexFile;
    expect(index.sessions.find((m) => m.id === "old-1")?.imported).toEqual(meta.imported);
  });

  it("refusals: no_project, unknown_session (not resumable / already a chat here), cli_session_running, and session_open's", async () => {
    const dir = makeRepo();
    const { h } = setup(dir, [
      { sessionId: "term-live", summary: "running", lastModified: 3000, cwd: dir },
      { sessionId: "old-1", summary: "s", lastModified: 2000, cwd: dir },
    ]);
    await h.hello();
    await expect(h.engine.request({ type: "cli_session_import", sessionId: "old-1" })).rejects.toThrow(/no_project/);
    const s = await h.open(dir);
    await expect(h.engine.request({ type: "cli_session_import", sessionId: "nope" })).rejects.toThrow(/unknown_session/);
    await expect(h.engine.request({ type: "cli_session_import", sessionId: "../x" })).rejects.toThrow(/unknown_session/);
    await expect(h.engine.request({ type: "cli_session_import", sessionId: s.sessions.currentId! })).rejects.toThrow(/unknown_session/);
    await expect(h.engine.request({ type: "cli_session_import", sessionId: "term-live" })).rejects.toThrow(/cli_session_running/);
    await h.engine.handle({ type: "send", text: "busy" });
    await expect(h.engine.request({ type: "cli_session_import", sessionId: "old-1" })).rejects.toThrow(/session_busy/);
    expect(h.engine.state.sessions.list.some((m) => m.id === "old-1")).toBe(false);
  });
});
