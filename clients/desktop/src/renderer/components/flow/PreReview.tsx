/**
 * MARK: wave3 desktop-flow
 * docs/PROTOCOL.md §36.13 in Electron (as on the Mac): "AI pre-review" in the Changes head (a read-only side session runs
 * /code-review on this round; "Pre-reviewing…" with cancel, "%d findings" leading to the first file with one, "Earlier
 * version" when it looked at an earlier B, "Failed: reason"), a ✦ badge per file, a mark at the end of a diff line and an
 * inline card under it — summary, failure scenario, category, "From the chat" for the main chat's ReportFindings — with
 * "Add as note" (an ordinary review note, sent with Request changes), "Ask in a side thread" and "Dismiss"; the findings no
 * line on screen carries sit above the diff. Nothing here changes a file.
 */
import { useMemo } from "react";
import type { FileDiff, PreReviewEffort, ReviewState } from "@reviewgate/engine";
import { t } from "../../i18n";
import { displayOrder, isTurnActive } from "../../reviewRound";
import { findingCounts, findingQuestion, findingsByLine, findingsOfFile, firstFindingPath, headStatus, isStaleRun, unplacedFindings, type PreReviewItem } from "../../preReview";
import { preReviewBlocker, supportsPreReview } from "../../storeFlow";
import { updateReason } from "../../flowLogic";
import { preReviewEffortOf } from "../../../shared/flowSettings";
import { useStore } from "../../store";
import { Menu, type MenuItem } from "../Menu";
import "./flow.css";

const EFFORTS: readonly PreReviewEffort[] = ["low", "medium", "high"];
const effortLabel = (e: PreReviewEffort): string => (e === "low" ? t("Low") : e === "high" ? t("High") : t("Medium"));

/** Why "Add as note" waits: a note is refused while Claude works on a change request (§34.4). */
export function noteLockReason(state: ReviewState): string | null {
  return isTurnActive(state.gate) && state.gate.isRequestingChanges ? t("Claude is working…") : null;
}

/** The Changes head's row: the status of the newest run and the button (with the effort and "this file only"). */
export function PreReviewHead() {
  const state = useStore((s) => s.state);
  const flow = useStore((s) => s.flow);
  const settings = useStore((s) => s.settings);
  const selectedPath = useStore((s) => s.selectedPath);
  const riskFirst = useStore((s) => s.riskFirst);
  const start = useStore((s) => s.startPreReview);
  const cancel = useStore((s) => s.cancelPreReview);
  const revealFile = useStore((s) => s.revealFile);
  const saveFlowSettings = useStore((s) => s.saveFlowSettings);
  if (state.changedFiles.length === 0 && flow.runs.length === 0) return null;
  const effort = preReviewEffortOf(settings);
  const status = headStatus(flow.runs, state.gate.reviewEndTree);
  const blocker = preReviewBlocker(state, flow);
  const counts = findingCounts(flow.runs);
  const supported = supportsPreReview(state, flow);
  const reason = !supported ? updateReason() : flow.preReviewError;
  const fileOnly = selectedPath !== null && state.changedFiles.some((f) => f.path === selectedPath);
  const items: MenuItem[] = [
    { kind: "head", label: t("Effort") },
    ...EFFORTS.map((e): MenuItem => ({ kind: "item", label: effortLabel(e), checked: e === effort, onClick: () => void saveFlowSettings({ preReviewEffort: e }), testId: `Pre-review effort ${e}` })),
    { kind: "sep" },
    {
      kind: "item",
      label: t("Pre-review the selected file only"),
      disabled: !fileOnly || blocker !== null,
      title: blocker ?? undefined,
      onClick: () => selectedPath && void start("files", [selectedPath], effort),
      testId: "Pre-review selected file",
    },
  ];
  return (
    <div className="prereview-head" data-testid="Pre-review head">
      <div className="status">
        {status.kind === "running" && (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="running" data-testid="Pre-review running">{t("Pre-reviewing…")}</span>
            <button type="button" className="plain small" onClick={() => void cancel(status.prereviewId)} title={t("Cancel the pre-review")} aria-label={t("Cancel the pre-review")} data-testid="Cancel pre-review">
              ✕
            </button>
          </>
        )}
        {status.kind === "done" && (
          <>
            <button
              type="button"
              className="count"
              disabled={status.count === 0}
              onClick={() => {
                const path = firstFindingPath(displayOrder(state.changedFiles, riskFirst).map((f) => f.path), counts);
                if (path) revealFile(path);
              }}
              title={status.count > 0 ? t("Open the first file with a finding") : t("The pre-review found nothing")}
              data-testid="Pre-review findings"
            >
              <span aria-hidden="true">✦ </span>
              {t("{0} findings", status.count)}
            </button>
            {status.stale && (
              <span className="flow-pill gray" title={t("The pre-review looked at an earlier version of these changes; lines may have moved")} data-testid="Pre-review stale">
                {t("Earlier version")}
              </span>
            )}
          </>
        )}
        {status.kind === "failed" && (
          <span className="failed truncate" title={status.reason} data-testid="Pre-review failed">
            ⚠ {t("Failed: {0}", status.reason)}
          </span>
        )}
        <span className="prereview-split">
          <button
            type="button"
            className="small start"
            disabled={blocker !== null}
            onClick={() => void start("round", undefined, effort)}
            title={blocker ?? t("Claude reviews this round's changes first, in a read-only side session — findings go on the diff lines, not into the chat (effort {0})", effortLabel(effort))}
            aria-label={t("AI pre-review")}
            data-testid="AI pre-review"
          >
            <span className="flow-spark" aria-hidden="true">✦</span> {t("AI pre-review")}
          </button>
          <Menu label="" items={items} align="right" title={t("Effort")} disabled={!supported} testId="Pre-review options" />
        </span>
      </div>
      {reason && (
        <div className={supported ? "flow-reason" : "caption muted"} title={reason} data-testid="Pre-review notice">
          {supported && <span aria-hidden="true">⚠</span>}
          <span>{reason}</span>
        </div>
      )}
    </div>
  );
}

/** "✦ 2" on a changed file with pre-review findings. */
export function PreReviewBadge({ path }: { path: string }) {
  const count = useStore((s) => findingCounts(s.flow.runs)[path] ?? 0);
  if (count === 0) return null;
  return (
    <span className="flow-pill purple" title={t("{0} findings", count)} aria-label={t("{0} findings", count)} data-testid={`Pre-review badge ${path}`}>
      ✦ {count}
    </span>
  );
}

/** The shown findings of `path` (null: none — the diff draws nothing extra). */
export function usePreReviewFile(path: string | null | undefined): { items: PreReviewItem[]; byLine: Map<number, PreReviewItem[]>; marked: ReadonlySet<string> } | null {
  const runs = useStore((s) => s.flow.runs);
  return useMemo(() => {
    if (!path || runs.length === 0) return null;
    const items = findingsOfFile(runs, path);
    if (items.length === 0) return null;
    const byLine = findingsByLine(items);
    return { items, byLine, marked: new Set([...byLine.keys()].map((n) => `new:${n}`)) };
  }, [runs, path]);
}

/** The cards under one diff line (`excerpt`: the line's text, a note's excerpt). */
export function PreReviewCards({ items, excerpt }: { items: readonly PreReviewItem[]; excerpt: string }) {
  return (
    <>
      {items.map((item) => (
        <FindingCard key={item.key} item={item} excerpt={excerpt} />
      ))}
    </>
  );
}

/** Above the diff: the file's findings no shown line carries (the whole file, a line outside the hunks; in the full-file view all of them). */
export function PreReviewUnplaced({ path, diff, placesLines }: { path: string; diff: FileDiff | null; placesLines: boolean }) {
  const file = usePreReviewFile(path);
  const newLines = useMemo(() => {
    if (!placesLines || !diff || diff.isBinary) return null;
    const lines = new Set<number>();
    for (const h of diff.hunks) for (const l of h.lines) if (l.kind !== "del" && l.kind !== "hunkHeader" && l.newNo !== null) lines.add(l.newNo);
    return lines;
  }, [diff, placesLines]);
  // The unified view places its lines once the diff is here (no flash of every finding while it loads).
  if (!file || (placesLines && !diff)) return null;
  const items = unplacedFindings(file.items, newLines);
  if (items.length === 0) return null;
  return (
    <div className="prereview-unplaced" data-testid="Pre-review findings without a line">
      {items.map((item) => (
        <FindingCard key={item.key} item={item} excerpt="" showLine />
      ))}
    </div>
  );
}

/** One finding: what may break, and what to do with it. */
function FindingCard({ item, excerpt, showLine = false }: { item: PreReviewItem; excerpt: string; showLine?: boolean }) {
  const { finding, run } = item;
  const stale = useStore((s) => isStaleRun(run, s.state.gate.reviewEndTree));
  const busy = useStore((s) => s.flow.busy[item.key] === true);
  const noteLock = useStore((s) => noteLockReason(s.state));
  const hasProject = useStore((s) => s.state.project !== null);
  const addAsNote = useStore((s) => s.addFindingAsNote);
  const dismiss = useStore((s) => s.dismissFinding);
  const askAbout = useStore((s) => s.askAbout);
  const summary = finding.summary.trim() || finding.shortSummary;
  return (
    <div className={`prereview-card ${stale ? "stale" : ""}`} data-testid={`Pre-review finding ${finding.id}`}>
      <div className="head">
        <span className="flow-spark" aria-hidden="true">✦</span>
        <span className="label">{t("AI pre-review")}</span>
        {showLine && <span className="caption muted num">{typeof finding.line === "number" ? `+${finding.line}` : t("whole file")}</span>}
        {finding.category && <span className="flow-pill purple">{finding.category}</span>}
        {run.source === "main" && (
          <span className="flow-pill gray" title={t("Claude reported this in the main chat (ReportFindings)")}>
            {t("From the chat")}
          </span>
        )}
        {stale && (
          <span className="flow-pill gray" title={t("The pre-review looked at an earlier version of these changes; lines may have moved")}>
            {t("Earlier version")}
          </span>
        )}
        <span className="spacer" />
        {busy && <span className="spinner" aria-hidden="true" />}
      </div>
      <div className="summary">{summary}</div>
      {finding.failureScenario.trim() && <div className="scenario">{finding.failureScenario}</div>}
      <div className="actions">
        <button
          type="button"
          className="small"
          disabled={busy || noteLock !== null}
          onClick={() => void addAsNote(run.prereviewId, finding, excerpt)}
          title={noteLock ?? t("A review note on this line — sent to Claude with Request changes (⌘⇧C)")}
          data-testid="Pre-review add as note"
        >
          {t("Add as note")}
        </button>
        {hasProject && (
          <button
            type="button"
            className="small"
            onClick={() => askAbout(typeof finding.line === "number" ? { path: finding.file, line: finding.line, side: "new" } : { path: finding.file }, { question: findingQuestion(finding) })}
            title={t("Ask about this finding in a side question — the main conversation is not affected")}
            data-testid="Pre-review ask"
          >
            {t("Ask in a side thread")}
          </button>
        )}
        <button type="button" className="small" disabled={busy} onClick={() => void dismiss(run.prereviewId, finding.id)} title={t("Remove this finding")} data-testid="Pre-review dismiss">
          {t("Dismiss finding")}
        </button>
      </div>
    </div>
  );
}
