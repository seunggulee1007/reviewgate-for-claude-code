import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewGate } from "../src/review/gate.js";
import { SESSION_FILE } from "../src/review/persist.js";
import { NEW_CHAT_TITLE, sessionTitle, sessionTranscriptPath, sessionsIndexPath, type SessionsIndexFile } from "../src/review/sessions.js";
import { TRANSCRIPT_FILE } from "../src/review/transcript.js";
import { makeHarness, type FakeClaudeSession, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * Chat sessions (docs/M15-POLISH.md): `<gitdir>/reviewgate/sessions/` (index.json + one NDJSON per
 * session), `session_new` / `session_open` / `session_rename` / `session_archive` / `session_delete`
 * / `tabs_set`, the guards, the title rule, the meta accumulation and the legacy-transcript migration.
 * The fake session reports the id the engine pre-chose (`settings.sessionId`) or resumed, like the CLI.
 */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-sessions"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
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
function harness(opts: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(opts);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const gitDir = (dir: string) => join(dir, ".git");
const indexFile = (dir: string) => sessionsIndexPath(gitDir(dir));
const sessionFile = (dir: string) => join(gitDir(dir), SESSION_FILE);
const readIndex = (dir: string) => JSON.parse(readFileSync(indexFile(dir), "utf8")) as SessionsIndexFile;
/** The id the CLI would report for this fake: the resumed one, else the pre-chosen one. */
const idOf = (s: FakeClaudeSession): string => s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId!;

/** Sends `text` and ends the turn (reporting the session's own id); waits until the gate settled. */
async function turn(h: Harness, text: string, opts: { costUsd?: number; mutate?: () => void } = {}): Promise<void> {
  await h.engine.handle({ type: "send", text });
  opts.mutate?.();
  h.session().emitTurnEnd({ sessionId: idOf(h.session()), usage: { costUsd: opts.costUsd ?? 0.01 } });
  await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting" && s.hud.turnCount > 0, "turn end");
  await h.settle();
}

async function waitForFile(path: string, pred: (text: string) => boolean, what: string): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const text = readFileSync(path, "utf8");
      if (pred(text)) return text;
    } catch {
      // not yet written
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} in ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("chat sessions (docs/M15-POLISH.md)", () => {
  it("open_project creates a New chat (fresh session with a pre-chosen id); session_new stops it and starts another; both persisted", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const opened = await h.open(dir);
    const first = opened.sessions.currentId!;
    expect(first).toBeTruthy();
    expect(opened.sessions.list.map((m) => [m.id, m.title, m.turns, m.costUSD, m.lastUserText])).toEqual([[first, NEW_CHAT_TITLE, 0, 0, null]]);
    expect(opened.sessions.openTabIds).toEqual([first]);
    expect(h.sessions[0]!.opts.settings.sessionId).toBe(first);
    expect(h.sessions[0]!.opts.settings.resumeSessionId).toBeUndefined();
    expect(h.ofType("transcript_restore")).toEqual([{ type: "transcript_restore", items: [] }]);

    await h.engine.request({ type: "session_new" });
    const s = await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== first, "second session");
    const second = s.sessions.currentId!;
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0]!.disposed).toBe(true);
    expect(h.sessions[1]!.opts.settings.sessionId).toBe(second);
    expect(h.sessions[1]!.opts.settings.resumeSessionId).toBeUndefined();
    expect(s.sessions.list.map((m) => m.id)).toEqual([second, first]); // newest first
    expect(s.sessions.openTabIds).toEqual([first, second]);
    expect(h.ofType("transcript_restore")).toHaveLength(2);
    expect(h.ofType("transcript_restore")[1]!.items).toEqual([]);
    expect(s.hud.turnCount).toBe(0);
    await waitForFile(sessionFile(dir), (t) => JSON.parse(t).sessionId === second, "session file");
    expect(JSON.parse(readFileSync(sessionFile(dir), "utf8"))).toMatchObject({ version: 1, sessionId: second, openTabIds: [first, second] });
    await waitForFile(indexFile(dir), (t) => t.includes(second), "index"); // written right after the session file
    expect(readIndex(dir).sessions.map((m) => m.id)).toEqual([second, first]);
  });

  it("the first user message titles the chat (first line ≤ 60 chars); every turn end accumulates turns / cost / updatedAt", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const id = (await h.open(dir)).sessions.currentId!;
    const long = "x".repeat(80);
    await turn(h, `  \n${long}\nsecond line`, { costUsd: 0.25 });
    let meta = h.engine.state.sessions.list[0]!;
    expect(meta.id).toBe(id);
    expect(meta.title).toBe("x".repeat(59) + "…");
    expect(meta.title.length).toBeLessThanOrEqual(60);
    expect(meta.turns).toBe(1);
    expect(meta.costUSD).toBeCloseTo(0.25, 10);
    expect(meta.lastUserText).toBe(`${long}\nsecond line`);
    const firstUpdate = meta.updatedAt;
    expect(firstUpdate >= meta.createdAt).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await turn(h, "follow-up", { costUsd: 0.1 });
    meta = h.engine.state.sessions.list[0]!;
    expect(meta.title).toBe("x".repeat(59) + "…"); // renamed only while still "New chat"
    expect(meta.turns).toBe(2);
    expect(meta.costUSD).toBeCloseTo(0.35, 10);
    expect(meta.lastUserText).toBe("follow-up");
    expect(meta.updatedAt > firstUpdate).toBe(true);
    // The per-session transcript carries both turns; the index mirrors the meta.
    const rows = readFileSync(sessionTranscriptPath(gitDir(dir), id), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; turn: number });
    expect(rows.map((r) => [r.kind, r.turn])).toEqual([["user_message", 1], ["turn_end", 1], ["user_message", 2], ["turn_end", 2]]);
    await waitForFile(indexFile(dir), (t) => (JSON.parse(t) as SessionsIndexFile).sessions[0]?.turns === 2, "index");
    expect(readIndex(dir).sessions[0]).toMatchObject({ id, turns: 2, lastUserText: "follow-up" });
    expect(sessionTitle("short title")).toBe("short title");
    expect(sessionTitle("\n\n  Hello world  \nmore")).toBe("Hello world");
    expect(sessionTitle("   ")).toBe(NEW_CHAT_TITLE);
  });

  it("session_open resumes another session with its transcript; opening the current one only replays the rows", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const first = (await h.open(dir)).sessions.currentId!;
    await turn(h, "remember pineapple");
    await h.engine.request({ type: "session_new" });
    await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== first, "second session");
    const second = h.engine.state.sessions.currentId!;
    await turn(h, "pong");
    expect(h.engine.state.sessions.list.map((m) => [m.id, m.title])).toEqual([[second, "pong"], [first, "remember pineapple"]]);

    await h.engine.request({ type: "session_open", sessionId: first });
    const s = await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId === first, "first session again");
    expect(h.sessions).toHaveLength(3);
    expect(h.sessions[2]!.opts.settings.resumeSessionId).toBe(first);
    expect(h.sessions[2]!.opts.settings.sessionId).toBeUndefined();
    const restores = h.ofType("transcript_restore");
    expect(restores).toHaveLength(3);
    expect(restores[2]!.items.map((i) => i.kind)).toEqual(["user_message", "turn_end"]);
    expect(restores[2]!.items[0]).toMatchObject({ kind: "user_message", text: "remember pineapple", turn: 1 });
    expect(s.hud.turnCount).toBe(0);
    expect(s.sessions.openTabIds).toEqual([first, second]);
    // A turn in the resumed session continues its numbering and meta.
    await turn(h, "what word?");
    expect(h.engine.state.sessions.list[0]).toMatchObject({ id: first, turns: 2, lastUserText: "what word?" });
    const rows = readFileSync(sessionTranscriptPath(gitDir(dir), first), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { turn: number });
    expect(rows.map((r) => r.turn)).toEqual([1, 1, 2, 2]);
    // Opening the current session is a replay, not a restart.
    await h.engine.request({ type: "session_open", sessionId: first });
    expect(h.sessions).toHaveLength(3);
    expect(h.ofType("transcript_restore")).toHaveLength(4);
    expect(h.ofType("transcript_restore")[3]!.items).toHaveLength(4);
    await expect(h.engine.request({ type: "session_open", sessionId: "nope" })).rejects.toThrow("unknown_session:nope");
  });

  it("session_rename / session_archive update the meta (empty title refused); session_delete removes meta, file and tab, but never the current one", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const first = (await h.open(dir)).sessions.currentId!;
    await turn(h, "one");
    await h.engine.request({ type: "session_new" });
    await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== first, "second session");
    const second = h.engine.state.sessions.currentId!;

    await h.engine.request({ type: "session_rename", sessionId: first, title: "  My chat  " });
    await expect(h.engine.request({ type: "session_rename", sessionId: first, title: "   " })).rejects.toThrow("empty_title");
    await expect(h.engine.request({ type: "session_rename", sessionId: "nope", title: "x" })).rejects.toThrow("unknown_session:nope");
    await h.engine.request({ type: "session_archive", sessionId: first, archived: true });
    let meta = h.engine.state.sessions.list.find((m) => m.id === first)!;
    expect(meta).toMatchObject({ title: "My chat", archived: true, turns: 1 });
    await waitForFile(indexFile(dir), (t) => t.includes('"My chat"') && t.includes('"archived":true'), "rename + archive persisted");
    await h.engine.request({ type: "session_archive", sessionId: first, archived: false });
    meta = h.engine.state.sessions.list.find((m) => m.id === first)!;
    expect(meta.archived).toBeUndefined();
    // A later message never overrides a title the user set — only "New chat" is replaced.
    await h.engine.request({ type: "session_rename", sessionId: second, title: "Named" });
    await turn(h, "hello");
    expect(h.engine.state.sessions.list.find((m) => m.id === second)!.title).toBe("Named");

    await expect(h.engine.request({ type: "session_delete", sessionId: second })).rejects.toThrow("session_current");
    expect(existsSync(sessionTranscriptPath(gitDir(dir), first))).toBe(true);
    await h.engine.request({ type: "session_delete", sessionId: first });
    const s = h.engine.state;
    expect(s.sessions.list.map((m) => m.id)).toEqual([second]);
    expect(s.sessions.openTabIds).toEqual([second]);
    expect(existsSync(sessionTranscriptPath(gitDir(dir), first))).toBe(false);
    await waitForFile(indexFile(dir), (t) => !t.includes(first), "delete persisted");
    await expect(h.engine.request({ type: "session_delete", sessionId: first })).rejects.toThrow(`unknown_session:${first}`);
  });

  it("guards: session_new / session_open are refused while busy (session_busy) and after a failed collection (collect_failed) — never for notes or a change request (r2-chats-cards M31)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const first = (await h.open(dir)).sessions.currentId!;
    await h.engine.handle({ type: "send", text: "edit" });
    await expect(h.engine.request({ type: "session_new" })).rejects.toThrow("session_busy");
    await expect(h.engine.request({ type: "session_open", sessionId: first })).rejects.toThrow("session_busy");
    write(dir, "README.md", "changed\n");
    h.session().emitTurnEnd({ sessionId: first });
    await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");

    // Unsent notes and a file sent back with notes are the worktree's review: a new chat opens next to them and they stay.
    await h.engine.handle({ type: "add_note", path: "README.md", line: 1, side: "new", excerpt: "changed", body: "why?" });
    const gate = (h.engine as unknown as { gate: ReviewGate }).gate;
    const readme = gate.changedFiles.find((f) => f.path === "README.md")!;
    readme.state = "changesRequested"; // only a session that died mid-round leaves it settled; force it on the gate
    await h.engine.request({ type: "session_new" });
    const other = await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== first, "new chat with notes and a change request");
    expect(other.reviewNotes.map((n) => [n.path, n.body, n.sent !== undefined])).toEqual([["README.md", "why?", false]]);
    expect(other.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "changesRequested"]]);
    await h.engine.request({ type: "session_open", sessionId: first });
    await h.waitFor((x) => x.sessions.currentId === first && x.session.open && !x.session.starting, "back with the notes");
    expect(h.engine.state.reviewNotes).toHaveLength(1);
    readme.state = "pending";
    await h.engine.handle({ type: "remove_note", noteId: h.engine.state.reviewNotes[0]!.id });
    await h.settle();
    expect(h.engine.state.reviewNotes).toHaveLength(0);

    // A failed collection: the Retry belongs to this conversation.
    gate.collectError = "git add -A failed";
    await expect(h.engine.request({ type: "session_new" })).rejects.toThrow("collect_failed");
    await expect(h.engine.request({ type: "session_open", sessionId: first })).rejects.toThrow("collect_failed");
    gate.collectError = null;

    // Plainly pending files do not block a new chat (the review is worktree state, not session state).
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    await h.engine.request({ type: "session_new" });
    const s = await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== first && x.sessions.list.length === 3, "new chat while files are pending");
    expect(s.sessions.list).toHaveLength(3);
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]); // the review survived the switch
    expect(s.gate.phase).toBe("reviewing");
    await h.engine.request({ type: "session_open", sessionId: first }); // and back, still allowed
    await h.waitFor((x) => x.sessions.currentId === first && x.session.open && !x.session.starting, "back in the first chat");
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    await h.engine.handle({ type: "accept_all" });
    await h.settle();
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "accepted"]]); // accepted files never blocked either
    await h.engine.request({ type: "session_new" });
    await h.waitFor((x) => x.sessions.list.length === 4 && x.session.open && !x.session.starting, "fourth chat");

    // No project at all → no_project.
    const g = harness();
    await g.hello();
    await expect(g.engine.request({ type: "session_new" })).rejects.toThrow("no_project");
    await expect(g.engine.request({ type: "tabs_set", openTabIds: [] })).rejects.toThrow("no_project");
  });

  it("a pending review survives a new chat untouched and the first send there merges into it (answer rule, docs/PROTOCOL.md §10)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const first = (await h.open(dir)).sessions.currentId!;
    await h.engine.handle({ type: "send", text: "edit" });
    write(dir, "README.md", "changed\n");
    h.session().emitTurnEnd({ sessionId: first });
    const before = await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    const treeA = before.gate.turnStartTree;
    const treeB = before.gate.turnEndTree;
    expect(before.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);

    await h.engine.request({ type: "session_new" });
    const s = await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== first, "new chat");
    // Gate state, not session state: the list, the file states and both snapshots are exactly as they were.
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(s.gate.pendingCount).toBe(1);
    expect([s.gate.turnStartTree, s.gate.turnEndTree]).toEqual([treeA, treeB]);

    // The first send in the NEW chat is a question: A is kept and the turn merges into the same review.
    await h.engine.handle({ type: "send", text: "how many files did you change?" });
    await h.waitFor((x) => x.gate.phase === "running", "question running");
    expect(h.engine.state.gate.turnStartTree).toBe(treeA);
    write(dir, "extra.txt", "brand new\n");
    h.session().emitTurnEnd({ sessionId: idOf(h.session()) });
    const after = await h.waitFor((x) => x.gate.phase === "reviewing", "reviewing after the question");
    expect(after.gate.turnStartTree).toBe(treeA);
    expect(after.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"], ["extra.txt", "pending"]]);
  });

  it("migration: the legacy reviewgate-transcript.ndjson becomes the first session (id from reviewgate-session.json, meta from its rows) and is deleted", async () => {
    const dir = track(makeRepo());
    const rows = [
      { at: "2026-09-01T10:00:00.000Z", turn: 1, kind: "user_message", text: "Add a README badge\nplease" },
      { at: "2026-09-01T10:00:05.000Z", turn: 1, kind: "assistant_text", text: "Done." },
      { at: "2026-09-01T10:00:06.000Z", turn: 1, kind: "turn_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.2, durationMs: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 1 }, files: 1, added: 1, deleted: 0, changedOutside: [] },
      { at: "2026-09-02T11:00:00.000Z", turn: 2, kind: "user_message", text: "And a license" },
      { at: "2026-09-02T11:00:09.000Z", turn: 2, kind: "turn_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.3, durationMs: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 1 }, files: 1, added: 1, deleted: 0, changedOutside: [] },
    ];
    const legacy = join(gitDir(dir), TRANSCRIPT_FILE);
    writeFileSync(legacy, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(sessionFile(dir), JSON.stringify({ version: 1, sessionId: "legacy-1", savedAt: "2026-09-02T11:00:09.000Z" }) + "\n");
    const h = harness();
    await h.hello();
    const s = await h.open(dir);
    expect(s.sessions.currentId).toBe("legacy-1");
    expect(s.sessions.openTabIds).toEqual(["legacy-1"]);
    expect(s.sessions.list).toEqual([{
      id: "legacy-1",
      title: "Add a README badge",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-02T11:00:09.000Z",
      turns: 2,
      costUSD: 0.5,
      lastUserText: "And a license",
    }]);
    expect(h.sessions[0]!.opts.settings.resumeSessionId).toBe("legacy-1"); // still resumable
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(sessionTranscriptPath(gitDir(dir), "legacy-1"), "utf8").trim().split("\n")).toHaveLength(5);
    expect(h.ofType("transcript_restore")[0]!.items.map((i) => i.kind)).toEqual(rows.map((r) => r.kind));
    expect(readIndex(dir).sessions.map((m) => m.id)).toEqual(["legacy-1"]);
    // A second open does not migrate again (no legacy file, index kept) and continues the numbering.
    await turn(h, "next");
    expect(h.engine.state.sessions.list[0]).toMatchObject({ id: "legacy-1", turns: 3, title: "Add a README badge" });
    const tail = readFileSync(sessionTranscriptPath(gitDir(dir), "legacy-1"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { turn: number });
    expect(tail.map((r) => r.turn)).toEqual([1, 1, 1, 2, 2, 3, 3]);
  });

  it("tabs_set persists openTabIds (unknown ids dropped) and a new engine restores tabs + current session", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    const first = (await a.open(dir)).sessions.currentId!;
    await turn(a, "one");
    await a.engine.request({ type: "session_new" });
    await a.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== first, "second");
    const second = a.engine.state.sessions.currentId!;
    await turn(a, "two");
    await a.engine.request({ type: "tabs_set", openTabIds: [second, "ghost", second] });
    expect(a.engine.state.sessions.openTabIds).toEqual([second]);
    await waitForFile(sessionFile(dir), (t) => JSON.stringify(JSON.parse(t).openTabIds) === JSON.stringify([second]), "tabs persisted");
    await a.engine.request({ type: "tabs_set", openTabIds: [first, second] });
    await a.engine.dispose();

    const b = harness();
    await b.hello();
    const s = await b.open(dir);
    expect(s.sessions.currentId).toBe(second);
    expect(s.sessions.openTabIds).toEqual([first, second]);
    expect(s.sessions.list.map((m) => [m.id, m.title, m.turns])).toEqual([[second, "two", 1], [first, "one", 1]]);
    expect(b.sessions[0]!.opts.settings.resumeSessionId).toBe(second);
    expect(b.ofType("transcript_restore")[0]!.items.map((i) => i.kind)).toEqual(["user_message", "turn_end"]);
    // session_list is a state refresh.
    await b.engine.request({ type: "session_list" });
    expect(b.engine.state.sessions.list).toHaveLength(2);
  });

  it("a session_open whose resume fails falls back to a fresh chat and flags the meta resumeFailed (transcript kept)", async () => {
    const dir = track(makeRepo());
    const h = harness({ autoRestartDelayMs: 20 });
    await h.hello();
    const first = (await h.open(dir)).sessions.currentId!;
    await turn(h, "one");
    await h.engine.request({ type: "session_new" });
    await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId !== first, "second");
    await h.engine.request({ type: "session_open", sessionId: first });
    await h.waitFor((x) => x.session.open && !x.session.starting && x.sessions.currentId === first, "first resumed");
    expect(h.sessions[2]!.opts.settings.resumeSessionId).toBe(first);
    h.session().emit({ type: "error", message: `No conversation found with session ID: ${first}`, fatal: true });
    h.session().emit({ type: "closed", code: 1 });
    const s = await h.waitFor((x) => x.session.open && !x.session.starting && h.sessions.length === 4, "fallback session");
    expect(s.sessions.currentId).not.toBe(first);
    expect(h.sessions[3]!.opts.settings.resumeSessionId).toBeUndefined();
    expect(h.sessions[3]!.opts.settings.sessionId).toBe(s.sessions.currentId);
    expect(s.sessions.list.find((m) => m.id === first)).toMatchObject({ resumeFailed: true, turns: 1, title: "one" });
    expect(s.sessions.list.find((m) => m.id === s.sessions.currentId)).toMatchObject({ title: NEW_CHAT_TITLE, turns: 0 });
    expect(s.sessions.list).toHaveLength(3);
    expect(existsSync(sessionTranscriptPath(gitDir(dir), first))).toBe(true);
    expect(h.ofType("transcript_restore").at(-1)!.items).toEqual([]);
    expect(s.session.sessionId).toBeNull();
  });

  it("the CLI reporting another id than the pre-chosen one renames the meta and its transcript file (test double / id not honoured)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const chosen = (await h.open(dir)).sessions.currentId!;
    await h.engine.handle({ type: "send", text: "hi" });
    h.session().emitSessionInfo({ sessionId: "cli-id" });
    await h.settle();
    let s = h.engine.state;
    expect(s.sessions.currentId).toBe("cli-id");
    expect(s.sessions.openTabIds).toEqual(["cli-id"]);
    expect(s.sessions.list.map((m) => m.id)).toEqual(["cli-id"]);
    expect(existsSync(sessionTranscriptPath(gitDir(dir), chosen))).toBe(false);
    expect(readFileSync(sessionTranscriptPath(gitDir(dir), "cli-id"), "utf8")).toContain('"hi"');
    h.session().emitTurnEnd({ sessionId: "cli-id" });
    await h.waitFor((x) => x.hud.turnCount === 1, "turn end");
    s = h.engine.state;
    expect(s.sessions.list[0]).toMatchObject({ id: "cli-id", title: "hi", turns: 1 });
    await waitForFile(sessionFile(dir), (t) => JSON.parse(t).sessionId === "cli-id", "session file");
    // restart_session resumes the reported id.
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((x) => x.session.open && !x.session.starting && h.sessions.length === 2, "restarted");
    expect(h.sessions[1]!.opts.settings.resumeSessionId).toBe("cli-id");
  });
});
