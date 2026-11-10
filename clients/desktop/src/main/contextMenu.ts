/**
 * MARK: polish p-lifecycle — P3-transcript-09 / P4-composer-11: a right click on text gets the menu every Windows app has —
 * Undo / Redo / Cut / Copy / Paste / Select All in a text box, Copy on selected text, Copy Link Address on a link — in the
 * UI language. Electron shows no menu of its own, so before this a right click did nothing. A part of the page with a menu
 * of its own (the diff's lines, a tool row, the agents) prevents the default and so never gets this one. Pure: the window
 * pops it up (src/main/windows.ts).
 */
import type { MenuItemConstructorOptions } from "electron";
import { t } from "../renderer/i18n";

/** What Electron says about the right click (`webContents` "context-menu"). */
export type TextContext = {
  isEditable: boolean;
  selectionText: string;
  linkURL: string;
  dictionarySuggestions: string[];
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
};

export type TextActions = { copyLink: (url: string) => void; replaceMisspelling: (word: string) => void };

/** A link worth copying: a web or mail address (never the app's own `file:` pages). */
const isCopyableLink = (url: string): boolean => /^(https?:|mailto:)/i.test(url);

/** The items for `p` — empty when there is nothing to do (plain text, nothing selected: no menu). */
export function textContextMenu(p: TextContext, actions: TextActions): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  const spelling = p.isEditable ? p.dictionarySuggestions.slice(0, 5) : [];
  if (spelling.length > 0) groups.push(spelling.map((word) => ({ label: word, click: () => actions.replaceMisspelling(word) })));
  const selected = p.selectionText.trim() !== "";
  if (p.isEditable) {
    groups.push([
      { role: "undo", label: t("Undo"), enabled: p.editFlags.canUndo },
      { role: "redo", label: t("Redo"), enabled: p.editFlags.canRedo },
    ]);
    groups.push([
      { role: "cut", label: t("Cut"), enabled: p.editFlags.canCut },
      { role: "copy", label: t("Copy"), enabled: p.editFlags.canCopy },
      { role: "paste", label: t("Paste"), enabled: p.editFlags.canPaste },
    ]);
    groups.push([{ role: "selectAll", label: t("Select All"), enabled: p.editFlags.canSelectAll }]);
  } else if (selected) {
    groups.push([{ role: "copy", label: t("Copy"), enabled: p.editFlags.canCopy }]);
  }
  if (p.linkURL && isCopyableLink(p.linkURL)) {
    const url = p.linkURL.startsWith("mailto:") ? p.linkURL.slice("mailto:".length) : p.linkURL;
    groups.push([{ label: t("Copy Link Address"), click: () => actions.copyLink(url) }]);
  }
  return groups.flatMap((g, i) => (i === 0 ? g : [{ type: "separator" as const }, ...g]));
}
