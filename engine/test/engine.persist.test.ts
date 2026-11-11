import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEW_FILE, SESSION_FILE, turnRefs, type PersistedReview } from "../src/review/persist.js";

/** The main worktree's per-worktree pins (`refs/reviewgate/main/turn-start|end`). */
const REF_TURN_START = turnRefs("main").start;
const REF_TURN_END = turnRefs("main").end;
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { makeHarness, type FakeClaudeSession, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/** `main` with README.md + a committed `.gitignore` (build/) so ignored writes can be exercised. */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-persist"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  write(dir, ".gitignore", "build/\n");
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

function ref(dir: string, name: string): string | null {
  try {
    return sh(dir, "rev-parse", "--verify", "--quiet", name).trim() || null;
  } catch {
    return null;
  }
}

const reviewFile = (dir: string) => join(dir, ".git", REVIEW_FILE);

/** The review / session files are written asynchronously behind the state: poll until `pred` holds on the parsed JSON. */
async function waitForJSON(path: string, pred: (o: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const o = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (pred(o)) return o;
    } catch {
      // missing or mid-rename
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} in ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sessionFile = (dir: string) => join(dir, ".git", SESSION_FILE);
/** M15: the transcript lives per session under `<gitdir>/reviewgate/sessions/<id>.ndjson` (the fake reports `sess-1`). */
const transcriptFile = (dir: string, id = "sess-1") => sessionTranscriptPath(join(dir, ".git"), id);

/** Sends `text`, ends the fake turn after `mutate()` ran, waits for the collection. */
async function fakeTurn(h: Harness, mutate: () => void, opts: Parameters<FakeClaudeSession["emitTurnEnd"]>[0] = {}): Promise<void> {
  await h.engine.handle({ type: "send", text: "do it" });
  mutate();
  h.session().emitTurnEnd(opts);
  await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
  await h.waitFor((s) => s.branches.list.length > 0, "branch refresh");
}

describe("review persistence (audit 1.3)", () => {
  it("every gate mutation is mirrored to <gitdir>/reviewgate-review.json with pinned refs", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await fakeTurn(h, () => {
      write(dir, "README.md", "changed\n");
      write(dir, "new.txt", "brand new\n");
    });
    await h.engine.handle({ type: "add_note", path: "README.md", line: 1, side: "new", excerpt: "changed", body: "why?" });
    await h.engine.handle({ type: "accept", paths: ["new.txt"] });
    const s = h.engine.state;
    const saved = await waitForJSON(reviewFile(dir), (o) => o.lastReviewSummary !== null, "accept persisted") as PersistedReview;
    expect(saved).toMatchObject({
      version: 1,
      turnStartTree: s.gate.turnStartTree,
      turnEndTree: s.gate.turnEndTree,
      isRequestingChanges: false,
      lastUserText: "do it",
      sessionId: "sess-1",
      lastReviewSummary: "[Review gate] Accepted: new.txt.",
    });
    expect(saved.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"], ["new.txt", "accepted"]]);
    expect(saved.reviewNotes.map((n) => [n.path, n.body])).toEqual([["README.md", "why?"]]);
    expect(typeof saved.savedAt).toBe("string");
    expect(ref(dir, REF_TURN_START)).toBe(s.gate.turnStartTree);
    expect(ref(dir, REF_TURN_END)).toBe(s.gate.turnEndTree);
  });

  it("crash mid-review → a new engine restores the pending list (re-verified against a fresh snapshot); accept works; file + refs cleaned once resolved", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    await fakeTurn(a, () => {
      write(dir, "README.md", "changed\n");
      write(dir, "new.txt", "brand new\n");
      write(dir, "gone.txt", "will be undone by hand\n");
    }, { toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1 }] });
    await a.engine.handle({ type: "add_note", path: "README.md", line: 1, side: "new", excerpt: "changed", body: "why?" });
    await a.engine.handle({ type: "add_note", path: "gone.txt", line: 1, side: "new", excerpt: "x", body: "dropped with the file" });
    await a.settle();
    const before = a.engine.state;
    expect(before.changedFiles.map((f) => f.path)).toEqual(["README.md", "gone.txt", "new.txt"]);
    // "Crash": shutdown WITHOUT resolving the review. The user undoes gone.txt by hand in between.
    await a.engine.dispose();
    expect(existsSync(reviewFile(dir))).toBe(true);
    rmSync(join(dir, "gone.txt"));

    const b = harness();
    await b.hello();
    const restored = await b.open(dir);
    expect(restored.session.open).toBe(true);
    expect(restored.gate.restored).toBe(true);
    expect(restored.gate.phase).toBe("reviewing");
    expect(restored.gate.blockedReason).toBeNull(); // a restored review does not block sending (§10)
    expect(restored.gate.turnStartTree).toBe(before.gate.turnStartTree);
    expect(restored.changedFiles.map((f) => [f.path, f.state, f.tools])).toEqual([["README.md", "pending", ["Edit"]], ["new.txt", "pending", []]]);
    expect(restored.reviewNotes.map((n) => [n.path, n.body])).toEqual([["README.md", "why?"]]);
    expect(restored.commit.suggestedMessage.startsWith("do it")).toBe(true);
    expect(b.sessions[0]!.opts.settings.resumeSessionId).toBe("sess-1");
    // The transcript of the previous engine is replayed for the client.
    const replay = b.ofType("transcript_restore");
    expect(replay).toHaveLength(1);
    expect(replay[0]!.items.map((i) => i.kind)).toEqual(["user_message", "turn_end", "turn_summary"]); // §38.3: the summary row too

    const diff = await b.engine.request({ type: "select_file", path: "README.md" });
    expect(diff.diff.hunks.length).toBeGreaterThan(0);
    await b.engine.handle({ type: "accept", paths: ["README.md"] });
    await b.engine.handle({ type: "reject", paths: ["new.txt"] });
    await b.waitFor((s) => s.gate.phase === "idle", "review resolved");
    expect(existsSync(join(dir, "new.txt"))).toBe(false);
    expect(b.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "accepted"]]);
    expect(b.engine.state.gate.canSend).toBe(true);
    // Accepted files stay persisted (commit still possible after a restart) …
    await b.settle();
    expect(existsSync(reviewFile(dir))).toBe(true);
    // … and everything is cleaned up once nothing is left to review or commit.
    await b.engine.request({ type: "commit", message: "accepted README" });
    await b.waitFor((s) => s.changedFiles.length === 0, "committed");
    // The round goes to the review history first (behind the same persist chain), then the file is removed.
    await waitUntil(() => !existsSync(reviewFile(dir)) && ref(dir, REF_TURN_END) === null, "review file + refs removed");
    expect(ref(dir, REF_TURN_START)).toBeNull();
    expect(ref(dir, REF_TURN_END)).toBeNull();
  });

  it("the restored flag is cleared on the next turn; a review file whose refs are gone is ignored and removed", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    await fakeTurn(a, () => write(dir, "README.md", "changed\n"));
    await a.engine.dispose();

    const b = harness();
    await b.hello();
    expect((await b.open(dir)).gate.restored).toBe(true);
    await b.engine.handle({ type: "accept_all" });
    await fakeTurn(b, () => write(dir, "README.md", "changed again\n"));
    expect(b.engine.state.gate.restored).toBe(false);
    expect(b.engine.state.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    await b.engine.dispose();

    sh(dir, "update-ref", "-d", REF_TURN_START);
    const c = harness();
    await c.hello();
    const opened = await c.open(dir);
    expect(opened.gate.restored).toBe(false);
    expect(opened.changedFiles).toEqual([]);
    expect(opened.gate.phase).toBe("idle");
    expect(existsSync(reviewFile(dir))).toBe(false);
  });

  it("close_project with nothing pending removes the review file and refs; with a pending review it keeps them", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await fakeTurn(h, () => write(dir, "README.md", "changed\n"));
    await h.engine.handle({ type: "close_project" });
    expect(existsSync(reviewFile(dir))).toBe(true);
    expect(ref(dir, REF_TURN_START)).not.toBeNull();
    await h.open(dir);
    expect(h.engine.state.gate.restored).toBe(true);
    await h.engine.handle({ type: "accept_all" });
    await h.engine.handle({ type: "close_project" });
    expect(existsSync(reviewFile(dir))).toBe(false);
    expect(ref(dir, REF_TURN_START)).toBeNull();
    expect(ref(dir, REF_TURN_END)).toBeNull();
    expect(existsSync(sessionFile(dir))).toBe(true); // the session id outlives the review (resume)
  });
});

describe("restart_session (audit 1.4) and resume (audit 3.1)", () => {
  it("restart_session keeps the gate, disposes the old session and resumes the stored session id", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    expect(h.sessions[0]!.opts.settings.resumeSessionId).toBeUndefined();
    await fakeTurn(h, () => write(dir, "README.md", "changed\n"));
    h.session().emitSessionInfo({ sessionId: "sess-42" });
    await h.settle();
    const before = h.engine.state;
    expect(before.gate.phase).toBe("reviewing");
    expect(before.session.canRestart).toBe(true);
    await h.engine.request({ type: "restart_session" });
    const after = await h.waitFor((s) => s.session.open && !s.session.starting, "restarted");
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0]!.disposed).toBe(true);
    expect(h.sessions[1]!.opts.settings.resumeSessionId).toBe("sess-42");
    expect(after.gate.phase).toBe("reviewing");
    expect(after.gate.restored).toBe(false);
    expect(after.gate.turnStartTree).toBe(before.gate.turnStartTree);
    expect(after.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(after.hud.turnCount).toBe(1);
    await waitForJSON(sessionFile(dir), (o) => o.sessionId === "sess-42", "session id persisted");
    await h.engine.handle({ type: "accept_all" });
    expect(h.engine.state.gate.canSend).toBe(true);
  });

  it("restart_session without a project is refused; a restart mid-turn closes and collects the turn", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await expect(h.engine.request({ type: "restart_session" })).rejects.toThrow("no_project");
    expect(h.engine.state.session.canRestart).toBe(false);
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "do it" });
    write(dir, "README.md", "half\n");
    await h.engine.request({ type: "restart_session" });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.session.open, "collected + restarted");
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    expect(h.ofType("turn_end")[0]).toMatchObject({ stopReason: "session restarted", files: 1 });
    expect(h.sessions).toHaveLength(2);
  });

  it("auto-restarts once per turn after an unexpected close (backoff seam); disabled by settings.autoRestartSession=false", async () => {
    const dir = track(makeRepo());
    const h = harness({ autoRestartDelayMs: 20 });
    await h.hello();
    await h.open(dir);
    h.session().emitSessionInfo({ sessionId: "sess-1" });
    await h.settle();
    h.session().emit({ type: "closed", code: 1 });
    await h.waitFor((s) => !s.session.open, "session gone");
    await h.waitFor((s) => s.session.open && h.sessions.length === 2, "auto restart");
    expect(h.sessions[1]!.opts.settings.resumeSessionId).toBe("sess-1");
    h.sessions[1]!.emitSessionInfo({ sessionId: "sess-1" });
    // A second death in the same turn is not retried automatically.
    h.session().emit({ type: "closed", code: 1 });
    await h.waitFor((s) => !s.session.open, "session gone again");
    await new Promise((r) => setTimeout(r, 80));
    expect(h.sessions).toHaveLength(2);
    expect(h.engine.state.session.open).toBe(false);
    expect(h.engine.state.gate.blockedReason).toBe("no_session");
    expect(h.engine.state.session.canRestart).toBe(true);
    // The counter is per turn: after a manual restart + a new turn, one automatic restart is available again.
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((s) => s.session.open && h.sessions.length === 3, "manual restart");
    await h.engine.handle({ type: "send", text: "again" });
    h.session().emit({ type: "closed", code: 1 });
    await h.waitFor((s) => s.session.open && h.sessions.length === 4, "auto restart in the next turn");

    const off = harness({ autoRestartDelayMs: 20 });
    const dir2 = track(makeRepo());
    await off.hello({ autoRestartSession: false });
    await off.open(dir2);
    off.session().emitSessionInfo();
    await off.settle();
    off.session().emit({ type: "closed", code: 1 });
    await off.waitFor((s) => !s.session.open, "session gone");
    await new Promise((r) => setTimeout(r, 80));
    expect(off.sessions).toHaveLength(1);
  });

  it("a session that dies before its first session_info while resuming falls back to a fresh session and flags the old one resumeFailed", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    await a.engine.handle({ type: "send", text: "hi" }); // session_info follows the first user message
    a.session().emitSessionInfo({ sessionId: "stale-id" });
    await a.settle();
    await a.engine.dispose();

    const b = harness({ autoRestartDelayMs: 20 });
    await b.hello();
    await b.open(dir);
    expect(b.sessions[0]!.opts.settings.resumeSessionId).toBe("stale-id");
    b.session().emit({ type: "error", message: "No conversation found with session ID: stale-id", fatal: true });
    b.session().emit({ type: "closed", code: 1 });
    await b.waitFor((s) => s.session.open && b.sessions.length === 2, "fresh session");
    expect(b.sessions[1]!.opts.settings.resumeSessionId).toBeUndefined();
    const s = b.engine.state;
    expect(s.session.sessionId).toBeNull();
    // M15: the failed session stays in the history (transcript readable), a new chat is current and persisted.
    expect(s.sessions.currentId).not.toBe("stale-id");
    expect(s.sessions.list.find((m) => m.id === "stale-id")).toMatchObject({ resumeFailed: true, lastUserText: "hi" });
    expect(b.sessions[1]!.opts.settings.sessionId).toBe(s.sessions.currentId);
    await waitForJSON(sessionFile(dir), (o) => o.sessionId === s.sessions.currentId, "new current session persisted");
  });
});

describe("ignored / filtered / outside signals (audit 1.1, 1.2)", () => {
  it("turn_end exposes gitignored tool writes, pattern-filtered paths and approved outside edits; cleared on the next turn", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello({ ignorePatterns: [".omc/"] });
    await h.open(dir);
    await fakeTurn(h, () => {
      write(dir, "README.md", "changed\n");
      write(dir, "build/out.txt", "generated\n");
      write(dir, ".omc/state.json", "{}\n");
    }, {
      toolFiles: [
        { path: join(dir, "README.md"), tools: ["Edit"], count: 1 },
        { path: join(dir, "build/out.txt"), tools: ["Write"], count: 1 },
        { path: join(dir, ".omc/state.json"), tools: ["Write"], count: 1 },
        { path: "/somewhere/else.txt", tools: ["Write"], count: 1 },
      ],
      changedOutside: ["/Users/me/.zshrc"],
    });
    const s = h.engine.state;
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    expect(s.gate.ignoredTouched).toEqual(["build/out.txt"]);
    // `.omc/state.json` never reaches the diff at all now: `snapshot()` excludes ignorePatterns via
    // git pathspec magic (`:(exclude).omc`) so the temp index never adds/stats them. `filteredByPattern`
    // is instead derived from the tool-touched paths, same as `ignoredTouched`.
    expect(s.gate.filteredByPattern).toEqual([".omc/state.json"]);
    expect(s.gate.changedOutside).toEqual(["/Users/me/.zshrc"]);
    expect(h.ofType("turn_end")[0]).toMatchObject({ files: 1, changedOutside: ["/Users/me/.zshrc"] });
    await h.engine.handle({ type: "accept_all" });
    await h.engine.handle({ type: "send", text: "next" });
    const next = h.engine.state;
    expect(next.gate.ignoredTouched).toEqual([]);
    expect(next.gate.filteredByPattern).toEqual([]);
    expect(next.gate.changedOutside).toEqual([]);
  });
});

describe("transcript persistence (audit 3.1)", () => {
  it("writes user/assistant/tool/permission/budget/turn_end rows and replays the tail on open_project", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    expect(a.ofType("transcript_restore")).toEqual([{ type: "transcript_restore", items: [] }]);
    await a.engine.handle({ type: "send", text: "hello there" });
    const s = a.session();
    s.emit({ type: "text_delta", text: "Sure, " });
    s.emit({ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } });
    s.emit({ type: "permission_request", requestId: "p1", toolName: "Bash", input: { command: "ls" } });
    await a.settle();
    await a.engine.handle({ type: "permission_response", requestId: "p1", allow: true });
    s.emit({ type: "tool_result", toolUseId: "tu1", isError: false, preview: "README.md" });
    s.emit({ type: "budget_event", kind: "warn", toolName: "Edit", files: 5, lines: 10, budget: { maxFiles: 5, maxLines: 200 } });
    s.emit({ type: "text_delta", text: "done." });
    write(dir, "README.md", "changed\n");
    s.emitTurnEnd();
    await a.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    const rows = readFileSync(transcriptFile(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.kind, r.turn])).toEqual([
      ["user_message", 1], ["tool_use", 1], ["permission", 1], ["tool_result", 1], ["budget_event", 1], ["assistant_text", 1], ["turn_end", 1], ["turn_summary", 1], // §38.3
    ]);
    expect(rows[0]).toMatchObject({ kind: "user_message", text: "hello there" });
    expect(rows[2]).toMatchObject({ kind: "permission", requestId: "p1", toolName: "Bash", allow: true });
    expect(rows[5]).toMatchObject({ kind: "assistant_text", text: "Sure, done." });
    expect(rows[6]).toMatchObject({ kind: "turn_end", files: 1, changedOutside: [] });
    for (const r of rows) expect(typeof r.at).toBe("string");
    await a.engine.dispose();

    const b = harness();
    await b.hello();
    await b.open(dir);
    const replay = b.ofType("transcript_restore")[0]!;
    expect(replay.items.map((i) => i.kind)).toEqual(rows.map((r) => r.kind));
    expect(replay.items[0]).toEqual(rows[0]);
  });
});

describe("change → cause linkage (engine)", () => {
  it("persists parentToolUseId / rationale / testOutcome, keeps Bash output for tool_output and carries toolUseIds into changedFiles", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    await a.engine.handle({ type: "send", text: "fix it" });
    const s = a.session();
    s.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "d" } });
    s.emit({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(dir, "README.md") }, file: join(dir, "README.md"), parentToolUseId: "ag1", rationale: "Fix the readme." });
    s.emit({ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" }, rationale: "Run the tests." });
    s.emit({ type: "tool_result", toolUseId: "b1", isError: false, preview: "p".repeat(500), truncated: true, output: { text: "full output", truncated: false }, testOutcome: "pass" });
    await a.settle();
    const wire = a.ofType("tool_result").find((e) => e.toolUseId === "b1")!;
    expect(wire).toEqual({ type: "tool_result", toolUseId: "b1", isError: false, preview: "p".repeat(500), truncated: true, testOutcome: "pass" });
    expect(await a.engine.request({ type: "tool_output", toolUseId: "b1" })).toMatchObject({ type: "tool_output", toolUseId: "b1", output: "full output", truncated: false });
    expect(await a.engine.request({ type: "tool_output", toolUseId: "nope" })).toMatchObject({ type: "tool_output", toolUseId: "nope", output: null, truncated: false });

    write(dir, "README.md", "changed\n");
    write(dir, "other.txt", "by bash\n");
    s.emitTurnEnd({ toolFiles: [
      { path: join(dir, "README.md"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
      { path: join(dir, "other.txt"), tools: ["Bash"], count: 1, toolUseIds: ["b1"] },
    ] });
    await a.waitFor((x) => x.gate.phase === "reviewing", "reviewing");
    expect(a.engine.state.changedFiles.map((f) => [f.path, f.tools, f.toolUseIds])).toEqual([
      ["README.md", ["Edit"], ["e1"]],
      ["other.txt", ["Bash"], ["b1"]],
    ]);
    const rows = readFileSync(transcriptFile(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.find((r) => r.id === "e1")).toMatchObject({ kind: "tool_use", parentToolUseId: "ag1", rationale: "Fix the readme." });
    const bashRow = rows.find((r) => r.toolUseId === "b1");
    expect(bashRow).toMatchObject({ kind: "tool_result", truncated: true, testOutcome: "pass" });
    expect(bashRow).not.toHaveProperty("output");
  });
});
