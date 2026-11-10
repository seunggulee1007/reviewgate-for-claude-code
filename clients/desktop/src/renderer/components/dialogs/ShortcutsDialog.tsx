/**
 * MARK: wave4d w4d-windows — audit polish-08: Help › Keyboard Shortcuts — the table of docs/SHORTCUTS.md (src/renderer/
 * shortcutTable.ts), the Mac's keys next to Windows' so the same habit works on both. This platform's column is bold.
 * polish p-lifecycle (P1-chrome-10): a search field on top (focused when the dialog opens) narrows the rows by their
 * words in the UI language, their English and their keys — the Mac's ShortcutsView has the same.
 */
import { useState } from "react";
import { t } from "../../i18n";
import { SHORTCUT_SECTIONS, type ShortcutSection } from "../../shortcutTable";
import { Modal } from "../Menu";

/** The sections and rows `query` finds (every word, any order, any case) — a section's own title finds all of its rows. */
export function filterShortcuts(sections: ShortcutSection[], query: string, translate: (key: string) => string = t): ShortcutSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return sections;
  const hits = (texts: (string | undefined)[]) => {
    const hay = texts.flatMap((x) => (x ? [x, translate(x)] : [])).join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  return sections.flatMap((section) => {
    if (hits([section.title])) return [section];
    const rows = section.rows.filter((r) => hits([section.title, r.action, r.note, r.mac, r.win]));
    return rows.length > 0 ? [{ ...section, rows }] : [];
  });
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const mac = window.rg.platform === "darwin";
  const [query, setQuery] = useState("");
  const shown = filterShortcuts(SHORTCUT_SECTIONS, query);
  return (
    <Modal title={t("Keyboard Shortcuts")} onClose={onClose} wide testId="Keyboard shortcuts dialog">
      <div className="shortcuts-dialog">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc empties the field first; an empty one lets the dialog close.
            if (e.key === "Escape" && query !== "") {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder={t("Search shortcuts")}
          aria-label={t("Search shortcuts")}
          autoFocus
          data-testid="Shortcut search"
        />
        <div className="caption">{t("The same keys do the same thing in the Mac and Windows apps — on Windows ⌘ is Ctrl and ⌥ is Alt.")}</div>
        {shown.length === 0 && (
          <div className="caption muted" role="status" data-testid="No shortcut matches">
            {t("No shortcuts match “{0}”", query.trim())}
          </div>
        )}
        {shown.map((section) => (
          <section key={section.title} aria-label={t(section.title)}>
            <h4>{t(section.title)}</h4>
            {section.note && <div className="caption">{t(section.note)}</div>}
            <table className="shortcuts-table">
              <thead>
                <tr>
                  <th scope="col">{t("Action")}</th>
                  <th scope="col" className={mac ? "current" : undefined}>Mac</th>
                  <th scope="col" className={mac ? undefined : "current"}>Windows</th>
                  <th scope="col">{t("Remarks")}</th>
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row) => (
                  <tr key={`${row.action}-${row.mac}`}>
                    <td>{t(row.action)}</td>
                    <td className={mac ? "mono current" : "mono"}>{row.mac}</td>
                    <td className={mac ? "mono" : "mono current"}>{row.win}</td>
                    <td className="caption">{row.note ? t(row.note) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
      {/* MARK: integration p-lifecycle × p-ui-kit — the Modal's last `.actions` child: Close stays in view, the table scrolls. */}
      <div className="actions">
        <button type="button" className="primary" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </Modal>
  );
}
