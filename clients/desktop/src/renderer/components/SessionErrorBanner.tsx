/**
 * The banner of session start / recovery and of the notices (docs/PROTOCOL.md §30, §29, §33.4, §32 `lfs_missing`): what
 * happened in one sentence, the CLI's own words and exit code on a second line, "×N · last time" when it repeated, and
 * the way out as buttons — the most useful first (a start failure, or a crash seen twice: New chat). Notices are
 * information (blue) or warnings (orange), never the red failure.
 */
import { useState } from "react";
import { lfsInstallCommand } from "../errorCodes";
import { t } from "../i18n";
import { newChatRefusal } from "../sessions";
import { createWorkbenchDialog, errorSubline, errorTone, repeatLabel, sessionActions, type SessionAction } from "../sessionErrors";
import { useStore, type ErrorBanner as Banner } from "../store";
import { samePath } from "./Sidebar";
import { movedChat } from "../chatMove"; // MARK: wave4b w4b-follow
import { useChatMove } from "./chat/ChatMoveViews";
import "./session.css";
import { errorCopyText } from "../errorCopy"; // polish P1-chrome-29
import { CopyButton } from "./common/CopyButton";
import { Icon } from "../icons";

const TONE_CLASS = { fatal: "red", error: "orange", warning: "orange", info: "blue" } as const;
const TONE_ICON = { fatal: "⊗", error: "⚠", warning: "⚠", info: "ⓘ" } as const;
/** Codes whose second line is the CLI's words (else the engine's own text). */
const CLI_CODES = new Set(["session_start_failed", "session_crashed", "session_id_in_use"]);
/** The engine's fallback sentence when the CLI said nothing — it only repeats the first line in English. */
const GENERIC_ENGINE_TEXT = new Set(["Claude Code exited while starting."]);

export function SessionErrorBanner({ banner }: { banner: Banner }) {
  const dismissError = useStore((s) => s.dismissError);
  const newChat = useStore((s) => s.newChat);
  const restartSession = useStore((s) => s.restartSession);
  const openDialog = useStore((s) => s.openDialog);
  const canRestart = useStore((s) => s.state.session.canRestart);
  const starting = useStore((s) => s.state.session.starting);
  const workbenches = useStore((s) => s.state.workbenches.list);
  const switchRefusal = useStore((s) => newChatRefusal(s.state)); // r2-chats-cards M31 (§9): while Claude works it waits
  const [copied, setCopied] = useState(false);
  const chatMove = useChatMove(); // MARK: wave4b w4b-follow (§39.4)
  const moved = useStore((s) => movedChat(s.state) !== null);

  const code = banner.code;
  const facts = banner.facts ?? {};
  const tone = errorTone(code, banner.fatal);
  const count = banner.count ?? 1;
  const actions = sessionActions(code, { count, facts, isWorkbench: (p) => workbenches.some((w) => samePath(w.path, p)) });
  const repeat = repeatLabel(count, banner.lastAt);
  const info = tone === "info";
  const engineText = banner.detail && !GENERIC_ENGINE_TEXT.has(banner.detail) ? banner.detail : "";
  const sub = CLI_CODES.has(code ?? "") ? errorSubline(facts) || engineText : code === "worktree_blocked" ? (facts.path ?? "") : "";

  const button = (a: SessionAction, primary: boolean) => {
    const cls = primary ? "small primary" : "small";
    switch (a) {
      case "newChat":
        return (
          <button key={a} type="button" className={cls} disabled={switchRefusal !== null} title={switchRefusal ?? t("Starts a new chat — the old one stays in History")} onClick={() => { dismissError(); void newChat(); }} data-testid="Session new chat">
            {code === "session_start_failed" ? t("Start a new chat") : t("New chat")}
          </button>
        );
      case "retry":
      case "reconnect":
        return (
          <button key={a} type="button" className={cls} disabled={!canRestart || starting} title={a === "retry" ? t("Starts Claude Code again with the same settings") : t("Reconnects this chat")} onClick={() => { dismissError(); void restartSession(); }} data-testid="Session restart">
            {a === "retry" ? t("Retry") : t("Reconnect the chat")}
          </button>
        );
      case "openLog":
        return (
          <button key={a} type="button" className={cls} onClick={() => void window.rg.openLog()} title={t("Open the log folder")} data-testid="Open log">
            {t("Open log")}
          </button>
        );
      case "history":
        return (
          <button key={a} type="button" className={cls} onClick={() => openDialog({ kind: "history", ...(facts.sessionId ? { highlight: facts.sessionId } : {}) })} data-testid="Session view previous chat">
            {t("View the previous chat")}
          </button>
        );
      case "createWorkbench":
        return (
          <button key={a} type="button" className={cls} title={t("Creates a git worktree on a new branch and opens it in its own window with its own Claude session.")} onClick={() => openDialog(createWorkbenchDialog(facts))} data-testid="Session create workbench">
            {t("Open as a workbench")}
          </button>
        );
      case "openWorkbench":
        return (
          <button key={a} type="button" className={cls} title={facts.path} onClick={() => facts.path && void window.rg.openWorkbenchWindow(facts.path)} data-testid="Session open workbench">
            {t("Open as a workbench")}
          </button>
        );
      case "openFolder":
        return (
          <button key={a} type="button" className={cls} title={facts.path} onClick={() => facts.path && void window.rg.openInNewWindow(facts.path)} data-testid="Session open folder">
            {t("Open folder")}
          </button>
        );
      // MARK: wave4b w4b-follow — §39.4
      case "moveChat":
        return (
          <button key={a} type="button" className={cls} disabled={!facts.path || moved} title={moved ? t("This chat is read-only here, so it cannot be moved.") : t("This chat continues in that worktree's window, and its changes there are reviewed")} onClick={() => facts.path && chatMove.start(facts.path)} data-testid="Session move chat">
            {t("Move This Chat There")}
          </button>
        );
      case "copyCommand": {
        const command = lfsInstallCommand(window.rg.platform);
        return (
          <button key={a} type="button" className={cls} title={command} onClick={() => void window.rg.copyText(command).then(() => setCopied(true))} data-testid="Session copy command">
            {copied ? t("Copied") : t("Copy command")}
          </button>
        );
      }
    }
  };

  return (
    <div
      className={`banner session-banner ${TONE_CLASS[tone]}`}
      role={tone === "fatal" || tone === "error" ? "alert" : "status"}
      data-testid="Error banner"
      data-code={code ?? ""}
    >
      <span className="icon" aria-hidden="true">{TONE_ICON[tone]}</span>
      <span className="text">
        {/* polish P1-chrome-29: the tooltip on the message (not over every button), three lines of it before it is cut */}
        <span className="main clamp-3" title={banner.detail && banner.detail !== banner.message ? `${banner.message}\n\n${banner.detail}` : banner.message} data-testid="Error message">
          {banner.message}
          {repeat && <span className="repeat" data-testid="Error repeat">{repeat}</span>}
        </span>
        {sub && <span className="sub" data-testid="Error detail">{sub}</span>}
        {info && facts.cliDetail && (
          <details>
            <summary>{t("Details")}</summary>
            <span className="sub">{facts.cliDetail}</span>
          </details>
        )}
      </span>
      <span className="actions">
        {actions.map((a, i) => button(a, i === 0))}
        <CopyButton text={errorCopyText(banner.message, sub || banner.detail, code, repeat)} title={t("Copy the error")} iconOnly toast={t("Copied")} />
        <button type="button" className="plain small" onClick={dismissError} title={t("Dismiss")} aria-label={t("Dismiss")} data-testid="Dismiss error">
          <Icon name="close" size={12} />
        </button>
      </span>
      {chatMove.dialog}
    </div>
  );
}
