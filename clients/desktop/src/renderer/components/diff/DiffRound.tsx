/**
 * wave2 desktop-flow — under the diff header (docs/PROTOCOL.md §34): while a turn runs, "Claude가 작업 중이에요 — 이번 턴 전
 * 기준 diff예요(읽기 전용)" with why reject waits (§34.2), and the file's diff ranges (§34.1: 전체 / 이번 턴 / 요청 이후 /
 * 수락 이후 — only the ones it has; the default follows the file, the pick is the user's until the next B).
 */
import type { ChangedFileState, GateState } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isDiffCollapsed } from "../../friction";
import { availableRanges, diffTreeOf, isTurnActive, rangeLabel, rejectBlockedReason } from "../../reviewRound";
import { pendingFiles, useStore, type ReviewDiff, type Store } from "../../store";
import "../reviewRound.css";

/**
 * The diff on screen is not the current review's: a turn runs on it, or it was made for a B the review has left.
 * `unavailable` (wave3 check-clients): no diff can be shown during this turn (a fresh review has no B) — then there is no
 * "diff from before this turn" on screen to speak of (as on the Mac, whose banner needs a diff).
 */
export function isStaleDiff(gate: GateState, diff: ReviewDiff | null, unavailable = false): boolean {
  if (isTurnActive(gate)) return !unavailable;
  return !!diff?.endTree && diffTreeOf(gate) !== diff.endTree;
}

/**
 * The review's diff pane is on screen with the "이번 턴 전 기준" banner (a reviewed file selected, not the live / history /
 * PR view, not collapsed): the banner then says why reject waits, and the Changes list does not say it again (as on the Mac).
 */
export function staleBannerShown(s: Pick<Store, "state" | "ui" | "selectedPath" | "selectedDiff" | "liveView" | "historyView" | "tab" | "diffUnavailable">): boolean {
  if (s.tab === "prs" || s.liveView !== null || s.historyView !== null || isDiffCollapsed(s.state, s.ui, s.selectedPath)) return false;
  if (!s.state.changedFiles.some((f) => f.path === s.selectedPath)) return false;
  return isStaleDiff(s.state.gate, s.selectedDiff, s.diffUnavailable !== null);
}

export function DiffRound({ file }: { file: ChangedFileState }) {
  const gate = useStore((s) => s.state.gate);
  const diff = useStore((s) => s.selectedDiff);
  const since = useStore((s) => s.diffSince);
  const setSince = useStore((s) => s.setDiffSince);
  const unavailable = useStore((s) => s.diffUnavailable !== null);
  const ranges = availableRanges(file, gate);
  const stale = isStaleDiff(gate, diff, unavailable);
  // Why reject waits, once on screen: here while files are pending (the Changes list then leaves it out).
  const anyPending = useStore((s) => pendingFiles(s.state).length > 0);
  const rejectBlocked = anyPending ? rejectBlockedReason({ gate }) : null;
  if (!stale && ranges.length < 2) return null;
  return (
    <div className="diff-round" data-testid="Diff round">
      {stale && (
        <div className="banner blue stale-banner" role="status" data-testid="Stale diff banner">
          <span className="round-pulse" aria-hidden="true" style={{ marginTop: 5 }} />
          <div className="stale-main">
            <span className="bold">{t("Claude is working — this is the diff from before this turn (read-only)")}</span>
            {rejectBlocked && <span className="stale-sub" data-testid="Stale reject reason">{rejectBlocked}</span>}
          </div>
        </div>
      )}
      {ranges.length > 1 && (
        <div className="range-row">
          <div className="range-seg" role="radiogroup" aria-label={t("Diff range")} data-testid="Diff range">
            {ranges.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={r === since} className={r === since ? "active" : ""} onClick={() => setSince(r)} data-testid={`Range ${r}`}>
                {rangeLabel(r)}
              </button>
            ))}
          </div>
          {file.state === "pending" && file.changedSinceAccepted && (
            <span className="pill orange" title={t("Accepted earlier, then changed again — “Since accepted” shows what changed")} data-testid="Diff changed after accept">
              {t("Changed after accept")}
            </span>
          )}
          {/* A range's lines and parts are not the whole review's: those side questions wait for 전체 (said, not hidden). */}
          {since !== "review" && (
            <span className="caption faint" data-testid="Range ask hint">{t("Line side questions are in the “Whole review” view")}</span>
          )}
        </div>
      )}
    </div>
  );
}
