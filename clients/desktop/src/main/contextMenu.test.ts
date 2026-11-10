// MARK: polish p-lifecycle — P3-transcript-09 / P4-composer-11: the text menu a right click gets.
import { describe, expect, it, vi } from "vitest";
import { textContextMenu, type TextContext } from "./contextMenu";

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
const ctx = (o: Partial<TextContext> = {}): TextContext => ({ isEditable: false, selectionText: "", linkURL: "", dictionarySuggestions: [], editFlags: flags, ...o });
const shape = (items: ReturnType<typeof textContextMenu>) => items.map((i) => i.role ?? i.type ?? i.label);

describe("the text context menu", () => {
  it("a text box: undo / redo, cut / copy / paste, select all — each enabled as Chromium says", () => {
    const items = textContextMenu(ctx({ isEditable: true }), { copyLink: () => undefined, replaceMisspelling: () => undefined });
    expect(shape(items)).toEqual(["undo", "redo", "separator", "cut", "copy", "paste", "separator", "selectAll"]);
    expect(items.find((i) => i.role === "redo")?.enabled).toBe(false);
  });

  it("selected text outside a box: copy; nothing selected: no menu at all", () => {
    const noop = { copyLink: () => undefined, replaceMisspelling: () => undefined };
    expect(shape(textContextMenu(ctx({ selectionText: "npm test" }), noop))).toEqual(["copy"]);
    expect(textContextMenu(ctx({ selectionText: "   " }), noop)).toEqual([]);
    expect(textContextMenu(ctx(), noop)).toEqual([]);
  });

  it("a web or mail link: copy its address (mailto: without the scheme); the app's own file: pages never", () => {
    const copyLink = vi.fn();
    const web = textContextMenu(ctx({ linkURL: "https://tasks.example.com/acme/42" }), { copyLink, replaceMisspelling: () => undefined });
    expect(shape(web)).toEqual(["Copy Link Address"]);
    (web[0]!.click as unknown as () => void)();
    const mail = textContextMenu(ctx({ linkURL: "mailto:dev@example.com", selectionText: "dev" }), { copyLink, replaceMisspelling: () => undefined });
    expect(shape(mail)).toEqual(["copy", "separator", "Copy Link Address"]);
    (mail[2]!.click as unknown as () => void)();
    expect(copyLink.mock.calls).toEqual([["https://tasks.example.com/acme/42"], ["dev@example.com"]]);
    expect(textContextMenu(ctx({ linkURL: "file:///C:/app/index.html" }), { copyLink, replaceMisspelling: () => undefined })).toEqual([]);
  });

  it("spelling suggestions first, in a text box only", () => {
    const replaceMisspelling = vi.fn();
    const items = textContextMenu(ctx({ isEditable: true, dictionarySuggestions: ["receive", "relieve"] }), { copyLink: () => undefined, replaceMisspelling });
    expect(shape(items).slice(0, 3)).toEqual(["receive", "relieve", "separator"]);
    (items[1]!.click as unknown as () => void)();
    expect(replaceMisspelling).toHaveBeenCalledWith("relieve");
  });
});
