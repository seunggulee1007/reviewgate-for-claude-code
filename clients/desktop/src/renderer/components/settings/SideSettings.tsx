/**
 * Settings › General › Side questions (§40.3, wave4b w4b-side): the web (off by default — code a side question read could
 * leave in a page address) and the side model picked from the session's models (the Mac's `SideSettingsRows`).
 */
import type { ReactNode } from "react";
import type { AppSettings } from "../../../shared/ipc";
import { t } from "../../i18n";
import { SIDE_WEB_MODES, sideModelChoices, sideWebHelp, sideWebLabel, sideWebModeOf } from "../../sideTrust";
import { useStore } from "../../store";

export function SideWebSetting({ settings, patch }: { settings: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  const mode = sideWebModeOf(settings.sideWeb);
  return (
    <>
      <div className="field-row">
        <span>{t("Web in side questions")}</span>
        <select value={mode} onChange={(e) => patch({ sideWeb: sideWebModeOf(e.target.value), sideAllowWeb: e.target.value === "on" })} data-testid="Side web">
          {SIDE_WEB_MODES.map((m) => (
            <option key={m} value={m}>
              {sideWebLabel(m)}
            </option>
          ))}
        </select>
      </div>
      <div className={`note${mode === "on" ? " orange" : ""}`} data-testid="Side web help">{sideWebHelp(mode)}</div>
    </>
  );
}

/**
 * The side model from the session's list; a typed value stays listed. Without a list yet (no session) the free-text
 * `fallback` stays.
 */
export function SideModelPicker({ value, onCommit, fallback }: { value: string; onCommit: (v: string) => void; fallback: ReactNode }) {
  const models = useStore((s) => s.state.session.availableModels ?? []);
  if (models.length === 0) return <>{fallback}</>;
  const choices = sideModelChoices(models, value);
  return (
    <select value={value.trim()} onChange={(e) => onCommit(e.target.value)} data-testid="Side model">
      {choices.map((c) => (
        <option key={c.value || "same"} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
