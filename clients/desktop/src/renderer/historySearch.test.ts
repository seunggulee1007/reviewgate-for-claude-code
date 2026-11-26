import { describe, expect, it } from "vitest";
import {
  historySearchKeyJustHandled,
  isHistorySearchKey,
  noteHistorySearchKey,
  searchAccepted,
  searchFailing,
  searchHighlight,
  searchKeyAction,
  searchMatch,
  searchNewer,
  searchOlder,
  searchPosition,
  startHistorySearch,
  withQuery,
} from "./historySearch";

/** docs/PROTOCOL.md §70.1: Ctrl+R over the prompt history (as the Mac's PromptHistorySearchTests). */
const entries = ["fix the login test", "add a README", "Fix the build", "run the tests"];
const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean; code: string }> = {}) => ({
  key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
});

describe("§70.1 the search (pure)", () => {
  it("shows nothing until something is typed; accepting gives the draft back", () => {
    const s = startHistorySearch(entries, "draft");
    expect(searchMatch(s)).toBeNull();
    expect(searchFailing(s)).toBe(false);
    expect(searchPosition(s)).toBeNull();
    expect(searchAccepted(s)).toBe("draft");
  });

  it("finds the newest match first, case-insensitive, and steps older / newer", () => {
    let s = withQuery(startHistorySearch(entries, ""), "fix");
    expect(searchMatch(s)).toBe("Fix the build");
    expect(searchPosition(s)).toEqual({ index: 1, count: 2 });
    s = searchOlder(s);
    expect(searchMatch(s)).toBe("fix the login test");
    expect(searchOlder(s)).toBe(s); // the oldest: stays
    s = searchNewer(s);
    expect(searchMatch(s)).toBe("Fix the build");
    expect(searchNewer(s)).toBe(s);
  });

  it("typing more starts over at the newest; the same text keeps the place", () => {
    let s = searchOlder(withQuery(startHistorySearch(entries, ""), "t"));
    expect(withQuery(s, "t")).toBe(s);
    s = withQuery(s, "te");
    expect(searchMatch(s)).toBe("run the tests");
  });

  it("a failing search keeps the draft", () => {
    const s = withQuery(startHistorySearch(entries, "half typed"), "nothing like it");
    expect(searchFailing(s)).toBe(true);
    expect(searchAccepted(s)).toBe("half typed");
  });

  it("highlights the first place", () => {
    expect(searchHighlight("Fix the build, fix it", "FIX")).toEqual([0, 3]);
    expect(searchHighlight("abc", "")).toBeNull();
    expect(searchHighlight("abc", "z")).toBeNull();
  });
});

describe("§70.1 the keys", () => {
  it("Ctrl+R opens it in the box (any layout), never mid-composition", () => {
    expect(isHistorySearchKey(key("r", { ctrlKey: true }))).toBe(true);
    expect(isHistorySearchKey(key("ㄱ", { ctrlKey: true, code: "KeyR" }))).toBe(true);
    expect(isHistorySearchKey(key("r", { ctrlKey: true, shiftKey: true }))).toBe(false); // Ctrl+Shift+R is Reject
    expect(isHistorySearchKey(key("r", { metaKey: true }))).toBe(false);
    expect(isHistorySearchKey(key("r", { ctrlKey: true, isComposing: true }))).toBe(false);
  });

  it("the field's keys", () => {
    expect(searchKeyAction(key("r", { ctrlKey: true }), false)).toBe("older");
    expect(searchKeyAction(key("ArrowUp"), false)).toBe("older");
    expect(searchKeyAction(key("ArrowDown"), false)).toBe("newer");
    expect(searchKeyAction(key("Enter"), false)).toBe("accept");
    expect(searchKeyAction(key("Tab"), false)).toBe("accept");
    expect(searchKeyAction(key("Escape"), false)).toBe("cancel");
    expect(searchKeyAction(key("Backspace"), true)).toBe("cancel");
    expect(searchKeyAction(key("Backspace"), false)).toBeNull();
    expect(searchKeyAction(key("a"), false)).toBeNull();
    expect(searchKeyAction(key("Enter", { isComposing: true }), false)).toBeNull();
  });

  it("drops the menu's Refresh for the press the box took", () => {
    noteHistorySearchKey(1000);
    expect(historySearchKeyJustHandled(1200)).toBe(true);
    expect(historySearchKeyJustHandled(1600)).toBe(false);
  });
});
