/** Everything the session loaded, grouped, so the user knows what `/name` can reach (the Mac app's `CapabilitiesPopover`). */
import { useEffect, useRef } from "react";
import type { SessionCapabilities } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { mcpStatusLabel, mcpTone } from "../../mcp";
import { capabilitiesCaption, sessionStarting } from "../../slashCommands";
import { NotAppliedHint } from "../extensions/LocalSettings";

function Group({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="group">
      <h4>{title}</h4>
      {items.length === 0 && <span className="faint">{t("none")}</span>}
      {items.map((name) => (
        <span key={name} className="mono">{name}</span>
      ))}
    </div>
  );
}

export function CapabilitiesPopover({ caps, onClose }: { caps: SessionCapabilities | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const openDialog = useStore((s) => s.openDialog);
  // wave3 desktop-session — §36.5: no capabilities yet reads "Starting session…" (never "enable user settings" when they are on).
  const starting = useStore((s) => sessionStarting(s.state.session));
  const loadUserSettings = useStore((s) => s.settings?.loadUserSettings !== false);
  const ext = useStore((s) => s.state.session.extensions ?? null);
  const live = useStore((s) => (s.mcp.loaded ? s.mcp.servers : null));
  const servers = live ?? caps?.mcpServers ?? [];
  return (
    <div className="popover" ref={ref} data-testid="Capabilities popover">
      <div className="row caps-head">
        <span className="bold grow">{t("This session")}</span>
        <button
          type="button"
          className="small"
          onClick={() => {
            onClose();
            openDialog({ kind: "extensions" });
          }}
          title={t("Plugins, hooks, MCP servers and CLAUDE.md applied to this session — turn plugins or hooks off")}
          data-testid="Open extensions"
        >
          {t("Applied extensions…")}
        </button>
      </div>
      {ext?.fallback && <div className="caption orange caps-fallback">⚠ {t("Started without extensions (loading timed out)")}</div>}
      {/* wave3 desktop-session — §36.6: local settings this session left out */}
      <NotAppliedHint
        onOpen={() => {
          onClose();
          openDialog({ kind: "extensions" });
        }}
      />
      {caps ? (
        <>
          <Group title={t("Skills")} items={caps.skills} />
          <Group title={t("Commands")} items={caps.slashCommands} />
          <Group title={t("Plugins")} items={caps.plugins} />
          <div className="group">
            <h4>{t("MCP servers")}</h4>
            {servers.length === 0 && <span className="faint">{t("none")}</span>}
            {servers.map((server, i) => (
              <span key={`${server.name}-${i}`} className="row" style={{ gap: 6 }}>
                <span className={`status-dot ${mcpTone(server.status)}`} />
                <span className="mono">{server.name}</span>
                <span className={`caption ${mcpTone(server.status) === "gray" ? "muted" : mcpTone(server.status)}`}>{mcpStatusLabel(server.status)}</span>
              </span>
            ))}
            {servers.some((s) => s.status === "failed" || s.status === "needs-auth") && (
              <button
                type="button"
                className="plain tiny"
                style={{ alignSelf: "flex-start", color: "var(--accent)" }}
                onClick={() => {
                  onClose();
                  openDialog({ kind: "extensions" });
                }}
                data-testid="Caps fix MCP"
              >
                {t("Fix in Applied extensions…")}
              </button>
            )}
          </div>
        </>
      ) : (
        <span className="muted" data-testid="Capabilities empty">{capabilitiesCaption({ caps: null, cached: false, mcpCount: 0, starting, loadUserSettings })}</span>
      )}
    </div>
  );
}
