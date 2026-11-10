/** §53 the split sheet's pure logic: cards, moves, proposal / restore, the commit_series command, the button's reason, refusals. */
import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { allParts, buildSeries, initialSplit, partKey, seriesBlocker, seriesDoneText, seriesFailureText, splitReducer, splitRefusalText, type SplitState } from "./commitSplit";
import type { CommitFile } from "@reviewgate/engine";

const hunk = (id: number) => ({ id, header: `@@ -${id},1 +${id},2 @@`, added: 1, deleted: 0, text: "+x" });
const files: CommitFile[] = [
  { path: "a.ts", status: "M", binary: false, hunks: [hunk(0), hunk(1), hunk(2)] },
  { path: "b.md", status: "A", binary: false, hunks: [] },
  { path: "c.ts", status: "M", binary: false, hunks: [hunk(0)] },
];
const ids = (s: SplitState, card: number) => s.cards.find((c) => c.id === card)!.parts.map(partKey);

beforeAll(() => initI18n("ko", "win32"));

describe("§53 split state", () => {
  it("starts as one card with everything; a whole-only file is one part", () => {
    const s = initialSplit(files, "msg");
    expect(s.cards).toHaveLength(1);
    expect(ids(s, 1)).toEqual(["a.ts#0", "a.ts#1", "a.ts#2", "b.md#whole", "c.ts#0"]);
    expect(allParts(files)).toHaveLength(5);
    expect(s.unassigned).toEqual([]);
  });

  it("moves one hunk, a whole file, to a new card and to 커밋하지 않음 — and back", () => {
    let s = splitReducer(initialSplit(files), { type: "addCard" });
    s = splitReducer(s, { type: "move", files, from: 1, to: 2, path: "a.ts", hunk: 1 });
    expect(ids(s, 1)).toEqual(["a.ts#0", "a.ts#2", "b.md#whole", "c.ts#0"]);
    expect(ids(s, 2)).toEqual(["a.ts#1"]);
    s = splitReducer(s, { type: "move", files, from: 1, to: 2, path: "a.ts" }); // the file: every part in the card
    expect(ids(s, 2)).toEqual(["a.ts#0", "a.ts#1", "a.ts#2"]);
    s = splitReducer(s, { type: "move", files, from: 1, to: "none", path: "b.md" });
    expect(s.unassigned.map(partKey)).toEqual(["b.md#whole"]);
    s = splitReducer(s, { type: "move", files, from: "none", to: 1, path: "b.md", hunk: null });
    expect(s.unassigned).toEqual([]);
    expect(ids(s, 1)).toEqual(["b.md#whole", "c.ts#0"]);
    // nothing to move / same place / unknown card: unchanged
    expect(splitReducer(s, { type: "move", files, from: 1, to: 1, path: "c.ts" })).toBe(s);
    expect(splitReducer(s, { type: "move", files, from: 2, to: 1, path: "zzz" })).toBe(s);
    expect(splitReducer(s, { type: "move", files, from: 1, to: 99, path: "c.ts" })).toBe(s);
  });

  it("reorders cards (not past the ends) and deleting a card sends its parts to 커밋하지 않음", () => {
    let s = splitReducer(initialSplit(files), { type: "addCard" });
    s = splitReducer(s, { type: "reorder", card: 2, by: -1 });
    expect(s.cards.map((c) => c.id)).toEqual([2, 1]);
    expect(splitReducer(s, { type: "reorder", card: 2, by: -1 })).toBe(s);
    s = splitReducer(s, { type: "deleteCard", files, card: 1 });
    expect(s.cards.map((c) => c.id)).toEqual([2]);
    expect(s.unassigned).toHaveLength(5);
    expect(s.unassigned[0]).toEqual({ path: "a.ts", hunk: 0 });
  });

  it("applies a proposal (why kept, no hunk twice, unknown paths and ids dropped, the rest unassigned) and restores", () => {
    const start = splitReducer(initialSplit(files, "mine"), { type: "message", card: 1, message: "mine edited" });
    const s = splitReducer(start, {
      type: "propose",
      files,
      commits: [
        { message: "fix a", why: "first", parts: [{ path: "a.ts", hunks: [0, 7] }, { path: "zzz" }] },
        { message: "docs", parts: [{ path: "b.md" }, { path: "a.ts", hunks: [0] }, { path: "c.ts" }] },
      ],
      unassigned: [],
    });
    expect(s.cards.map((c) => c.message)).toEqual(["fix a", "docs"]);
    expect(s.cards[0]!.why).toBe("first");
    expect(s.cards[0]!.parts.map(partKey)).toEqual(["a.ts#0"]);
    expect(s.cards[1]!.parts.map(partKey)).toEqual(["b.md#whole", "c.ts#0"]);
    expect(s.unassigned.map(partKey)).toEqual(["a.ts#1", "a.ts#2"]);
    expect(new Set(s.cards.flatMap((c) => c.parts).concat(s.unassigned).map(partKey)).size).toBe(5);
    const back = splitReducer(s, { type: "restore" });
    expect(back.cards[0]!.message).toBe("mine edited");
    expect(back.cards).toHaveLength(1);
    expect(back.before).toBeNull();
    expect(splitReducer(back, { type: "restore" })).toBe(back);
  });

  it("a part without hunks for a file with hunks means all its hunks", () => {
    const s = splitReducer(initialSplit(files), { type: "propose", files, commits: [{ message: "all a", parts: [{ path: "a.ts" }] }], unassigned: [] });
    expect(s.cards[0]!.parts.map(partKey)).toEqual(["a.ts#0", "a.ts#1", "a.ts#2"]);
    expect(s.unassigned.map(partKey)).toEqual(["b.md#whole", "c.ts#0"]);
  });
});

describe("§53 the commit_series command", () => {
  it("sends hunks for a file with hunks (even all of them), the whole-only file whole, trimmed messages", () => {
    let s = splitReducer(initialSplit(files, "  one  "), { type: "addCard" });
    s = splitReducer(s, { type: "message", card: 2, message: "two" });
    s = splitReducer(s, { type: "move", files, from: 1, to: 2, path: "a.ts", hunk: 2 });
    s = splitReducer(s, { type: "move", files, from: 1, to: "none", path: "c.ts" });
    expect(buildSeries(s)).toEqual([
      { message: "one", parts: [{ path: "a.ts", hunks: [0, 1] }, { path: "b.md" }] },
      { message: "two", parts: [{ path: "a.ts", hunks: [2] }] },
    ]);
  });
});

describe("§53 the button's reason", () => {
  it("no card / empty message / no parts / busy; otherwise null", () => {
    const s = initialSplit(files, "m");
    expect(seriesBlocker(s)).toBeNull();
    expect(seriesBlocker({ ...s, cards: [] })).toBe("커밋을 먼저 추가해 주세요");
    expect(seriesBlocker({ ...s, cards: [{ ...s.cards[0]!, message: "  " }] })).toBe("1번째 커밋에 메시지가 없어요");
    expect(seriesBlocker(splitReducer(s, { type: "addCard" }))).toBe("2번째 커밋에 메시지가 없어요");
    expect(seriesBlocker({ ...s, cards: [{ ...s.cards[0]!, parts: [] }] })).toBe("1번째 커밋에 변경이 없어요");
    expect(seriesBlocker(s, { splitting: true })).toBe("나누는 중…");
  });
});

describe("§53 words", () => {
  const made = [
    { sha: "aaa1111", shortSha: "aaa1", message: "m1", files: ["a"] },
    { sha: "bbb2222", shortSha: "bbb2", message: "m2", files: ["b"] },
  ];
  it("the result", () => {
    expect(seriesDoneText(made, false)).toBe("커밋 2개를 만들었어요 (aaa1, bbb2)");
    expect(seriesDoneText(made, true)).toContain("푸시함");
  });
  it("refusals in the user's words", () => {
    expect(splitRefusalText("commit_split_failed:the fork answered nothing")).toBe("Claude가 변경을 나누지 못했어요: the fork answered nothing");
    expect(splitRefusalText("nothing_to_commit")).toContain("수락");
    expect(splitRefusalText("side_limit")).toContain("곁질문");
    expect(splitRefusalText("invalid_part:src/a.ts")).toContain("src/a.ts");
    expect(splitRefusalText("hunk_twice:src/a.ts#1")).toContain("src/a.ts#1");
    expect(splitRefusalText("empty_message")).toBe("메시지가 비어 있는 커밋이 있어요");
    expect(splitRefusalText("session_running")).toContain("작업");
    expect(splitRefusalText("merge_unresolved")).toContain("충돌");
    expect(splitRefusalText("commit_failed:hook rejected")).toBe("git이 커밋하지 못했어요: hook rejected");
    expect(splitRefusalText("git_identity_missing:user.name")).toContain("user.name");
  });
  it("a stopped series says what was made, then why", () => {
    expect(seriesFailureText("commit_failed:hook rejected", made)).toBe("커밋 2개를 만들었어요 (aaa1, bbb2) — 그다음에 멈췄어요: git이 커밋하지 못했어요: hook rejected");
    expect(seriesFailureText("empty_message", [])).toBe("메시지가 비어 있는 커밋이 있어요");
  });
});
