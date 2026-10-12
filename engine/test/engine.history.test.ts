import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewHistoryEntry } from "../src/protocol.js";
import { appendCapped, HISTORY_CAP, HISTORY_FILE, historyView } from "../src/review/history.js";
import { REF_TURN_END, REF_TURN_START, REVIEW_FILE, refNamespace, staleWorktreeNamespaces, turnRefs } from "../src/review/persist.js";
import { makeHarness, type FakeClaudeSession, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-history"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  write(dir, "b.txt", "bee\n");
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

function ref(dir: string, name: string): string | null {
  try {
    return sh(dir, "rev-parse", "--verify", "--quiet", name).trim() || null;
  } catch {
    return null;
  }
}

function refs(dir: string, prefix = "refs/reviewgate/"): string[] {
  return sh(dir, "for-each-ref", "--format=%(refname)", prefix).split("\n").filter(Boolean);
}

async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function turn(h: Harness, text: string, mutate: () => void, opts: Parameters<FakeClaudeSession["emitTurnEnd"]>[0] = {}): Promise<void> {
  await h.engine.handle({ type: "send", text });
  mutate();
  h.session().emitTurnEnd(opts);
  await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting" && s.gate.phase !== "running", "turn collection");
  await h.settle();
}

async function history(h: Harness, all = false): Promise<ReviewHistoryEntry[]> {
  const ev = await h.engine.request({ type: "review_history", ...(all ? { all: true } : {}) });
  return ev.entries;
}

describe("review history (§14)", () => {
  it("a round with accept + reject is recorded when the next fresh send starts; past diffs stay viewable", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, "change both files", () => {
      write(dir, "README.md", "line1\nCHANGED\nline3\n");
      write(dir, "b.txt", "bee\nmore\n");
    }, { toolFiles: [{ path: join(dir, "README.md"), tools: ["Edit"], count: 1, toolUseIds: ["tu-1"] }] });
    expect(await history(h)).toEqual([]);
    await h.engine.handle({ type: "accept", paths: ["README.md"] });
    await h.engine.request({ type: "reject", paths: ["b.txt"] });
    expect(read(dir, "b.txt")).toBe("bee\n");
    // The accepted file still awaits a commit: the round is open until the next fresh send.
    expect(await history(h)).toEqual([]);

    await turn(h, "next thing", () => write(dir, "c.txt", "new\n"));
    const entries = await history(h);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.prompt).toBe("change both files");
    expect(e.turns).toEqual([1]);
    expect(e.sessionId).toBe("sess-1");
    expect(Date.parse(e.endedAt)).toBeGreaterThanOrEqual(Date.parse(e.startedAt));
    expect(e.files.map((f) => [f.path, f.verdict, f.adds, f.dels, f.status])).toEqual([
      ["README.md", "accepted", 1, 1, "M"],
      ["b.txt", "rejected", 1, 0, "M"],
    ]);
    expect(e.files[0]!.toolUseIds).toEqual(["tu-1"]);
    // The trees are pinned per entry (a rejected file's proposal under end-1).
    await waitUntil(() => refs(dir, `refs/reviewgate/main/history/${e.id}/`).length >= 2, "history refs");
    expect(ref(dir, `refs/reviewgate/main/history/${e.id}/start`)).toBe(e.turnStartTree);
    expect(ref(dir, `refs/reviewgate/main/history/${e.id}/end`)).toBe(e.turnEndTree);
    const rejected = e.files.find((f) => f.path === "b.txt")!;
    expect(rejected.endTree).toBeDefined();
    expect(ref(dir, `refs/reviewgate/main/history/${e.id}/end-1`)).toBe(rejected.endTree!);

    const d = await h.engine.request({ type: "history_diff", entryId: e.id, path: "b.txt" });
    expect(d.type).toBe("history_diff");
    expect(d.diff.hunks.flatMap((x) => x.lines).filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["more"]);
    const d2 = await h.engine.request({ type: "history_diff", entryId: e.id, path: "README.md" });
    expect(d2.diff.hunks.flatMap((x) => x.lines).filter((l) => l.kind !== "context" && l.kind !== "hunkHeader").map((l) => `${l.kind}:${l.text}`)).toEqual(["del:line2", "add:CHANGED"]);
    await expect(h.engine.request({ type: "history_diff", entryId: "nope", path: "b.txt" })).rejects.toThrow("unknown_history_entry:nope");
    await expect(h.engine.request({ type: "history_diff", entryId: e.id, path: "zzz" })).rejects.toThrow("not_in_history_entry:zzz");

    // Persisted: a new engine reads the same history.
    await waitUntil(() => existsSync(join(dir, ".git", HISTORY_FILE)), "history file");
    const file = JSON.parse(readFileSync(join(dir, ".git", HISTORY_FILE), "utf8")) as { version: number; entries: ReviewHistoryEntry[] };
    expect(file.version).toBe(1);
    expect(file.entries.map((x) => x.id)).toEqual([e.id]);
  });

  it("request_changes rounds carry the notes and a changes-requested count; commit of the rest resolves the round", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, "edit readme", () => write(dir, "README.md", "line1\nv1\nline3\n"));
    await h.engine.handle({ type: "add_note", path: "README.md", line: 2, side: "new", excerpt: "v1", body: "use v2" });
    await h.engine.handle({ type: "request_changes" });
    write(dir, "README.md", "line1\nv2\nline3\n");
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "follow-up collected");
    await h.engine.handle({ type: "accept", paths: ["README.md"] });
    await h.engine.request({ type: "commit", message: "readme" });
    await h.waitFor((s) => s.changedFiles.length === 0, "committed");
    await waitUntil(() => existsSync(join(dir, ".git", HISTORY_FILE)), "history file");
    const [e] = await history(h);
    expect(e!.turns).toEqual([1, 2]);
    expect(e!.notes).toEqual([{ path: "README.md", line: 2, side: "new", body: "use v2" }]);
    expect(e!.files).toHaveLength(1);
    expect(e!.files[0]).toMatchObject({ path: "README.md", verdict: "accepted", changesRequested: 1, committed: true });
    // The diff shows the final (committed) proposal against the original A.
    const d = await h.engine.request({ type: "history_diff", entryId: e!.id, path: "README.md" });
    expect(d.diff.hunks.flatMap((x) => x.lines).filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["v2"]);
  });

  it("a partially reverted file pins its whole proposal: history_diff shows it, final: true what was kept", async () => {
    const dir = track(makeRepo());
    const base = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
    write(dir, "long.txt", base.join("\n") + "\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "long");
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, "two edits", () => write(dir, "long.txt", base.map((l, i) => (i === 1 ? "TWO" : i === 25 ? "TWENTY-SIX" : l)).join("\n") + "\n"));
    const proposal = h.engine.state.gate.turnEndTree!;
    await h.engine.request({ type: "reject_hunks", path: "long.txt", hunks: [0] });
    expect(h.engine.state.changedFiles[0]).toMatchObject({ partial: true, rejectedHunks: 1 });
    await h.engine.handle({ type: "accept", paths: ["long.txt"] });
    await turn(h, "next", () => write(dir, "c.txt", "new\n"));
    const [e] = await history(h);
    const f = e!.files.find((x) => x.path === "long.txt")!;
    expect(f).toMatchObject({ verdict: "accepted", rejectedHunks: 1, adds: 1, dels: 1, endTree: proposal });
    expect(f.endTree).not.toBe(e!.turnEndTree);
    await waitUntil(() => ref(dir, `refs/reviewgate/main/history/${e!.id}/end-1`) === proposal, "proposal pinned");
    const adds = (d: { diff: { hunks: { lines: { kind: string; text: string }[] }[] } }) => d.diff.hunks.flatMap((x) => x.lines).filter((l) => l.kind === "add").map((l) => l.text);
    const whole = await h.engine.request({ type: "history_diff", entryId: e!.id, path: "long.txt" });
    expect(adds(whole)).toEqual(["TWO", "TWENTY-SIX"]);
    expect(whole).not.toHaveProperty("final");
    const kept = await h.engine.request({ type: "history_diff", entryId: e!.id, path: "long.txt", final: true });
    expect(adds(kept)).toEqual(["TWENTY-SIX"]);
    expect(kept.final).toBe(true);
  });

  it("a partial revert followed by a whole reject keeps the original proposal as endTree", async () => {
    const dir = track(makeRepo());
    const base = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
    write(dir, "long.txt", base.join("\n") + "\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "long");
    const h = harness();
    await h.hello();
    await h.open(dir);
    await turn(h, "two edits", () => write(dir, "long.txt", base.map((l, i) => (i === 1 ? "TWO" : i === 25 ? "TWENTY-SIX" : l)).join("\n") + "\n"));
    const proposal = h.engine.state.gate.turnEndTree!;
    await h.engine.request({ type: "reject_hunks", path: "long.txt", hunks: [1] });
    await h.engine.request({ type: "reject", paths: ["long.txt"] });
    await h.waitFor((s) => s.gate.phase === "idle", "resolved");
    await waitUntil(() => existsSync(join(dir, ".git", HISTORY_FILE)), "history file");
    const [e] = await history(h);
    expect(e!.files[0]).toMatchObject({ path: "long.txt", verdict: "rejected", rejectedHunks: 1, endTree: proposal });
    const d = await h.engine.request({ type: "history_diff", entryId: e!.id, path: "long.txt" });
    expect(d.diff.hunks.flatMap((x) => x.lines).filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["TWO", "TWENTY-SIX"]);
  });

  it("the round survives an engine restart (persisted with the review file)", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    await turn(a, "first prompt", () => write(dir, "README.md", "x\n"));
    await a.engine.handle({ type: "add_note", path: "README.md", line: 1, side: "new", excerpt: "x", body: "hm" });
    await a.settle();
    await waitUntil(() => {
      try {
        return (JSON.parse(readFileSync(join(dir, ".git", REVIEW_FILE), "utf8")) as { round?: { prompt: string } }).round?.prompt === "first prompt";
      } catch {
        return false;
      }
    }, "round persisted");
    await a.engine.dispose();

    const b = harness();
    await b.hello();
    await b.open(dir);
    expect(b.engine.state.gate.restored).toBe(true);
    await b.engine.handle({ type: "remove_note", noteId: b.engine.state.reviewNotes[0]!.id });
    await b.engine.request({ type: "reject", paths: ["README.md"] });
    await b.waitFor((s) => s.gate.phase === "idle", "resolved");
    await waitUntil(() => existsSync(join(dir, ".git", HISTORY_FILE)), "history file");
    const [e] = await history(b, true);
    expect(e).toMatchObject({ prompt: "first prompt", turns: [1] });
    expect(e!.files.map((f) => [f.path, f.verdict])).toEqual([["README.md", "rejected"]]);
  });

  it("review_history filters by session; orphaned history refs are pruned on open", async () => {
    const dir = track(makeRepo());
    // An orphan left by a crashed engine: pruned at the next open.
    const tree = sh(dir, "rev-parse", "HEAD^{tree}").trim();
    sh(dir, "update-ref", "refs/reviewgate/main/history/orphan-1/start", tree);
    const h = harness();
    await h.hello();
    await h.open(dir);
    await waitUntil(() => refs(dir, "refs/reviewgate/main/history/").length === 0, "orphan pruned");
    await turn(h, "one", () => write(dir, "b.txt", "1\n"));
    await h.engine.request({ type: "reject", paths: ["b.txt"] });
    await waitUntil(() => existsSync(join(dir, ".git", HISTORY_FILE)), "history file");
    expect(await history(h)).toHaveLength(1);
    expect((await h.engine.request({ type: "review_history", sessionId: "other" })).entries).toEqual([]);
    expect((await history(h, true)).map((e) => e.sessionId)).toEqual(["sess-1"]);
  });

  it("refs are namespaced per worktree; the shared pre-namespace refs are migrated on restore", async () => {
    const dir = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(dir);
    await turn(a, "edit", () => write(dir, "README.md", "y\n"));
    const s = a.engine.state;
    await waitUntil(() => ref(dir, turnRefs("main").end) === s.gate.turnEndTree, "namespaced refs");
    expect(ref(dir, turnRefs("main").start)).toBe(s.gate.turnStartTree);
    await a.engine.dispose();
    // Simulate an engine from before the namespace: only the shared refs pin the review.
    sh(dir, "update-ref", REF_TURN_START, s.gate.turnStartTree!);
    sh(dir, "update-ref", REF_TURN_END, s.gate.turnEndTree!);
    sh(dir, "update-ref", "-d", turnRefs("main").start);
    sh(dir, "update-ref", "-d", turnRefs("main").end);
    const b = harness();
    await b.hello();
    await b.open(dir);
    expect(b.engine.state.gate.restored).toBe(true);
    await waitUntil(() => ref(dir, REF_TURN_START) === null, "legacy refs dropped");
    expect(ref(dir, turnRefs("main").start)).toBe(s.gate.turnStartTree);

    // A linked worktree gets its own namespace.
    const wt = track(realpathSync(makeTempDir("rg-history-wt")));
    removeDir(wt);
    sh(dir, "worktree", "add", "-q", "-b", "side", wt);
    const c = harness();
    await c.hello();
    await c.open(wt);
    await turn(c, "side edit", () => write(wt, "b.txt", "side\n"));
    const name = basename(wt);
    await waitUntil(() => ref(dir, turnRefs(`wt-${name}`).end) === c.engine.state.gate.turnEndTree, "worktree refs");
    expect(ref(dir, turnRefs(`wt-${name}`).start)).toBe(c.engine.state.gate.turnStartTree);
    // The main worktree's pins are untouched.
    expect(ref(dir, turnRefs("main").start)).toBe(s.gate.turnStartTree);
  });
});

describe("worktree ref namespaces (§14)", () => {
  it("two worktrees reviewing concurrently keep their pins apart; workbench_remove and a later open drop a gone worktree's namespace", async () => {
    const dir = track(makeRepo());
    const wt1 = track(realpathSync(makeTempDir("rg-ns-one")));
    const wt2 = track(realpathSync(makeTempDir("rg-ns-two")));
    removeDir(wt1);
    removeDir(wt2);
    sh(dir, "worktree", "add", "-q", "-b", "one", wt1);
    sh(dir, "worktree", "add", "-q", "-b", "two", wt2);
    const [n1, n2] = [`wt-${basename(wt1)}`, `wt-${basename(wt2)}`];
    const [a, b, c] = [harness(), harness(), harness()];
    for (const h of [a, b, c]) await h.hello();
    await Promise.all([a.open(dir), b.open(wt1), c.open(wt2)]);
    // All three turns run at the same time.
    const roots = [dir, wt1, wt2];
    const hs = [a, b, c];
    await Promise.all(hs.map((h) => h.engine.handle({ type: "send", text: "edit b" })));
    roots.forEach((r, i) => write(r, "b.txt", `bee ${i}\n`));
    hs.forEach((h) => h.session().emitTurnEnd());
    await Promise.all(hs.map((h) => h.waitFor((s) => s.gate.phase === "reviewing" && s.gate.turnEndTree !== null, "reviewing")));
    const ends = hs.map((h) => h.engine.state.gate.turnEndTree!);
    expect(new Set(ends).size).toBe(3);
    await waitUntil(() => [["main", ends[0]], [n1, ends[1]], [n2, ends[2]]].every(([ns, end]) => ref(dir, turnRefs(ns!).end) === end), "three namespaces pinned");
    await Promise.all(hs.map((h) => h.engine.request({ type: "reject", paths: ["b.txt"] })));
    await Promise.all(hs.map((h) => h.waitFor((s) => s.gate.phase === "idle", "resolved")));
    for (const h of hs) await h.settle();
    const entries = await Promise.all(hs.map(async (h) => (await history(h))[0]!));
    for (const [i, ns] of ["main", n1, n2].entries()) {
      await waitUntil(() => ref(dir, `refs/reviewgate/${ns}/history/${entries[i]!.id}/start`) !== null, `history pinned in ${ns}`);
      const d = await hs[i]!.engine.request({ type: "history_diff", entryId: entries[i]!.id, path: "b.txt" });
      expect(d.diff.hunks.flatMap((x) => x.lines).filter((l) => l.kind === "add").map((l) => l.text)).toEqual([`bee ${i}`]);
      // Each worktree's history lists only its own round.
      expect((await history(hs[i]!, true)).map((e) => e.id)).toEqual([entries[i]!.id]);
    }
    expect(refs(dir, `refs/reviewgate/${n1}/`).some((r) => r.includes(entries[2]!.id))).toBe(false);

    // workbench_remove drops the removed worktree's whole namespace, nobody else's.
    await c.engine.dispose();
    await a.engine.request({ type: "workbench_remove", path: wt2, force: true });
    expect(refs(dir, `refs/reviewgate/${n2}/`)).toEqual([]);
    expect(refs(dir, `refs/reviewgate/${n1}/`).length).toBeGreaterThan(0);
    expect(refs(dir, "refs/reviewgate/main/").length).toBeGreaterThan(0);

    // A worktree deleted outside the app: the next open of the main worktree prunes its namespace.
    await b.engine.dispose();
    await a.engine.dispose();
    removeDir(wt1);
    sh(dir, "worktree", "prune");
    const d = harness();
    await d.hello();
    await d.open(dir);
    await waitUntil(() => refs(dir, `refs/reviewgate/${n1}/`).length === 0, "gone worktree pruned");
    expect(refs(dir, `refs/reviewgate/main/history/${entries[0]!.id}/`).length).toBeGreaterThan(0);
  });

  it("staleWorktreeNamespaces: only wt-* namespaces without an admin dir", () => {
    const refs = ["refs/reviewgate/main/turn-start", "refs/reviewgate/turn-start", "refs/reviewgate/wt-a/turn-end", "refs/reviewgate/wt-b/history/x/start", "refs/reviewgate/wt-b/turn-end", "refs/reviewgate/wt-c_d/turn-end"];
    expect(staleWorktreeNamespaces(refs, ["a", "c d"], "/r/.git")).toEqual(["wt-b"]);
    expect(staleWorktreeNamespaces(refs, [], "/r/.git")).toEqual(["wt-a", "wt-b", "wt-c_d"]);
  });

  it("history cap: dropping the oldest of 50 entries deletes its pinned refs", async () => {
    const dir = track(makeRepo());
    const tree = sh(dir, "rev-parse", "HEAD^{tree}").trim();
    const seeded: ReviewHistoryEntry[] = Array.from({ length: HISTORY_CAP }, (_, i) => ({
      id: `seed-${String(i).padStart(2, "0")}`, sessionId: "sess-1", turns: [i], startedAt: "", endedAt: "", prompt: `p${i}`,
      files: [{ path: "b.txt", oldPath: null, status: "M", verdict: "rejected", adds: 1, dels: 0, toolUseIds: [], endTree: tree }],
      notes: [], turnStartTree: tree, turnEndTree: tree,
    }));
    mkdirSync(join(dir, ".git", "reviewgate"), { recursive: true });
    writeFileSync(join(dir, ".git", HISTORY_FILE), JSON.stringify({ version: 1, entries: seeded }));
    for (const e of seeded) for (const r of ["start", "end"]) sh(dir, "update-ref", `refs/reviewgate/main/history/${e.id}/${r}`, tree);
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.settle();
    // Every seeded entry is in the history: nothing pruned on open.
    expect(refs(dir, "refs/reviewgate/main/history/seed-00/")).toHaveLength(2);
    await turn(h, "one more", () => write(dir, "b.txt", "x\n"));
    await h.engine.request({ type: "reject", paths: ["b.txt"] });
    await h.waitFor((s) => s.gate.phase === "idle", "resolved");
    await waitUntil(() => refs(dir, "refs/reviewgate/main/history/seed-00/").length === 0, "evicted entry's refs deleted");
    const all = await history(h, true);
    expect(all).toHaveLength(HISTORY_CAP);
    expect(all.map((e) => e.id)).not.toContain("seed-00");
    expect(all[all.length - 1]!.id).toBe("seed-01");
    expect(refs(dir, "refs/reviewgate/main/history/seed-01/")).toHaveLength(2);
    await waitUntil(() => refs(dir, `refs/reviewgate/main/history/${all[0]!.id}/`).length >= 2, "new entry pinned");
    const file = JSON.parse(readFileSync(join(dir, ".git", HISTORY_FILE), "utf8")) as { entries: ReviewHistoryEntry[] };
    expect(file.entries).toHaveLength(HISTORY_CAP);
  });
});

describe("history helpers", () => {
  const entry = (id: string, sessionId: string | null = "s"): ReviewHistoryEntry => ({
    id, sessionId, turns: [1], startedAt: "", endedAt: "", prompt: "", files: [], notes: [], turnStartTree: "a", turnEndTree: "b",
  });

  it("appendCapped keeps the newest entries and reports the dropped ones", () => {
    let list: ReviewHistoryEntry[] = [];
    const dropped: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = appendCapped(list, entry(`e${i}`), 3);
      list = r.entries;
      dropped.push(...r.dropped.map((d) => d.id));
    }
    expect(list.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
    expect(dropped).toEqual(["e0", "e1"]);
    // Same id replaces.
    expect(appendCapped(list, entry("e3"), 3).entries.map((e) => e.id)).toEqual(["e2", "e4", "e3"]);
  });

  it("historyView is newest first and filters by session", () => {
    const list = [entry("a", "s1"), entry("b", "s2"), entry("c", "s1")];
    expect(historyView(list, undefined).map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(historyView(list, "s1").map((e) => e.id)).toEqual(["c", "a"]);
    expect(historyView(list, null).map((e) => e.id)).toEqual([]);
  });

  it("refNamespace: main for the common dir, wt-<name> for a linked worktree", () => {
    expect(refNamespace("/r/.git", "/r/.git")).toBe("main");
    expect(refNamespace("/r/.git/", "/r/.git")).toBe("main");
    expect(refNamespace("/r/.git/worktrees/feat-x", "/r/.git")).toBe("wt-feat-x");
    expect(refNamespace("/r/.git/worktrees/a b", "/r/.git")).toBe("wt-a_b");
    expect(refNamespace("C:\\r\\.git\\worktrees\\w1", "C:/r/.git")).toBe("wt-w1");
  });
});
