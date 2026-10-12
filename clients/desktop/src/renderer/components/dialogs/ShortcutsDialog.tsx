/**
 * MARK: wave4d w4d-windows — audit polish-08: Help › Keyboard Shortcuts — the table of docs/SHORTCUTS.md (src/renderer/
 * shortcutTable.ts), the Mac's keys next to Windows' so the same habit works on both. This platform's column is bold.
 */
import { t } from "../../i18n";
import { SHORTCUT_SECTIONS } from "../../shortcutTable";
import { Modal } from "../Menu";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const mac = window.rg.platform === "darwin";
  return (
    <Modal title={t("Keyboard Shortcuts")} onClose={onClose} wide testId="Keyboard shortcuts dialog">
      <div className="shortcuts-dialog">
        <div className="caption">{t("The same keys do the same thing in the Mac and Windows apps — on Windows ⌘ is Ctrl and ⌥ is Alt.")}</div>
        {SHORTCUT_SECTIONS.map((section) => (
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
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="primary" onClick={onClose} autoFocus>
            {t("Close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
