/**
 * Audit daily-03: on the PRs / History tabs the Changes tab keeps saying what Claude is doing (a pulsing dot while it
 * works, an orange "!" while it waits for the user, the number of files to review), and the PRs tab — where the chat is
 * not shown — gets a bar "Claude가 권한 확인을 기다려요 · 돌아가기" while Claude is blocked on the user.
 */
import { t } from "../i18n";
import { useStore } from "../store";
import { changesStatus, changesStatusLabel, waitingText } from "../tabAttention";
import "./session.css";

/** Inside the sidebar's Changes button; nothing while the Changes tab is shown. */
export function TabStatusDot() {
  const tab = useStore((s) => s.tab);
  // The snapshot itself (a stable reference): a selector returning a fresh object would re-render forever.
  const state = useStore((s) => s.state);
  const status = changesStatus(state);
  if (tab === "changes" || !status) return null;
  const label = changesStatusLabel(status);
  if (status.kind === "running") return <span className="tab-status running" role="img" aria-label={label} title={label} data-testid="Changes status" />;
  return (
    <span className={`tab-status ${status.kind}`} role="img" aria-label={label} title={label} data-testid="Changes status">
      {status.kind === "waiting" ? "!" : status.count > 99 ? "99+" : status.count}
    </span>
  );
}

/** Above the PR pane while Claude waits for the user (a card, a question, a plan, a held message). */
export function TabAttentionBar() {
  const tab = useStore((s) => s.tab);
  const state = useStore((s) => s.state);
  const setTab = useStore((s) => s.setTab);
  const status = changesStatus(state);
  if (tab !== "prs" || !status || status.kind !== "waiting") return null;
  return (
    <div className="banner orange tab-attention-bar" role="status" data-testid="Tab attention bar">
      <span aria-hidden="true">✋</span>
      <span className="grow truncate">{waitingText(status.reason)}</span>
      <button type="button" className="small primary" onClick={() => setTab("changes")} title={t("Back to the Changes tab")} data-testid="Back to changes">
        {t("Go back")}
      </button>
    </div>
  );
}
