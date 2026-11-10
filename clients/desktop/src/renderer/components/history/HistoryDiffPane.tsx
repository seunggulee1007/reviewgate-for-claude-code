/**
 * A past review round's file (`history_diff`, docs/PROTOCOL.md §14) shown read-only where the live diff
 * normally is: a "history — read-only" banner with the way back to the live review, the file's verdict, and
 * the patch between the round's snapshots with the notes that were sent on it. No note, accept or revert here.
 */
import type { DiffLine } from "@reviewgate/engine";
import { formatDate, relativeTime, t } from "../../i18n";
import { useStore } from "../../store";
import { statusColor } from "../ChangedFiles";
import { Bubble } from "../diff/Bubble";
import { keyId, UnifiedDiff, type LineKey } from "../UnifiedDiff";
import { VerdictChip } from "./HistoryList";
import { AskButton, SideBadge, useDiffSide } from "../side/SideAsk";
import "../diff/diff.css";
import "./history.css";
import { FileWhyLine } from "./HistoryWhy"; // MARK: wave4 w4-history (§38.3)
// MARK: wave4c w4c-review — §41.3 "20줄 더 보기" from the round's own tree
import { engineRequest } from "../../engineRequest";
import { historyOffersContext } from "../../reviewLeftovers";
import { useFileLinesContext } from "../diff/MoreLines";

export function HistoryDiffPane() {
  const view = useStore((s) => s.historyView);
  const closeHistoryView = useStore((s) => s.closeHistoryView);
  const setTab = useStore((s) => s.setTab);
  const tab = useStore((s) => s.tab);
  const live = useStore((s) => s.state.changedFiles.length);
  const side = useDiffSide(view?.path ?? null, view?.entry.id);
  // MARK: wave4c w4c-review — the new side of this diff (the tree history_diff diffs to), asked on the first click
  const viewFile = view?.entry.files.find((f) => f.path === view.path);
  const contextKey = view?.diff && viewFile && historyOffersContext(viewFile.status, view.diff.isBinary) ? `${view.entry.id}\u0000${view.path}` : null;
  const context = useFileLinesContext(contextKey, () => engineRequest({ type: "history_file_lines", entryId: view!.entry.id, path: view!.path }));
  if (!view) return null;
  const { entry, path } = view;
  const file = entry.files.find((f) => f.path === path);
  const notes = entry.notes.filter((n) => n.path === path);
  const byLine = new Map<string, typeof notes>();
  for (const n of notes) {
    if (n.line === null) continue;
    const k = keyId({ side: n.side, line: n.line });
    byLine.set(k, [...(byLine.get(k) ?? []), n]);
  }
  const fileNotes = notes.filter((n) => n.line === null);
  const back = () => {
    closeHistoryView();
    if (tab === "history") setTab("changes");
  };
  const extra = (_line: DiffLine, key: LineKey | null) => {
    if (!key) return null;
    const list = byLine.get(keyId(key));
    if (!list) return null;
    return list.map((n, i) => <Bubble key={i} kind="note" body={n.body} meta={`${n.side === "old" ? "−" : "+"}${n.line}`} />);
  };

  return (
    <div className="pane diff history-diff" data-testid="History diff pane">
      <div className="banner blue history-banner" data-testid="History banner">
        <span className="bold" style={{ flex: "none" }}>🕘 {t("History — read-only")}</span>
        <span className="caption truncate grow" title={`${formatDate(entry.endedAt)}\n${entry.prompt}`}>
          {relativeTime(entry.endedAt)} · {entry.prompt || t("(no prompt)")}
        </span>
        <button type="button" className="small primary" onClick={back} data-testid="Back to live review">
          ← {live > 0 ? t("Back to the live review ({0})", live) : t("Back to the live review")}
        </button>
      </div>
      <div className="pane-header diff-header">
        <div className="row" style={{ gap: 8 }}>
          {file && <span className={`glyph mono bold ${statusColor(file.status)}`} style={{ width: 14, textAlign: "center" }}>{file.status}</span>}
          <div className="col grow" style={{ gap: 1 }}>
            <span className="bold truncate" title={path} data-testid="History path">{path}</span>
            {file?.oldPath && file.oldPath !== path && <span className="caption muted truncate">{t("from")} {file.oldPath}</span>}
          </div>
          {file && <span className="caption num green">+{file.adds}</span>}
          {file && <span className="caption num red">−{file.dels}</span>}
          {file?.rejectedHunks ? <span className="pill orange">↶ {t("Partly reverted {0}", file.rejectedHunks)}</span> : null}
          {file?.committed && <span className="pill green" title={file.commit ? t("Commit: {0}", file.commit.subject) : undefined}>{t("committed")}</span>}
          {file && <VerdictChip verdict={file.verdict} />}
          <SideBadge threads={side.threads} testId="Side badge history file" />
          <AskButton anchor={{ path, entryId: entry.id }} title={t("Ask why this file changed in that round (side question)")} testId="Ask history file" />
        </div>
        {file?.verdict === "rejected" && <div className="caption muted">{t("Rejected in this round — shown as Claude proposed it; the file was put back on disk.")}</div>}
        {view.why && <FileWhyLine why={view.why} /* MARK: wave4 w4-history — §38.3 the round's reason */ />}
      </div>
      {fileNotes.length > 0 && (
        <div className="history-file-notes">
          {fileNotes.map((n, i) => (
            <Bubble key={i} kind="note" body={n.body} meta={t("file")} />
          ))}
        </div>
      )}
      {view.diff?.truncated && <div className="banner orange">{t("Diff truncated at 20,000 lines — open in editor to see the whole change")}</div>}
      {view.loading ? (
        <div className="empty"><span className="spinner" /><div className="caption muted">{t("Loading diff…")}</div></div>
      ) : view.error ? (
        <div className="empty" data-testid="History diff error">
          <span className="glyph">⚠</span>
          <h2>{t("Could not load this diff")}</h2>
          <div className="caption">{view.error}</div>
        </div>
      ) : view.diff ? (
        <UnifiedDiff diff={view.diff} highlighted={new Set(byLine.keys())} extra={extra} onAsk={side.onAsk} hunkAside={side.hunkAside} anchoredLines={side.anchoredLines} path={path} /* MARK: wave2 desktop-diff — 경로:줄 복사 */ truncated={view.diff.truncated} context={context} /* MARK: wave4c w4c-review */ />
      ) : null}
    </div>
  );
}
