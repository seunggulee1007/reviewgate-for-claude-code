import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/** `refresh` (docs/M15-POLISH.md): re-snapshot/re-diff while reviewing; branches / workbenches otherwise. */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-refresh"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  write(dir, "other.txt", "other\n");
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
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** A turn that changes README.md and adds new.txt → reviewing. */
async function reviewedTurn(h: Harness, dir: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "edit" });
  write(dir, "README.md", "line1\nline2 changed\nline3\n");
  write(dir, "new.txt", "brand new\n");
  h.session().emitTurnEnd({ toolFiles: [{ path: `${dir}/README.md`, tools: ["Edit"], count: 1 }] });
  await h.waitFor((s) => s.gate.phase === "reviewing" && s.branches.list.length > 0, "reviewing");
}

describe("refresh (docs/M15-POLISH.md)", () => {
  it("while reviewing: an external edit appears (existing file re-diffed, new file pending); reviewed states and tools are kept", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    await h.engine.handle({ type: "accept", paths: ["new.txt"] });
    const before = h.engine.state;
    const oldDiff = await h.engine.request({ type: "select_file", path: "README.md" });
    // The user edits by hand: README gets another line, other.txt changes, extra.txt appears.
    write(dir, "README.md", "line1\nline2 changed\nline3\nline4 by hand\n");
    write(dir, "other.txt", "other edited\n");
    write(dir, "extra.txt", "new by hand\n");
    await h.engine.request({ type: "refresh" });
    const s = h.engine.state;
    expect(s.gate.phase).toBe("reviewing");
    expect(s.gate.turnStartTree).toBe(before.gate.turnStartTree);
    expect(s.gate.turnEndTree).not.toBe(before.gate.turnEndTree);
    expect(s.changedFiles.map((f) => [f.path, f.state, f.tools, f.added])).toEqual([
      ["README.md", "pending", ["Edit"], 2],
      ["extra.txt", "pending", [], 1],
      ["new.txt", "accepted", [], 1],
      ["other.txt", "pending", [], 1],
    ]);
    const diff = await h.engine.request({ type: "select_file", path: "README.md" });
    const added = diff.diff.hunks.flatMap((x) => x.lines).filter((l) => l.kind === "add").map((l) => l.text);
    expect(added).toEqual(["line2 changed", "line4 by hand"]);
    expect(oldDiff.diff.hunks.flatMap((x) => x.lines).filter((l) => l.kind === "add")).toHaveLength(1);
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Accepted: new.txt.");
  });

  it("while reviewing: a file reverted by hand is dropped with its notes; when nothing is left the gate opens", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await reviewedTurn(h, dir);
    await h.engine.handle({ type: "add_note", path: "README.md", line: 2, side: "new", excerpt: "line2 changed", body: "why?" });
    await h.engine.handle({ type: "add_note", path: "new.txt", line: 1, side: "new", excerpt: "brand new", body: "keep" });
    expect(h.engine.state.reviewNotes).toHaveLength(2);
    sh(dir, "checkout", "--", "README.md");
    await h.engine.request({ type: "refresh", scope: ["review"] });
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["new.txt", "pending"]]);
    expect(s.reviewNotes.map((n) => n.path)).toEqual(["new.txt"]);
    expect(s.gate.phase).toBe("reviewing");
    await expect(h.engine.request({ type: "select_file", path: "README.md" })).rejects.toThrow("not_a_changed_file:README.md");
    // Undo the last one too → nothing to review, the gate opens (the review file goes away with it).
    sh(dir, "clean", "-fq", "--", "new.txt");
    expect(read(dir, "new.txt")).toBeNull();
    await h.engine.request({ type: "refresh" });
    s = h.engine.state;
    expect(s.changedFiles).toEqual([]);
    expect(s.gate.phase).toBe("idle");
    expect(s.gate.canSend).toBe(true);
    expect(s.gate.blockedReason).toBeNull();
  });

  it("idle: refresh re-reads branches / workbenches (the review scope is a no-op); refused only by a git failure", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.engine.request({ type: "refresh" }); // no project: nothing applicable, still ok
    await h.open(dir);
    expect(h.engine.state.branches.list.map((b) => b.name)).toEqual(["main"]);
    sh(dir, "branch", "feature/x");
    write(dir, "other.txt", "dirty\n");
    const before = h.engine.state;
    expect(before.branches.isWorktreeDirty).toBe(false);
    expect(before.workbenches.list[0]!.dirty).toBe(false);
    await h.engine.request({ type: "refresh", scope: ["branches"] });
    let s = h.engine.state;
    expect(s.branches.list.map((b) => b.name).sort()).toEqual(["feature/x", "main"]);
    expect(s.branches.isWorktreeDirty).toBe(true);
    expect(s.gate.phase).toBe("idle");
    expect(s.changedFiles).toEqual([]); // idle refresh never turns worktree changes into a review
    sh(dir, "checkout", "--", "other.txt");
    await h.engine.request({ type: "refresh" });
    s = h.engine.state;
    expect(s.branches.isWorktreeDirty).toBe(false);
    expect(s.workbenches.list.map((w) => [w.isCurrent, w.dirty])).toEqual([[true, false]]);
    expect(s.commit.identity).toEqual({ name: "Test", email: "test@example.com" });
    // A running turn keeps the review scope out (no re-snapshot mid-turn) but branches still refresh.
    await h.engine.handle({ type: "send", text: "go" });
    sh(dir, "branch", "feature/y");
    await h.engine.request({ type: "refresh" });
    s = h.engine.state;
    expect(s.gate.phase).toBe("running");
    expect(s.branches.list.map((b) => b.name).sort()).toEqual(["feature/x", "feature/y", "main"]);
  });
});
