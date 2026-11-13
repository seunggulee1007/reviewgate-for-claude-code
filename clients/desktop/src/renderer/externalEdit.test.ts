import { describe, expect, it } from "vitest";
import { isExternalEditKey } from "./externalEdit";
import { initI18n, t } from "./i18n";

// docs/PROTOCOL.md §56.3: Ctrl+G in the composer, as the terminal's key (Ctrl on every platform).

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("§56.3 Ctrl+G", () => {
  it("is Ctrl+G alone — not ⌘G (find next), not with Shift / Alt, not a plain g", () => {
    expect(isExternalEditKey(key("g", { ctrlKey: true }))).toBe(true);
    expect(isExternalEditKey(key("G", { ctrlKey: true }))).toBe(true);
    expect(isExternalEditKey(key("g", { metaKey: true }))).toBe(false);
    expect(isExternalEditKey(key("g", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isExternalEditKey(key("g", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isExternalEditKey(key("g"))).toBe(false);
  });

  it("its tooltip names Ctrl+G on Windows, ⌃G on the Mac", () => {
    initI18n("en", "win32");
    expect(t("Edit the message in an external editor (⌃G) — each save comes back here")).toBe("Edit the message in an external editor (Ctrl+G) — each save comes back here");
    initI18n("en", "darwin");
    expect(t("Edit the message in an external editor (⌃G) — each save comes back here")).toContain("(⌃G)");
  });
});
