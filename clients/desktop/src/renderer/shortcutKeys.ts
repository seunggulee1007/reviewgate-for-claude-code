/**
 * MARK: polish p-foundation — PX-11: a tooltip names the key of what it does, read from the one shortcut table
 * (shortcutTable.ts, docs/SHORTCUTS.md), never typed into its text — so Windows never shows a ⌘ and a key cannot drift.
 *
 *   title={tKey("Accept this file", "Accept")}            // "이 파일 수락 (Ctrl+Shift+A)" / "(⌘⇧A)" on a Mac
 *   title={`${t("Send")} (${sendKeyLabel(settings?.returnSends)})`}
 *
 * `action` is the row's English `action` in shortcutTable.ts; an action the table does not list shows the label alone.
 * The Mac's are `String.withKey` / `.helpWithKey` (App/UI/Common/KeyHint.swift) over Core `ShortcutTable.key`.
 */
import { t, usesMacKeys } from "./i18n";
import { SHORTCUT_SECTIONS, type ShortcutRow } from "./shortcutTable";

let rows: Map<string, ShortcutRow> | null = null;

/** Each action's first row ("Stop": ⌘. before Esc in the message box). */
function rowOf(action: string): ShortcutRow | undefined {
  if (!rows) {
    rows = new Map();
    for (const row of SHORTCUT_SECTIONS.flatMap((s) => s.rows)) if (!rows.has(row.action)) rows.set(row.action, row);
  }
  return rows.get(action);
}

/**
 * The keys of `action` on this platform ("⌘⇧A" on a Mac, "Ctrl+Shift+A" elsewhere); null when the table has no such row, or
 * when it is a key only the Mac app has (its Windows cell "—", note "Mac app only") — this client does not have it.
 */
export function shortcutKeyOf(action: string): string | null {
  const row = rowOf(action);
  if (!row || row.win === "—") return null;
  return usesMacKeys() ? row.mac : row.win;
}

/** `t(label, …args)` followed by the key of `action` — "수락 (Ctrl+Shift+A)"; the label alone when no key is listed. */
export function tKey(label: string, action: string, ...args: (string | number)[]): string {
  const text = t(label, ...args);
  const key = shortcutKeyOf(action);
  return key === null ? text : t("{0} ({1})", text, key);
}

/** The key that sends the message box: ↩ / Enter while "Return sends the message" is on (absent: on), else ⌘↩ / Ctrl+Enter. */
export function sendKeyLabel(returnSends: boolean | undefined): string {
  const mac = usesMacKeys();
  if (returnSends !== false) return mac ? "↩" : "Enter";
  return mac ? "⌘↩" : "Ctrl+Enter";
}
