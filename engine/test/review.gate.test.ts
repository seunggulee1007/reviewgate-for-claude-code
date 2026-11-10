import { mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCheckpoint } from "../src/git/checkpoint.js";
import type { ReviewGate } from "../src/review/gate.js";
import { requestChangesMessage } from "../src/review/notes.js";
import { FakeClaudeSession, makeHarness, testSettings, type Harness } from "./helpers/engine.js";
import { fileExists, makeBranchRepo, makeTempDir, read, removeDir, renameWhenFree, sh, write } from "./helpers/repo.js";

/** Mirrors `RequestChangesTests.makeRepo`: README.md (20 lines) + other.txt committed on `main`. */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-gate")); // git prints the resolved toplevel (/private/var on macOS)
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", readmeLines().join("\n") + "\n");
  write(dir, "other.txt", "other\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

function readmeLines(): string[] {
  return Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** Opens `dir`, sends `text`, waits until the fake session has the message queued. */
async function openAndSend(h: Harness, dir: string, text = "do it"): Promise<void> {
  await h.hello();
  const opened = await h.open(dir);
  expect(opened.session.open).toBe(true);
  expect(opened.gate.canSend).toBe(true);
  await h.engine.handle({ type: "send", text });
  expect(h.session().sends).toHaveLength(1);
}

/** Ends the fake turn and waits for the collection (`turn_end` + reviewing/idle). */
async function endTurn(h: Harness, opts: Parameters<FakeClaudeSession["emitTurnEnd"]>[0] = {}): Promise<void> {
  h.session().emitTurnEnd(opts);
  await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
  await h.waitFor((s) => s.branches.list.length > 0, "branch refresh");
}

describe("ReviewEngine review gate", () => {
  it("open_project starts a session; send snapshots A and queues the message", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    const s0 = h.engine.state;
    expect(s0.gate.canSend).toBe(false);
    expect(s0.gate.blockedReason).toBe("no_session");

    const opened = await h.open(dir);
    expect(opened.project?.root).toBe(dir);
    expect(opened.project?.branch).toBe("main");
    expect(opened.project?.name).toBe(basename(dir));
    expect(opened.branches.list.map((b) => b.name)).toEqual(["main"]);
    expect(opened.session.open).toBe(true);
    expect(opened.gate.phase).toBe("idle");
    expect(h.session().opts.claudePath).toBe(testSettings.claudePath);
    expect(h.session().opts.settings.loadUserSettings).toBe(false);

    await h.engine.handle({ type: "send", text: "  hello  " });
    const running = h.engine.state;
    expect(running.gate.phase).toBe("running");
    expect(running.gate.canSend).toBe(false);
    expect(running.gate.blockedReason).toBe("running");
    expect(running.hud.turnStartedAt).toBe(1_700_000_000_000);
    expect(running.hud.activity).toEqual({ kind: "working" });
    const cp = await openCheckpoint(dir);
    expect(h.session().sends[0]).toEqual({ text: "hello", checkpointTree: await cp.snapshot() });
    expect(running.gate.turnStartTree).toBe(await cp.snapshot());
    expect(h.ofType("user_message")).toEqual([{ type: "user_message", text: "hello", turn: 1 }]);

    // A second send while running is refused without an error event.
    const before = h.ofType("error").length;
    await h.engine.handle({ type: "send", text: "again", id: "x" });
    expect(h.ofType("result").find((r) => r.id === "x")).toEqual({ type: "result", id: "x", ok: false, error: "gate_closed:running", code: "gate_closed" });
    expect(h.ofType("error")).toHaveLength(before);
  });

  it("turn_end collects the changed files, attributes tools, ignores patterns and opens the review", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);

    write(dir, "README.md", "changed\n");
    write(dir, "new.txt", "brand new\n");
    write(dir, ".omc/state.json", "{}\n");
    await endTurn(h, {
      toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 2 }, { path: join(dir, "new.txt"), tools: ["Write"], count: 1 }],
      usage: { costUsd: 0.25, durationMs: 4200, contextTokens: 5000, contextWindow: 200000 },
      budget: { files: 2, lines: 21, denied: false },
    });
    const s = h.engine.state;
    expect(s.gate.phase).toBe("reviewing");
    // A review never closes the input: a question can be asked without accepting anything (§10).
    expect(s.gate.canSend).toBe(true);
    expect(s.gate.blockedReason).toBeNull();
    expect(s.gate.pendingCount).toBe(2);
    expect(s.changedFiles.map((f) => [f.path, f.status, f.state, f.tools, f.added, f.deleted])).toEqual([
      ["README.md", "M", "pending", ["Edit"], 1, 20],
      ["new.txt", "A", "pending", ["Write"], 1, 0],
    ]);
    expect(s.hud).toMatchObject({ turnCount: 1, lastTurnMs: 4200, sessionCostUSD: 0.25, contextTokens: 5000, contextWindow: 200000, turnStartedAt: null, activity: { kind: "idle" } });
    expect(s.budgetUsage).toEqual({ files: 2, lines: 21, denied: false });
    expect(s.branches.switchBlocker).toEqual({ kind: "pendingReview", count: 2 });
    const turnEnd = h.ofType("turn_end");
    expect(turnEnd).toHaveLength(1);
    expect(turnEnd[0]).toMatchObject({ stopReason: "end_turn", files: 2, added: 2, deleted: 20 });
    expect(turnEnd[0]!.usage.costUsd).toBe(0.25);
  });

  it("select_file / full_file reply with the parsed diff and the full view", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    const lines = readmeLines();
    lines[11] = "if (x == null)";
    write(dir, "README.md", lines.join("\n") + "\n");
    await endTurn(h);

    const diff = await h.engine.request({ type: "select_file", path: "README.md" });
    expect(diff.type).toBe("file_diff");
    expect(diff.scope).toBe("turn");
    expect(diff.truncated).toBe(false);
    expect(diff.diff.hunks).toHaveLength(1);
    expect(diff.diff.hunks[0]!.lines.filter((l) => l.kind === "add").map((l) => [l.newNo, l.text])).toEqual([[12, "if (x == null)"]]);
    expect(diff.diff.hunks[0]!.lines.filter((l) => l.kind === "del").map((l) => [l.oldNo, l.text])).toEqual([[12, "line12"]]);

    const full = await h.engine.request({ type: "full_file", path: "README.md" });
    expect(full.type).toBe("full_file_content");
    expect(full.lines[11]).toBe("if (x == null)");
    expect(full.changedNewLines).toEqual([12]);
    expect(full.deletedAfterNewLine).toEqual({ "11": ["line12"] });
    expect(full.isBinary).toBe(false);
    expect(full.newText).toBe(lines.join("\n") + "\n");
    expect(full.oldText).toBe(readmeLines().join("\n") + "\n");

    await expect(h.engine.request({ type: "select_file", path: "nope.txt" })).rejects.toThrow("not_a_changed_file:nope.txt");
  });

  it("accept / reject: reject reverts on disk and re-snapshots B; summary prefixes the next send", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    write(dir, "other.txt", "other changed\n");
    write(dir, "new.txt", "brand new\n");
    // Claude's own changes (§31: `reject_all` reverts only those).
    await endTurn(h, { toolFiles: ["README.md", "other.txt", "new.txt"].map((f, i) => ({ path: join(dir, f), tools: ["Write"], count: 1, toolUseIds: [`w${i}`] })) });
    const endTree = h.engine.state.gate.turnEndTree;

    await h.engine.handle({ type: "accept", paths: ["other.txt", "not-there.txt"] });
    expect(h.engine.state.changedFiles.find((f) => f.path === "other.txt")?.state).toBe("accepted");
    expect(h.engine.state.gate.pendingCount).toBe(2);

    await h.engine.handle({ type: "reject", paths: ["new.txt"] });
    let s = h.engine.state;
    expect(fileExists(join(dir, "new.txt"))).toBe(false);
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md", "other.txt"]);
    expect(s.gate.turnEndTree).not.toBe(endTree);
    expect(s.gate.phase).toBe("reviewing");
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Accepted: other.txt. Rejected (reverted on disk, do not redo unless asked): new.txt.");

    await h.engine.handle({ type: "reject_all" });
    s = h.engine.state;
    expect(read(dir, "README.md")).toBe(readmeLines().join("\n") + "\n");
    expect(read(dir, "other.txt")).toBe("other changed\n"); // accepted files are never reverted
    expect(s.changedFiles.map((f) => f.path)).toEqual(["other.txt"]);
    expect(s.gate.phase).toBe("idle");
    expect(s.gate.canSend).toBe(true);
    expect(s.branches.switchBlocker).toEqual({ kind: "dirtyWorktree" });

    await h.engine.handle({ type: "send", text: "next" });
    expect(h.session().sends[1]!.text).toBe(
      "[Review gate] Accepted: other.txt. Rejected (reverted on disk, do not redo unless asked): new.txt, README.md.\n\nnext",
    );
    expect(h.engine.state.gate.lastReviewSummary).toBeNull();
    // A fresh A was taken (not the kept one): it contains the accepted other.txt change.
    expect(h.session().sends[1]!.checkpointTree).not.toBe(h.session().sends[0]!.checkpointTree);
  });

  it("accept_all opens the gate; accepted files stay on disk", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    await endTurn(h);
    await h.engine.handle({ type: "accept_all" });
    const s = h.engine.state;
    expect(s.gate.canSend).toBe(true);
    expect(s.gate.phase).toBe("idle");
    expect(s.changedFiles[0]!.state).toBe("accepted");
    expect(read(dir, "README.md")).toBe("changed\n");
  });

  it("request changes: message format, kept A, pre-accepted unchanged patches (RequestChangesTests.messageFormatAndStateTransitions)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    const a = h.session().sends[0]!.checkpointTree!;

    // Turn 1: Claude edits README.md line 12 and other.txt.
    const readme = readmeLines();
    readme[11] = "if (x == null)";
    write(dir, "README.md", readme.join("\n") + "\n");
    write(dir, "other.txt", "other changed\n");
    await endTurn(h);
    expect(h.engine.state.changedFiles.map((f) => f.path).sort()).toEqual(["README.md", "other.txt"]);
    expect(h.engine.state.gate.canSend).toBe(true); // sending is a question, not an accept (§10)

    await h.engine.handle({ type: "accept", paths: ["other.txt"] });
    await h.engine.handle({ type: "add_note", path: "README.md", line: 12, side: "new", excerpt: "if (x == null)", body: "여기 null 체크 빠짐" });
    await h.engine.handle({ type: "add_note", path: "README.md", line: null, side: "old", excerpt: "", body: "second" });
    await h.engine.handle({ type: "add_note", path: "README.md", line: null, side: "old", excerpt: "", body: "   ", id: "empty" });
    expect(h.ofType("result").find((r) => r.id === "empty")).toMatchObject({ ok: false, error: "empty note" });
    let s = h.engine.state;
    expect(s.reviewNotes).toHaveLength(2);
    expect(s.changedFiles.find((f) => f.path === "README.md")?.noteCount).toBe(2);
    expect(s.gate.canRequestChanges).toBe(true);
    expect(s.gate.canSend).toBe(true);

    await h.engine.handle({ type: "request_changes", extra: " please fix " });
    const expected = [
      "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.",
      "- README.md:12 (new) `if (x == null)` — 여기 null 체크 빠짐",
      "- README.md (old) — second",
      "",
      "please fix",
    ].join("\n");
    // A is kept for the review, not re-snapshotted; the session's hooks count the turn from its own start (§54).
    const own = (h.engine as unknown as { gate: ReviewGate }).gate.runningTurnStart;
    expect(own).not.toBe(a);
    expect(h.session().sends[1]).toEqual({ text: expected, checkpointTree: own });
    s = h.engine.state;
    expect(s.gate.turnStartTree).toBe(a);
    expect(s.gate.turnEndTree).toBeNull();
    expect(s.gate.isRequestingChanges).toBe(true);
    expect(s.gate.phase).toBe("running");
    expect(s.changedFiles.find((f) => f.path === "README.md")?.state).toBe("changesRequested");
    expect(s.changedFiles.find((f) => f.path === "other.txt")?.state).toBe("accepted");
    expect(h.ofType("user_message")[1]).toEqual({ type: "user_message", text: expected, turn: 2 });
    expect(s.gate.canSend).toBe(false); // the request-changes turn is running

    // Turn 2: Claude fixes README.md; other.txt untouched (byte-identical patch) → pre-marked accepted.
    readme[11] = "if (x == null) { return }";
    write(dir, "README.md", readme.join("\n") + "\n");
    await endTurn(h);
    s = h.engine.state;
    expect(s.gate.turnStartTree).toBe(a);
    expect(s.gate.isRequestingChanges).toBe(false);
    // §34.4: the sent notes stay ("요청함 — 반영 확인") and are never sent again.
    expect(s.reviewNotes.map((n) => [n.body, n.sent?.turn])).toEqual([["여기 null 체크 빠짐", 2], ["second", 2]]);
    expect(s.gate.canRequestChanges).toBe(false);
    expect(s.changedFiles.map((f) => f.path).sort()).toEqual(["README.md", "other.txt"]);
    expect(s.changedFiles.find((f) => f.path === "other.txt")?.state).toBe("accepted");
    expect(s.changedFiles.find((f) => f.path === "README.md")?.state).toBe("pending");
    expect(s.branches.switchBlocker).toEqual({ kind: "pendingReview", count: 1 });

    // The cumulative diff vs the ORIGINAL A is what gets reviewed.
    const full = await h.engine.request({ type: "full_file", path: "README.md" });
    expect(full.lines[11]).toBe("if (x == null) { return }");
    expect(full.changedNewLines).toEqual([12]);
    expect(full.deletedAfterNewLine).toEqual({ "11": ["line12"] });
    expect(s.gate.canSend).toBe(true);
    await h.engine.handle({ type: "accept_all" });
    expect(h.engine.state.gate.pendingCount + h.engine.state.gate.changesRequestedCount).toBe(0);
  });

  it("request changes: an accepted file changed again is pending after the rebuild (RequestChangesTests.acceptedFileChangedAgainIsPendingAfterRebuild)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    write(dir, "other.txt", "other changed\n");
    await endTurn(h);
    await h.engine.handle({ type: "accept", paths: ["other.txt"] });
    await h.engine.handle({ type: "add_note", path: "README.md", line: 1, side: "new", excerpt: "changed", body: "no" });
    await h.engine.handle({ type: "request_changes" });
    expect(h.session().sends[1]!.text).toBe(
      "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.\n- README.md:1 (new) `changed` — no",
    );

    write(dir, "other.txt", "other changed twice\n"); // Claude touched the accepted file too
    await endTurn(h);
    const s = h.engine.state;
    expect(s.changedFiles.find((f) => f.path === "other.txt")?.state).toBe("pending");
    expect(s.changedFiles.find((f) => f.path === "README.md")?.state).toBe("pending");
    expect(s.gate.lastReviewSummary).toContain("other.txt");
  });

  it("request changes: a refused send undoes the marking and keeps the notes", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    await endTurn(h);
    const endTree = h.engine.state.gate.turnEndTree;
    await h.engine.handle({ type: "add_note", path: "README.md", line: 1, side: "new", excerpt: "changed", body: "no" });
    h.session().refuseSends = new Error("session closed");
    await h.engine.handle({ type: "request_changes" });
    const s = h.engine.state;
    expect(s.gate.phase).toBe("reviewing");
    expect(s.gate.isRequestingChanges).toBe(false);
    expect(s.gate.turnEndTree).toBe(endTree);
    expect(s.changedFiles[0]!.state).toBe("pending");
    expect(s.reviewNotes).toHaveLength(1);
    expect(s.lastError).toBe("session closed");
    expect(h.ofType("error").at(-1)).toMatchObject({ scope: "session", fatal: false });
  });

  it("remove_note and request_changes guard", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    await endTurn(h);
    await h.engine.handle({ type: "request_changes", id: "rc" });
    expect(h.ofType("result").find((r) => r.id === "rc")).toMatchObject({ ok: false, error: "request_changes_unavailable:no_notes" });
    await h.engine.handle({ type: "add_note", path: "README.md", line: 1, side: "new", excerpt: "changed", body: "no" });
    const noteId = h.engine.state.reviewNotes[0]!.id;
    await h.engine.handle({ type: "remove_note", noteId });
    expect(h.engine.state.reviewNotes).toEqual([]);
    expect(h.engine.state.gate.canRequestChanges).toBe(false);
  });

  it("edit_note changes an unsent note; request_changes{noteIds} sends only those and keeps the rest unsent", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    write(dir, "other.txt", "other changed\n");
    await endTurn(h);
    await h.engine.handle({ type: "add_note", path: "README.md", line: 1, side: "new", excerpt: "changed", body: "first" });
    await h.engine.handle({ type: "add_note", path: "other.txt", line: 1, side: "new", excerpt: "other changed", body: "second" });
    const [first, second] = h.engine.state.reviewNotes.map((n) => n.id);
    await h.engine.handle({ type: "edit_note", noteId: first!, body: "  first, edited  " });
    await h.engine.handle({ type: "edit_note", noteId: first!, body: "   ", id: "blank" });
    expect(h.ofType("result").find((r) => r.id === "blank")).toMatchObject({ ok: false });
    expect(h.engine.state.reviewNotes.map((n) => n.body)).toEqual(["first, edited", "second"]);

    await h.engine.handle({ type: "request_changes", noteIds: ["nope"], id: "none" });
    expect(h.ofType("result").find((r) => r.id === "none")).toMatchObject({ ok: false, error: "request_changes_unavailable:no_notes" });

    await h.engine.handle({ type: "request_changes", noteIds: [first!] });
    expect(h.session().sends[1]!.text).toBe(
      "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.\n- README.md:1 (new) `changed` — first, edited",
    );
    const s = h.engine.state;
    expect(s.changedFiles.find((f) => f.path === "README.md")?.state).toBe("changesRequested");
    expect(s.changedFiles.find((f) => f.path === "other.txt")?.state).toBe("pending");
    expect(s.reviewNotes.find((n) => n.id === second)?.sent).toBeUndefined();
    await endTurn(h);
    await h.engine.handle({ type: "edit_note", noteId: first!, body: "too late", id: "sent" });
    expect(h.ofType("result").find((r) => r.id === "sent")).toMatchObject({ ok: false });
    expect(h.engine.state.gate.canRequestChanges).toBe(true); // "second" is still unsent
  });

  it("commits that land outside the app while the review stands are carried into A: only Claude's changes stay", async () => {
    const dir = track(makeRepo());
    write(dir, "other.txt", "local edit\n"); // uncommitted before the turn: part of A
    const h = harness();
    await openAndSend(h, dir);
    const readme = readmeLines();
    readme[1] = "claude changed this";
    write(dir, "README.md", readme.join("\n") + "\n");
    await endTurn(h);
    const a = h.engine.state.gate.turnStartTree;
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    // Someone else's work arrives (a pull / merge): a new file, committed outside the app.
    write(dir, "pulled.txt", "new on develop\n");
    sh(dir, "add", "pulled.txt");
    sh(dir, "commit", "-q", "-m", "merged work");
    await h.engine.handle({ type: "refresh", scope: ["review"] });
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    expect(s.gate.turnStartTree).not.toBe(a);
    const full = await h.engine.request({ type: "full_file", path: "README.md" });
    expect(full.changedNewLines).toEqual([2]);

    // A commit over what A holds uncommitted (other.txt) does not apply: A stays and the move is reported.
    write(dir, "other.txt", "theirs\n");
    sh(dir, "add", "other.txt");
    sh(dir, "commit", "-q", "-m", "overlap");
    write(dir, "other.txt", "local edit\n");
    const before = h.engine.state.gate.turnStartTree;
    await h.engine.handle({ type: "refresh", scope: ["review"] });
    s = h.engine.state;
    expect(s.gate.turnStartTree).toBe(before);
    expect(s.gate.headMoved).not.toBeNull();
  });

  /** `develop` off main: a new file, another.txt changed and README line 5 changed to `line5`; main is checked out again. */
  function makeDevelop(dir: string, readme5 = "line5"): void {
    sh(dir, "checkout", "-q", "-b", "develop");
    const readme = readmeLines();
    readme[4] = readme5;
    write(dir, "README.md", readme.join("\n") + "\n");
    write(dir, "other.txt", "other on develop\n");
    write(dir, "dev.txt", "new on develop\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "develop work");
    sh(dir, "checkout", "-q", "main");
  }

  it("§46: a merge Claude ran and committed in the turn is carried into A at the collection — only Claude's own edits are listed", async () => {
    const dir = track(makeRepo());
    makeDevelop(dir);
    const h = harness();
    await openAndSend(h, dir, "merge develop, then fix README line 2");
    sh(dir, "merge", "-q", "--no-edit", "develop"); // the approved `git merge`
    const readme = read(dir, "README.md")!.split("\n");
    readme[1] = "claude changed this";
    write(dir, "README.md", readme.join("\n"));
    await endTurn(h);
    const s = h.engine.state;
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    expect(h.ofType("turn_end")[0]).toMatchObject({ files: 1 });
    const full = await h.engine.request({ type: "full_file", path: "README.md" });
    expect(full.changedNewLines).toEqual([2]); // develop's line 5 is not Claude's
  });

  it("§46: an unfinished merge carries its incoming side into A; a conflicted file shows only Claude's resolution against ours", async () => {
    const dir = track(makeRepo());
    makeDevelop(dir, "line5 on develop");
    const readme = readmeLines();
    readme[4] = "line5 on main";
    write(dir, "README.md", readme.join("\n") + "\n");
    sh(dir, "commit", "-qam", "main work");
    const h = harness();
    await openAndSend(h, dir, "merge develop and resolve the conflicts");
    expect(() => sh(dir, "merge", "-q", "develop")).toThrow(); // CONFLICT in README.md
    readme[4] = "line5 resolved";
    write(dir, "README.md", readme.join("\n") + "\n");
    sh(dir, "add", "README.md");
    write(dir, "claude.txt", "claude's own\n");
    expect(fileExists(join(dir, ".git", "MERGE_HEAD"))).toBe(true); // resolved, not committed
    await endTurn(h);
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md", "claude.txt"]);
    const full = await h.engine.request({ type: "full_file", path: "README.md" });
    expect(full.changedNewLines).toEqual([5]);
    // Carried once: a refresh while the merge is still under way changes nothing.
    const a = s.gate.turnStartTree;
    await h.engine.handle({ type: "refresh", scope: ["review"] });
    s = h.engine.state;
    expect(s.gate.turnStartTree).toBe(a);
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md", "claude.txt"]);
  });

  /** main and develop both change README line 5; Claude merges develop in a turn (conflict) — resolution left to the test. */
  async function conflictedMergeTurn(h: Harness, dir: string): Promise<string[]> {
    makeDevelop(dir, "line5 on develop");
    const readme = readmeLines();
    readme[4] = "line5 on main";
    write(dir, "README.md", readme.join("\n") + "\n");
    sh(dir, "commit", "-qam", "main work");
    await openAndSend(h, dir, "merge develop and resolve the conflicts");
    expect(() => sh(dir, "merge", "-q", "develop")).toThrow(); // CONFLICT in README.md
    return readme;
  }

  it("§46: the review's commit concludes an unfinished merge (git refuses a partial commit during one); unresolved or staged-unreviewed files refuse it", async () => {
    const dir = track(makeRepo());
    const h = harness();
    const readme = await conflictedMergeTurn(h, dir);
    readme[4] = "line5 resolved";
    write(dir, "README.md", readme.join("\n") + "\n");
    sh(dir, "add", "README.md"); // Claude staged its resolution
    write(dir, "claude.txt", "claude's own\n");
    await endTurn(h);
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["README.md", "claude.txt"]);
    await h.engine.handle({ type: "accept", paths: ["claude.txt"] });
    await expect(h.engine.request({ type: "commit", message: "Merge develop", push: false })).rejects.toThrow(/merge_unresolved:README\.md/);
    expect(fileExists(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    await h.engine.handle({ type: "accept", paths: ["README.md"] });
    await h.engine.request({ type: "commit", message: "Merge develop", push: false });
    expect(fileExists(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(sh(dir, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toHaveLength(3);
    expect(sh(dir, "status", "--porcelain").trim()).toBe("");
    expect(read(dir, "dev.txt")).toBe("new on develop\n");
    expect(h.engine.state.changedFiles).toEqual([]);
    await h.engine.handle({ type: "refresh", scope: ["review"] });
    expect(h.engine.state.changedFiles).toEqual([]);
    expect(h.engine.state.gate.headMoved).toBeNull();
  });

  it("§46: a conflicted file nobody resolved refuses the merge commit even with the others accepted", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await conflictedMergeTurn(h, dir);
    write(dir, "claude.txt", "claude's own\n");
    await endTurn(h);
    await h.engine.handle({ type: "accept", paths: ["claude.txt"] });
    await expect(h.engine.request({ type: "commit", message: "Merge develop", push: false })).rejects.toThrow(/merge_unresolved:README\.md/);
    expect(fileExists(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
  });

  it("§46: a merge Claude commits with its resolution carries only the other side — the resolution stays in the review", async () => {
    const dir = track(makeRepo());
    const h = harness();
    const readme = await conflictedMergeTurn(h, dir);
    readme[4] = "line5 resolved";
    write(dir, "README.md", readme.join("\n") + "\n");
    write(dir, "claude.txt", "claude's own\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "--no-edit"); // the approved `git commit` concluding the merge
    await endTurn(h);
    const s = h.engine.state;
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md", "claude.txt"]);
    const full = await h.engine.request({ type: "full_file", path: "README.md" });
    expect(full.changedNewLines).toEqual([5]); // ours → the resolution; develop's other files are not listed
  });

  it("§46: an aborted merge takes its incoming side back out of A — nothing of develop shows as Claude undoing it", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await conflictedMergeTurn(h, dir);
    write(dir, "claude.txt", "claude's own\n");
    await endTurn(h);
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["README.md", "claude.txt"]);
    sh(dir, "merge", "--abort");
    await h.engine.handle({ type: "refresh", scope: ["review"] });
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["claude.txt"]);
    expect(h.engine.state.gate.headMoved).toBeNull();
  });

  it("§46: a file the other branch renamed while ours changed it does not stop the rest of the merge from carrying", async () => {
    const dir = track(makeRepo());
    write(dir, "Old.java", "class Old {\n  int a;\n  int b;\n  int c;\n}\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "old");
    makeDevelop(dir, "line5 on develop");
    sh(dir, "checkout", "-q", "develop");
    sh(dir, "mv", "Old.java", "New.java");
    sh(dir, "commit", "-qm", "rename");
    sh(dir, "checkout", "-q", "main");
    write(dir, "Old.java", "class Old {\n  int a;\n  int b;\n  int c2;\n}\n");
    const readme = readmeLines();
    readme[4] = "line5 on main";
    write(dir, "README.md", readme.join("\n") + "\n");
    sh(dir, "commit", "-qam", "main work");
    const h = harness();
    await openAndSend(h, dir, "merge develop");
    expect(() => sh(dir, "merge", "-q", "develop")).toThrow();
    write(dir, "claude.txt", "claude's own\n");
    await endTurn(h);
    const listed = h.engine.state.changedFiles.map((f) => f.path);
    expect(listed).toContain("claude.txt");
    expect(listed).not.toContain("dev.txt"); // develop's untouched files were carried
    expect(listed).not.toContain("other.txt");
  });

  it("unaccept: an accepted file is pending again, nothing on disk changes", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    write(dir, "other.txt", "other changed\n");
    await endTurn(h);
    await h.engine.handle({ type: "accept", paths: ["other.txt"] });
    expect(h.engine.state.changedFiles.find((f) => f.path === "other.txt")?.state).toBe("accepted");
    await h.engine.handle({ type: "unaccept", paths: ["other.txt", "README.md"] });
    const s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"], ["other.txt", "pending"]]);
    expect(s.gate.pendingCount).toBe(2);
    expect(read(dir, "other.txt")).toBe("other changed\n");
  });

  it("a file .gitignore starts hiding mid-review is not a deletion: it is on disk, just ignored now", async () => {
    const dir = track(makeRepo());
    write(dir, "notes.md", "my notes\n"); // untracked, not ignored yet: part of A
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    write(dir, ".gitignore", "notes.md\n");
    await endTurn(h);
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.status])).toEqual([[".gitignore", "A"], ["README.md", "M"]]);
    await h.engine.handle({ type: "refresh", scope: ["review"] });
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual([".gitignore", "README.md"]);
  });

  it("a collection failure leaves the input open (M30) and no turn_end until retry_collect succeeds", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    write(dir, "README.md", "changed\n");
    await renameWhenFree(join(dir, ".git"), join(dir, ".git-hidden")); // Windows: the send's git work may still hold it
    h.session().emitTurnEnd();
    const failed = await h.waitFor((s) => s.gate.phase === "collect_failed", "collect failure");
    // M30 (§3): the next turn would fold the failed one in — the input stays open.
    expect(failed.gate.canSend).toBe(true);
    expect(failed.gate.blockedReason).toBeNull();
    expect(failed.gate.collectError).toBeTruthy();
    expect(failed.gate.turnEndTree).toBeNull();
    expect(h.ofType("turn_end")).toHaveLength(0);
    expect(h.ofType("error").at(-1)?.message).toMatch(/^Failed to collect changes: /);
    expect(h.engine.state.branches.switchBlocker).toBeNull(); // SessionStore.branchSwitchBlocker ignores reviewCollectFailed

    await renameWhenFree(join(dir, ".git-hidden"), join(dir, ".git"));
    await h.engine.handle({ type: "retry_collect" });
    await h.waitFor((s) => s.gate.phase === "reviewing", "retry");
    const s = h.engine.state;
    expect(s.gate.collectError).toBeNull();
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    expect(h.ofType("turn_end")).toHaveLength(1);
    await h.engine.handle({ type: "retry_collect", id: "r2" });
    expect(h.ofType("result").find((r) => r.id === "r2")).toMatchObject({ ok: false, error: "nothing_to_retry" });
  });

  it("HUD accounting: session cost sums per-turn deltas; capabilities come from session_info", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    // §36.5: never null once a session started — empty lists until the CLI reports (`state` ready: the fake answered initialize).
    expect(h.engine.state.session.capabilities).toEqual({ slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "ready" });
    h.session().emitSessionInfo();
    await h.settle();
    let s = h.engine.state;
    expect(s.session.sessionId).toBe("sess-1");
    expect(s.session.model).toBe("claude-test");
    expect(s.session.capabilities).toEqual({ slashCommands: ["commit"], skills: ["graphify"], plugins: ["p"], mcpServers: [{ name: "fs", status: "connected" }], pluginDetails: [{ name: "p", path: "/p", id: null }], state: "ready" });

    await endTurn(h, { usage: { costUsd: 0.1, durationMs: 1000, contextTokens: 1000 } });
    await h.engine.handle({ type: "send", text: "two" });
    await endTurn(h, { usage: { costUsd: 0.25, durationMs: 2000, contextTokens: 3000, contextWindow: 1_000_000 } });
    s = h.engine.state;
    expect(s.hud.turnCount).toBe(2);
    expect(s.hud.sessionCostUSD).toBeCloseTo(0.35, 10);
    expect(s.hud.lastTurnMs).toBe(2000);
    expect(s.hud.contextTokens).toBe(3000);
    expect(s.hud.contextWindow).toBe(1_000_000);
    expect(s.hud.turnStartedAt).toBeNull();
  });

  it("activity folding (SessionStoreTests.toolStartActivityShowsToolAndDetailUntilToolEnd)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    const f = h.session();
    const act = () => h.engine.state.hud.activity;

    f.emit({ type: "activity", kind: "tool_start", toolName: "Write" });
    expect(act()).toEqual({ kind: "tool", toolName: "Write" });
    f.emit({ type: "activity", kind: "tool_start", toolName: "Write", detail: "x.txt" });
    expect(act()).toEqual({ kind: "tool", toolName: "Write", detail: "x.txt" });
    // The transcript events of the same call must not overwrite the HUD text.
    f.emit({ type: "tool_use", id: "t1", name: "Write", input: {}, file: "/p/x.txt" });
    f.emit({ type: "tool_result", toolUseId: "t1", isError: false, preview: "ok" });
    expect(act()).toEqual({ kind: "tool", toolName: "Write", detail: "x.txt" });
    f.emit({ type: "activity", kind: "tool_end", toolName: "Write" });
    expect(act()).toEqual({ kind: "working" });

    // subagentDepth is derived from state.hud.agents: the session emits the Agent tool_use before subagent_start.
    f.emit({ type: "tool_use", id: "ag1", name: "Agent", input: { description: "explore" } });
    f.emit({ type: "activity", kind: "subagent_start", toolName: "Agent", detail: "explore" });
    expect(act()).toEqual({ kind: "subagent", toolName: "Agent", detail: "explore" });
    expect(h.engine.state.hud.subagentDepth).toBe(1);
    f.emit({ type: "activity", kind: "tool_start", toolName: "Bash", detail: "ls" });
    f.emit({ type: "activity", kind: "tool_end", toolName: "Bash" });
    expect(act()).toEqual({ kind: "subagent" });
    f.emit({ type: "tool_result", toolUseId: "ag1", isError: false, preview: "done" });
    f.emit({ type: "activity", kind: "subagent_end", toolName: "Agent" });
    expect(act()).toEqual({ kind: "working" });
    expect(h.engine.state.hud.subagentDepth).toBe(0);
    f.emit({ type: "activity", kind: "thinking" });
    expect(act()).toEqual({ kind: "thinking" });
    f.emit({ type: "activity", kind: "idle" });
    expect(act()).toEqual({ kind: "idle" });
    expect(h.ofType("tool_use")).toHaveLength(2);
    expect(h.ofType("activity").length).toBeGreaterThanOrEqual(9);
  });

  it("permission_request is mirrored in state; permission_response clears it and reaches the session", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    h.session().emit({ type: "permission_request", requestId: "p1", toolName: "Bash", input: { command: "ls" } });
    let s = h.engine.state;
    expect(s.session.pendingPermission).toEqual({ requestId: "p1", toolName: "Bash", input: { command: "ls" }, file: undefined });
    expect(s.gate.blockedReason).toBe("awaiting_permission");
    await h.engine.handle({ type: "permission_response", requestId: "p1", allow: false, message: "nope" });
    s = h.engine.state;
    expect(s.session.pendingPermission).toBeNull();
    expect(h.session().permissionResponses).toEqual([{ requestId: "p1", allow: false, message: "nope" }]);
    await h.engine.handle({ type: "interrupt" });
    expect(h.session().interrupts).toBe(1);
    await h.engine.handle({ type: "set_settings", settings: { budget: { maxFiles: 1, maxLines: 10 } } });
    expect(h.session().budgets).toEqual([{ maxFiles: 1, maxLines: 10 }]);
    expect(h.engine.state.budget).toEqual({ maxFiles: 1, maxLines: 10 });
  });

  it("budget_event updates usage; a fatal session error ends the turn and collects what is on disk", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    h.session().emit({ type: "budget_event", kind: "deny", toolName: "Edit", files: 6, lines: 10, budget: { maxFiles: 5, maxLines: 200 } });
    expect(h.engine.state.budgetUsage).toEqual({ files: 6, lines: 10, denied: true });
    write(dir, "README.md", "half done\n");
    h.session().emit({ type: "error", message: "boom", fatal: true });
    await h.waitFor((s) => s.gate.phase === "reviewing", "collection after fatal error");
    const s = h.engine.state;
    expect(s.lastError).toBe("boom");
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    expect(h.ofType("turn_end")[0]).toMatchObject({ stopReason: "error", files: 1 });
    expect(h.ofType("error")[0]).toEqual({ type: "error", message: "boom", fatal: true, scope: "session" });
  });

  it("session closed while running: review list preserved, pending_review outranks no_session, open_project restores it (audit 1.3/1.4)", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello({ autoRestartSession: false });
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "do it" });
    write(dir, "README.md", "half done\n");
    h.session().emit({ type: "closed", code: 1 });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing", "collection after close");
    expect(s.session.open).toBe(false);
    expect(s.session.canRestart).toBe(true);
    expect(s.gate.blockedReason).toBe("pending_review");
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    expect(h.engine.state.gate.canSend).toBe(false);
    // Re-opening the same project no longer wipes the review: it is restored from <gitdir>/reviewgate-review.json.
    const reopened = await h.open(dir);
    expect(reopened.session.open).toBe(true);
    expect(reopened.gate.restored).toBe(true);
    expect(reopened.gate.phase).toBe("reviewing");
    expect(reopened.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(reopened.gate.blockedReason).toBeNull(); // the session is back: the standing review does not block sending
    expect(reopened.gate.canSend).toBe(true);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0]!.disposed).toBe(true);
    await h.engine.handle({ type: "accept_all" });
    expect(h.engine.state.gate.canSend).toBe(true);
    expect(h.engine.state.gate.blockedReason).toBeNull();
  });

  it("branch switch blockers, switch_branch and create_branch", async () => {
    const dir = track(realpathSync(makeBranchRepo()));
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "create_branch", name: "feature" });
    let s = h.engine.state;
    expect(s.project?.branch).toBe("feature");
    expect(s.branches.list.map((b) => [b.name, b.isCurrent])).toEqual([["feature", true], ["main", false]]);
    await h.engine.handle({ type: "switch_branch", name: "main" });
    expect(h.engine.state.project?.branch).toBe("main");

    await h.engine.handle({ type: "create_branch", name: "bad name", id: "b" });
    expect(h.ofType("result").find((r) => r.id === "b")?.ok).toBe(false);
    expect(h.ofType("error").at(-1)?.message).toMatch(/^Failed to create branch bad name: /);

    write(dir, "a.txt", "dirty\n");
    await h.engine.handle({ type: "branches" });
    s = h.engine.state;
    expect(s.branches.isWorktreeDirty).toBe(true);
    expect(s.branches.switchBlocker).toEqual({ kind: "dirtyWorktree" });
    await h.engine.handle({ type: "switch_branch", name: "feature", id: "sw" });
    expect(h.ofType("result").find((r) => r.id === "sw")).toMatchObject({ ok: false, error: "switch_blocked:dirtyWorktree" });
    expect(h.engine.state.project?.branch).toBe("main");

    await h.engine.handle({ type: "send", text: "go" });
    expect(h.engine.state.branches.switchBlocker).toEqual({ kind: "running" });
  });

  it("git-init flow: candidates + unsafe, cancel, init_repo starts the session", async () => {
    const dir = track(realpathSync(makeTempDir("rg-nogit")));
    mkdirSync(join(dir, "sub-repo/.git"), { recursive: true });
    mkdirSync(join(dir, "plain"), { recursive: true });
    const h = harness();
    await h.hello();
    let s = await h.open(dir);
    expect(s.gitInit).toEqual({ path: dir, candidates: [join(dir, "sub-repo")], looksUnsafe: false });
    expect(s.project).toBeNull();
    expect(s.gate.blockedReason).toBe("git_init_needed");
    await h.engine.handle({ type: "cancel_git_init" });
    expect(h.engine.state.gitInit).toBeNull();
    await h.engine.handle({ type: "init_repo", id: "i" });
    expect(h.ofType("result").find((r) => r.id === "i")).toMatchObject({ ok: false, error: "git_init_not_needed" });

    await h.open(dir);
    await h.engine.handle({ type: "init_repo" });
    s = await h.waitFor((x) => x.session.open, "session after init");
    expect(s.gitInit).toBeNull();
    expect(fileExists(join(dir, ".git"))).toBe(true);
    expect(s.project?.root).toBe(dir);
    expect(s.project?.branch).toBeNull(); // unborn branch
    expect(s.gate.canSend).toBe(true);
  });

  it("close_project / switch_project stop the session and clear project state", async () => {
    const dir1 = track(makeRepo());
    const dir2 = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir1);
    write(dir1, "README.md", "changed\n");
    await endTurn(h);
    const first = h.session();
    await h.engine.handle({ type: "switch_project", path: dir2 });
    await h.waitFor((s) => s.session.open && s.project?.root === dir2, "switch");
    expect(first.disposed).toBe(true);
    let s = h.engine.state;
    expect(s.changedFiles).toEqual([]);
    expect(s.gate.phase).toBe("idle");
    expect(s.hud.turnCount).toBe(0);
    // §36.5: the new project's session shows empty lists (no cache of its own yet), never the old project's.
    expect(s.session.capabilities).toEqual({ slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "ready" });
    await h.engine.handle({ type: "close_project" });
    s = h.engine.state;
    expect(s.project).toBeNull();
    expect(s.session.open).toBe(false);
    expect(h.session().disposed).toBe(true);
    expect(s.branches.list).toEqual([]);
  });

  it("missing claude → fatal engine error, session stays closed", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello({ claudePath: undefined });
    const s = await h.open(dir);
    expect(s.session.open).toBe(false);
    expect(s.lastError).toMatch(/^claude CLI not found/);
    expect(h.ofType("error")[0]).toMatchObject({ fatal: true, scope: "engine" });
    expect(s.project?.root).toBe(dir); // the project is open; only the session is missing
  });

  it("failed session start is reported and leaves the gate closed", async () => {
    const dir = track(makeRepo());
    const h = makeHarness({
      sessionFactory: (o) => {
        const f = new FakeClaudeSession(o);
        f.failStart = new Error("spawn ENOENT");
        return f;
      },
    });
    harnesses.push(h);
    await h.hello();
    const s = await h.open(dir);
    expect(s.session.open).toBe(false);
    expect(s.session.starting).toBe(false);
    expect(s.lastError).toBe("spawn ENOENT");
    expect(h.ofType("error")[0]).toMatchObject({ fatal: true, scope: "session" });
  });

  it("state emission is coalesced per macrotask with a strictly increasing seq", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    const before = h.states.length;
    // Three synchronous mutations → one snapshot.
    h.session().emit({ type: "activity", kind: "thinking" });
    h.session().emit({ type: "activity", kind: "tool_start", toolName: "Read" });
    h.session().emit({ type: "activity", kind: "tool_end", toolName: "Read" });
    await h.settle();
    expect(h.states.length).toBe(before + 1);
    const seqs = h.states.map((s) => s.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(1);
  });

  it("shutdown replies, disposes the session and stops emitting", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await openAndSend(h, dir);
    await h.engine.handle({ type: "shutdown", id: "bye" });
    expect(h.ofType("result").find((r) => r.id === "bye")).toEqual({ type: "result", id: "bye", ok: true });
    expect(h.session().disposed).toBe(true);
    const n = h.events.length;
    await h.engine.handle({ type: "branches", id: "late" });
    await h.settle();
    expect(h.events.length).toBe(n);
  });
});

describe("requestChangesMessage", () => {
  it("is byte-identical to SessionStore.requestChangesMessage", () => {
    const notes = [
      { id: "1", path: "README.md", line: 12, side: "new" as const, excerpt: "  if (x == null)  ", body: "여기 null 체크 빠짐" },
      { id: "2", path: "README.md", line: null, side: "old" as const, excerpt: "", body: "second" },
    ];
    expect(requestChangesMessage(notes, " please fix ")).toBe(
      "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.\n- README.md:12 (new) `if (x == null)` — 여기 null 체크 빠짐\n- README.md (old) — second\n\nplease fix",
    );
    expect(requestChangesMessage(notes, "   ")).toBe(
      "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.\n- README.md:12 (new) `if (x == null)` — 여기 null 체크 빠짐\n- README.md (old) — second",
    );
    expect(requestChangesMessage([], null)).toBe("[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.");
  });
});
