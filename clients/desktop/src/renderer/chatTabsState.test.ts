import { beforeEach, describe, expect, it } from "vitest";
import { CLOSED_TABS_LIMIT, isHistoryKey, isReopenTabKey, rememberClosedTab, stepTab, tabStepKey, takeClosedTab, useClosedTabs } from "./chatTabsState";

/** r2-chats-cards — polish PX-19 / P4-composer-34: reopen a closed chat tab, step through the tabs. */
const key = (k: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

describe("chat tabs (PX-19, P4-composer-34)", () => {
  beforeEach(() => useClosedTabs.setState({ ids: [], justClosed: null }));

  it("closed tabs come back last first, skipping chats that are gone; the stack is bounded", () => {
    rememberClosedTab("a");
    rememberClosedTab("b");
    rememberClosedTab("a");
    expect(useClosedTabs.getState()).toEqual({ ids: ["b", "a"], justClosed: "a" });
    expect(takeClosedTab((id) => id !== "a")).toBe("b");
    expect(useClosedTabs.getState().ids).toEqual([]);
    for (let i = 0; i < CLOSED_TABS_LIMIT + 5; i++) rememberClosedTab(`c${i}`);
    expect(useClosedTabs.getState().ids).toHaveLength(CLOSED_TABS_LIMIT);
    expect(takeClosedTab(() => true)).toBe(`c${CLOSED_TABS_LIMIT + 4}`);
  });

  it("the next / previous tab around the ends, and the keys that step and reopen", () => {
    expect(stepTab(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepTab(["a", "b", "c"], "a", -1)).toBe("c");
    expect(stepTab(["a"], "a", 1)).toBeNull();
    expect(tabStepKey(key("Tab", { ctrlKey: true }))).toBe(1);
    expect(tabStepKey(key("Tab", { ctrlKey: true, shiftKey: true }))).toBe(-1);
    expect(tabStepKey(key("PageDown", { ctrlKey: true }))).toBe(1);
    expect(tabStepKey(key("PageUp", { ctrlKey: true }))).toBe(-1);
    expect(tabStepKey(key("Tab"))).toBeNull();
    expect(isReopenTabKey(key("T", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isReopenTabKey(key("t", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isReopenTabKey(key("t", { ctrlKey: true }), false)).toBe(false);
    // ⌘Y / Ctrl+H open the chat history (docs/SHORTCUTS.md "채팅 기록").
    expect(isHistoryKey(key("y", { metaKey: true }), true)).toBe(true);
    expect(isHistoryKey(key("h", { ctrlKey: true }), false)).toBe(true);
    expect(isHistoryKey(key("ㅗ", { ctrlKey: true, code: "KeyH" } as never), false)).toBe(true); // a Korean input source
    expect(isHistoryKey(key("h", { ctrlKey: true }), true)).toBe(false);
    expect(isHistoryKey(key("y", { metaKey: true, shiftKey: true }), true)).toBe(false);
  });
});
