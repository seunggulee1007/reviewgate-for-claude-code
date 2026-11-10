// MARK: polish p-lifecycle — P1-chrome-10: Help › Keyboard Shortcuts narrows the table as the user types.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { SHORTCUT_SECTIONS } from "./shortcutTable";
import { filterShortcuts } from "./components/dialogs/ShortcutsDialog";

describe("shortcut search (P1-chrome-10)", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "darwin"));

  const actions = (q: string) => filterShortcuts(SHORTCUT_SECTIONS, q).flatMap((s) => s.rows.map((r) => r.action));

  it("finds rows by their Korean, their English and their keys, every word in any order", () => {
    expect(actions("거절")).toContain("Reject");
    expect(actions("reject")).toContain("Reject");
    expect(actions("ctrl+shift+k")).toEqual(["Commit Accepted…"]);
    expect(actions("탭 채팅")).toEqual(expect.arrayContaining(["Close Chat Tab", "Chat tabs 1–9"]));
  });

  it("a section's title finds the whole section; nothing found: no section; empty: everything", () => {
    const review = SHORTCUT_SECTIONS.find((s) => s.title === "Review")!;
    expect(filterShortcuts(SHORTCUT_SECTIONS, "Review").find((s) => s.title === "Review")?.rows).toEqual(review.rows);
    expect(filterShortcuts(SHORTCUT_SECTIONS, "zzz-nothing")).toEqual([]);
    expect(filterShortcuts(SHORTCUT_SECTIONS, "  ")).toBe(SHORTCUT_SECTIONS);
  });
});
