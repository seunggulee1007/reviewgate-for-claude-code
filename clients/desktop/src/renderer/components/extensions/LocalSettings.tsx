/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.6 (SME-01) in "Applied extensions": the per-project switch "Load local settings
 * (settings.local.json)" (default on, kept in the app settings, sent before the project's `open_project`), whether this
 * session loaded them, and "Not applied in the app" — what `.claude/settings.local.json` and the local MCP servers hold
 * that this session left out (names, commands and counts only, never a value). Local allow rules never skip a permission
 * card or the review: the engine's PreToolUse hook decides first (§33.5).
 */
import type { NotAppliedLocalSettings, SessionExtensions } from "@reviewgate/engine";
import { t } from "../../i18n";
import { knowsSessionTools, loadsLocalSettings, notAppliedOf, projectLoadsLocal, updateReason } from "../../sessionTools";
import { useStore } from "../../store";
import "./localSettings.css";

export type LocalSettingsViewProps = {
  ext: SessionExtensions;
  /** The project's choice. */
  wanted: boolean;
  /** The engine has §36.6 (else the switch is off with the reason). */
  supported: boolean;
  /** A project is open (the choice is per project). */
  hasProject: boolean;
  /** A session is starting (the retry waits). */
  starting: boolean;
  onToggle: (on: boolean) => void;
  onRetry: () => void;
};

/** The section, connected to the store. */
export function LocalSettingsSection({ ext }: { ext: SessionExtensions }) {
  const root = useStore((s) => s.state.project?.root ?? null);
  const settings = useStore((s) => s.settings);
  const supported = useStore((s) => knowsSessionTools(s.state.session));
  const starting = useStore((s) => s.state.session.starting);
  const setLocal = useStore((s) => s.setLoadLocalSettings);
  const retry = useStore((s) => s.retryExtensions);
  return (
    <LocalSettingsView
      ext={ext}
      wanted={projectLoadsLocal(settings, root)}
      supported={supported}
      hasProject={root !== null}
      starting={starting}
      onToggle={(on) => void setLocal(on)}
      onRetry={() => void retry()}
    />
  );
}

/** The switch with what it loads, whether this session loaded it, and what it left out. */
export function LocalSettingsView(p: LocalSettingsViewProps) {
  const loaded = loadsLocalSettings(p.ext);
  const notApplied = notAppliedOf(p.ext);
  return (
    <section className="ext-section" data-testid="Local settings">
      <h4>
        <span className="mono">settings.local.json</span>
        {p.supported && (
          <span className={`pill ${loaded ? "green" : "gray"}`} data-testid="Local settings applied">
            {loaded ? `✓ ${t("Loaded")}` : t("Off")}
          </span>
        )}
      </h4>
      <label className="check ext-toggle" title={p.supported ? t("Load this project's .claude/settings.local.json and local MCP servers in new sessions") : updateReason()}>
        <input type="checkbox" checked={p.wanted} disabled={!p.supported || !p.hasProject} onChange={(e) => p.onToggle(e.target.checked)} data-testid="Load local settings" />
        <span className="col" style={{ gap: 2 }}>
          <span>{t("Load local settings (settings.local.json)")}</span>
          <span className="caption muted">
            {t("Hooks, environment variables and allow rules of this project's .claude/settings.local.json and its local MCP servers, as in the terminal. Permission cards and the review still apply. Applies from the next session.")}
          </span>
          {!p.supported && (
            <span className="caption orange" data-testid="Load local settings unavailable">
              ⚠ {updateReason()}
            </span>
          )}
        </span>
      </label>
      {notApplied && <NotAppliedBlock notApplied={notApplied} byFallback={p.ext.fallback !== null} {...p} />}
    </section>
  );
}

/** "Not applied in the app": the §16 fallback dropped them (with the user settings) or the project's switch is off. */
function NotAppliedBlock(p: { notApplied: NotAppliedLocalSettings; byFallback: boolean } & LocalSettingsViewProps) {
  const { notApplied } = p;
  return (
    <div className="not-applied" role="group" aria-label={t("Not applied in the app")} data-testid="Not applied in the app">
      <span className="bold">{t("Not applied in the app")}</span>
      <span className="caption">
        {p.byFallback
          ? t("Extensions did not start in time, so local settings are off too until you retry.")
          : t("Local settings are off for this project. Claude in the terminal uses these; this session does not:")}
      </span>
      {notApplied.hooks.length > 0 && (
        <div className="na-group">
          <span className="caption bold">{t("Hooks")}</span>
          <ul>
            {notApplied.hooks.slice(0, 50).map((h, i) => (
              <li key={`${h.event}-${i}`}>
                <span className="ext-event mono">{h.event}</span>
                <span className="mono tiny truncate" title={h.command}>{h.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notApplied.envKeys.length > 0 && (
        <div className="na-group">
          <span className="caption bold">{t("Environment variables")}</span>
          <span className="mono tiny na-list">{notApplied.envKeys.join(", ")}</span>
        </div>
      )}
      {notApplied.mcpServers.length > 0 && (
        <div className="na-group">
          <span className="caption bold">{t("Local MCP servers")}</span>
          <span className="mono tiny na-list">{notApplied.mcpServers.join(", ")}</span>
        </div>
      )}
      {notApplied.allowRuleCount > 0 && <span className="caption">{t("{0} allow rules", notApplied.allowRuleCount)}</span>}
      {p.byFallback ? (
        <button type="button" className="small" disabled={p.starting} onClick={p.onRetry} data-testid="Not applied retry">
          {t("Retry with extensions")}
        </button>
      ) : (
        !p.wanted &&
        p.supported && (
          <button type="button" className="small" disabled={!p.hasProject} onClick={() => p.onToggle(true)} title={t("Turns on “Load local settings” for this project; applies from the next session")} data-testid="Load local settings now">
            {t("Load local settings")}
          </button>
        )
      )}
    </div>
  );
}

/** One line in the capabilities popover when the session left local settings out (opens "Applied extensions"). */
export function NotAppliedHint({ onOpen }: { onOpen: () => void }) {
  const has = useStore((s) => notAppliedOf(s.state.session.extensions) !== null);
  if (!has) return null;
  return (
    <button type="button" className="plain tiny caps-not-applied" onClick={onOpen} data-testid="Caps not applied">
      ⚠ {t("Not applied in the app")}
    </button>
  );
}
