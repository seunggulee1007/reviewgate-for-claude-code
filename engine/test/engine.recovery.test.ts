import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_FILE } from "../src/review/persist.js";
import { sessionsIndexPath, sessionTranscriptPath, type SessionsIndexFile } from "../src/review/sessions.js";
import { cliProjectDirName } from "../src/session/cliRecords.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §30 — session start and recovery (audit crash-1 / robustness-01, crash-4, crash-5, crash-2,
 * robustness-02, robustness-03): a conversation the CLI knows is always resumed (also one that only a peer message or
 * another unprompted turn created), `--session-id` collisions resume instead of crashing, a vanished conversation
 * falls back to a new chat with a notice, resume success is decided at initialize, deterministic start failures are
 * not retried with the same arguments, and the errors the user saw are kept in the chat transcript.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-recovery"));
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
const track = (d: string): string => {
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

const gitDir = (dir: string) => join(dir, ".git");
const readIndex = (dir: string) => JSON.parse(readFileSync(sessionsIndexPath(gitDir(dir)), "utf8")) as SessionsIndexFile;

/** The state the user's acme checkout was in (2026-10-21): the current chat never got a user message (turns 0). */
function seedChat(dir: string, id: string, meta: Partial<SessionsIndexFile["sessions"][number]> = {}): void {
  mkdirSync(join(gitDir(dir), "reviewgate", "sessions"), { recursive: true });
  writeFileSync(join(gitDir(dir), SESSION_FILE), JSON.stringify({ version: 1, sessionId: id, openTabIds: [id], permissionMode: "default", savedAt: "2026-10-20T12:25:46.000Z" }));
  const row = { id, title: "New chat", createdAt: "2026-09-15T05:15:55.096Z", updatedAt: "2026-09-15T05:15:55.096Z", turns: 0, costUSD: 0, lastUserText: null, ...meta };
  writeFileSync(sessionsIndexPath(gitDir(dir)), JSON.stringify({ version: 1, sessions: [row] }));
}

const ID = "86281b8f-1ea4-4073-a0fb-63afefff9b81";

describe("a conversation the CLI knows is always resumed (crash-1)", () => {
  it("a chat whose only turn was one Claude Code ran by itself (a peer message) is resumed after an app restart", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    const id = (await a.open(dir)).sessions.currentId!;
    expect(a.session().opts.settings.sessionId).toBe(id); // fresh, pre-named (--session-id)
    // Another terminal session's message ran a turn on its own: system/init, then its result — no user turn.
    a.session().emitSessionInfo({ sessionId: id });
    a.session().emit({ type: "unprompted_turn_end", sessionId: id });
    await a.settle();
    await a.engine.dispose(); // persists the index

    expect(readIndex(dir).sessions[0]).toMatchObject({ id, turns: 0, lastUserText: null, cliKnown: true });
    const b = harness();
    await b.hello();
    const s = await b.open(dir);
    expect(s.sessions.currentId).toBe(id);
    expect(b.sessions[0]!.opts.settings.resumeSessionId).toBe(id);
    expect(b.sessions[0]!.opts.settings.sessionId).toBeUndefined();
    expect(b.ofType("error")).toEqual([]);
  });

  it("the CLI's own record file makes a chat resumable even when the index never said so (written by an older engine)", async () => {
    const dir = track(makeRepo());
    const config = track(realpathSync(makeTempDir("rg-recovery-config")));
    seedChat(dir, ID);
    mkdirSync(join(config, "projects", cliProjectDirName(dir, {})), { recursive: true });
    writeFileSync(join(config, "projects", cliProjectDirName(dir, {}), `${ID}.jsonl`), "");
    const h = harness({ env: { CLAUDE_CONFIG_DIR: config } });
    await h.hello();
    const s = await h.open(dir);
    expect(s.sessions.currentId).toBe(ID);
    expect(h.sessions[0]!.opts.settings.resumeSessionId).toBe(ID);
    expect(h.sessions[0]!.opts.settings.sessionId).toBeUndefined();

    // Without the record (and without turns / cliKnown) the chat still starts fresh with its pre-chosen id.
    const other = track(makeRepo());
    seedChat(other, ID);
    const g = harness({ env: { CLAUDE_CONFIG_DIR: config } });
    await g.hello();
    await g.open(other);
    expect(g.sessions[0]!.opts.settings.sessionId).toBe(ID);
    expect(g.sessions[0]!.opts.settings.resumeSessionId).toBeUndefined();
  });
});

const IN_USE = `Error: Session ID ${ID} is already in use.`;

describe("a refused start is recovered, not shown (crash-1 safety net, crash-5)", () => {
  it("'Session ID … is already in use' resumes that conversation at once — no error, no backoff, a message sent meanwhile goes out again", async () => {
    const dir = track(makeRepo());
    seedChat(dir, ID); // nothing on our side says the CLI knows it (another config dir, an older engine)
    const h = harness({ autoRestartDelayMs: 60_000 }, { ready: (i) => i > 0 });
    await h.hello();
    await h.open(dir);
    expect(h.sessions[0]!.opts.settings.sessionId).toBe(ID);
    await h.engine.handle({ type: "send", text: "hello again" }); // the CLI never took it
    h.session().emit({ type: "error", message: "Claude Code process exited with code 1", fatal: true, code: "session_id_in_use", detail: IN_USE, exitCode: 1, signal: null });
    h.session().emit({ type: "closed", code: 1 });
    const s = await h.waitFor((x) => x.session.open && h.sessions.length === 2, "resumed", 3000);
    expect(h.sessions[1]!.opts.settings.resumeSessionId).toBe(ID);
    expect(h.sessions[1]!.opts.settings.sessionId).toBeUndefined();
    expect(h.sessions[1]!.sends.map((m) => m.text)).toEqual(["hello again"]);
    expect(s.gate.phase).toBe("running");
    expect(s.sessions.currentId).toBe(ID);
    expect(s.sessions.list[0]).toMatchObject({ id: ID, cliKnown: true });
    expect(s.sessions.list[0]!.resumeFailed).toBeUndefined();
    expect(h.ofType("error")).toEqual([]);
    expect(s.lastError).toBeNull();
  });

  it("the CLI's words alone (no code from an older session object) are recognized; a second refusal is shown, not looped", async () => {
    const dir = track(makeRepo());
    seedChat(dir, ID);
    const h = harness({ autoRestartDelayMs: 20 }, { ready: () => false });
    await h.hello();
    await h.open(dir);
    h.session().emit({ type: "error", message: IN_USE, fatal: true });
    h.session().emit({ type: "closed", code: 1 });
    await h.waitFor((x) => x.session.open && h.sessions.length === 2, "resumed");
    expect(h.sessions[1]!.opts.settings.resumeSessionId).toBe(ID);
    expect(h.ofType("error")).toEqual([]);
    // Should the resumed CLI refuse the same way again, it is a real failure: shown once, not retried in a loop.
    h.session().emit({ type: "error", message: IN_USE, fatal: true });
    h.session().emit({ type: "closed", code: 1 });
    await h.waitFor((x) => !x.session.open, "gone");
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sessions).toHaveLength(2);
    expect(h.ofType("error")).toMatchObject([{ fatal: true, scope: "session", message: IN_USE }]);
  });

  it("a conversation Claude Code no longer has (30-day cleanup) falls back to a new chat with a resume_not_found notice instead of a crash", async () => {
    const dir = track(makeRepo());
    seedChat(dir, ID, { turns: 7, title: "acme-1200 작업", lastUserText: "이어서 해줘" });
    const h = harness({ autoRestartDelayMs: 60_000 }, { ready: (i) => i > 0 });
    await h.hello();
    await h.open(dir);
    expect(h.sessions[0]!.opts.settings.resumeSessionId).toBe(ID);
    const notFound = `No conversation found with session ID: ${ID}`;
    h.session().emit({ type: "error", message: `Claude Code returned an error result: ${notFound}`, fatal: true, code: "resume_not_found", detail: notFound, exitCode: 1, signal: null });
    h.session().emit({ type: "closed", code: 1 });
    const s = await h.waitFor((x) => x.session.open && h.sessions.length === 2, "new chat", 3000);
    const fresh = s.sessions.currentId!;
    expect(fresh).not.toBe(ID);
    expect(h.sessions[1]!.opts.settings.sessionId).toBe(fresh);
    expect(h.sessions[1]!.opts.settings.resumeSessionId).toBeUndefined();
    expect(s.sessions.list.find((m) => m.id === ID)).toMatchObject({ resumeFailed: true, turns: 7, title: "acme-1200 작업" });
    const errors = h.ofType("error");
    expect(errors).toEqual([{ type: "error", message: expect.stringContaining("no record of this conversation"), fatal: false, scope: "session", code: "resume_not_found", sessionId: ID, detail: notFound }]);
    // The notice belongs to the new chat: it follows that chat's transcript_restore.
    const at = (ev: unknown) => h.events.indexOf(ev as never);
    expect(at(errors[0])).toBeGreaterThan(at(h.ofType("transcript_restore").at(-1)));
    expect(s.lastError).toBeNull();
  });
});

describe("state.session.ready (§30)", () => {
  it("is true once the CLI answered initialize, false while it starts and after it died", async () => {
    const dir = track(makeRepo());
    const h = harness({ autoRestartDelayMs: 20 }, { ready: () => false });
    await h.hello({ autoRestartSession: false });
    let s = await h.open(dir);
    expect(s.session.open).toBe(true);
    expect(s.session.ready).toBe(false); // spawned, not initialized yet
    h.session().emit({ type: "session_ready" });
    s = await h.waitFor((x) => x.session.ready === true, "ready");
    h.session().emit({ type: "closed", code: 1 });
    s = await h.waitFor((x) => !x.session.open, "gone");
    expect(s.session.ready).toBe(false);
  });
});

describe("resume success is decided at initialize (crash-4); start failures are not retried blindly (crash-2)", () => {
  it("a resumed chat whose CLI dies after initialize but before the first message is resumed again, not abandoned", async () => {
    const dir = track(makeRepo());
    seedChat(dir, ID, { turns: 1, title: "hi", lastUserText: "hi" });
    const h = harness({ autoRestartDelayMs: 20 });
    await h.hello();
    await h.open(dir);
    expect(h.sessions[0]!.opts.settings.resumeSessionId).toBe(ID);
    h.session().emit({ type: "closed", code: 1 }); // e.g. `pkill claude`; no session_info yet (that needs a message)
    const s = await h.waitFor((x) => x.session.open && h.sessions.length === 2, "auto restart");
    expect(h.sessions[1]!.opts.settings.resumeSessionId).toBe(ID);
    expect(s.sessions.currentId).toBe(ID);
    expect(s.sessions.list.find((m) => m.id === ID)!.resumeFailed).toBeUndefined();
    expect(s.sessions.list).toHaveLength(1);
  });

  it("a start that dies before initialize is not restarted with the same arguments; restart_session retries; code + detail stay the same", async () => {
    const dir = track(makeRepo());
    const h = harness({ autoRestartDelayMs: 20 }, { ready: () => false });
    await h.hello();
    const id = (await h.open(dir)).sessions.currentId!;
    const death = { type: "error" as const, message: "Claude Code process exited with code 1", fatal: true, code: "session_start_failed", detail: "Error: unknown option '--frobnicate'", exitCode: 1, signal: null };
    h.session().emit(death);
    h.session().emit({ type: "closed", code: 1 });
    await h.waitFor((x) => !x.session.open, "gone");
    await new Promise((r) => setTimeout(r, 120));
    expect(h.sessions).toHaveLength(1);
    expect(h.engine.state.session.canRestart).toBe(true);
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((x) => x.session.open && h.sessions.length === 2, "manual restart");
    expect(h.sessions[1]!.opts.settings.sessionId).toBe(id);
    h.session().emit(death);
    h.session().emit({ type: "closed", code: 1 });
    await h.waitFor((x) => !x.session.open, "gone again");
    await new Promise((r) => setTimeout(r, 120));
    expect(h.sessions).toHaveLength(2);
    const errors = h.ofType("error");
    expect(errors).toHaveLength(2);
    for (const e of errors) expect(e).toEqual({ ...death, scope: "session" });
  });
});

const rowsOf = (dir: string, id: string) =>
  readFileSync(sessionTranscriptPath(gitDir(dir), id), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("errors the user saw stay in the chat transcript (robustness-03)", () => {
  it("error events become kind:'error' rows (code / detail, and §35.3 the exit code / signal) and come back with transcript_restore; hints are not rows", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello({ autoRestartSession: false });
    const id = (await a.open(dir)).sessions.currentId!;
    a.session().emit({ type: "error", message: "retrying", fatal: false, code: "api_retrying", attempt: 1, maxRetries: 10, retryDelayMs: 500, status: 529 });
    a.session().emit({ type: "error", message: "Claude Code process exited with code 1", fatal: true, code: "session_crashed", detail: "panic: x", exitCode: 1, signal: null });
    a.session().emit({ type: "closed", code: 1 });
    await a.waitFor((x) => !x.session.open, "gone");
    await a.settle();
    const row = { kind: "error", message: "Claude Code process exited with code 1", fatal: true, scope: "session", code: "session_crashed", detail: "panic: x", exitCode: 1, signal: null };
    expect(rowsOf(dir, id)).toEqual([{ at: expect.any(String), turn: 0, ...row }]);
    await a.engine.dispose();

    const b = harness();
    await b.hello();
    await b.open(dir);
    expect(b.ofType("transcript_restore")[0]!.items).toEqual([{ at: expect.any(String), turn: 0, ...row }]);
  });

  it("the resume_not_found notice is a row of the new chat; the chat that could not be continued keeps its own rows", async () => {
    const dir = track(makeRepo());
    seedChat(dir, ID, { turns: 2, title: "old", lastUserText: "old" });
    const h = harness({}, { ready: (i) => i > 0 });
    await h.hello();
    await h.open(dir);
    h.session().emit({ type: "error", message: `No conversation found with session ID: ${ID}`, fatal: true });
    h.session().emit({ type: "closed", code: 1 });
    const s = await h.waitFor((x) => x.session.open && h.sessions.length === 2, "new chat");
    await h.settle();
    expect(rowsOf(dir, s.sessions.currentId!)).toEqual([{ at: expect.any(String), turn: 0, kind: "error", message: expect.stringContaining("no record"), fatal: false, scope: "session", code: "resume_not_found", sessionId: ID }]);
  });
});
