/**
 * MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2, as on the Mac (App ViewingChatViews.swift, ExploreRunRow.swift):
 * - daily-13: another chat tab is read without switching the Claude session. The bar above the composer says so and offers
 *   [이 채팅으로 이어가기]; while Claude works in the live chat sending waits with the reason and [실행 중인 채팅으로]. The
 *   review panel says whose review it shows. Logic: viewedChat.ts.
 * - market-12: a run of reads / searches / read-only commands as one "탐색: …" line that opens to its rows (exploreFold.ts).
 */
import { useEffect, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { exploreSummary, type ExploreRun } from "../../exploreFold";
import { chatTitleOf, continueInViewedChat, liveChatWaits, loadEarlierInViewedChat, stopViewing, useViewedChat, useViewing, viewChat, viewingSendBlocker, viewingSendWait } from "../../viewedChat";
import { cancelPendingSwitch, pendingSwitchText, usePendingSwitch } from "../../pendingSwitch"; // r2-chats-cards M31 / M33
import "./viewingChat.css";

/**
 * Above the composer while another chat is shown read-only. r2-chats-cards M31 / M33 (§9): while Claude works in the live
 * chat [이 채팅으로 이어가기] and a send wait for it instead of being refused — the line says what waits, [취소] calls it off.
 */
export function ViewingChatBar() {
  const viewing = useViewing();
  const state = useStore((s) => s.state);
  const queued = useStore((s) => s.queue.items.length > 0 || s.queue.inflight);
  const pending = usePendingSwitch((s) => s.pending);
  const [switching, setSwitching] = useState(false);
  useEffect(() => setSwitching(false), [viewing?.id]);
  if (!viewing) return null;
  const blocker = viewingSendBlocker(state, queued);
  const wait = viewingSendWait(state, queued);
  const held = pending?.kind === "open" && pending.id === viewing.id;
  const recordOnly = state.sessions?.list.find((m) => m.id === viewing.id)?.resumeFailed === true;
  const waits = liveChatWaits(state);
  const live = chatTitleOf(state, state.sessions?.currentId ?? null);
  const reason = blocker ?? wait;
  const line = waits ? t("Claude is waiting for you in '{0}'", live) : reason;
  return (
    <div className="viewing-bar" data-testid="Viewing chat bar">
      <div className="row">
        <span className="grow" data-testid="Viewing chat note">
          <span aria-hidden="true">👁</span> {recordOnly ? t("Only the record of this chat is left — sending starts a new chat") : t("You're viewing this chat — sending continues it here")}
        </span>
        {switching && !held ? (
          <span className="caption muted" data-testid="Viewing chat switching">{t("Switching…")}</span>
        ) : (
          !held && (
            <button
              type="button"
              className="small"
              disabled={blocker !== null}
              title={blocker ?? (wait !== null ? t("Moves Claude's session to this chat once it is done in the running chat") : t("Moves Claude's session to this chat; the running chat stays in its tab"))}
              onClick={() => {
                setSwitching(wait === null);
                void continueInViewedChat().then((ok) => {
                  if (!ok) setSwitching(false);
                });
              }}
              data-testid="Continue in this chat"
            >
              {t("Continue in this chat")}
            </button>
          )
        )}
      </div>
      {held ? (
        <div className="row caption muted">
          <span className="grow truncate" title={pendingSwitchText(state, pending) ?? undefined} data-testid="Viewing chat held switch">
            {pendingSwitchText(state, pending)}
          </span>
          <button type="button" className="small" onClick={cancelPendingSwitch} title={t("Keeps Claude's session where it is; a message waiting here goes back to the message box")} data-testid="Cancel held chat switch">
            {t("Call off")}
          </button>
        </div>
      ) : (
        line !== null && (
          <div className="row caption muted">
            <span className="grow truncate" title={line} data-testid="Viewing chat blocker">
              {line}
            </span>
            <button type="button" className="small" onClick={stopViewing} title={t("Go back to the running chat; this one stays in its tab")} data-testid="Back to the running chat">
              {t("Back to the running chat")}
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** At the top of a chat shown read-only: loading, a failed read, or [이전 대화 더 보기] for its older rows. */
export function ViewedChatHeader() {
  const viewing = useViewing();
  if (!viewing) return null;
  let body: ReactNode = null;
  if (viewing.loading) body = <span className="caption muted">{viewing.items.length === 0 ? t("Loading this chat…") : t("Show earlier messages")}</span>;
  else if (viewing.error)
    body = (
      <>
        <span className="caption orange"><span aria-hidden="true">⚠</span> {viewing.error}</span>
        <button
          type="button"
          className="small"
          onClick={() => {
            useViewedChat.setState({ chat: null });
            void viewChat(viewing.id);
          }}
        >
          {t("Retry")}
        </button>
      </>
    );
  else if ((viewing.start ?? 0) > 0)
    body = (
      <button type="button" className="small" onClick={() => void loadEarlierInViewedChat()} data-testid="Viewed chat earlier messages">
        <span aria-hidden="true">↑</span> {t("Show earlier messages")}
      </button>
    );
  else if (viewing.items.length === 0) body = <span className="caption muted">{t("No messages in this chat yet")}</span>;
  return body ? <div className="older-rows" data-testid="Viewed chat header">{body}</div> : null;
}

/** The review panel while another chat is shown: the review is the running chat's. */
export function ViewingReviewNote() {
  const viewing = useViewing();
  const live = useStore((s) => chatTitleOf(s.state, s.state.sessions?.currentId ?? null));
  if (!viewing) return null;
  return (
    <div className="caption muted viewing-review-note" data-testid="Viewing review note">
      <span aria-hidden="true">ⓘ</span> {t("This review belongs to the running chat ('{0}')", live)}
    </div>
  );
}

/** wave4b integration (§39.2 × §39.3): the agent panel while another chat is shown — its agents (this turn's and the
 *  earlier turns') are the running chat's, as the review is (the Mac's ViewingAgentsNote). */
export function ViewingAgentsNote() {
  const viewing = useViewing();
  const live = useStore((s) => chatTitleOf(s.state, s.state.sessions?.currentId ?? null));
  if (!viewing) return null;
  return (
    <div className="caption muted viewing-review-note" data-testid="Viewing agents note">
      <span aria-hidden="true">ⓘ</span> {t("These agents belong to the running chat ('{0}')", live)}
    </div>
  );
}

/** A folded run: "탐색: 파일 2개 읽음 · 검색 1회", its rows when open. `forceOpen`: a find hit or a revealed row is inside. */
export function ExploreRunRow({ run, running, forceOpen, children }: { run: ExploreRun; running: boolean; forceOpen: boolean; children: ReactNode }) {
  const [override, setOverride] = useState<boolean | null>(null);
  // A revealed row inside keeps the run open after the reveal (as an agent group does).
  useEffect(() => {
    if (forceOpen) setOverride(true);
  }, [forceOpen]);
  const open = override ?? forceOpen;
  const summary = exploreSummary(run.counts);
  const live = running && run.counts.open > 0;
  return (
    <div className={`explore-run ${open ? "open" : ""}`} data-testid="Explore run">
      <button
        type="button"
        className="plain explore-head"
        aria-expanded={open}
        title={open ? t("Fold the reads and searches into one line") : t("Show every read and search")}
        onClick={() => setOverride(!open)}
      >
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span aria-hidden="true">⌕</span>
        <span className="truncate">{live ? t("Exploring: {0}", summary) : t("Explored: {0}", summary)}</span>
        {live && <span className="spinner" aria-hidden="true" />}
      </button>
      {open && <div className="explore-body">{children}</div>}
    </div>
  );
}
