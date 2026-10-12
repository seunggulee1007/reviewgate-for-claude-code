import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCheckpoint } from "../src/git/checkpoint.js";
import { nulSplit } from "../src/git/exec.js";
import type { FileWhy } from "../src/protocol.js";
import type { ReviewGate } from "../src/review/gate.js";
import { turnPaths } from "../src/review/turnDelta.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §37.3: a collection diffs the turn's own start tree against B once. The §34.8 "this turn's files"
 * (which files get a fresh `why`) used to come from a second diff of the same two trees (`diff-tree --name-only
 * --no-renames`) next to the §34.3 `changedThisTurn` delta; both now read the one delta — the same set (a rename counts
 * by both its names, as the name-only diff listed them), one git diff less per turn.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-turndelta"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "Svc.java", Array.from({ length: 12 }, (_, i) => `s${i + 1}`).join("\n") + "\n");
  write(dir, "other.txt", Array.from({ length: 12 }, (_, i) => `o${i + 1}`).join("\n") + "\n");
  write(dir, "gone.txt", "bye\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const tree = (dir: string): string => {
  sh(dir, "add", "-A");
  return sh(dir, "write-tree").trim();
};

describe("one delta for this turn (§37.3)", () => {
  it("turnPaths(changes(a, b)) is exactly the name-only --no-renames set of the two trees (renames by both names)", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const cp = new GitCheckpoint(dir);
    const a = tree(dir);
    // A modification, a rename with an edit, a deletion, an addition.
    write(dir, "Svc.java", Array.from({ length: 12 }, (_, i) => (i === 3 ? "s4 changed" : `s${i + 1}`)).join("\n") + "\n");
    sh(dir, "mv", "other.txt", "moved.txt");
    write(dir, "moved.txt", Array.from({ length: 12 }, (_, i) => (i === 0 ? "o1 edited" : `o${i + 1}`)).join("\n") + "\n");
    sh(dir, "rm", "-q", "gone.txt");
    write(dir, "added.txt", "hi\n");
    const b = tree(dir);
    const changes = await cp.changes(a, b);
    expect(changes.find((f) => f.path === "moved.txt")).toMatchObject({ status: "R", oldPath: "other.txt" });
    const nameOnly = new Set(nulSplit((await cp.git(["diff-tree", "-r", "--no-renames", "--name-only", "-z", a, b])).stdout).filter((p) => p.length > 0));
    expect([...turnPaths(changes)].sort()).toEqual([...nameOnly].sort());
    expect([...turnPaths(changes)].sort()).toEqual(["Svc.java", "added.txt", "gone.txt", "moved.txt", "other.txt"]);
  });

  it("a question turn over a standing review: why is recomputed exactly for changedThisTurn, with no second diff of the turn's trees", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello({ budget: { maxFiles: 50, maxLines: 5000 } });
    await h.open(dir);
    // Turn 1: Svc.java and other.txt, each with its own rationale.
    await h.engine.request({ type: "send", text: "first" });
    let s = h.session();
    s.emit({ type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(dir, "Svc.java") }, file: join(dir, "Svc.java"), rationale: "Svc needs s4", rationaleSource: "same_message", rationaleAge: 0 });
    s.emit({ type: "tool_use", id: "e2", name: "Edit", input: { file_path: join(dir, "other.txt") }, file: join(dir, "other.txt"), rationale: "other needs o2", rationaleSource: "same_message", rationaleAge: 0 });
    write(dir, "Svc.java", Array.from({ length: 12 }, (_, i) => (i === 3 ? "s4 changed" : `s${i + 1}`)).join("\n") + "\n");
    write(dir, "other.txt", Array.from({ length: 12 }, (_, i) => (i === 1 ? "o2 changed" : `o${i + 1}`)).join("\n") + "\n");
    s.emit({ type: "tool_result", toolUseId: "e1", isError: false, preview: "ok" });
    s.emit({ type: "tool_result", toolUseId: "e2", isError: false, preview: "ok" });
    s.emitTurnEnd({ toolFiles: [
      { path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
      { path: join(dir, "other.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] },
    ] });
    await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null, "turn 1 collected");

    // Turn 2 (a question over the review): Svc.java again, with a new reason.
    await h.engine.request({ type: "send", text: "and s9?" });
    const gate = (h.engine as unknown as { gate: ReviewGate }).gate;
    const cp = gate.checkpoint!;
    const calls: string[][] = [];
    const real = cp.git.bind(cp);
    cp.git = (args, opts) => {
      calls.push(args);
      return real(args, opts);
    };
    s = h.session();
    s.emit({ type: "tool_use", id: "e3", name: "Edit", input: { file_path: join(dir, "Svc.java") }, file: join(dir, "Svc.java"), rationale: "s9 too", rationaleSource: "same_message", rationaleAge: 0 });
    write(dir, "Svc.java", Array.from({ length: 12 }, (_, i) => (i === 3 ? "s4 changed" : i === 8 ? "s9 changed" : `s${i + 1}`)).join("\n") + "\n");
    s.emit({ type: "tool_result", toolUseId: "e3", isError: false, preview: "ok" });
    s.emitTurnEnd({ toolFiles: [{ path: join(dir, "Svc.java"), tools: ["Edit"], count: 1, toolUseIds: ["e3"] }] });
    const s2 = await h.waitFor((x) => x.gate.phase === "reviewing" && x.hud.turnCount === 2 && x.gate.turnEndTree !== null, "turn 2 collected");
    // The §26 record of the turn closes after turn_end: it reads the same delta (no third diff of the trees).
    await h.waitFor((x) => (x.session.checkpoints ?? []).length === 2 && (x.session.checkpoints ?? []).every((c) => c.endedAt !== null), "turn 2's record closed");
    cp.git = real;

    const why = (p: string) => (s2.changedFiles.find((f) => f.path === p) as { why?: FileWhy } | undefined)?.why;
    expect(s2.changedFiles.map((f) => [f.path, f.changedThisTurn ?? false])).toEqual([["Svc.java", true], ["other.txt", false]]);
    expect(why("Svc.java")).toMatchObject({ text: "s9 too", source: "same_message", toolUseId: "e3", turn: 2 });
    expect(why("other.txt")).toMatchObject({ text: "other needs o2", toolUseId: "e2", turn: 1 });
    // The turn's own delta was read once: no name-only diff of the same trees next to it.
    expect(calls.filter((a) => a.includes("--name-only"))).toEqual([]);
    const own = gate.turnBaseTree!;
    expect(calls.filter((a) => a[0] === "diff-tree" && a.includes("--numstat") && a.includes(own) && !a.includes("-w"))).toHaveLength(1);
    // Its status diff is `--raw` since §40.2 (the modes and a rename's score come with the same call): still one, none beside it.
    expect(calls.filter((a) => a[0] === "diff-tree" && a.includes("--raw") && a.includes(own))).toHaveLength(1);
    expect(calls.filter((a) => a[0] === "diff-tree" && a.includes("--name-status"))).toEqual([]);
    expect(records(h).map((r) => [r.turn, r.files])).toEqual([[1, ["Svc.java", "other.txt"]], [2, ["Svc.java"]]]);
  });

  it("the §26 record keeps the unfiltered delta: a rename by both names and a tracked file the ignore patterns hide from the list", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    write(dir, "gen/out.txt", "v1\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "gen");
    const h = makeHarness();
    harnesses.push(h);
    await h.hello({ budget: { maxFiles: 50, maxLines: 5000 }, ignorePatterns: ["gen/*.txt"] });
    await h.open(dir);
    await h.engine.request({ type: "send", text: "rename other" });
    sh(dir, "mv", "other.txt", "moved.txt");
    write(dir, "gen/out.txt", "v2\n");
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "moved.txt"), tools: ["Bash"], count: 1, toolUseIds: ["b1"] }] });
    const s = await h.waitFor((x) => x.gate.phase === "reviewing" && x.gate.turnEndTree !== null, "collected");
    await h.waitFor((x) => (x.session.checkpoints ?? []).length === 1 && (x.session.checkpoints ?? []).every((c) => c.endedAt !== null), "record closed");
    // The review hides gen/out.txt (an ignore pattern); the record — what a file rewind may restore — does not.
    expect(s.changedFiles.map((f) => [f.path, f.status, f.oldPath])).toEqual([["moved.txt", "R", "other.txt"]]);
    expect(records(h).map((r) => r.files)).toEqual([["gen/out.txt", "moved.txt", "other.txt"]]);
  });
});

function records(h: Harness): { turn: number | null; files: string[] | null }[] {
  type Rec = { turn: number | null; files: string[] | null; kind: string };
  return (h.engine as unknown as { checkpoints: { records: Rec[] } }).checkpoints.records.filter((r) => r.kind === "turn");
}
