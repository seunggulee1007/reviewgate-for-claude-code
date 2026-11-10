import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/diff/parse.js";
import { CommandRefused } from "../src/errors.js";
import { openCheckpoint } from "../src/git/checkpoint.js";
import type { ReviewNote } from "../src/review/notes.js";
import { carryNote, parsePersistedRanges, sinceOf, syncRangePins, treeEntryIds } from "../src/review/ranges.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §34.1 / §34.4 / §34.5 helpers: `since` parsing, tree entry ids, notes carried to a new B, range pins. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function note(line: number | null, excerpt: string, extra: Partial<ReviewNote> = {}): ReviewNote {
  return { id: "n", path: "Svc.java", line, side: "new", excerpt, body: "b", ...extra };
}

/** The old → new patch of one file, as `git diff-tree -p` prints it. */
function patch(...hunks: string[]): ReturnType<typeof parseUnifiedDiff> {
  return parseUnifiedDiff(["diff --git a/Svc.java b/Svc.java", "--- a/Svc.java", "+++ b/Svc.java", ...hunks].join("\n") + "\n");
}

describe("sinceOf (§34.1)", () => {
  it("absent / null is review; the four ranges pass; anything else is invalid_since", () => {
    expect(sinceOf(undefined)).toBe("review");
    expect(sinceOf(null)).toBe("review");
    for (const s of ["review", "turn", "request", "accepted"] as const) expect(sinceOf(s)).toBe(s);
    for (const bad of ["last_turn", "", 3, {}]) {
      let thrown: unknown;
      try {
        sinceOf(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(CommandRefused);
      expect((thrown as CommandRefused).code).toBe("invalid_since");
    }
  });
});

describe("carryNote (§34.4 anchors)", () => {
  // Old B: lines "l1".."l16"; the new B inserts two lines after l2 and rewrites l11.
  const diff = patch(
    "@@ -1,5 +1,7 @@",
    " l1",
    " l2",
    "+new a",
    "+new b",
    " l3",
    " l4",
    " l5",
    "@@ -8,7 +10,7 @@",
    " l8",
    " l9",
    " l10",
    "-l11",
    "+l11 rewritten",
    " l12",
    " l13",
    " l14",
  );

  it("a line before every change keeps its number and no anchor", () => {
    expect(carryNote(note(1, "l1"), diff)).toEqual(note(1, "l1"));
  });

  it("a context line inside a hunk moves to its new number", () => {
    expect(carryNote(note(4, "l4"), diff)).toEqual(note(6, "l4", { anchor: "moved" }));
    expect(carryNote(note(12, "l12"), diff)).toEqual(note(14, "l12", { anchor: "moved" }));
  });

  it("a line between or after the hunks shifts by every hunk before it", () => {
    expect(carryNote(note(7, "l7"), diff)).toEqual(note(9, "l7", { anchor: "moved" }));
    expect(carryNote(note(16, "l16"), diff)).toEqual(note(18, "l16", { anchor: "moved" }));
  });

  it("a rewritten line without a same-text line in its block is gone (the number stays)", () => {
    expect(carryNote(note(11, "l11"), diff)).toEqual(note(11, "l11", { anchor: "gone" }));
  });

  it("a line inside a changed block keeps a place on the nearest new line of that block with the same trimmed text", () => {
    const same = patch("@@ -3,3 +3,4 @@", "-  int a = 1;", "-  int b = 2;", "+  int a = 10;", "+int b = 2;  ", "+  int c = 3;", " }");
    expect(carryNote(note(4, "  int b = 2;"), same)).toEqual(note(4, "  int b = 2;"));
    const shifted = patch("@@ -3,3 +3,4 @@", "-x", "-  y", "+z", "+w", "+  y  ", " end");
    expect(carryNote(note(4, "y"), shifted)).toEqual(note(5, "y", { anchor: "moved" }));
    // Two candidates: the one nearest the note's place in the block wins.
    const twice = patch("@@ -1,3 +1,3 @@", "-y", "-x", "-y", "+y", "+q", "+y");
    expect(carryNote(note(3, "y"), twice)).toEqual(note(3, "y"));
    expect(carryNote(note(1, "y"), twice)).toEqual(note(1, "y"));
  });

  it("a note without an excerpt inside a changed block is gone", () => {
    expect(carryNote(note(11, "   "), diff)).toEqual(note(11, "   ", { anchor: "gone" }));
  });

  it("old-side, file-level and already-gone notes never move; an empty diff changes nothing", () => {
    const old = note(4, "l4", { side: "old" });
    expect(carryNote(old, diff)).toBe(old);
    const fileLevel = note(null, "");
    expect(carryNote(fileLevel, diff)).toBe(fileLevel);
    const gone = note(4, "l4", { anchor: "gone" });
    expect(carryNote(gone, diff)).toBe(gone);
    const n = note(4, "l4");
    expect(carryNote(n, parseUnifiedDiff(""))).toBe(n);
  });

  it("a moved note stays moved even when a later carry leaves its number alone", () => {
    const n = note(6, "l4", { anchor: "moved" });
    expect(carryNote(n, patch("@@ -20,1 +20,1 @@", "-x", "+y"))).toBe(n);
  });

  it("a deleted file takes every new-side note's place", () => {
    const deleted = patch("@@ -1,2 +0,0 @@", "-l1", "-l2");
    expect(carryNote(note(2, "l2"), deleted)).toEqual(note(2, "l2", { anchor: "gone" }));
  });
});

describe("tree entries and range pins (git)", () => {
  /** `*` and `:` cannot be in a Windows file name: the pathspec-magic file exists elsewhere only. */
  const posix = process.platform !== "win32";

  function repo(): string {
    const dir = realpathSync(makeTempDir("rg-ranges"));
    dirs.push(dir);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "test@example.com");
    sh(dir, "config", "user.name", "Test");
    write(dir, "a.txt", "a\n");
    write(dir, "dir/b[x].txt", "glob name\n"); // as a glob it would match dir/bx.txt
    write(dir, "dir/bx.txt", "other\n");
    if (posix) write(dir, ":magic.txt", "colon\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "init");
    return dir;
  }

  it("treeEntryIds: the ids of exactly the named paths (globs / pathspec magic are literal), absent ones missing", async () => {
    const dir = repo();
    const cp = await openCheckpoint(dir);
    const tree = sh(dir, "rev-parse", "HEAD^{tree}").trim();
    const ids = await treeEntryIds(cp, tree, ["a.txt", "dir/b[x].txt", ...(posix ? [":magic.txt"] : []), "nope.txt", "dir"]);
    expect([...ids.keys()].sort()).toEqual([...(posix ? [":magic.txt"] : []), "a.txt", "dir/b[x].txt"]);
    expect(ids.get("a.txt")).toBe(sh(dir, "rev-parse", "HEAD:a.txt").trim());
    expect(ids.get("dir/b[x].txt")).toBe(sh(dir, "rev-parse", "HEAD:dir/b[x].txt").trim());
    expect((await treeEntryIds(cp, tree, [])).size).toBe(0);
  });

  it("syncRangePins pins exactly the given trees under refs/reviewgate/<ns>/range/ and drops the others", async () => {
    const dir = repo();
    const cp = await openCheckpoint(dir);
    const t1 = sh(dir, "rev-parse", "HEAD^{tree}").trim();
    write(dir, "a.txt", "a2\n");
    sh(dir, "add", "-A");
    const t2 = sh(dir, "write-tree").trim();
    const pins = () => sh(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/reviewgate/").split("\n").filter(Boolean).sort();
    await syncRangePins(cp, "main", [t1, t2]);
    expect(pins()).toEqual([`refs/reviewgate/main/range/${t1} ${t1}`, `refs/reviewgate/main/range/${t2} ${t2}`].sort());
    await syncRangePins(cp, "main", [t2]);
    expect(pins()).toEqual([`refs/reviewgate/main/range/${t2} ${t2}`]);
    await syncRangePins(cp, "main", []);
    expect(pins()).toEqual([]);
  });
});

describe("parsePersistedRanges (review file, §34.1)", () => {
  it("keeps well-formed fields and drops the rest; absent in older files", () => {
    expect(parsePersistedRanges(undefined)).toBeNull();
    expect(parsePersistedRanges("x")).toBeNull();
    expect(
      parsePersistedRanges({
        turnBaseTree: "t1",
        heldEndTree: 5,
        requestTree: "r1",
        lastRequest: { turn: 3, at: "2026-10-23T00:00:00.000Z", notes: 2 },
        lastTurnChanges: { turn: 3, files: 1, added: 2, deleted: "x" },
        acceptedTrees: { "a.txt": "t2", "b.txt": 7 },
      }),
    ).toEqual({
      turnBaseTree: "t1",
      heldEndTree: null,
      requestTree: "r1",
      lastRequest: { turn: 3, at: "2026-10-23T00:00:00.000Z", notes: 2 },
      lastTurnChanges: null,
      acceptedTrees: { "a.txt": "t2" },
    });
  });
});
