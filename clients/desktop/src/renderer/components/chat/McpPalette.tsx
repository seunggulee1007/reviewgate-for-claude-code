/**
 * MARK: composer parity — docs/PROTOCOL.md §56.4: `/mcp`, as in the terminal — the session's MCP servers over the composer
 * (the Mac app's `ComposerMcpPalette`): per server its status dot (a spinner while an action runs), name, where it comes
 * from, its MCP tool count, the status, and its own buttons (the Enter action, the on / off switch, Open Config File). The
 * keys live in Composer.tsx; the rules in src/renderer/mcpPalette.ts.
 */
import { useEffect, useRef } from "react";
import type { McpServerInfo } from "@reviewgate/engine";
import { t } from "../../i18n";
import { mcpSourceLabel, mcpTone } from "../../mcp";
import { actionTitle, commandFilter, disabledReason, isOff, primaryAction, rowStatus, toggleAction, unavailableReason, type McpAction, type McpCommand, type McpPaletteContext } from "../../mcpPalette";
import "../extensions/extensions.css";
import "./slash.css";

export function McpPalette(props: {
  command: McpCommand;
  rows: McpServerInfo[];
  /** Every server the session has (the count; the empty state). */
  total: number;
  loaded: boolean;
  selection: number;
  busy: Record<string, unknown>;
  ctx: McpPaletteContext;
  /** The last failed action, in words. */
  error: string | null;
  onSelect: (index: number) => void;
  onAction: (action: McpAction, server: McpServerInfo) => void;
  onOpenConfig: (server: McpServerInfo) => void;
  onRefresh: () => void;
  onDismissError: () => void;
  onAddServer: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${props.selection}"]`) as HTMLElement | null | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [props.selection, props.rows]);
  const unavailable = unavailableReason(props.ctx);
  const filter = commandFilter(props.command);
  const runs = props.command.kind === "run" ? actionTitle(props.command.verb) : null;

  return (
    <div className="palette slash-palette mcp-palette" role="dialog" aria-label={t("MCP servers")} data-testid="MCP palette" onMouseDown={(e) => e.preventDefault()}>
      <div className="mcp-palette-head">
        <span className="slash-name">/mcp</span>
        <span className="bold">{t("MCP servers")}</span>
        <span className="pill gray" aria-label={t("{0} servers", props.total)}>{props.total}</span>
        {runs && <span className="badge" title={t("↩ runs this on the server named after it, or on the selected one")}>{runs}</span>}
        <span className="spacer" />
        <button
          type="button"
          className="plain tiny"
          disabled={unavailable !== null}
          onClick={props.onRefresh}
          title={unavailable ?? t("Refresh the server status")}
          aria-label={t("Refresh MCP servers")}
          data-testid="MCP palette refresh"
        >
          ↻
        </button>
      </div>
      {props.error && (
        <div className="mcp-palette-error caption orange" role="alert" data-testid="MCP palette error">
          <span className="grow">{props.error}</span>
          <button type="button" className="plain tiny" onClick={props.onDismissError} title={t("Dismiss")} aria-label={t("Dismiss")}>×</button>
        </div>
      )}
      {props.rows.length === 0 ? (
        <div className="note" role="status" data-testid="MCP palette empty">
          {props.total > 0 ? (
            t("No server matches “{0}”", filter)
          ) : !props.loaded && unavailable === null ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {t("Loading MCP servers…")}
            </>
          ) : !props.loaded && unavailable ? (
            unavailable
          ) : (
            <>
              <span className="grow">{t("No MCP servers")}</span>
              <button type="button" className="small" onClick={props.onAddServer} title={t("Add an MCP server to this session, the project or your user settings")} data-testid="MCP palette add server">
                {t("Add server…")}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="items" ref={listRef} role="listbox" aria-label={t("MCP servers")}>
          {props.rows.map((s, i) => (
            <McpRow
              key={s.name}
              server={s}
              index={i}
              selected={i === props.selection}
              busy={props.busy[s.name] !== undefined}
              ctx={props.ctx}
              onSelect={() => props.onSelect(i)}
              onAction={(a) => props.onAction(a, s)}
              onOpenConfig={() => props.onOpenConfig(s)}
            />
          ))}
        </div>
      )}
      <div className="foot" title={t("↑↓ select · ↩ reconnect (log in when it needs a login, turn on when it is off) · ⌥↩ turn on or off · ⌘↩ open the config file · ⇥ complete the name · esc close — or type /mcp reconnect <name>")}>
        {t("↑↓ select · ↩ reconnect / log in / turn on · ⌥↩ on/off · ⌘↩ config file · ⇥ complete · esc close")}
      </div>
    </div>
  );
}

function McpRow(props: {
  server: McpServerInfo;
  index: number;
  selected: boolean;
  busy: boolean;
  ctx: McpPaletteContext;
  onSelect: () => void;
  onAction: (a: McpAction) => void;
  onOpenConfig: () => void;
}) {
  const s = props.server;
  const primary = primaryAction(s);
  const toggle = toggleAction(s);
  const primaryWhy = disabledReason(primary, s, props.busy, props.ctx);
  const toggleWhy = disabledReason(toggle, s, props.busy, props.ctx);
  const status = rowStatus(s, props.busy);
  const file = s.origin?.file ?? null;
  const tone = isOff(s) ? "gray" : mcpTone(s.status);
  const label = [s.name, s.source !== "unknown" ? mcpSourceLabel(s.source) : null, status, s.toolCount !== null ? t("{0} MCP tools", s.toolCount) : null, s.error]
    .filter((x): x is string => !!x)
    .join(", ");
  return (
    <div
      role="option"
      aria-selected={props.selected}
      aria-label={label}
      className={`item mcp-palette-row ${props.selected ? "selected" : ""} ${isOff(s) ? "off" : ""}`}
      data-index={props.index}
      onMouseEnter={props.onSelect}
      onClick={props.onSelect}
      data-testid={`MCP palette ${s.name}`}
    >
      {props.busy ? <span className="spinner" aria-hidden="true" /> : <span className={`status-dot ${tone}`} aria-hidden="true" />}
      <span className="slash-name" title={[`${s.name} — ${status}`, s.error, t("↩ {0} · ⌥↩ {1} · ⌘↩ Open Config File", actionTitle(primary), actionTitle(toggle))].filter((x) => !!x).join("\n")}>
        {s.name}
      </span>
      {s.source !== "unknown" && <span className="pill gray mcp-source">{mcpSourceLabel(s.source)}</span>}
      <span className="spacer" />
      {s.toolCount !== null && <span className="tiny faint nowrap">{t("{0} MCP tools", s.toolCount)}</span>}
      <span className={`caption nowrap ${s.status === "failed" || s.status === "needs-auth" ? "orange" : "muted"}`}>{status}</span>
      <button
        type="button"
        className="small nowrap"
        disabled={primaryWhy !== null}
        onClick={(e) => (e.stopPropagation(), props.onAction(primary))}
        title={primaryWhy ?? t("{0} (↩)", actionTitle(primary))}
        data-testid={`MCP palette primary ${s.name}`}
      >
        {actionTitle(primary)}
      </button>
      <label className="switch" title={toggleWhy ?? t("{0} (⌥↩)", actionTitle(toggle))} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={!isOff(s)}
          disabled={toggleWhy !== null}
          onChange={() => props.onAction(toggle)}
          aria-label={`${actionTitle(toggle)} ${s.name}`}
          data-testid={`MCP palette toggle ${s.name}`}
        />
        <span className="track" aria-hidden="true" />
      </label>
      <button
        type="button"
        className="plain tiny"
        disabled={file === null}
        onClick={(e) => (e.stopPropagation(), props.onOpenConfig())}
        title={file ? t("{0} (⌘↩)", t("Open the file that defines this server")) : t("ReviewGate does not know which file defines this server")}
        aria-label={t("Open Config File")}
        data-testid={`MCP palette config ${s.name}`}
      >
        ⎘
      </button>
    </div>
  );
}
