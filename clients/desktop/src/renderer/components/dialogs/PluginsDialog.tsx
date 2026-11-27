/**
 * docs/PROTOCOL.md §72.3: `/plugin` — the terminal's plugin panel (Installed, Discover, Marketplaces) on Claude Code's own
 * `claude plugin … --json` commands: turn a plugin on or off, update or uninstall it, install one a marketplace offers,
 * add, update or remove a marketplace. What installs or deletes asks first; every command's words and output show under the
 * list; Reload Plugins is `/reload-plugins`. As on the Mac (App PluginsSheet.swift); the words in pluginManager.ts.
 */
import { useEffect, useRef, useState } from "react";
import type { PluginAction, PluginInstalled } from "@reviewgate/engine";
import { t } from "../../i18n";
import {
  PLUGIN_TABS, installScopeLabel, loadPlugins, marketplaceLocation, pluginActionConfirms, pluginActionWords, pluginConfirmButton, pluginConfirmMessage, pluginConfirmTitle,
  pluginManageBlocker, pluginRunning, pluginScopeLabel, pluginTabTitle, pluginToggleHelp, pluginUnknown, reloadPlugins, reloadPluginsBlocker, runPlugin,
  type PluginRequest, type PluginResult, type PluginsList, type PluginTab,
} from "../../pluginManager";
import { useStore } from "../../store";
import { showToast } from "../../toast";
import { Modal } from "../Menu";

type Pending = { action: PluginAction; target: string };

export function PluginsDialog({ request, onClose }: { request: PluginRequest; onClose: () => void }) {
  const state = useStore((s) => s.state);
  const hasProject = state.project !== null;
  const [tab, setTab] = useState<PluginTab>(request.tab);
  const [list, setList] = useState<PluginsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<PluginResult | null>(request.unknown ? { action: "install", target: "", ok: false, message: pluginUnknown(request.unknown), output: "" } : null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [source, setSource] = useState("");
  const [reloadNote, setReloadNote] = useState<string | null>(null);
  const started = useRef(false);
  const load = async () => {
    const r = await loadPlugins();
    if ("list" in r) {
      setList(r.list);
      setError(null);
    } else setError(r.error);
  };
  const run = (action: PluginAction, target: string, scope?: "user" | "project" | "local") => {
    if (busy !== null) return;
    setBusy(pluginRunning(action, target));
    void runPlugin(action, target, scope).then(async (r) => {
      setLast(r);
      if (r.ok && action === "marketplace_add") setSource("");
      setBusy(null);
      await load();
    });
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load().then(() => {
      if (request.action && request.target) {
        if (pluginActionConfirms(request.action)) setPending({ action: request.action, target: request.target });
        else run(request.action, request.target);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the request of the `/plugin` that opened it, once
  }, []);
  const busyBlocker = busy !== null ? t("A claude plugin command is running") : null;
  const reloadBlocker = reloadPluginsBlocker(state) ?? busyBlocker;
  const reload = () => {
    void reloadPlugins(false).then((r) => {
      setReloadNote(r.notice);
      if (!r.warning) showToast(r.notice);
    });
  };
  const count = (k: PluginTab) => (list ? (k === "installed" ? list.installed.length : k === "discover" ? list.available.length : list.marketplaces.length) : null);
  const addBlocker = busyBlocker ?? (source.trim() === "" ? t("Type a marketplace's source first") : null);

  return (
    <Modal title={t("Plugins")} onClose={pending ? undefined : onClose} wide testId="Plugins dialog">
      <div className="row plugins-head">
        <span className="tiny muted">{t("Through Claude Code's own claude plugin commands — they change the same settings the terminal's /plugin does.")}</span>
        <span className="spacer" />
        <button type="button" className="small" disabled={busy !== null} onClick={() => void load()} title={busyBlocker ?? t("Ask Claude Code for the plugins again")} data-testid="Plugins refresh">{t("Refresh")}</button>
      </div>
      <div className="segmented plugins-tabs" role="tablist">
        {PLUGIN_TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)} data-testid={`Plugins tab ${k}`}>
            {pluginTabTitle(k)}{count(k) !== null && <span className="muted"> {count(k)}</span>}
          </button>
        ))}
      </div>
      <div className="plugins-body">
        {error !== null ? (
          <div className="small red">{error}</div>
        ) : list === null ? (
          <div className="small muted">{t("Asking Claude Code for its plugins…")}</div>
        ) : list.error ? (
          <div className="small red">{t("Claude Code could not list the plugins: {0}", list.error)}</div>
        ) : tab === "installed" ? (
          list.installed.length === 0 ? <Empty text={t("No plugins installed")} /> : list.installed.map((p) => (
            <InstalledRow key={p.id} plugin={p} busyBlocker={busyBlocker} run={(a) => run(a, p.id)} ask={(a) => setPending({ action: a, target: p.id })} />
          ))
        ) : tab === "discover" ? (
          list.available.length === 0 ? <Empty text={t("Your marketplaces offer no other plugins — add a marketplace first")} /> : list.available.map((p) => (
            <div key={p.id} className="plugins-row" data-testid="Plugins available">
              <div className="plugins-text">
                <span className="row">
                  <span className="small bold">{p.name}</span>
                  <span className="tiny muted">@{p.marketplace}</span>
                  {p.version && <span className="tiny muted mono">{p.version}</span>}
                </span>
                {p.description && <span className="tiny muted plugins-clamp" title={p.description}>{p.description}</span>}
              </div>
              <button type="button" className="small" disabled={busy !== null} title={busyBlocker ?? t("Install {0} — you pick the scope first", p.id)} onClick={() => setPending({ action: "install", target: p.id })} data-testid="Plugins install">
                {t("Install…")}
              </button>
            </div>
          ))
        ) : (
          <>
            {list.marketplaces.length === 0 ? <Empty text={t("No marketplaces yet — add one below")} /> : list.marketplaces.map((m) => (
              <div key={m.name} className="plugins-row" data-testid="Plugins marketplace">
                <div className="plugins-text">
                  <span className="small bold">{m.name}</span>
                  <span className="tiny muted mono truncate" title={marketplaceLocation(m)}>{marketplaceLocation(m)}</span>
                </div>
                <button type="button" className="small" disabled={busy !== null} title={busyBlocker ?? t("Fetch the marketplace's list again — claude plugin marketplace update")} onClick={() => run("marketplace_update", m.name)}>{t("Update")}</button>
                <button type="button" className="small" disabled={busy !== null} title={busyBlocker ?? pluginConfirmMessage("marketplace_remove")} onClick={() => setPending({ action: "marketplace_remove", target: m.name })}>{t("Remove…")}</button>
              </div>
            ))}
            <div className="row plugins-add">
              <input className="grow" value={source} placeholder={t("owner/repo, a git URL, a folder or a marketplace.json URL")} onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && addBlocker === null) setPending({ action: "marketplace_add", target: source.trim() }); }} data-testid="Plugins marketplace source" />
              <button type="button" className="small" disabled={addBlocker !== null} title={addBlocker ?? pluginConfirmMessage("marketplace_add")} onClick={() => setPending({ action: "marketplace_add", target: source.trim() })} data-testid="Plugins add marketplace">
                {t("Add Marketplace…")}
              </button>
            </div>
          </>
        )}
      </div>
      {busy !== null ? (
        <div className="tiny muted" data-testid="Plugins busy">{busy}</div>
      ) : last && (
        <div className="plugins-result" data-testid="Plugins result">
          <div className={`tiny ${last.ok ? "muted" : "orange"}`} title={last.message}>{last.ok ? "✓ " : "⚠ "}{last.message}</div>
          {last.output && last.output !== last.message && (
            <details className="tiny">
              <summary>{t("Command output")}</summary>
              <pre className="mono plugins-output">{last.output}</pre>
            </details>
          )}
        </div>
      )}
      <div className="tiny muted">{t("Changes reach this chat by themselves once Claude is not working; Reload Plugins applies them now. Plugin MCP servers start with the next chat.")}</div>
      <div className="actions">
        <button type="button" disabled={reloadBlocker !== null} title={reloadBlocker ?? t("Apply the plugin changes to this chat now, as the terminal's /reload-plugins")} onClick={reload} data-testid="Plugins reload">{t("Reload Plugins")}</button>
        {reloadNote && <span className="tiny muted truncate" title={reloadNote}>{reloadNote}</span>}
        <span className="spacer" />
        <button type="button" className="primary" onClick={onClose} autoFocus data-testid="Plugins done">{t("Done")}</button>
      </div>
      {pending && <ConfirmPlugin pending={pending} hasProject={hasProject} onCancel={() => setPending(null)} onGo={(scope) => { setPending(null); run(pending.action, pending.target, scope); }} />}
    </Modal>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="small muted plugins-empty">{text}</div>;
}

function InstalledRow({ plugin: p, busyBlocker, run, ask }: { plugin: PluginInstalled; busyBlocker: string | null; run: (a: PluginAction) => void; ask: (a: PluginAction) => void }) {
  const blocker = busyBlocker ?? pluginManageBlocker(p);
  return (
    <div className="plugins-row" data-testid={`Plugins installed ${p.name}`}>
      <div className="plugins-text">
        <span className="row">
          <span className="small bold">{p.name}</span>
          {p.marketplace && <span className="tiny muted">@{p.marketplace}</span>}
          <span className="tiny muted mono truncate">{p.version}</span>
          <span className="tiny plugins-scope">{pluginScopeLabel(p.scope)}</span>
        </span>
        {p.appOff && <span className="tiny orange">{t("Off in ReviewGate (Settings › Extensions) — it stays off in the app's chats")}</span>}
        {(p.errors ?? []).map((e) => <span key={e} className="tiny red plugins-clamp" title={e}>⚠ {e}</span>)}
        {(p.notes ?? []).map((n) => <span key={n} className="tiny muted plugins-clamp" title={n}>{n}</span>)}
      </div>
      <label className="plugins-switch" title={blocker ?? pluginToggleHelp(p.enabled)}>
        <input type="checkbox" role="switch" checked={p.enabled} disabled={blocker !== null} onChange={(e) => run(e.target.checked ? "enable" : "disable")} aria-label={p.name} data-testid="Plugins toggle" />
      </label>
      <button type="button" className="small" disabled={blocker !== null || !p.marketplace} title={blocker ?? t("Update to its marketplace's latest version — claude plugin update")} onClick={() => run("update")}>{t("Update")}</button>
      <button type="button" className="small" disabled={blocker !== null} title={blocker ?? pluginConfirmMessage("uninstall")} onClick={() => ask("uninstall")}>{t("Uninstall…")}</button>
    </div>
  );
}

/** The confirmation: what runs, why to be careful, and (to install) the scope, as the terminal's three install options. */
function ConfirmPlugin({ pending, hasProject, onCancel, onGo }: { pending: Pending; hasProject: boolean; onCancel: () => void; onGo: (scope?: "user" | "project" | "local") => void }) {
  const [scope, setScope] = useState<"user" | "project" | "local">("user");
  const install = pending.action === "install";
  return (
    <Modal title={pluginConfirmTitle(pending.action, pending.target)} onClose={onCancel} testId="Plugins confirm">
      <div className="small muted">{pluginConfirmMessage(pending.action)}</div>
      {install && (
        <div className="plugins-scopes" role="radiogroup" aria-label={t("Scope")} title={hasProject ? t("Where Claude Code turns it on") : t("Open a project to install for it — without one it installs for you")}>
          {(["user", "project", "local"] as const).map((s) => (
            <label key={s} className="row small">
              <input type="radio" name="plugin-scope" checked={scope === s} disabled={!hasProject && s !== "user"} onChange={() => setScope(s)} data-testid={`Plugins scope ${s}`} />
              {installScopeLabel(s)}
            </label>
          ))}
        </div>
      )}
      <div className="tiny muted mono">{`claude plugin ${pluginActionWords(pending.action)} ${pending.target}${install ? ` --scope ${scope}` : ""}`}</div>
      <div className="actions">
        <button type="button" onClick={onCancel}>{t("Cancel")}</button>
        <button type="button" className="primary" autoFocus onClick={() => onGo(install ? scope : undefined)} data-testid="Plugins confirm go">{pluginConfirmButton(pending.action)}</button>
      </div>
    </Modal>
  );
}
