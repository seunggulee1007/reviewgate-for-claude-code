/**
 * The two header rows of the diff pane (the Mac app's `DiffView.header`): status glyph, path,
 * `+n −m`, note count; then Full-file toggle, side-by-side / collapse-unchanged toggles, Open in
 * Editor, Reject / Accept or the file's review-state label.
 */
import type { ChangedFileState } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isExternalChange } from "../../reviewGate";
import { statusColor } from "../ChangedFiles";
import { OpenInEditor } from "./OpenInEditor";

export type DiffHeaderProps = {
  file: ChangedFileState;
  noteCount: number;
  absolutePath: string;
  /** Line the external editor should jump to. */
  editorLine: number;
  showFullFile: boolean;
  onToggleFullFile: () => void;
  /** Only meaningful while the full-file (Monaco) view is shown. */
  sideBySide: boolean;
  onToggleSideBySide: () => void;
  collapseUnchanged: boolean;
  onToggleCollapseUnchanged: () => void;
  /** A turn, its collection or a revert is in flight: accept / reject are disabled. */
  reviewLocked: boolean;
  /**
   * wave2 desktop-flow — §34.2: why accept / reject cannot be offered now (null: they can); they replace `reviewLocked`
   * when given — accept also works while a turn runs on this review, reject waits for its end.
   */
  acceptBlocked?: string | null;
  rejectBlocked?: string | null;
  onAccept: () => void;
  onReject: () => void;
};

export function DiffHeader(props: DiffHeaderProps) {
  const { file } = props;
  const renamed = file.oldPath && file.oldPath !== file.path;
  return (
    <div className="pane-header diff-header" data-testid="Diff header">
      <div className="row" style={{ gap: 8 }}>
        <span className={`glyph mono bold ${statusColor(file.status)}`} style={{ width: 14, textAlign: "center" }}>{file.status}</span>
        <div className="col grow" style={{ gap: 1 }}>
          <MiddlePath path={file.path} className="bold" testId="Diff path" />
          {renamed && <MiddlePath path={file.oldPath ?? ""} className="caption muted" prefix={t("from")} />}
        </div>
        <span className="caption num green">+{file.added}</span>
        <span className="caption num red">−{file.deleted}</span>
        {file.partial && (
          <span className="pill orange" style={{ flex: "none" }} title={t("Some parts of this file were reverted; the rest is still under review")} data-testid="Partial badge">
            {t("Partly reverted {0}", file.rejectedHunks ?? 0)}
          </span>
        )}
        {isExternalChange(file) && (
          <span className="pill gray external" style={{ flex: "none" }} title={t("Not changed by a Claude tool — it may be the IDE, another session or a git pull")} data-testid="External badge">
            {t("Outside change")}
          </span>
        )}
        {props.noteCount > 0 && (
          <span className="caption orange" style={{ whiteSpace: "nowrap" }} data-testid="Note count">💬 {t("{0} notes", props.noteCount)}</span>
        )}
      </div>
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          className={`small ${props.showFullFile ? "active" : ""}`}
          aria-pressed={props.showFullFile}
          disabled={file.status === "D"}
          onClick={props.onToggleFullFile}
          title={t("Full file")}
          data-testid="Full file"
        >
          {t("Full file")}
        </button>
        {props.showFullFile && (
          <button
            type="button"
            className={`small ${props.sideBySide ? "active" : ""}`}
            aria-pressed={props.sideBySide}
            onClick={props.onToggleSideBySide}
            title={t("Side by side")}
            data-testid="Side by side"
          >
            {props.sideBySide ? t("Side by side") : t("Inline")}
          </button>
        )}
        {props.showFullFile && (
          <button
            type="button"
            className={`small ${props.collapseUnchanged ? "active" : ""}`}
            aria-pressed={props.collapseUnchanged}
            onClick={props.onToggleCollapseUnchanged}
            title={t("Fold unchanged regions (3 context lines)")}
            data-testid="Collapse unchanged"
          >
            {t("Collapse unchanged")}
          </button>
        )}
        <OpenInEditor absolutePath={props.absolutePath} line={props.editorLine} />
        <StateControls
          file={file}
          acceptBlocked={props.acceptBlocked !== undefined ? props.acceptBlocked : props.reviewLocked ? t("Claude is working…") : null}
          rejectBlocked={props.rejectBlocked !== undefined ? props.rejectBlocked : props.reviewLocked ? t("Claude is working…") : null}
          turnRunning={props.reviewLocked}
          onAccept={props.onAccept}
          onReject={props.onReject}
        />
      </div>
    </div>
  );
}

/** Path with the directory truncated (ellipsis) and the file name always visible. */
function MiddlePath(props: { path: string; className?: string; prefix?: string; testId?: string }) {
  const slash = props.path.lastIndexOf("/");
  const dir = slash < 0 ? "" : props.path.slice(0, slash + 1);
  const name = slash < 0 ? props.path : props.path.slice(slash + 1);
  return (
    <span className={`path-middle ${props.className ?? ""}`} title={props.path} data-testid={props.testId}>
      {props.prefix && <span className="faint" style={{ flex: "none" }}>{props.prefix}&nbsp;</span>}
      <span className="head truncate">{dir}</span>
      <span className="tail">{name}</span>
    </span>
  );
}

function StateControls(props: { file: ChangedFileState; acceptBlocked: string | null; rejectBlocked: string | null; turnRunning: boolean; onAccept: () => void; onReject: () => void }) {
  switch (props.file.state) {
    case "pending":
      return (
        <>
          <button
            type="button"
            className="small"
            disabled={props.rejectBlocked !== null || props.file.uncaptured === true}
            onClick={props.onReject}
            title={props.file.uncaptured ? t("Content not captured (large file / binary) — cannot be reverted") : (props.rejectBlocked ?? t("Reject (⌘⇧R)"))}
            data-testid="Reject"
          >
            ↶ {t("Reject")}
          </button>
          <button
            type="button"
            className="primary small"
            disabled={props.acceptBlocked !== null}
            onClick={props.onAccept}
            // wave2 desktop-flow — §34.2: an accept while the turn runs holds only if the turn leaves the file alone.
            title={props.acceptBlocked ?? (props.turnRunning ? t("Accept now (⌘⇧A) — if this turn changes the file again, it comes back as pending") : t("Accept (⌘⇧A)"))}
            data-testid="Accept"
          >
            ✓ {t("Accept")}
          </button>
        </>
      );
    case "accepted":
      return <span className="green bold" data-testid="State label">✓ {t("Accepted")}</span>;
    case "rejected":
      return <span className="orange bold" data-testid="State label">↶ {t("Rejected")}</span>;
    case "changesRequested":
      return <span className="orange bold" data-testid="State label">! {t("Changes requested")}</span>;
  }
}
