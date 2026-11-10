/**
 * Settings (the Mac app's `SettingsView`): General | Permissions | Accounts tabs. Loads `window.rg.getSettings()`
 * on mount when the store has none yet; rendered inside the "settings" dialog by `Dialogs`.
 */
import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { AccountsTab } from "./AccountsTab";
import { GeneralTab } from "./GeneralTab";
import { PermissionsTab } from "./PermissionsTab";
import { ProjectTab } from "./ProjectTab"; // MARK: wave3 desktop-flow
import "./settings.css";

export type SettingsTab = "general" | "accounts" | "permissions" | "project";

export function SettingsPanel({ initialTab = "general" }: { initialTab?: SettingsTab }) {
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEffect(() => {
    if (!settings) void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="settings" data-testid="Settings">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className={tab === "general" ? "active" : ""} onClick={() => setTab("general")} data-testid="Settings General">{t("General")}</button>
        <button type="button" role="tab" className={tab === "permissions" ? "active" : ""} onClick={() => setTab("permissions")} data-testid="Settings Permissions">{t("Permissions")}</button>
        <button type="button" role="tab" className={tab === "accounts" ? "active" : ""} onClick={() => setTab("accounts")} data-testid="Settings Accounts">{t("Accounts")}</button>
        {/* MARK: wave3 desktop-flow — the repository's commit template, workbench setup and PR command */}
        <button type="button" role="tab" className={tab === "project" ? "active" : ""} onClick={() => setTab("project")} data-testid="Settings Project">{t("Project")}</button>
      </div>
      {tab === "project" ? (
        settings ? <ProjectTab /> : <div className="empty"><span className="spinner" /></div>
      ) : tab === "general" ? (
        settings ? <GeneralTab settings={settings} /> : <div className="empty"><span className="spinner" /></div>
      ) : tab === "permissions" ? (
        settings ? <PermissionsTab settings={settings} /> : <div className="empty"><span className="spinner" /></div>
      ) : (
        <AccountsTab />
      )}
    </div>
  );
}
