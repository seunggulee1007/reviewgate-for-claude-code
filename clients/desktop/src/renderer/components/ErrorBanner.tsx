/**
 * Non-modal error banner at the top of the window (docs/AUDIT-2026-09-14.md §4.2): the last `error`
 * event (with its engine `scope`) or client-side failure that set `lastError`, with Dismiss and
 * Open log. Transcript rows still exist; this makes failures visible outside the chat pane.
 * §19.6 codes add their way out: `auth_required` → the `claude /login` instructions (copyable), a missing CLI
 * (`cli_not_found` / `cli_not_executable`) → Restart / Reopen and Settings. Session start / recovery and the notices
 * (§30 / §29 / §33.4, `lfs_missing`) have their own banner: SessionErrorBanner.
 */
import { useState } from "react";
import { presentationOf } from "../errorCodes";
import { t } from "../i18n";
import { SESSION_BANNER_CODES } from "../sessionErrors";
import { extensionsWaitingOf, waitingDetail, waitingText } from "../sessionTools"; // MARK: wave3 desktop-session
import { useStore } from "../store";
import { SessionErrorBanner } from "./SessionErrorBanner";
import { ContinueWorkButton, LimitResumeToggle } from "./chat/LongWorkChips"; // MARK: wave4 w4-longwork

const SCOPE_LABEL: Record<string, () => string> = {
  engine: () => t("Engine"),
  session: () => t("Session"),
  git: () => t("Git"),
  pr: () => t("Pull requests"),
  client: () => t("Client"),
};

export const LOGIN_COMMAND = "claude /login";

/** Restart the session when the engine can, else reopen the project (a fresh engine session). */
function RestartButton() {
  const canRestart = useStore((s) => s.state.session.canRestart);
  const hasProject = useStore((s) => s.state.project !== null);
  const starting = useStore((s) => s.state.session.starting);
  const restartSession = useStore((s) => s.restartSession);
  const reopen = useStore((s) => s.retryWithExtensions);
  const dismissError = useStore((s) => s.dismissError);
  if (canRestart) {
    return (
      <button type="button" className="small" disabled={starting} onClick={() => { dismissError(); void restartSession(); }} data-testid="Error restart session">
        {t("Restart session")}
      </button>
    );
  }
  if (!hasProject) return null;
  return (
    <button type="button" className="small" disabled={starting} onClick={() => { dismissError(); void reopen(); }} data-testid="Error reopen project">
      {t("Reopen project")}
    </button>
  );
}

/** §22 `mcp_auth_required`: opens the CLI's MCP dialog in a terminal (`mcp_auth`), then the list shows the new status. */
function McpSignIn({ server }: { server: string }) {
  const auth = useStore((s) => s.mcpAuth);
  const openDialog = useStore((s) => s.openDialog);
  const dismissError = useStore((s) => s.dismissError);
  return (
    <>
      <button
        type="button"
        className="small primary"
        onClick={() => {
          dismissError();
          void auth(server);
          openDialog({ kind: "extensions" });
        }}
        title={t("Opens a terminal with claude /mcp to sign in; reconnect afterwards")}
        data-testid="Error MCP sign in"
      >
        {t("Sign in")}
      </button>
    </>
  );
}

function LoginHelp() {
  const [copied, setCopied] = useState(false);
  return (
    <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
      <span className="bold truncate" data-testid="Error message">{t("Claude login required")}</span>
      <span className="caption" style={{ color: "var(--fg-2)" }}>
        {t("Run this in a terminal, finish the login, then restart the session:")}{" "}
        <code className="mono" data-testid="Login command">{LOGIN_COMMAND}</code>{" "}
        <button
          type="button"
          className="plain tiny"
          onClick={() => void window.rg.copyText(LOGIN_COMMAND).then(() => setCopied(true))}
          data-testid="Copy login command"
        >
          {copied ? t("Copied") : t("Copy")}
        </button>
      </span>
    </span>
  );
}

export function ErrorBanner() {
  const banner = useStore((s) => s.errorBanner);
  const dismissError = useStore((s) => s.dismissError);
  const openDialog = useStore((s) => s.openDialog);
  if (!banner) return null;
  // §30 / §29 / §33.4 / lfs_missing: their own sentence, the CLI's words, ×N and the way out (src/renderer/sessionErrors.ts).
  if (banner.code && SESSION_BANNER_CODES.has(banner.code)) return <SessionErrorBanner banner={banner} />;
  const kind = presentationOf(banner.code);
  const tooltip = banner.detail ? `${banner.message}\n\n${banner.detail}` : banner.message;
  return (
    <div className={`banner error-banner ${banner.fatal || kind === "fatalSession" ? "red" : kind === "info" ? "blue" : "orange"}`} role="alert" data-testid="Error banner" data-code={banner.code ?? ""} title={tooltip}>
      <span className="pill gray" data-testid="Error scope">{(SCOPE_LABEL[banner.scope] ?? SCOPE_LABEL.client!)()}</span>
      {kind === "auth" ? (
        <LoginHelp />
      ) : (
        <span className="grow truncate" data-testid="Error message">{banner.fatal ? `${t("Fatal")}: ` : ""}{banner.message}</span>
      )}
      {(kind === "auth" || kind === "fatalSession") && <RestartButton />}
      {kind === "mcpAuth" && banner.server && <McpSignIn server={banner.server} />}
      {/* MARK: wave4 w4-longwork — §38.2 [이어서 계속] after the tool-call limit, "풀리면 이어서 하기" on a usage limit */}
      {banner.code === "max_turns" && <ContinueWorkButton />}
      {banner.code === "usage_limit" && <LimitResumeToggle />}
      {kind === "fatalSession" && (
        <button type="button" className="small" onClick={() => openDialog({ kind: "settings", tab: "general" })} data-testid="Error settings">
          {t("Settings")}
        </button>
      )}
      <button type="button" className="small" onClick={() => void window.rg.openLog()} title={t("Open the log folder")} data-testid="Open log">
        {t("Open log")}
      </button>
      <button type="button" className="small" onClick={dismissError} data-testid="Dismiss error">
        {t("Dismiss")}
      </button>
    </div>
  );
}

/** §19.6 `cli_start_slow`: a hint while the CLI is still starting — hides itself (store timer) or on Dismiss. */
export function StartSlowBanner() {
  const hint = useStore((s) => s.startSlowHint);
  const dismiss = useStore((s) => s.dismissStartSlow);
  const openDialog = useStore((s) => s.openDialog);
  // MARK: wave3 desktop-session — §36.7: what the starting CLI waits for ("serena 기다리는 중").
  const session = useStore((s) => s.state.session);
  if (!hint) return null;
  const waiting = extensionsWaitingOf(session);
  const text = waiting ? `${hint.message} · ${waitingText(waiting)}` : hint.message;
  return (
    <div className="banner blue" role="status" data-testid="Start slow banner">
      <span className="spinner" style={{ width: 10, height: 10 }} aria-hidden="true" />
      <span className="grow truncate" title={waiting ? `${text}\n${waitingDetail(waiting)}` : text}>{text}</span>
      <button type="button" className="small plain" onClick={() => openDialog({ kind: "extensions" })}>{t("Details")}</button>
      <button type="button" className="plain small" onClick={dismiss} title={t("Dismiss")} aria-label={t("Dismiss")} data-testid="Dismiss start slow">✕</button>
    </div>
  );
}
