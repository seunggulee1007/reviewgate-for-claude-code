/**
 * §2.8 / §33.8 first open of a project: when the user's Claude Code settings start sessions in another mode
 * (`permissions.defaultMode`, one ReviewGate offers), a slim question above the composer — "터미널처럼 {mode} 모드로
 * 시작할까요?". Yes stores it as the mode new sessions start in (`settings.permissionMode`) and switches the live
 * session when it is idle; No is remembered for that mode (this window's browser storage), so it is never asked again.
 */
import { useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@reviewgate/engine";
import { t } from "../../i18n";
import { permissionMode, useStore } from "../../store";
import { modeSuggestion } from "../../terminalRules";
import { modeLabel } from "./ModeMenu";

const DECLINED_KEY = "rg.modeSuggestion.declined";

function declinedModes(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DECLINED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

function rememberDeclined(mode: PermissionMode): void {
  try {
    localStorage.setItem(DECLINED_KEY, JSON.stringify([...new Set([...declinedModes(), mode])]));
  } catch {
    /* private mode etc.: it may be asked again next time */
  }
}

export function ModeSuggestion() {
  const root = useStore((s) => s.state.project?.root ?? null);
  const hasSettings = useStore((s) => s.settings !== null);
  const startMode = useStore((s) => s.settings?.permissionMode ?? "default");
  const liveMode = useStore((s) => permissionMode(s.state));
  const fetchRules = useStore((s) => s.fetchPermissionRules);
  const saveSettings = useStore((s) => s.saveSettings);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const [suggested, setSuggested] = useState<PermissionMode | null>(null);
  const askedFor = useRef<string | null>(null);

  // Once per project opened in this window: read the terminal's default mode (query lane, no side effects). The answer
  // is dropped when another project is open by then (no effect cleanup: StrictMode re-runs effects).
  useEffect(() => {
    if (!root || !hasSettings || askedFor.current === root) return;
    askedFor.current = root;
    setSuggested(null);
    void fetchRules().then((r) => {
      const s = useStore.getState();
      if (!r.ok || s.state.project?.root !== root) return;
      setSuggested(modeSuggestion(r.rules, s.settings?.permissionMode ?? "default", permissionMode(s.state), declinedModes()));
    });
  }, [root, hasSettings, fetchRules]);

  // A mode chosen meanwhile (the mode menu, Settings) settles the question.
  const mode = suggested && suggested !== startMode && suggested !== liveMode ? suggested : null;
  if (!mode || !root) return null;

  const yes = async () => {
    setSuggested(null);
    await saveSettings({ permissionMode: mode });
    const s = useStore.getState().state;
    if (s.session.open && s.gate.phase !== "running") await setPermissionMode(mode);
  };
  const no = () => {
    rememberDeclined(mode);
    setSuggested(null);
  };

  return (
    <div className="mode-suggestion" role="region" aria-label={t("Start in {0} mode like the terminal?", modeLabel(mode))} data-testid="Mode suggestion">
      <span className="grow">
        <span className="bold">{t("Start in {0} mode like the terminal?", modeLabel(mode))}</span>{" "}
        <span className="caption muted">{t("Your Claude Code settings start sessions in this mode (permissions.defaultMode). Yes switches this session too; No won't ask again.")}</span>
      </span>
      {/* polish P4-composer-04: what each answer does (the Mac's keys) */}
      <button type="button" className="small primary" onClick={() => void yes()} title={t("Switch this session and remember the mode for this project")} data-testid="Mode suggestion yes">
        {t("Yes")}
      </button>
      <button type="button" className="small" onClick={no} title={t("Keep the current mode; this project will not be asked again")} data-testid="Mode suggestion no">
        {t("No")}
      </button>
    </div>
  );
}
