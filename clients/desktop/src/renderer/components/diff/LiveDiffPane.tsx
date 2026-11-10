/**
 * wave2 desktop-flow — a file of the running turn's "진행 중 변경" (docs/PROTOCOL.md §34.6 `live_diff`: the turn's own start
 * tree → the live snapshot) shown read-only where the review diff normally is: no accept, reject, hunk revert or note —
 * the turn may still change it, and once it ends the file is reviewed as usual. "← 리뷰로 돌아가기" goes back.
 */
import type { LiveChangedFile } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { statusColor } from "../ChangedFiles";
import { generatedLabel } from "../LiveChanges";
import { UnifiedDiff } from "../UnifiedDiff";
import "./diff.css";
import "../reviewRound.css";

export function LiveDiffPane() {
  const view = useStore((s) => s.liveView);
  const file = useStore((s): LiveChangedFile | undefined => s.live.files.find((f) => f.path === s.liveView?.path));
  const close = useStore((s) => s.closeLiveView);
  const reviewFiles = useStore((s) => s.state.changedFiles.length);
  if (!view) return null;
  return (
    <div className="pane diff live-diff" data-testid="Live diff pane">
      <div className="banner blue live-banner" data-testid="Live diff banner">
        <span className="round-pulse" aria-hidden="true" />
        <span className="bold" style={{ flex: "none" }}>{t("In progress (can't accept yet)")}</span>
        <span className="caption truncate grow">{t("Read-only — Claude may still change this file; it is reviewed when the turn ends")}</span>
        <button type="button" className="small primary" onClick={close} data-testid="Back to the review">
          ← {reviewFiles > 0 ? t("Back to the live review ({0})", reviewFiles) : t("Back to the live review")}
        </button>
      </div>
      <div className="pane-header diff-header">
        <div className="row" style={{ gap: 8 }}>
          {file && <span className={`glyph mono bold ${statusColor(file.status)}`} style={{ width: 14, textAlign: "center" }}>{file.status}</span>}
          <div className="col grow" style={{ gap: 1 }}>
            <span className="bold truncate" title={view.path} data-testid="Live diff path">{view.path}</span>
            {file?.oldPath && file.oldPath !== view.path && <span className="caption muted truncate">{t("from")} {file.oldPath}</span>}
          </div>
          {file && !file.isBinary && <span className="caption num green">+{file.added}</span>}
          {file && !file.isBinary && <span className="caption num red">−{file.deleted}</span>}
          {file?.generated && <span className="pill gray">{generatedLabel(file.generated)}</span>}
          {view.loading && view.diff && <span className="spinner" aria-label={t("Loading…")} />}
        </div>
      </div>
      {view.diff?.truncated && <div className="banner orange">{t("Diff truncated at 20,000 lines — open in editor to see the whole change")}</div>}
      {view.diff ? (
        <UnifiedDiff diff={view.diff} />
      ) : view.error ? (
        <div className="empty" data-testid="Live diff error">
          <span className="glyph">⚠</span>
          <h2>{t("Could not load this diff")}</h2>
          <div className="caption">{view.error}</div>
        </div>
      ) : (
        <div className="empty"><span className="spinner" /><div className="caption muted">{t("Loading diff…")}</div></div>
      )}
    </div>
  );
}
