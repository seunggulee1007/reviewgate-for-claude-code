import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileDiff } from "../src/diff/parse.js";
import type { ChangedFileState } from "../src/protocol.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §66 "Since accepted": a file the user accepted that a later turn of the same review changes again is
 * pending with an `acceptedBase` — its default diff, counts, `reject` and `reject_hunks` start from the accepted content.
 */

const lines = (n: number, tag = "l"): string[] => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`);
const text = (ls: string[]): string => ls.join("\n") + "\n";
/** 20 lines of new.ts with `edits` (1-based line → text). */
function newTs(edits: Record<number, string> = {}): string {
  const ls = lines(20, "n");
  for (const [no, t] of Object.entries(edits)) ls[Number(no) - 1] = t;
  return text(ls);
}

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-accbase"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "Svc.java", text(lines(5)));
  write(dir, "old.txt", "old\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const adds = (d: FileDiff): string[] => d.hunks.flatMap((x) => x.lines.filter((l) => l.kind === "add").map((l) => l.text));
const dels = (d: FileDiff): string[] => d.hunks.flatMap((x) => x.lines.filter((l) => l.kind === "del").map((l) => l.text));
const fileOf = (h: Harness, path: string): ChangedFileState | undefined => h.engine.state.changedFiles.find((f) => f.path === path);

/** Ends the running turn with `files` edited and waits for its collection. */
async function collect(h: Harness, dir: string, files: string[]): Promise<void> {
  const turn = h.engine.state.hud.turnCount;
  h.session().emitTurnEnd({ toolFiles: files.map((f) => ({ path: join(dir, f), tools: ["Edit"], count: 1, toolUseIds: [`${f}@${turn}`] })) });
  await h.waitFor((s) => s.hud.turnCount > turn && s.gate.turnEndTree !== null && s.gate.phase !== "running" && s.gate.phase !== "collecting", "collection");
  await h.settle();
}

/**
 * Turn 1 creates new.ts and changes Svc.java; the user accepts new.ts (Svc.java stays pending, so A is kept) and asks on;
 * turn 2 runs `second` and is collected into the same review. Returns A and B1 (the accepted tree).
 */
async function acceptThenChange(h: Harness, dir: string, second: () => void, touched = ["new.ts"]): Promise<{ a: string; b1: string }> {
  await h.hello();
  await h.open(dir);
  await h.engine.request({ type: "send", text: "add new.ts" });
  h.session().emitSessionInfo();
  write(dir, "new.ts", newTs());
  write(dir, "Svc.java", text([...lines(5), "l6"]));
  await collect(h, dir, ["new.ts", "Svc.java"]);
  const a = h.engine.state.gate.turnStartTree!;
  const b1 = h.engine.state.gate.turnEndTree!;
  await h.engine.request({ type: "accept", paths: ["new.ts"] });
  await h.engine.request({ type: "send", text: "go on" });
  second();
  await collect(h, dir, touched);
  return { a, b1 };
}

describe("§66 since accepted", () => {
  it("a file accepted and changed again is pending with its accepted base: the default diff, counts and summary are since accepted", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = harness();
    const { a, b1 } = await acceptThenChange(h, dir, () => write(dir, "new.ts", newTs({ 2: "n2 again" })));
    const s = h.engine.state;
    expect(s.gate.turnStartTree).toBe(a);
    const f = fileOf(h, "new.ts")!;
    expect(f).toMatchObject({ state: "pending", status: "A", changedSinceAccepted: true, added: 1, deleted: 1 });
    expect(f.acceptedBase).toMatchObject({ tree: b1, blob: sh(dir, "rev-parse", `${b1}:new.ts`).trim(), turn: 1, status: "M", roundAdded: 20, roundDeleted: 0 });
    expect(Date.parse(f.acceptedBase!.at!)).toBeGreaterThan(0);
    expect(fileOf(h, "Svc.java")?.acceptedBase).toBeUndefined();
    expect(s.gate.reviewSummary).toEqual({ files: 2, added: 2, deleted: 1, pending: 2, changesRequested: 0, acceptedUncommitted: 0 });

    // No `since`: the since-accepted diff, and the reply says so.
    const byDefault = await h.engine.request({ type: "select_file", path: "new.ts" });
    expect(byDefault).toMatchObject({ since: "accepted", baseTree: b1, endTree: s.gate.turnEndTree });
    expect([adds(byDefault.diff), dels(byDefault.diff)]).toEqual([["n2 again"], ["n2"]]);
    const full = await h.engine.request({ type: "full_file", path: "new.ts" });
    expect(full).toMatchObject({ since: "accepted", changedNewLines: [2] });
    // `round` (= `review`): the whole round from A, as before §66.
    const round = await h.engine.request({ type: "select_file", path: "new.ts", since: "round" });
    expect(round).toMatchObject({ since: "review", baseTree: a });
    expect(adds(round.diff)).toHaveLength(20);
    // A file without an accepted base keeps the old reply (no `since`).
    expect((await h.engine.request({ type: "select_file", path: "Svc.java" })).since).toBeUndefined();

    // Accepting it again: accepted, the base and the since-accepted counts go.
    await h.engine.request({ type: "accept", paths: ["new.ts"] });
    expect(fileOf(h, "new.ts")).toMatchObject({ state: "accepted", added: 20, deleted: 0 });
    expect(fileOf(h, "new.ts")?.acceptedBase).toBeUndefined();
    expect(h.engine.state.gate.reviewSummary).toMatchObject({ pending: 1, acceptedUncommitted: 1 });
    expect((await h.engine.request({ type: "select_file", path: "new.ts" })).since).toBeUndefined();
  });

  it("reject puts the accepted content back and the file is accepted again; to:\"round\" reverts to A as before", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = harness();
    await acceptThenChange(h, dir, () => write(dir, "new.ts", newTs({ 2: "n2 again" })));
    await h.engine.request({ type: "reject", paths: ["new.ts"] });
    expect(read(dir, "new.ts")).toBe(newTs());
    const f = fileOf(h, "new.ts")!;
    expect(f).toMatchObject({ state: "accepted", added: 20, deleted: 0 });
    expect(f.changedSinceAccepted).toBeUndefined();
    expect(f.acceptedBase).toBeUndefined();
    expect(h.engine.state.gate.lastReviewSummary).toBe(
      "[Review gate] Later changes rejected (reverted on disk to the version the user accepted earlier, do not redo them unless asked): new.ts.",
    );
    const history = await h.engine.request({ type: "review_history" });
    expect(history.current?.files.find((x) => x.path === "new.ts")?.verdict).toBe("accepted");
    // §58.1: counted as a reject; with Svc.java accepted after it, Continue tells Claude both.
    expect(h.engine.state.gate.untoldDecisions).toEqual({ accepted: 0, rejected: 1 });
    await h.engine.request({ type: "accept", paths: ["Svc.java"] });
    expect(h.engine.state.gate.untoldDecisions).toEqual({ accepted: 1, rejected: 1 });

    // The explicit round reject: back to A (new.ts did not exist), out of the list.
    const dir2 = makeRepo();
    dirs.push(dir2);
    const h2 = harness();
    await acceptThenChange(h2, dir2, () => write(dir2, "new.ts", newTs({ 2: "n2 again" })));
    await h2.engine.request({ type: "reject", paths: ["new.ts"], to: "round" });
    expect(existsSync(join(dir2, "new.ts"))).toBe(false);
    expect(fileOf(h2, "new.ts")).toBeUndefined();
  });

  it("reject_hunks takes the since-accepted hunk ids: only the new hunk goes; the round's ids still work with A as base", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = harness();
    const { a, b1 } = await acceptThenChange(h, dir, () => write(dir, "new.ts", newTs({ 2: "n2 again", 18: "n18 again" })));
    const since = await h.engine.request({ type: "select_file", path: "new.ts" });
    expect(since.diff.hunks).toHaveLength(2);
    await h.engine.request({ type: "reject_hunks", path: "new.ts", hunks: [since.diff.hunks[0]!.id], expectedEndTree: since.endTree!, expectedBaseTree: b1 });
    expect(read(dir, "new.ts")).toBe(newTs({ 18: "n18 again" }));
    let f = fileOf(h, "new.ts")!;
    expect(f).toMatchObject({ state: "pending", partial: true, added: 1, deleted: 1 });
    expect(f.acceptedBase).toMatchObject({ tree: b1, roundAdded: 20 });
    expect(h.engine.state.gate.lastReviewSummary).toContain("Partially rejected (some hunks reverted on disk, do not redo them unless asked): new.ts.");
    const after = await h.engine.request({ type: "select_file", path: "new.ts" });
    expect([adds(after.diff), dels(after.diff)]).toEqual([["n18 again"], ["n18"]]);

    // A base that is neither A nor the accepted tree is refused; the last hunk without a base (the default range) leaves
    // the file at its accepted content: accepted again.
    await expect(h.engine.request({ type: "reject_hunks", path: "new.ts", hunks: [0], expectedBaseTree: "0123456789012345678901234567890123456789" })).rejects.toThrow("stale_diff");
    await h.engine.request({ type: "reject_hunks", path: "new.ts", hunks: [after.diff.hunks[0]!.id] });
    expect(read(dir, "new.ts")).toBe(newTs());
    f = fileOf(h, "new.ts")!;
    expect(f).toMatchObject({ state: "accepted", added: 20 });

    // Svc.java (no accepted base) still takes A's ids.
    const svc = await h.engine.request({ type: "select_file", path: "Svc.java" });
    expect(svc.baseTree).toBe(a);
  });

  it("deleted after its accept, or re-created after an accepted delete (a tombstone): reject brings the accepted state back", async () => {
    // A file of A deleted by turn 1 and accepted (a tombstone), re-created by turn 2.
    const dir2 = makeRepo();
    dirs.push(dir2);
    const h2 = harness();
    await h2.hello();
    await h2.open(dir2);
    await h2.engine.request({ type: "send", text: "drop old.txt" });
    h2.session().emitSessionInfo();
    removeFile(dir2, "old.txt");
    write(dir2, "Svc.java", text([...lines(5), "l6"]));
    await collect(h2, dir2, ["old.txt", "Svc.java"]);
    const tomb = h2.engine.state.gate.turnEndTree!;
    await h2.engine.request({ type: "accept", paths: ["old.txt"] });
    await h2.engine.request({ type: "send", text: "go on" });
    write(dir2, "old.txt", "old\nback\n");
    await collect(h2, dir2, ["old.txt"]);
    const g = fileOf(h2, "old.txt")!;
    expect(g).toMatchObject({ state: "pending", status: "M", changedSinceAccepted: true, added: 2, deleted: 0 });
    expect(g.acceptedBase).toMatchObject({ tree: tomb, blob: null, status: "A", roundAdded: 1, roundDeleted: 0 });
    await h2.engine.request({ type: "reject", paths: ["old.txt"] });
    expect(existsSync(join(dir2, "old.txt"))).toBe(false);
    expect(fileOf(h2, "old.txt")).toMatchObject({ state: "accepted", status: "D" });

    // An accepted file that the next turn deletes.
    const dir3 = makeRepo();
    dirs.push(dir3);
    const h3 = harness();
    await h3.hello();
    await h3.open(dir3);
    await h3.engine.request({ type: "send", text: "edit old.txt" });
    h3.session().emitSessionInfo();
    write(dir3, "old.txt", "old\nnew line\n");
    write(dir3, "Svc.java", text([...lines(5), "l6"]));
    await collect(h3, dir3, ["old.txt", "Svc.java"]);
    await h3.engine.request({ type: "accept", paths: ["old.txt"] });
    await h3.engine.request({ type: "send", text: "go on" });
    removeFile(dir3, "old.txt");
    await collect(h3, dir3, ["old.txt"]);
    expect(fileOf(h3, "old.txt")).toMatchObject({ state: "pending", status: "D", added: 0, deleted: 2 });
    expect(fileOf(h3, "old.txt")?.acceptedBase).toMatchObject({ status: "D", roundDeleted: 1 });
    await h3.engine.request({ type: "reject", paths: ["old.txt"] });
    expect(read(dir3, "old.txt")).toBe("old\nnew line\n");
    expect(fileOf(h3, "old.txt")).toMatchObject({ state: "accepted", status: "M" });
  });

  it("survives an engine restart: the base, its time and turn, and the default range come back", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = harness();
    const { b1 } = await acceptThenChange(h, dir, () => write(dir, "new.ts", newTs({ 2: "n2 again" })));
    const before = fileOf(h, "new.ts")!.acceptedBase!;
    await h.engine.dispose();

    const h2 = harness();
    await h2.hello();
    await h2.open(dir);
    expect(h2.engine.state.gate.restored).toBe(true);
    const f = fileOf(h2, "new.ts")!;
    expect(f).toMatchObject({ state: "pending", changedSinceAccepted: true, added: 1, deleted: 1 });
    expect(f.acceptedBase).toEqual(before);
    const d = await h2.engine.request({ type: "select_file", path: "new.ts" });
    expect(d).toMatchObject({ since: "accepted", baseTree: b1 });
    await h2.engine.request({ type: "reject", paths: ["new.ts"] });
    expect(read(dir, "new.ts")).toBe(newTs());
  });

  it("an accepted file the next turn leaves alone stays accepted and commits; Accept & Continue / request changes / finish keep working", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = harness();
    // Turn 2 changes Svc.java only: new.ts stays accepted, without a base.
    await acceptThenChange(h, dir, () => write(dir, "Svc.java", text([...lines(5), "l6", "l7"])), ["Svc.java"]);
    expect(fileOf(h, "new.ts")).toMatchObject({ state: "accepted", added: 20 });
    expect(fileOf(h, "new.ts")?.acceptedBase).toBeUndefined();
    expect(h.engine.state.gate.reviewSummary).toMatchObject({ pending: 1, acceptedUncommitted: 1 });
    await h.engine.request({ type: "commit", message: "Add new.ts", push: false });
    expect(sh(dir, "show", "--name-status", "--format=", "HEAD").trim()).toBe("A\tnew.ts");
    expect(fileOf(h, "new.ts")).toBeUndefined();
    expect(h.engine.state.gate.reviewSummary).toMatchObject({ files: 1, pending: 1, acceptedUncommitted: 0 });

    // Request changes on a file with a base keeps it; the follow-up's change is still measured from the accept.
    const dir2 = makeRepo();
    dirs.push(dir2);
    const h2 = harness();
    const { b1 } = await acceptThenChange(h2, dir2, () => write(dir2, "new.ts", newTs({ 2: "n2 again" })));
    await h2.engine.request({ type: "add_note", path: "new.ts", line: 2, side: "new", excerpt: "n2 again", body: "not like this" });
    await h2.engine.request({ type: "request_changes" });
    write(dir2, "new.ts", newTs({ 2: "n2 third" }));
    await collect(h2, dir2, ["new.ts"]);
    expect(fileOf(h2, "new.ts")).toMatchObject({ state: "pending", changedSinceAccepted: true, added: 1, deleted: 1 });
    expect(fileOf(h2, "new.ts")?.acceptedBase?.tree).toBe(b1);
    const d = await h2.engine.request({ type: "select_file", path: "new.ts" });
    expect([adds(d.diff), dels(d.diff)]).toEqual([["n2 third"], ["n2"]]);

    // Accept N & Continue: everything accepted, the base gone, Claude told.
    const sends = h2.session().sends.length;
    await h2.engine.request({ type: "send", text: "Continue.", acceptPending: true });
    await h2.waitFor((x) => x.gate.phase === "running", "running");
    expect(h2.session().sends[sends]!.text.startsWith("[Review gate] Accepted: ")).toBe(true);
    expect(h2.engine.state.changedFiles.every((f) => f.state === "accepted" && f.acceptedBase === undefined)).toBe(true);
    await collect(h2, dir2, []);

    // finish_review ends it all.
    const dir3 = makeRepo();
    dirs.push(dir3);
    const h3 = harness();
    await acceptThenChange(h3, dir3, () => write(dir3, "new.ts", newTs({ 2: "n2 again" })));
    await h3.engine.request({ type: "finish_review" });
    expect(h3.engine.state.changedFiles).toEqual([]);
    expect(read(dir3, "new.ts")).toBe(newTs({ 2: "n2 again" }));
  });
});

function removeFile(dir: string, path: string): void {
  rmSync(join(dir, path));
}
