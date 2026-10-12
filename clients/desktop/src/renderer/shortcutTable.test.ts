// MARK: wave4d w4d-windows — audit polish-08: the shortcut table this client shows is the one in docs/SHORTCUTS.md (the Mac's
// Core ShortcutTableTests holds its own copy to the same document), and every label has its Korean.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ko from "./i18n/ko.json";
import { SHORTCUT_SECTIONS, shortcutKeys } from "./shortcutTable";

const doc = readFileSync(fileURLToPath(new URL("../../../../docs/SHORTCUTS.md", import.meta.url)), "utf8");

/** The doc's shortcut tables: per `## ` section, its rows' [Mac, Windows] cells. Sections without a table are skipped. */
function docSections(): { title: string; keys: [string, string][] }[] {
  const out: { title: string; keys: [string, string][] }[] = [];
  for (const line of doc.split("\n")) {
    if (line.startsWith("## ")) out.push({ title: line.slice(3).trim(), keys: [] });
    else if (line.startsWith("|") && out.length > 0) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells[1] === "Mac" || /^-+$/.test(cells[0] ?? "")) continue;
      out[out.length - 1]!.keys.push([cells[1]!, cells[2]!]);
    }
  }
  return out.filter((s) => s.keys.length > 0);
}

describe("keyboard shortcut table (polish-08)", () => {
  it("has the rows and keys of docs/SHORTCUTS.md, in its order", () => {
    const fromDoc = docSections();
    expect(fromDoc.map((s) => s.keys)).toEqual(SHORTCUT_SECTIONS.map((s) => s.rows.map((r) => [r.mac, r.win])));
  });

  it("gives ⌥⌘↩ one meaning family: the stronger ⌘↩ (stop and send / allow for the session / the note)", () => {
    const rows = SHORTCUT_SECTIONS.flatMap((s) => s.rows);
    const alt = rows.filter((r) => r.mac === "⌥⌘↩").map((r) => r.action);
    expect(alt).toEqual(["Stop and send", "Allow for session", "Add the conclusion as a review note"]);
    // One key, one row per section: no section lists a key twice.
    for (const s of SHORTCUT_SECTIONS) expect(new Set(s.rows.map((r) => r.mac)).size).toBe(s.rows.length);
  });

  it("reads the platform's keys: ⌘ on a Mac, Ctrl elsewhere", () => {
    const accept = SHORTCUT_SECTIONS.flatMap((s) => s.rows).find((r) => r.action === "Accept")!;
    expect(shortcutKeys(accept, "darwin")).toBe("⌘⇧A");
    expect(shortcutKeys(accept, "win32")).toBe("Ctrl+Shift+A");
    for (const r of SHORTCUT_SECTIONS.flatMap((s) => s.rows)) expect(r.win).not.toMatch(/[⌘⌥⇧⌃⌫]/);
  });

  it("has Korean for every title, action and note (from the Mac's catalog)", () => {
    const dict = ko as Record<string, string>;
    const strings = SHORTCUT_SECTIONS.flatMap((s) => [s.title, ...(s.note ? [s.note] : []), ...s.rows.flatMap((r) => [r.action, ...(r.note ? [r.note] : [])])]);
    for (const k of [...strings, "Keyboard Shortcuts", "Action", "Remarks", "The same keys do the same thing in the Mac and Windows apps — on Windows ⌘ is Ctrl and ⌥ is Alt."]) {
      expect(dict[k], k).toMatch(/[가-힣]/);
    }
  });
});
