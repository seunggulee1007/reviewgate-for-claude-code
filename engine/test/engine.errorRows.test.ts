import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_FILE } from "../src/review/persist.js";
import { sessionsIndexPath, sessionTranscriptPath } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.3 (wave-2 follow-up of §30's error rows): a `kind: "error"` transcript row keeps the details its
 * banner needs — `toolName` / `path` / `branch` (§33.4 worktree notices: "워크벤치로 열기" with the branch / folder),
 * `exitCode` / `signal` (the CLI's death), `sessionId` (the chat a resume notice is about), `resetAt` / `status` (API
 * errors) — so the banner restored after a restart says what the live one said. Before, only `code` / `detail`.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-errrows"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const rowsOf = (dir: string, id: string) =>
  readFileSync(sessionTranscriptPath(join(dir, ".git"), id), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("error rows keep what their banner needs (§35.3)", () => {
  it("worktree notices keep toolName / path / branch, a crash its exitCode / signal, a usage limit its resetAt — and come back with transcript_restore", async () => {
    const dir = realpathSync(makeRepo());
    dirs.push(dir);
    const a = harness();
    await a.hello({ autoRestartSession: false });
    const id = (await a.open(dir)).sessions.currentId!;
    await a.engine.request({ type: "send", text: "work in a worktree" });
    a.session().emit({ type: "scope_notice", code: "worktree_blocked", toolName: "EnterWorktree", toolUseId: "t1", branch: "feature-x", path: join(dir, ".claude/worktrees/feature-x") });
    a.session().emit({ type: "error", message: "Usage limit reached", fatal: false, code: "usage_limit", resetAt: "2026-10-23T05:00:00.000Z" });
    a.session().emit({ type: "error", message: "Claude Code process exited with code 137", fatal: true, code: "session_crashed", detail: "Killed", exitCode: null, signal: "SIGKILL" });
    a.session().emit({ type: "closed", code: 1 });
    await a.waitFor((x) => !x.session.open && x.gate.phase !== "running" && x.gate.phase !== "collecting", "gone");
    await a.settle();
    const errors = rowsOf(dir, id).filter((r) => r.kind === "error");
    expect(errors).toEqual([
      expect.objectContaining({ code: "worktree_blocked", toolName: "EnterWorktree", branch: "feature-x", path: join(dir, ".claude/worktrees/feature-x"), fatal: false, scope: "session" }),
      expect.objectContaining({ code: "usage_limit", resetAt: "2026-10-23T05:00:00.000Z" }),
      expect.objectContaining({ code: "session_crashed", detail: "Killed", exitCode: null, signal: "SIGKILL", fatal: true }),
    ]);
    // Only what the event carried: no toolUseId, no empty keys.
    expect(Object.keys(errors[0]!).sort()).toEqual(["at", "branch", "code", "fatal", "kind", "message", "path", "scope", "toolName", "turn"]);
    await a.engine.dispose();

    const b = harness();
    await b.hello();
    await b.open(dir);
    const restored = b.ofType("transcript_restore")[0]!.items.filter((r) => r.kind === "error");
    expect(restored).toEqual(errors);
  });

  it("a resume notice row names the chat that could not be continued (sessionId) and keeps the CLI's words", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const old = "86281b8f-1ea4-4073-a0fb-63afefff9b81";
    mkdirSync(join(dir, ".git", "reviewgate", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".git", SESSION_FILE), JSON.stringify({ version: 1, sessionId: old, openTabIds: [old], permissionMode: "default", savedAt: "2026-10-20T12:25:46.000Z" }));
    writeFileSync(sessionsIndexPath(join(dir, ".git")), JSON.stringify({ version: 1, sessions: [{ id: old, title: "old", createdAt: "2026-09-15T05:15:55.096Z", updatedAt: "2026-09-15T05:15:55.096Z", turns: 2, costUSD: 0, lastUserText: "old" }] }));
    const h = harness({}, { ready: (i) => i > 0 });
    await h.hello();
    await h.open(dir);
    h.session().emit({ type: "error", message: `No conversation found with session ID: ${old}`, fatal: true, detail: `No conversation found with session ID: ${old}` });
    h.session().emit({ type: "closed", code: 1 });
    const s = await h.waitFor((x) => x.session.open && h.sessions.length === 2, "new chat");
    await h.settle();
    expect(rowsOf(dir, s.sessions.currentId!)).toEqual([
      { at: expect.any(String), turn: 0, kind: "error", message: expect.stringContaining("no record"), fatal: false, scope: "session", code: "resume_not_found", sessionId: old, detail: `No conversation found with session ID: ${old}` },
    ]);
  });
});
