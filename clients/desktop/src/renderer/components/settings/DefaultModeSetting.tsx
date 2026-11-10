/**
 * MARK: wave4b w4b-auto — docs/PROTOCOL.md §39.5: Settings › Permissions, the mode a project opened for the first time
 * starts in (`settings.permissionMode`, the engine's fallback when the project has no mode of its own, §11); each project
 * then keeps the mode picked there. The four modes only — never bypassPermissions / dontAsk.
 */
import type { PermissionMode } from "@reviewgate/engine";
import type { AppSettings } from "../../../shared/ipc";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { MODES, modeHelp, modeLabel } from "../chat/ModeMenu";

export function DefaultModeSetting({ settings }: { settings: AppSettings }) {
  const save = useStore((s) => s.saveSettings);
  const mode: PermissionMode = MODES.includes(settings.permissionMode as PermissionMode) ? (settings.permissionMode as PermissionMode) : "default";
  return (
    <section>
      <h4>{t("Starting mode")}</h4>
      <div className="field-row">
        <select value={mode} onChange={(e) => void save({ permissionMode: e.target.value as PermissionMode })} aria-label={t("Starting mode")} data-testid="Default permission mode">
          {MODES.map((m) => (
            <option key={m} value={m}>
              {modeLabel(m)}
            </option>
          ))}
        </select>
      </div>
      <div className="note">{t("New projects start in this mode; each project then keeps the mode you pick.")}</div>
      <div className="note">{`${modeLabel(mode)}: ${modeHelp(mode)}`}</div>
    </section>
  );
}
