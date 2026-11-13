/**
 * MARK: composer parity — docs/PROTOCOL.md §56.1: the /btw answer over the composer, never in the chat (as on the Mac,
 * ComposerBtwOverlay.swift). While the question is on its way it says so with Cancel; then the question, the answer and how
 * it was answered, with Copy and Close and the same in its context menu. Esc, Enter or Space in an empty composer closes it
 * too (Composer.tsx).
 */
import { useBtw } from "../../btw";
import { t } from "../../i18n";
import { useAgentContextMenu, type AgentMenuItem } from "../agents/AgentBits";
import { Markdown } from "./Markdown";

export function BtwOverlay() {
  const overlay = useBtw((s) => s.overlay);
  const dismiss = useBtw((s) => s.dismiss);
  const answer = overlay?.kind === "answered" ? overlay.answer : null;
  const question = overlay === null ? "" : overlay.kind === "asking" ? overlay.question : overlay.answer.question;
  const copy = (text: string) => void window.rg.copyText(text);
  const items: AgentMenuItem[] = answer
    ? [
        { label: t("Copy the answer"), onClick: () => copy(answer.answer), testId: "Side answer menu copy" },
        { label: t("Copy the question"), onClick: () => copy(answer.question), testId: "Side answer menu copy question" },
        { label: t("Close"), onClick: dismiss, testId: "Side answer menu close" },
      ]
    : [{ label: t("Cancel"), onClick: dismiss, testId: "Side answer menu cancel" }];
  const menu = useAgentContextMenu(items);
  if (overlay === null) return null;
  return (
    <div className="btw-overlay" role="dialog" aria-label={t("Side answer")} data-testid="Side answer" onContextMenu={menu.onContextMenu}>
      <div className="btw-head">
        <span className="btw-tag mono">/btw</span>
        <span className="btw-question truncate" title={question}>{question}</span>
        {answer === null ? (
          <>
            <span className="btw-wait" role="status">{t("Asking on the side…")}</span>
            <button type="button" className="tiny" onClick={dismiss} title={t("Stop waiting — the answer is dropped when it comes")} data-testid="Cancel side question">
              {t("Cancel")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="plain tiny" onClick={() => copy(answer.answer)} aria-label={t("Copy the answer")} title={t("Copy the answer")} data-testid="Copy side answer">⧉</button>
            <button type="button" className="plain tiny" onClick={dismiss} aria-label={t("Close the side answer")} title={t("Close (esc · ↩ · space) — /btw alone shows it again")} data-testid="Close side answer">×</button>
          </>
        )}
      </div>
      {answer && (
        <>
          <div className={`btw-body${answer.synthetic ? " faint" : ""}`}>
            <Markdown text={answer.answer} />
          </div>
          <div className="btw-foot tiny faint">
            {answer.viaFork ? t("Answered without tools by a copy of the conversation — not added to the chat") : t("Answered without tools from the conversation so far — not added to the chat")}
          </div>
        </>
      )}
      {menu.menu}
    </div>
  );
}
