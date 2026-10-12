/**
 * "Applied extensions" (docs/PROTOCOL.md §16): what the running session took from the user's Claude Code setup —
 * plugins (each with an on/off switch → `settings.disabledPlugins`), the user-hooks switch
 * (`settings.disableUserHooks`), MCP servers (§22: status, reconnect / on-off / add / remove / sign-in — McpServers.tsx), skill / command counts, which CLAUDE.md files
 * loaded and the hook sources. Switches apply at the next session start; "Restart now" issues `restart_session`.
 * After an init-timeout fallback the session runs without user settings until the project is opened again.
 */
import { useState } from "react";
import type { ExtensionHook, ExtensionPlugin, SessionExtensions } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isRunning, useStore } from "../../store";
import { Modal } from "../Menu";
import { McpServers } from "./McpServers";
import "./extensions.css";
// MARK: wave3 desktop-session — §36.6
import { LocalSettingsSection } from "./LocalSettings";
import { knowsSessionTools, localSettingsNeedRestart, projectLoadsLocal } from "../../sessionTools";
import { InstructionsSection } from "./Instructions"; // MARK: wave4d w4d-config (§42.3)
import { ModsSection } from "./Mods"; // MARK: wave5 w5-graph (§43.3)

const EMPTY: string[] = [];

export { mcpTone } from "../../mcp";

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function ExtensionsDialog({ onClose }: { onClose: () => void }) {
  const ext = useStore((s) => s.state.session.extensions ?? null);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const restartSession = useStore((s) => s.restartSession);
  // MARK: wave3 desktop-session — §36.7: retry_extensions (an older engine reopens the project, as before).
  const retryExtensions = useStore((s) => s.retryExtensions);
  const retryError = useStore((s) => s.extensionsRetryError);
  const canRestart = useStore((s) => s.state.session.canRestart && !isRunning(s.state) && !s.state.session.starting);
  const starting = useStore((s) => s.state.session.starting);
  const [busy, setBusy] = useState(false);

  const disabled = settings?.disabledPlugins ?? EMPTY;
  const hooksOff = settings?.disableUserHooks === true;
  const loadUser = settings?.loadUserSettings !== false;
  // MARK: wave3 desktop-session — §36.6: the project's "Load local settings" differs from what this session applied.
  const root = useStore((s) => s.state.project?.root ?? null);
  const supportsSessionTools = useStore((s) => knowsSessionTools(s.state.session));
  const localChanged = localSettingsNeedRestart(ext, projectLoadsLocal(settings, root), supportsSessionTools);
  const changed = ext !== null && (!sameSet(disabled, ext.disabledPlugins) || hooksOff !== ext.userHooksDisabled || localChanged);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const togglePlugin = (id: string, on: boolean) =>
    void saveSettings({ disabledPlugins: on ? disabled.filter((p) => p !== id) : [...disabled.filter((p) => p !== id), id] });

  return (
    <Modal title={t("Applied extensions")} onClose={busy ? undefined : onClose} wide testId="Extensions dialog">
      {!loadUser && <div className="banner orange ext-note">{t("User settings are off (Settings → Load user settings): plugins, user MCP servers and hooks are not loaded.")}</div>}
      {ext?.fallback && (
        <div className="banner orange ext-note col" style={{ alignItems: "flex-start", gap: 4 }} data-testid="Extensions fallback note">
          <span className="bold">{t("Extensions took longer than {0} s to load, so this session started without them.", Math.round(ext.fallback.timeoutMs / 1000))}</span>
          <span className="caption">{t("Check your VPN / network and access to the plugin marketplaces, then try again. Restarting keeps the session without extensions; re-opening the project tries them again.")}</span>
          {supportsSessionTools && <span className="caption">{t("ReviewGate also retries once by itself the next time Claude is idle.")}</span>}
          {retryError && (
            <span className="caption bold" role="alert" data-testid="Extensions retry error">
              ⚠ {retryError}
            </span>
          )}
        </div>
      )}
      {!ext ? (
        <div className="empty faint" style={{ height: "auto" }}>{t("Shown once a Claude session has started.")}</div>
      ) : (
        <div className="ext-body scroll">
          <div className="caption muted">
            {t("Setting sources: {0}", ext.settingSources.length > 0 ? ext.settingSources.join(", ") : t("none"))}
          </div>
          <LocalSettingsSection ext={ext} />
          <Plugins ext={ext} disabled={disabled} onToggle={togglePlugin} />
          <ModsSection ext={ext} /> {/* MARK: wave5 w5-graph — §43.3 the user's mods (read only) */}
          <section className="ext-section">
            <h4>{t("Hooks")}</h4>
            <label className="check ext-toggle">
              <input type="checkbox" checked={hooksOff} onChange={(e) => void saveSettings({ disableUserHooks: e.target.checked })} data-testid="Disable user hooks" />
              <span className="col" style={{ gap: 2 }}>
                <span>{t("Turn off my hooks (settings files and plugins)")}</span>
                <span className="caption muted">
                  {t("Also turns off your status line. ReviewGate's own safety hooks (budget, git guard, containment) keep running.")}
                </span>
              </span>
            </label>
            <HookList hooks={ext.hooks} applied={ext.userHooksDisabled} />
          </section>
          <McpServers />
          <section className="ext-section">
            <h4>{t("Skills and commands")}</h4>
            <div className="row wrap" style={{ gap: 6 }}>
              <CountList label={t("{0} skills", ext.skills.length)} items={ext.skills} />
              <CountList label={t("{0} commands", ext.slashCommands.length)} items={ext.slashCommands.map((c) => `/${c}`)} />
            </div>
          </section>
          {/* MARK: wave4d w4d-config — §42.3: CLAUDE.md and memory (open, edit the project's), the subagents */}
          <InstructionsSection ext={ext} />
        </div>
      )}
      <div className="actions">
        {(busy || starting) && <span className="spinner" />}
        {changed && <span className="caption orange grow" data-testid="Extensions pending change">{t("Changes apply from the next session.")}</span>}
        <span className="spacer" />
        {ext?.fallback ? (
          <button
            type="button"
            className="primary"
            disabled={busy || starting}
            onClick={() =>
              void act(async () => {
                const outcome = await retryExtensions();
                if (outcome !== "refused") onClose();
              })
            }
            data-testid="Retry with extensions"
          >
            {t("Retry with extensions")}
          </button>
        ) : (
          <button
            type="button"
            className={changed ? "primary" : ""}
            disabled={busy || !canRestart}
            onClick={() => void act(restartSession)}
            title={t("Restarts the Claude session (the conversation is resumed); the review is not touched")}
            data-testid="Restart for extensions"
          >
            {t("Restart now")}
          </button>
        )}
        <button type="button" onClick={onClose} disabled={busy}>{t("Done")}</button>
      </div>
    </Modal>
  );
}

function Plugins({ ext, disabled, onToggle }: { ext: SessionExtensions; disabled: string[]; onToggle: (id: string, on: boolean) => void }) {
  return (
    <section className="ext-section" data-testid="Extensions plugins">
      <h4>{t("Plugins")} <span className="faint num">{ext.plugins.filter((p) => p.enabled).length}/{ext.plugins.length}</span></h4>
      {ext.plugins.length === 0 && <span className="faint caption">{t("none")}</span>}
      <ul className="ext-plugins">
        {ext.plugins.map((p) => (
          <PluginRow key={p.id ?? p.path ?? p.name} plugin={p} wantOn={p.id ? !disabled.includes(p.id) : true} onToggle={onToggle} />
        ))}
      </ul>
      {ext.unresolvedDisabledPlugins.length > 0 && (
        <div className="caption orange">{t("Ignored (no such plugin): {0}", ext.unresolvedDisabledPlugins.join(", "))}</div>
      )}
    </section>
  );
}

function PluginRow({ plugin: p, wantOn, onToggle }: { plugin: ExtensionPlugin; wantOn: boolean; onToggle: (id: string, on: boolean) => void }) {
  const pending = wantOn !== p.enabled;
  return (
    <li className={p.enabled ? "" : "off"} data-testid={`Plugin ${p.name}`}>
      <label className="switch" title={p.id ? undefined : t("Plugins loaded with --plugin-dir cannot be turned off here")}>
        <input type="checkbox" checked={wantOn} disabled={!p.id} onChange={(e) => p.id && onToggle(p.id, e.target.checked)} />
        <span className="track" aria-hidden="true" />
      </label>
      <div className="col grow" style={{ gap: 1 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="bold truncate">{p.name}</span>
          {p.version && <span className="tiny faint">v{p.version}</span>}
          {!p.enabled && <span className="pill gray">{t("off")}</span>}
          {pending && <span className="pill orange">{wantOn ? t("on from next session") : t("off from next session")}</span>}
        </span>
        <span className="mono tiny faint truncate" title={p.path ?? undefined}>{p.id ?? t("local plugin (--plugin-dir)")}</span>
      </div>
    </li>
  );
}

function HookList({ hooks, applied }: { hooks: ExtensionHook[]; applied: boolean }) {
  if (hooks.length === 0) return <span className="faint caption">{t("No hooks besides ReviewGate's own.")}</span>;
  const label = (h: ExtensionHook) => (h.source === "user" ? t("user") : h.source === "project" ? t("project") : h.plugin ?? t("plugin"));
  return (
    <ul className="ext-files" data-testid="Extensions hooks">
      {hooks.map((h, i) => (
        <li key={`${h.path}-${i}`} className={h.active && !applied ? "" : "off"} title={h.path}>
          <span className={`pill ${h.source === "plugin" ? "" : "gray"}`}>{label(h)}</span>
          <span className="row wrap grow" style={{ gap: 3 }}>
            {h.events.map((e) => (
              <span key={e} className="ext-event mono">{e}</span>
            ))}
          </span>
          {!(h.active && !applied) && <span className="pill gray">{t("off")}</span>}
        </li>
      ))}
    </ul>
  );
}

function CountList({ label, items }: { label: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="ext-count">
      <button type="button" className="small" disabled={items.length === 0} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {label} {items.length > 0 && <span className="faint">{open ? "▾" : "▸"}</span>}
      </button>
      {open && (
        <span className="ext-count-list">
          {items.map((n) => (
            <span key={n} className="mono tiny">{n}</span>
          ))}
        </span>
      )}
    </span>
  );
}

/** §16 banner: the session fell back to running without the user's extensions (init timeout). */
export function ExtensionsFallbackBanner() {
  const fallback = useStore((s) => s.state.session.extensions?.fallback ?? null);
  const dismissedAt = useStore((s) => s.dismissedFallbackAt);
  // MARK: wave3 desktop-session — §36.7: closed stays closed for the project (the engine's own retry may fall back again; the
  // HUD's "확장 꺼짐" chip keeps saying it); the retry is retry_extensions.
  const silenced = useStore((s) => s.fallbackBannerSilenced);
  const dismiss = useStore((s) => s.silenceFallbackBanner);
  const retry = useStore((s) => s.retryExtensions);
  const retrying = useStore((s) => s.extensionsRetrying);
  const openDialog = useStore((s) => s.openDialog);
  const starting = useStore((s) => s.state.session.starting);
  if (!fallback || silenced || dismissedAt === fallback.at) return null;
  const secs = Math.round(fallback.timeoutMs / 1000);
  return (
    <div className="banner orange ext-fallback" role="status" data-testid="Extensions fallback banner">
      <span className="glyph" aria-hidden="true">⚠</span>
      <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="bold truncate">{t("Loading extensions took over {0} s, so the session started without them", secs)}</span>
        <span className="caption truncate" style={{ color: "var(--fg-2)" }}>
          {t("Plugins, user MCP servers and hooks are off. Check your VPN / network and access to the plugin marketplaces.")}
        </span>
      </span>
      <button type="button" className="small" disabled={starting || retrying} onClick={() => void retry()} data-testid="Fallback retry">{t("Retry with extensions")}</button>
      <button type="button" className="small plain" onClick={() => openDialog({ kind: "extensions" })}>{t("Details")}</button>
      <button type="button" className="plain small" onClick={dismiss} title={t("Dismiss")} aria-label={t("Dismiss")}>✕</button>
    </div>
  );
}
