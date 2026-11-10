import { afterAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { sendKeyLabel, shortcutKeyOf, tKey } from "./shortcutKeys";

// polish p-foundation — PX-11: tooltips name a key only from the shortcut table, in the platform's spelling.

afterAll(() => initI18n("en", "darwin"));

describe("shortcut keys in tooltips", () => {
  it("Windows spells the table's Windows column; a Mac its own", () => {
    initI18n("en", "win32");
    expect(shortcutKeyOf("Accept")).toBe("Ctrl+Shift+A");
    expect(tKey("Accept this file", "Accept")).toBe("Accept this file (Ctrl+Shift+A)");
    expect(shortcutKeyOf("Switch the permission mode")).toBe("Shift+Tab");
    initI18n("en", "darwin");
    expect(shortcutKeyOf("Accept")).toBe("⌘⇧A");
    expect(tKey("Accept this file", "Accept")).toBe("Accept this file (⌘⇧A)");
  });

  it("two rows of one action name the first; an action the table does not list shows the label alone", () => {
    initI18n("en", "win32");
    expect(shortcutKeyOf("Stop")).toBe("Ctrl+.");
    expect(shortcutKeyOf("Make coffee")).toBeNull();
    expect(tKey("Make coffee", "Make coffee")).toBe("Make coffee");
    // The label's own arguments still go in.
    expect(tKey("Close {0}", "Close Chat Tab", "Mapper fix")).toBe("Close Mapper fix (Ctrl+Shift+W)");
  });

  // r2-review-flow (polish): a menu key only the Mac app has ("—" on Windows) is not this client's on either platform.
  it("names no key the Windows app does not have", () => {
    initI18n("en", "win32");
    expect(shortcutKeyOf("Copy Path")).toBeNull();
    expect(tKey("Copy path", "Copy Path")).toBe("Copy path");
    expect(shortcutKeyOf("Zoom In")).toBe("Ctrl+=");
    initI18n("en", "darwin");
    expect(shortcutKeyOf("Copy Path")).toBeNull();
    expect(shortcutKeyOf("Zoom In")).toBe("⌘+");
  });

  it("the send key follows Return sends (absent: on)", () => {
    initI18n("en", "win32");
    expect(sendKeyLabel(undefined)).toBe("Enter");
    expect(sendKeyLabel(false)).toBe("Ctrl+Enter");
    initI18n("en", "darwin");
    expect(sendKeyLabel(true)).toBe("↩");
    expect(sendKeyLabel(false)).toBe("⌘↩");
  });
});
