import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEW_FILE, turnRefs } from "../src/review/persist.js";
import { STALE_REVIEW_MS } from "../src/engine.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, renameWhenFree, sh, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/** The harness clock (`makeHarness` pins `now` to it). */
const NOW = 1_700_000_000_000;

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-stale"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "a\n");
  write(dir, "b.txt", "b\n");
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

const reviewFile = (dir: string) => join(dir, ".git", REVIEW_FILE);
const ref = (dir: string, name: string): string | null => {
  try {
    return sh(dir, "rev-parse", "--verify", "--quiet", name).trim() || null;
  } catch {
    return null;
  }
};
async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Day 1: Claude edits a.txt (an attributed Edit); the review is left as `then` leaves it and the app quits. */
async function dayOne(dir: string, then: (h: Harness) => Promise<void>): Promise<void> {
  const h = harness();
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "edit a" });
  write(dir, "a.txt", "a by claude\n");
  h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "a.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] }] });
  await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");
  await then(h);
  await h.engine.dispose();
}

/** Two weeks of work in a terminal: new files, an IntelliJ edit and a commit. */
function outsideWork(dir: string): void {
  for (let i = 1; i <= 3; i++) write(dir, `feature-${i}.txt`, `terminal work ${i}\n`);
  write(dir, "b.txt", "b edited in IntelliJ\n");
  sh(dir, "add", "feature-1.txt", "b.txt");
  sh(dir, "commit", "-qm", "terminal session commit");
}

describe("a review restored after work outside the app (daily-01, §31)", () => {
  it("an accepted-only review is cleaned up on shutdown like close_project: nothing comes back", async () => {
    const dir = track(makeRepo());
    await dayOne(dir, async (h) => {
      await h.engine.handle({ type: "accept_all" });
    });
    expect(existsSync(reviewFile(dir))).toBe(false);
    expect(ref(dir, turnRefs("main").start)).toBeNull();
    outsideWork(dir);
    const b = harness();
    await b.hello();
    const s = await b.open(dir);
    expect(s.gate.restored).toBe(false);
    expect(s.changedFiles).toEqual([]);
    expect(s.gate.phase).toBe("idle");
  });

  it("commits made while the app was closed are carried into A: only what is still uncommitted stays, no stale flag", async () => {
    const dir = track(makeRepo());
    await dayOne(dir, async () => {});
    outsideWork(dir);
    const b = harness();
    await b.hello();
    const s = await b.open(dir);
    expect(s.changedFiles.map((f) => [f.path, f.origin])).toEqual([
      ["a.txt", "tool"],
      ["feature-2.txt", "external"],
      ["feature-3.txt", "external"],
    ]);
    expect(s.gate.stale).toBeNull();
  });

  it("§46: a merge left unfinished while the app was closed — its incoming side is carried into A once, also over another restart", async () => {
    const dir = track(makeRepo());
    await dayOne(dir, async () => {});
    sh(dir, "checkout", "-q", "-b", "develop");
    write(dir, "b.txt", "b on develop\n");
    write(dir, "dev.txt", "new on develop\n");
    sh(dir, "add", "b.txt", "dev.txt"); // Claude's a.txt stays uncommitted
    sh(dir, "commit", "-qm", "develop work");
    sh(dir, "checkout", "-q", "main");
    sh(dir, "merge", "-q", "--no-ff", "--no-commit", "develop"); // MERGE_HEAD, nothing committed
    for (let i = 0; i < 2; i++) {
      const b = harness();
      await b.hello();
      const s = await b.open(dir);
      expect(s.changedFiles.map((f) => [f.path, f.origin])).toEqual([["a.txt", "tool"]]);
      expect(s.gate.stale).toBeNull();
      await b.engine.dispose();
    }
    expect(JSON.parse(readFileSync(reviewFile(dir), "utf8")).baseMerge).toBe(sh(dir, "rev-parse", "develop").trim());
  });

  it("(a review saved before baseHead) new changes are external (reject_all leaves them), HEAD moved → gate.stale; finish_review empties the list without touching disk", async () => {
    const dir = track(makeRepo());
    const before = sh(dir, "rev-parse", "HEAD").trim();
    await dayOne(dir, async () => {});
    const saved = JSON.parse(readFileSync(reviewFile(dir), "utf8"));
    delete saved.baseHead;
    writeFileSync(reviewFile(dir), JSON.stringify(saved));
    outsideWork(dir);
    const after = sh(dir, "rev-parse", "HEAD").trim();

    const b = harness();
    await b.hello();
    const s = await b.open(dir);
    expect(s.gate.restored).toBe(true);
    expect(s.changedFiles.map((f) => [f.path, f.state, f.origin])).toEqual([
      ["a.txt", "pending", "tool"],
      ["b.txt", "pending", "external"],
      ["feature-1.txt", "pending", "external"],
      ["feature-2.txt", "pending", "external"],
      ["feature-3.txt", "pending", "external"],
    ]);
    expect(s.gate.externalPendingCount).toBe(4);
    expect(s.gate.stale).toEqual({
      reasons: ["head_moved"],
      savedAt: expect.any(String),
      savedHead: { sha: before, branch: "main" },
      head: { sha: after, branch: "main" },
      externalFiles: 4,
    });

    // "Reject all" never touches the terminal's work.
    await b.engine.request({ type: "reject_all" });
    expect(read(dir, "a.txt")).toBe("a\n");
    expect(read(dir, "b.txt")).toBe("b edited in IntelliJ\n");
    expect(b.engine.state.changedFiles.map((f) => f.path)).toEqual(["b.txt", "feature-1.txt", "feature-2.txt", "feature-3.txt"]);

    // "정리": the list goes, the disk stays.
    await b.engine.request({ type: "finish_review" });
    const done = b.engine.state;
    expect(done.changedFiles).toEqual([]);
    expect(done.gate.phase).toBe("idle");
    expect(done.gate.stale).toBeNull();
    expect(done.gate.restored).toBe(false);
    expect(done.gate.turnStartTree).toBeNull();
    // A stale review's verdicts belong to an old conversation: nothing prefixes the next message.
    expect(done.gate.lastReviewSummary).toBeNull();
    expect(read(dir, "feature-2.txt")).toBe("terminal work 2\n");
    expect(read(dir, "b.txt")).toBe("b edited in IntelliJ\n");
    await until(() => !existsSync(reviewFile(dir)) && ref(dir, turnRefs("main").start) === null, "review file + refs removed");
    // The round is history, its unreviewed files `pending`, closed by finish_review.
    const history = await b.engine.request({ type: "review_history", all: true });
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]!.finished).toBe(true);
    expect(history.entries[0]!.files.map((f) => [f.path, f.verdict])).toEqual([
      ["a.txt", "rejected"],
      ["b.txt", "pending"],
      ["feature-1.txt", "pending"],
      ["feature-2.txt", "pending"],
      ["feature-3.txt", "pending"],
    ]);
    // The next turn starts from a fresh A: the left-over files are its baseline, not a review.
    await b.engine.handle({ type: "send", text: "next" });
    b.session().emitTurnEnd();
    await b.waitFor((x) => x.gate.turnEndTree !== null && x.gate.phase !== "collecting", "collected");
    expect(b.engine.state.changedFiles).toEqual([]);
  });

  it("an old review (≥ 12 h) is stale even on the same HEAD; keep_review dismisses the flag and keeps the review", async () => {
    const dir = track(makeRepo());
    await dayOne(dir, async () => {});
    const o = JSON.parse(readFileSync(reviewFile(dir), "utf8")) as Record<string, unknown>;
    expect(o.head).toEqual({ sha: sh(dir, "rev-parse", "HEAD").trim(), branch: "main" });
    o.savedAt = new Date(NOW - STALE_REVIEW_MS - 60_000).toISOString();
    writeFileSync(reviewFile(dir), JSON.stringify(o));

    const b = harness();
    await b.hello();
    const s = await b.open(dir);
    expect(s.gate.stale).toMatchObject({ reasons: ["old"], externalFiles: 0 });
    await b.engine.request({ type: "keep_review" });
    expect(b.engine.state.gate.stale).toBeNull();
    expect(b.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["a.txt", "pending"]]);
  });

  it("finish_review keeps a fresh review's verdicts for the next message; refused while a turn runs or a collection failed", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.request({ type: "finish_review" }); // nothing under review: a no-op
    await h.engine.handle({ type: "send", text: "edit" });
    await expect(h.engine.request({ type: "finish_review" })).rejects.toThrow("session_running");
    write(dir, "a.txt", "a by claude\n");
    write(dir, "b.txt", "b by claude\n");
    h.session().emitTurnEnd({ toolFiles: ["a.txt", "b.txt"].map((f, i) => ({ path: join(dir, f), tools: ["Edit"], count: 1, toolUseIds: [`e${i}`] })) });
    await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");
    await h.engine.request({ type: "accept", paths: ["a.txt"] });
    await h.engine.request({ type: "add_note", path: "b.txt", line: 1, side: "new", excerpt: "b by claude", body: "hm" });
    await h.engine.request({ type: "finish_review" });
    const s = h.engine.state;
    expect(s.changedFiles).toEqual([]);
    expect(s.reviewNotes).toEqual([]);
    expect(read(dir, "b.txt")).toBe("b by claude\n");
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Accepted: a.txt.");

    // A failed collection belongs to the turn: retry it first.
    await h.engine.handle({ type: "send", text: "more" });
    write(dir, "a.txt", "again\n");
    // Windows: the send's own git work (its pins, the persisted review) may still hold .git for a moment.
    await renameWhenFree(join(dir, ".git"), join(dir, ".git-hidden"));
    h.session().emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "collect_failed", "collect failure");
    await expect(h.engine.request({ type: "finish_review" })).rejects.toThrow("collect_failed");
    await renameWhenFree(join(dir, ".git-hidden"), join(dir, ".git"));
  });
});
