/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.7 (robustness-05) in the HUD: "Extensions off" after the init-timeout fallback — it stays while the
 * session runs without the user's extensions (closing the banner does not hide it), until a retry succeeds or the project
 * is reopened. Its popover says why and offers "Retry with extensions" (`retry_extensions`; an older engine reopens the
 * project). While the CLI starts, the HUD's start chip names what it waits for (SessionChips.tsx, `waitingText`).
 */
import { useRef, useState } from "react";
import { t } from "../../i18n";
import { extensionsRetryBlockedReason, knowsSessionTools } from "../../sessionTools";
import { useStore } from "../../store";
import { AnchoredPopover } from "./HudPopovers";
import "../sessionTools.css";

export function ExtensionsOffChip() {
  const fallback = useStore((s) => (s.state.project ? (s.state.session.extensions?.fallback ?? null) : null));
  const retrying = useStore((s) => s.extensionsRetrying);
  const supported = useStore((s) => knowsSessionTools(s.state.session));
  const error = useStore((s) => s.extensionsRetryError);
  const phase = useStore((s) => s.state.gate.phase);
  const starting = useStore((s) => s.state.session.starting);
  const retry = useStore((s) => s.retryExtensions);
  const openDialog = useStore((s) => s.openDialog);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!fallback) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="pill orange ext-off-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t("Your plugins, MCP servers and hooks are off for this session — click for details")}
        data-testid="HUD extensions off"
      >
        {retrying ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">⚠</span>}
        {t("Extensions off")}
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} onClose={() => setOpen(false)} width={360} testId="Extensions off popover">
          <ExtensionsOffDetails
            timeoutMs={fallback.timeoutMs}
            supported={supported}
            error={error}
            retrying={retrying}
            blockedReason={extensionsRetryBlockedReason({ phase, starting, retrying })}
            onRetry={() => void retry()}
            onDetails={() => {
              setOpen(false);
              openDialog({ kind: "extensions" });
            }}
          />
        </AnchoredPopover>
      )}
    </>
  );
}

/** The popover's content (props only, so it renders in tests). */
export function ExtensionsOffDetails(p: { timeoutMs: number; supported: boolean; error: string | null; retrying: boolean; blockedReason: string | null; onRetry: () => void; onDetails: () => void }) {
  return (
    <div className="ext-off" role="group" aria-label={t("Extensions off")}>
      <span className="bold ext-off-title">⚠ {t("Extensions off")}</span>
      <span>{t("Loading extensions took over {0} s, so the session started without them", Math.round(p.timeoutMs / 1000))}</span>
      <span className="caption muted">{t("Plugins, user MCP servers and hooks are off. Check your VPN / network and access to the plugin marketplaces.")}</span>
      {p.supported && <span className="caption muted">{t("ReviewGate also retries once by itself the next time Claude is idle.")}</span>}
      {p.error && (
        <span className="caption orange" role="alert" data-testid="Extensions retry error">
          ⚠ {p.error}
        </span>
      )}
      <span className="row" style={{ gap: 8 }}>
        <button type="button" className="small primary" disabled={p.blockedReason !== null} onClick={p.onRetry} data-testid="HUD retry with extensions">
          {t("Retry with extensions")}
        </button>
        {p.retrying ? <span className="spinner" aria-hidden="true" /> : p.blockedReason && <span className="caption muted">{p.blockedReason}</span>}
        <span className="spacer" />
        <button type="button" className="small plain" onClick={p.onDetails}>{t("Details")}</button>
      </span>
    </div>
  );
}
