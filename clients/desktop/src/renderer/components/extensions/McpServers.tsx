/**
 * MCP servers (docs/PROTOCOL.md §22) inside "Applied extensions": the live list (`mcp_status`) with status dot,
 * source, transport, tools, the redacted config and the error; reconnect, on / off, remove (scope-aware, confirmed),
 * sign-in for needs-auth; the "서버 추가" form; and the restart banner when a config file changed. Env / header values
 * are typed into password fields and sent once — the engine never sends them back, and nothing here logs them.
 */
import { useEffect, useState } from "react";
import type { McpScope, McpServerInfo } from "@reviewgate/engine";
import { t } from "../../i18n";
import { configLine, EMPTY_FORM, mcpSourceLabel, mcpStatusLabel, mcpTone, scopeHelp, sortServers, splitArgs, validateForm, type FormErrors, type KV, type McpForm } from "../../mcp";
// MARK: wave4d w4d-config — §42.3: where a server is defined, every workbench, the login wait
import { isFromParentFolder, isOffForRepository, notRemovableReason, originLine, parentRemoveHelp, removeScope, terminalCommand } from "../../claudeConfig";
import { isRunning, useStore } from "../../store";
import { knowsSessionTools, updateReason } from "../../sessionTools"; // MARK: wave3 desktop-session

export function McpServers() {
  const mcp = useStore((s) => s.mcp);
  const fallback = useStore((s) => s.state.session.extensions?.mcpServers ?? null);
  const notice = useStore((s) => s.mcpNotice);
  const dismiss = useStore((s) => s.dismissMcpNotice);
  const refresh = useStore((s) => s.mcpRefresh);
  const restartSession = useStore((s) => s.restartSession);
  const canRestart = useStore((s) => s.state.session.canRestart && !isRunning(s.state) && !s.state.session.starting);
  const sessionOpen = useStore((s) => s.state.session.open);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (sessionOpen) void refresh();
  }, [sessionOpen, refresh]);

  const servers = mcp.loaded ? sortServers(mcp.servers) : [];
  const count = mcp.loaded ? servers.length : (fallback?.length ?? 0);

  return (
    <section className="ext-section" data-testid="MCP servers">
      <h4 className="mcp-head">
        <span>{t("MCP servers")}</span>
        <span className="faint num">{count}</span>
        <span className="spacer" />
        <button
          type="button"
          className="plain small"
          disabled={!sessionOpen || refreshing}
          onClick={() => {
            setRefreshing(true);
            void refresh().finally(() => setRefreshing(false));
          }}
          title={t("Ask the session for the current status")}
          data-testid="MCP refresh"
        >
          {refreshing ? <span className="spinner" /> : "↻"} {t("Refresh")}
        </button>
        <button type="button" className={`small ${adding ? "active" : ""}`} disabled={!sessionOpen} onClick={() => setAdding((v) => !v)} aria-expanded={adding} data-testid="MCP add toggle">
          + {t("Add server")}
        </button>
      </h4>
      {mcp.restartRequired && (
        <div className="banner blue mcp-banner" data-testid="MCP restart banner">
          <span className="grow">{t("A Claude Code config file changed — the running session picks it up after a restart.")}</span>
          <button type="button" className="small primary" disabled={!canRestart} onClick={() => void restartSession()} title={canRestart ? undefined : t("Wait for Claude to finish the turn")} data-testid="MCP restart now">
            {t("Restart now")}
          </button>
        </div>
      )}
      {notice && (
        <div className="banner orange mcp-banner" data-testid="MCP notice">
          <span className="grow">{notice}</span>
          <button type="button" className="plain small" onClick={dismiss} aria-label={t("Dismiss")}>✕</button>
        </div>
      )}
      {adding && <AddServerForm existing={mcp.servers.map((s) => s.name)} onDone={() => setAdding(false)} />}
      {!mcp.loaded ? (
        fallback && fallback.length > 0 ? (
          <div className="ext-grid">
            {fallback.map((m, i) => (
              <span key={`${m.name}-${i}`} className="ext-mcp" title={m.status}>
                <span className={`status-dot ${mcpTone(m.status)}`} />
                <span className="mono truncate">{m.name}</span>
                <span className={`caption ${mcpTone(m.status) === "gray" ? "muted" : mcpTone(m.status)}`}>{mcpStatusLabel(m.status)}</span>
              </span>
            ))}
          </div>
        ) : (
          <span className="faint caption">{sessionOpen ? t("none") : t("Shown once a Claude session has started.")}</span>
        )
      ) : servers.length === 0 ? (
        <span className="faint caption">{t("No MCP servers. Add one for this session, the project or your user settings.")}</span>
      ) : (
        <ul className="mcp-list">
          {servers.map((s) => (
            <ServerRow key={s.name} server={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ServerRow({ server: s }: { server: McpServerInfo }) {
  const busy = useStore((st) => st.mcp.busy[s.name]);
  const reconnect = useStore((st) => st.mcpReconnect);
  const toggle = useStore((st) => st.mcpToggle);
  const remove = useStore((st) => st.mcpRemove);
  const auth = useStore((st) => st.mcpAuth);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const enabled = s.status !== "disabled" && !s.disabledByUser;
  const tone = mcpTone(s.status);
  // MARK: wave3 desktop-session — §36.6: a local server is removed with scope local (an engine that has it).
  const localScope = useStore((st) => knowsSessionTools(st.state.session));
  // MARK: wave4d w4d-config — §42.3: the engine's origin decides; a parent folder's file is named in the confirmation.
  const scope = removeScope(s, { localScope });
  const repoToggle = useStore((st) => st.mcp.repositoryToggle === true);
  const origin = originLine(s, null);
  const command = terminalCommand(s);
  const [copied, setCopied] = useState(false);
  const line = configLine(s);
  const keys = [...(s.config?.envKeys ?? []).map((k) => `${k}=…`), ...(s.config?.headerKeys ?? []).map((k) => `${k}: …`)];
  return (
    <li className={`mcp-row ${enabled ? "" : "off"}`} data-testid={`MCP ${s.name}`} data-status={s.status}>
      <label className="switch" title={enabled ? t("Turn off for this project (kept across sessions)") : t("Turn on")}>
        <input type="checkbox" checked={enabled} disabled={!!busy} onChange={(e) => void toggle(s.name, e.target.checked)} data-testid={`MCP toggle ${s.name}`} />
        <span className="track" aria-hidden="true" />
      </label>
      <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className={`status-dot ${tone}`} title={mcpStatusLabel(s.status)} />
          <span className="mono bold truncate" title={s.name}>{s.name}</span>
          <span className={`caption ${tone === "gray" ? "muted" : tone}`}>{mcpStatusLabel(s.status)}</span>
          <span className="pill gray mcp-source" title={s.scope ?? undefined}>{mcpSourceLabel(s.source)}</span>
          {isOffForRepository(s) && <span className="pill orange" data-testid={`MCP off everywhere ${s.name}`}>{t("Off in every workbench")}</span>}
          {s.transport !== "unknown" && <span className="tiny faint">{s.transport}</span>}
          {s.serverInfo?.version && <span className="tiny faint">v{s.serverInfo.version}</span>}
          <span className="spacer" />
          {busy && <span className="spinner" aria-hidden="true" />}
        </div>
        {line && (
          <div className="mono tiny faint truncate" title={line}>
            {line}
            {keys.length > 0 && <span className="mcp-keys"> · {keys.join(" ")}</span>}
          </div>
        )}
        {origin && (
          <div className={`tiny truncate ${isFromParentFolder(s) ? "orange" : "faint"}`} title={s.origin?.file ?? undefined} data-testid={`MCP origin ${s.name}`}>
            {origin}
          </div>
        )}
        {s.authWaiting && s.status === "needs-auth" && <div className="caption muted">{t("Log in in Terminal — ReviewGate reconnects the server once the login took. Not yet? Reconnect.")}</div>}
        {s.error && <div className="caption red mcp-error" title={s.error}>{s.error}</div>}
        <div className="row wrap" style={{ gap: 4 }}>
          {s.toolCount !== null && (
            <button type="button" className="plain tiny" disabled={s.tools.length === 0} onClick={() => setToolsOpen((v) => !v)} aria-expanded={toolsOpen} data-testid={`MCP tools ${s.name}`}>
              {t("{0} MCP tools", s.toolCount)} {s.tools.length > 0 && (toolsOpen ? "▾" : "▸")}
            </button>
          )}
          <span className="spacer" />
          {s.status === "needs-auth" && (
            <button type="button" className="small primary" disabled={!!busy} onClick={() => void auth(s.name)} title={t("Opens Terminal with claude /mcp, where you log in; ReviewGate then reconnects the server")} data-testid={`MCP auth ${s.name}`}>
              {t("Sign in")}
            </button>
          )}
          {enabled && (
            <button type="button" className="small" disabled={!!busy} onClick={() => void reconnect(s.name)} data-testid={`MCP reconnect ${s.name}`}>
              ↻ {t("Reconnect")}
            </button>
          )}
          {repoToggle && !isOffForRepository(s) && (
            <button type="button" className="small plain" disabled={!!busy} onClick={() => void toggle(s.name, false, "repository")} title={t("Turn on or off in every workbench of this repository")} data-testid={`MCP off everywhere toggle ${s.name}`}>
              {t("Turn Off in Every Workbench")}
            </button>
          )}
          {repoToggle && !enabled && (
            <button type="button" className="small plain" disabled={!!busy} onClick={() => void toggle(s.name, true, "repository")} title={t("Turn on or off in every workbench of this repository")} data-testid={`MCP on everywhere toggle ${s.name}`}>
              {t("Turn On in Every Workbench")}
            </button>
          )}
          {!scope && command &&
            (confirm ? (
              <span className="row wrap mcp-confirm" style={{ gap: 4 }} data-testid={`MCP remove command ${s.name}`}>
                <span className="caption orange">{notRemovableReason(s, null)}</span>
                <code className="mono tiny">{command}</code>
                <button
                  type="button"
                  className="small"
                  onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => undefined)}
                >
                  {copied ? t("Copied") : t("Copy Command")}
                </button>
                <button type="button" className="plain small" onClick={() => setConfirm(false)}>{t("Cancel")}</button>
              </span>
            ) : (
              <button type="button" className="small plain danger" disabled={!!busy} onClick={() => (setCopied(false), setConfirm(true))} title={notRemovableReason(s, null) ?? undefined} data-testid={`MCP remove ${s.name}`}>
                {t("Delete")}
              </button>
            ))}
          {scope &&
            (confirm ? (
              <span className="row mcp-confirm" style={{ gap: 4 }}>
                <span className="caption orange">{parentRemoveHelp(s, null) ?? removeHelp(scope)}</span>
                <button type="button" className="small danger" disabled={!!busy} onClick={() => void remove(s.name, scope, isFromParentFolder(s) ? s.origin?.file ?? undefined : undefined).then((err) => err === null && setConfirm(false))} data-testid={`MCP remove confirm ${s.name}`}>
                  {t("Delete")}
                </button>
                <button type="button" className="plain small" onClick={() => setConfirm(false)}>{t("Cancel")}</button>
              </span>
            ) : (
              <button type="button" className="small plain danger" disabled={!!busy} onClick={() => setConfirm(true)} data-testid={`MCP remove ${s.name}`}>
                {t("Delete")}
              </button>
            ))}
        </div>
        {toolsOpen && (
          <div className="mcp-tools">
            {s.tools.map((name) => (
              <span key={name} className="mono tiny">{name}</span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function removeHelp(scope: McpScope): string {
  switch (scope) {
    case "session":
      return t("Remove from this session?");
    case "project":
      return t("Remove from the project's .mcp.json?");
    case "user":
      return t("Remove from your ~/.claude.json (every project)?");
    // MARK: wave3 desktop-session — §36.6
    case "local":
      return t("Remove from this project's entry in ~/.claude.json (only you)?");
  }
}

function AddServerForm({ existing, onDone }: { existing: string[]; onDone: () => void }) {
  const add = useStore((s) => s.mcpAdd);
  // MARK: wave3 desktop-session — §36.6: "Local (this project, only me)" with an engine that takes scope local.
  const localScope = useStore((s) => knowsSessionTools(s.state.session));
  const [f, setF] = useState<McpForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const patch = (p: Partial<McpForm>) => {
    setF((cur) => ({ ...cur, ...p }));
    setErrors({});
    setFailure(null);
  };
  const args = f.type === "stdio" ? splitArgs(f.args) : [];

  const submit = async () => {
    const v = validateForm(f, existing);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setBusy(true);
    const err = await add(v.name, v.scope, v.config);
    setBusy(false);
    if (err === null) {
      setF(EMPTY_FORM);
      onDone();
    } else setFailure(err);
  };

  return (
    <form
      className="mcp-form"
      data-testid="MCP add form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mcp-form-grid">
        <label htmlFor="mcp-name">{t("Name")}</label>
        <div className="col" style={{ gap: 3 }}>
          <input id="mcp-name" type="text" className="mono" value={f.name} placeholder="github" autoFocus onChange={(e) => patch({ name: e.target.value })} data-testid="MCP name" />
          {errors.name && <span className="caption red">{errors.name}</span>}
        </div>
        <span>{t("Where")}</span>
        <div className="col" style={{ gap: 4 }}>
          <div className="segmented mini" role="radiogroup">
            {(["session", "local", "project", "user"] as McpScope[]).map((sc) => (
              <button
                key={sc}
                type="button"
                className={f.scope === sc ? "active" : ""}
                disabled={sc === "local" && !localScope}
                title={sc === "local" && !localScope ? updateReason() : undefined}
                onClick={() => patch({ scope: sc })}
                data-testid={`MCP scope ${sc}`}
              >
                {sc === "session" ? t("This session") : sc === "local" ? t("Local (this project, only me)") : sc === "project" ? t("Project") : t("User")}
              </button>
            ))}
          </div>
          <span className="caption muted">{scopeHelp(f.scope)}</span>
          {!localScope && (
            <span className="caption faint" data-testid="MCP scope local unavailable">
              {t("Local (this project, only me)")}: {updateReason()}
            </span>
          )}
        </div>
        <span>{t("Type")}</span>
        <div className="segmented mini" role="radiogroup">
          {(["stdio", "http", "sse"] as const).map((ty) => (
            <button key={ty} type="button" className={f.type === ty ? "active" : ""} onClick={() => patch({ type: ty })} data-testid={`MCP type ${ty}`}>
              {ty === "stdio" ? t("Command (stdio)") : ty.toUpperCase()}
            </button>
          ))}
        </div>
        {f.type === "stdio" ? (
          <>
            <label htmlFor="mcp-cmd">{t("Command")}</label>
            <div className="col" style={{ gap: 3 }}>
              <input id="mcp-cmd" type="text" className="mono" value={f.command} placeholder="npx" onChange={(e) => patch({ command: e.target.value })} data-testid="MCP command" />
              {errors.command && <span className="caption red">{errors.command}</span>}
            </div>
            <label htmlFor="mcp-args">{t("Arguments")}</label>
            <div className="col" style={{ gap: 3 }}>
              <input id="mcp-args" type="text" className="mono" value={f.args} placeholder='-y @modelcontextprotocol/server-github "--root=a b"' onChange={(e) => patch({ args: e.target.value })} data-testid="MCP args" />
              {args.length > 0 && (
                <span className="mcp-argchips">
                  {args.map((a, i) => (
                    <span key={i} className="mono tiny">{a}</span>
                  ))}
                </span>
              )}
              {errors.args && <span className="caption red">{errors.args}</span>}
            </div>
            <span>{t("Environment")}</span>
            <KVRows rows={f.env} onChange={(env) => patch({ env })} keyPlaceholder="GITHUB_TOKEN" sep="=" error={errors.env} testId="MCP env" />
          </>
        ) : (
          <>
            <label htmlFor="mcp-url">URL</label>
            <div className="col" style={{ gap: 3 }}>
              <input id="mcp-url" type="text" className="mono" value={f.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => patch({ url: e.target.value })} data-testid="MCP url" />
              {errors.url && <span className="caption red">{errors.url}</span>}
            </div>
            <span>{t("Headers")}</span>
            <KVRows rows={f.headers} onChange={(headers) => patch({ headers })} keyPlaceholder="Authorization" sep=":" error={errors.headers} testId="MCP headers" />
          </>
        )}
      </div>
      {failure && <div className="banner red mcp-banner" data-testid="MCP add error">{failure}</div>}
      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
        <span className="tiny faint grow">{t("Values are sent to Claude Code once and never shown again.")}</span>
        {busy && <span className="spinner" />}
        <button type="button" className="small" onClick={onDone} disabled={busy}>{t("Cancel")}</button>
        <button type="submit" className="small primary" disabled={busy} data-testid="MCP add submit">{t("Add")}</button>
      </div>
    </form>
  );
}

function KVRows({ rows, onChange, keyPlaceholder, sep, error, testId }: { rows: KV[]; onChange: (rows: KV[]) => void; keyPlaceholder: string; sep: string; error?: string; testId: string }) {
  const set = (i: number, p: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="col" style={{ gap: 4 }} data-testid={testId}>
      {rows.map((r, i) => (
        <div key={i} className="mcp-kv">
          <input type="text" className="mono" value={r.key} placeholder={keyPlaceholder} onChange={(e) => set(i, { key: e.target.value })} aria-label={t("Name")} />
          <span className="faint mono">{sep}</span>
          <input type="password" className="mono" value={r.value} placeholder={t("value")} autoComplete="off" onChange={(e) => set(i, { value: e.target.value })} aria-label={t("Value")} />
          <button type="button" className="plain small" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={t("Remove")}>✕</button>
        </div>
      ))}
      <button type="button" className="plain small mcp-kv-add" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        + {t("Add row")}
      </button>
      {error && <span className="caption red">{error}</span>}
    </div>
  );
}
