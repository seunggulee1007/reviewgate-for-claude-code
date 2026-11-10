/**
 * An error in the transcript — live or restored by `transcript_restore` (docs/PROTOCOL.md §30), drawn the same way: the
 * sentence, "×N · last time" when the same failure repeated (merged, src/renderer/sessionErrors.ts), and the CLI's own
 * words / exit code on a second line. Notices (§30 resume, §33.4 worktree, §29 release) read as information or warnings.
 */
import { t } from "../../i18n";
import { scopeRowText } from "../../scopeNotices";
import { errorSubline, errorTone, repeatLabel, type ErrorRow } from "../../sessionErrors";
import { ScopeRowActions, ScopeRowFiles } from "./ScopeRowActions"; // MARK: r1-scope (§33.4)
import { asksStill, rejectAskedPath } from "../../rejectSchedule"; // MARK: r2-review-flow (M32)
import { useStore } from "../../store";
import { rejectBlockedReason } from "../../reviewRound";
import "../session.css";

const ICON = { fatal: "⊗", error: "ⓘ", warning: "⚠", info: "ⓘ" } as const;

export function ErrorNoticeRow({ item }: { item: ErrorRow }) {
  const code = item.facts?.code;
  const tone = errorTone(code, item.fatal, item.facts?.hookName); // r1x (§38.2): a failed hook, an old PreToolUse block — gray
  const repeat = repeatLabel(item.count, item.lastAt);
  const words = errorSubline(item.facts);
  // A blocked worktree names its folder below; information keeps the CLI's words folded.
  const sub = tone === "info" ? "" : code === "worktree_blocked" ? (item.facts?.path ?? "") : words;
  // r1-scope (§33.4): a command's changes outside the review — the same sentence for live and restored rows, its files below.
  const scope = code === "worktree_outside_review";
  const message = (scope ? scopeRowText({ code, path: item.facts?.path, files: item.facts?.files }) : null) ?? item.message;
  return (
    <div className={`error-row notice-${tone}`} data-testid={item.fatal ? "Fatal error" : "Error"} data-code={code ?? ""}>
      <span className="icon" aria-hidden="true">{ICON[tone]}</span>
      <span className="err-body">
        <span>
          {message}
          {repeat && <span className="err-repeat" title={t("Happened {0} times", item.count ?? 1)} data-testid="Error repeat">{repeat}</span>}
        </span>
        {sub && <span className="err-sub" data-testid="Error detail">{sub}</span>}
        {scope && <ScopeRowFiles item={item} />}
        {scope && <ScopeRowActions item={item} />}
        <RejectAgainActions code={code} detail={item.facts?.cliDetail} />
        {tone === "info" && words && (
          <details>
            <summary>{t("Details")}</summary>
            <span className="err-sub">{words}</span>
          </details>
        )}
      </span>
    </div>
  );
}

/**
 * MARK: r2-review-flow — M32 (§34.2): a file the turn changed again after the user rejected it during the turn was not
 * reverted; its row asks — [되돌리기] (an ordinary reject now) and its diff — while it is still pending in the review.
 */
function RejectAgainActions({ code, detail }: { code: string | undefined; detail: string | undefined }) {
  const path = rejectAskedPath(code, detail);
  const still = useStore((s) => (path ? asksStill(path, s.state.changedFiles) : false));
  const blocked = useStore((s) => rejectBlockedReason(s.state));
  const reject = useStore((s) => s.reject);
  const selectFile = useStore((s) => s.selectFile);
  if (!path || !still) return null;
  return (
    <span className="row" style={{ gap: 6, marginTop: 4 }}>
      <button type="button" className="small primary" disabled={blocked !== null} onClick={() => reject(path)}
        title={blocked ?? t("Reject the file as it is now — its changes go back to the start of the review")} data-testid="Reject again from row">
        {t("Revert")}
      </button>
      <button type="button" className="small" onClick={() => selectFile(path)} title={t("Show this file's diff in the review")} data-testid="Show diff from reject row">
        {t("Show Diff")}
      </button>
    </span>
  );
}
