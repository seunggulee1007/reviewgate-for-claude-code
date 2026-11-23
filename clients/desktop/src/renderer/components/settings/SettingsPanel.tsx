/**
 * Settings (the Mac app's `SettingsView`, docs/PROTOCOL.md §55.11): a search field over every setting, the tabs General |
 * Permissions | Session | Review | Git & Workbenches | Project | Accounts | Advanced (General used to hold them all), and
 * one "다음 세션부터 적용돼요 — [지금 재시작]" banner on every tab. Loads `window.rg.getSettings()` on mount when the store
 * has none yet; rendered inside the "settings" dialog by `Dialogs`. A result (or `highlight`) opens its tab and tints its
 * row (`data-setting`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { isEnter } from "../../ime";
import { SETTINGS_TABS, searchSettings, settingEntry, settingsTabOf, type SettingEntry, type SettingsTab } from "../../settingsIndex";
import { useStore } from "../../store";
import { AccountsTab } from "./AccountsTab";
import { AdvancedPane, GeneralPane, GitPane, ReviewPane, SessionPane } from "./GeneralTab";
import { PermissionsTab } from "./PermissionsTab";
import { ProjectTab } from "./ProjectTab"; // MARK: wave3 desktop-flow
import { AppliesBadge, SettingsRestartBanner } from "./SettingsBits";
import "./settings.css";

export type { SettingsTab } from "../../settingsIndex";

const tabTestId = (id: SettingsTab) => `Settings ${id === "git" ? "Git" : id.charAt(0).toUpperCase() + id.slice(1)}`;

export function SettingsPanel({ initialTab = "general", highlight }: { initialTab?: SettingsTab; highlight?: string }) {
  const settings = useStore((s) => s.settings);
  const loadSettings = useStore((s) => s.loadSettings);
  const [tab, setTab] = useState<SettingsTab>(() => (highlight ? settingEntry(highlight)?.tab : undefined) ?? settingsTabOf(initialTab));
  const [query, setQuery] = useState("");
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(highlight ? { id: highlight, n: 0 } : null);
  const root = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchSettings(query, (k) => t(k)), [query]);
  useEffect(() => {
    if (!settings) void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A result picked: once its tab is drawn, its row scrolls into view and is tinted for a moment.
  useEffect(() => {
    if (!flash || query) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      const row = root.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(flash.id)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("setting-flash");
      timer = setTimeout(() => row.classList.remove("setting-flash"), 2200);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [flash, tab, query, settings]);

  const open = (entry: SettingEntry) => {
    setTab(entry.tab);
    setQuery("");
    setFlash((f) => ({ id: entry.id, n: (f?.n ?? 0) + 1 }));
  };

  return (
    <div className="settings" data-testid="Settings" ref={root}>
      <div className="settings-head">
        <input
          type="search"
          className="settings-search"
          value={query}
          placeholder={t("Search settings")}
          aria-label={t("Search settings")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && results[0]) {
              e.preventDefault();
              open(results[0]);
            } else if (e.key === "Escape" && query) {
              e.preventDefault(); // the search empties first; the next Esc closes the dialog
              setQuery("");
            }
          }}
          data-testid="Settings search"
        />
        <div className="tabs" role="tablist">
          {SETTINGS_TABS.map(({ id, title }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id && !query} onClick={() => { setTab(id); setQuery(""); }} className={tab === id && !query ? "active" : ""} data-testid={tabTestId(id)}>
              {t(title)}
            </button>
          ))}
        </div>
      </div>
      <SettingsRestartBanner />
      {query.trim() ? (
        <SearchResults query={query} results={results} onOpen={open} />
      ) : !settings && tab !== "accounts" ? (
        <div className="empty"><span className="spinner" /></div>
      ) : (
        <TabBody tab={tab} />
      )}
      <div className="caption muted settings-legend">{t("Settings without a badge apply right away.")}</div>
    </div>
  );
}

function TabBody({ tab }: { tab: SettingsTab }) {
  const settings = useStore((s) => s.settings);
  if (tab === "accounts") return <AccountsTab />;
  if (!settings) return null;
  switch (tab) {
    case "general": return <GeneralPane settings={settings} />;
    case "permissions": return <PermissionsTab settings={settings} />;
    case "session": return <SessionPane settings={settings} />;
    case "review": return <ReviewPane settings={settings} />;
    case "git": return <GitPane settings={settings} />;
    case "project": return <ProjectTab />;
    case "advanced": return <AdvancedPane settings={settings} />;
  }
}

/** The settings the query found, by tab; a click (or Enter on the first) opens its tab at the row. */
function SearchResults({ query, results, onOpen }: { query: string; results: SettingEntry[]; onOpen: (e: SettingEntry) => void }) {
  if (results.length === 0) {
    return <div className="empty muted" data-testid="Settings no results">{t("No settings match “{0}”", query.trim())}</div>;
  }
  return (
    <div className="body settings-results" data-testid="Settings search results">
      {SETTINGS_TABS.filter((tab) => results.some((r) => r.tab === tab.id)).map((tab) => (
        <section key={tab.id}>
          <h4>{t(tab.title)}</h4>
          <ul className="list">
            {results.filter((r) => r.tab === tab.id).map((r) => (
              <li key={r.id}>
                <button type="button" className="plain settings-result" onClick={() => onOpen(r)} title={r.info ? t(r.info) : undefined} data-testid={`Settings result ${r.id}`}>
                  <span className="row" style={{ gap: 6 }}>
                    <span>{t(r.title)}</span>
                    <AppliesBadge applies={r.applies} />
                  </span>
                  {r.section !== r.title && <span className="caption muted">{t(r.section)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
