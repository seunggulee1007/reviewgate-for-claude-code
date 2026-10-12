/** wave4 w4-input (polish-06): ⌥⌘N — a review note on the selected line, else the first changed line. */
import { describe, expect, it } from "vitest";
import type { DiffLine } from "@reviewgate/engine";
import { isNoteKey, noteLineTarget } from "./noteShortcut";

let id = 0;
const line = (kind: DiffLine["kind"], oldNo: number | null, newNo: number | null): DiffLine => ({ id: id++, kind, oldNo, newNo, text: "x" }) as DiffLine;
const diff = {
  hunks: [
    { lines: [line("hunkHeader", null, null), line("context", 9, 9), line("del", 10, null), line("add", null, 10), line("context", 11, 11)] },
    { lines: [line("hunkHeader", null, null), line("add", null, 40)] },
  ],
};
const key = (over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
  key: "n",
  code: "KeyN",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("⌥⌘N / Ctrl+Alt+N", () => {
  it("is the physical N with ⌥ and ⌘ (or Ctrl)", () => {
    expect(isNoteKey(key({ key: "˜", metaKey: true, altKey: true }))).toBe(true);
    expect(isNoteKey(key({ key: "ㅜ", ctrlKey: true, altKey: true }))).toBe(true);
    expect(isNoteKey(key({ metaKey: true }))).toBe(false);
    expect(isNoteKey(key({ metaKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it("notes the selected line", () => {
    expect(noteLineTarget(diff, { path: "a", line: 11, side: "new" }, "both")).toEqual({ side: "new", line: 11 });
    expect(noteLineTarget(diff, { path: "a", line: 10, side: "old" }, "both")).toEqual({ side: "old", line: 10 });
  });

  it("else the first changed line; a range view skips removed lines", () => {
    expect(noteLineTarget(diff, null, "both")).toEqual({ side: "old", line: 10 });
    expect(noteLineTarget(diff, null, "new")).toEqual({ side: "new", line: 10 });
    expect(noteLineTarget(diff, { path: "a", line: 10, side: "old" }, "new")).toEqual({ side: "new", line: 10 });
    expect(noteLineTarget(diff, { path: "a", hunkId: 1 }, "both")).toEqual({ side: "old", line: 10 });
  });

  it("has nothing to note on an empty diff", () => {
    expect(noteLineTarget({ hunks: [] }, null, "both")).toBeNull();
  });
});
