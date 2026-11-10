/**
 * The review diff pane (the Mac app's `DiffView` + `FullFilePane`): header, then either the unified
 * hunk list from `file_diff` or — "Full file" — a Monaco DiffEditor over `full_file_content`.
 * Notes are added from either view through the store's `addNote`.
 */
import { useCallback, useEffect, useState } from "react";
import type { FullFileContentEvent, ReviewNote } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isReviewLocked, useStore } from "../../store";
import type { LineKey } from "../UnifiedDiff";
import { ChangeCause } from "./ChangeCause";
import { DiffHeader } from "./DiffHeader";
import { FileNotices } from "./FileNotices";
import { useHunkReject } from "./HunkReject";
import { FullFilePlaceholder, MonacoDiffView } from "./MonacoDiffView";
import { OpenInEditor } from "./OpenInEditor";
import { UnifiedView, type NoteTarget } from "./UnifiedView";
// MARK: wave2 desktop-flow — §34 ranges, the read-only diff of a running turn, sent notes
import { acceptBlockedReason, diffTreeOf, isTurnActive, placeNotes, rejectBlockedReason } from "../../reviewRound";
import { DiffRound } from "./DiffRound";
import { OutsideNotes } from "./NoteCards";
import "./diff.css";
import { DiffToolsRow } from "./DiffTools"; // MARK: wave2 desktop-diff
import { isNoteKey, noteLineTarget } from "../../noteShortcut"; // MARK: wave4 w4-input
import { selectionAnchor } from "../../shortcuts";
import { PreReviewUnplaced } from "../flow/PreReview"; // MARK: wave3 desktop-flow
import { FileMetaRow } from "./FileMetaRow"; // MARK: wave4b w4b-files
// MARK: wave4c w4c-review — §41.3 the whitespace-ignoring view, an image's two sides
import { isPreviewImage, useIgnoreWhitespace } from "../../reviewLeftovers";
import { ImagePreview } from "./ImagePreview";
import { WhitespaceDiffBody, WhitespaceToggle } from "./WhitespaceDiff";

/** A boolean view preference remembered in localStorage (default true). */
function usePersistedBool(key: string): [boolean, () => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* private mode etc. */
    }
  }, [key, value]);
  return [value, useCallback(() => setValue((v) => !v), [])];
}

export default function DiffPane() {
  const state = useStore((s) => s.state);
  const selectedPath = useStore((s) => s.selectedPath);
  const selectedDiff = useStore((s) => s.selectedDiff);
  const diffLoading = useStore((s) => s.diffLoading);
  const accept = useStore((s) => s.accept);
  const reject = useStore((s) => s.reject);
  const addNote = useStore((s) => s.addNote);
  const removeNote = useStore((s) => s.removeNote);
  const fullFile = useStore((s) => s.fullFile);

  const file = state.changedFiles.find((f) => f.path === selectedPath) ?? null;
  const notes = file ? state.reviewNotes.filter((n) => n.path === file.path) : [];
  const reviewLocked = isReviewLocked(state);
  // wave2 desktop-flow — §34.2: accept also while a turn runs on this review; reject waits for its end.
  const acceptBlocked = acceptBlockedReason(state);
  const rejectBlocked = rejectBlockedReason(state);
  const diffSince = useStore((s) => s.diffSince);
  const diffUnavailable = useStore((s) => s.diffUnavailable);

  const [showFullFile, setShowFullFile] = useState(false);
  const [sideBySide, toggleSideBySide] = usePersistedBool("rg.diff.sideBySide");
  const [collapseUnchanged, toggleCollapseUnchanged] = usePersistedBool("rg.diff.collapseUnchanged");
  const [composer, setComposer] = useState<LineKey | null>(null);
  const [content, setContent] = useState<{ path: string; tree: string | null; data: FullFileContentEvent | null; error: string | null } | null>(null);

  const hunk = useHunkReject(file, diffLoading ? null : selectedDiff);
  const ignoreWhitespace = useIgnoreWhitespace((s) => s.ignore); // MARK: wave4c w4c-review

  // Reset per-file UI state when the selection changes.
  useEffect(() => setComposer(null), [selectedPath]);

  // Full-file content (re-fetched whenever snapshot B changes; the store cache is cleared then too).
  // wave2 desktop-flow — per review B (`reviewEndTree`, kept while a turn runs) and range (§34.1 `full_file.since`).
  const tree = diffTreeOf(state.gate);
  const turnActive = isTurnActive(state.gate);
  const contentId = `${tree ?? ""}\u0000${diffSince}`;
  useEffect(() => {
    if (!showFullFile || !file) return;
    if (content && content.path === file.path && content.tree === contentId) return;
    let live = true;
    setContent({ path: file.path, tree: contentId, data: null, error: null });
    fullFile(file.path, diffSince)
      .then((data) => live && setContent({ path: file.path, tree: contentId, data, error: null }))
      .catch((e) => {
        // An engine before §34 has no B to read during a turn: say when it comes back instead of its refusal code.
        const error = tree === null && turnActive ? t("This diff can be shown when the turn ends") : e instanceof Error ? e.message : String(e);
        if (live) setContent({ path: file.path, tree: contentId, data: null, error });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFullFile, file?.path, contentId]);

  // ⌘⇧A (Ctrl on other platforms) accepts the selected file. ⌘⇧R (reject) is window-wide (src/renderer/rejectShortcut.ts):
  // it must always take the key, or it falls through to the browser's force reload (audit polish-03).
  useEffect(() => {
    if (!file || file.state !== "pending") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      // A blocked accept still takes the key: the store says why (the Mac's error row), never a silent no-op.
      if (k === "a") {
        e.preventDefault();
        accept(file.path);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [file, accept]);

  // wave4 w4-input (polish-06): ⌥⌘N (Ctrl+Alt+N) opens a review note on the selected line, else the first changed line.
  useEffect(() => {
    if (!file || (showFullFile && file.status !== "D") || diffLoading || !selectedDiff || diffUnavailable) return;
    if (ignoreWhitespace && !selectedDiff.isBinary) return; // MARK: wave4c w4c-review — the -w view takes no notes
    const onKey = (e: KeyboardEvent) => {
      if (!isNoteKey(e) || useStore.getState().dialog) return;
      const { anchor } = selectionAnchor();
      const target = noteLineTarget(selectedDiff, anchor?.path === file.path ? anchor : null, diffSince === "review" ? "both" : "new");
      if (!target) return;
      e.preventDefault();
      setComposer(target);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [file, showFullFile, diffLoading, selectedDiff, diffUnavailable, diffSince, ignoreWhitespace]);

  const onAddNote = useCallback(
    (target: NoteTarget, body: string) => {
      if (!file) return;
      addNote(file.path, target.line, target.side, target.excerpt, body);
      setComposer(null);
    },
    [file, addNote],
  );
  const openComposer = useCallback((target: NoteTarget) => setComposer({ side: target.side, line: target.line }), []);
  const closeComposer = useCallback(() => setComposer(null), []);

  if (!file) {
    return (
      <div className="pane diff" data-testid="Diff pane">
        <div className="empty">
          <span className="glyph">🔍</span>
          <h2>{t("Select a file")}</h2>
          <div>{t("Diffs appear here once a turn has changed files.")}</div>
        </div>
      </div>
    );
  }

  const root = state.project?.root ?? "";
  const absolutePath = root ? `${root}/${file.path}` : file.path;
  const editorLine = composer?.line ?? firstChangedLine(selectedDiff);
  const showMonaco = showFullFile && file.status !== "D";
  // wave2 desktop-flow — §34.4: notes without a line on screen (gone, file notes, outside this range; the full-file view
  // shows the new side only) sit above the diff instead of vanishing or landing on a line that now holds something else.
  const placed = showMonaco ? placeNotes(notes, null) : placeNotes(notes, diffLoading ? null : selectedDiff);
  const inlineNotes = showMonaco ? placed.inline.filter((n) => n.side === "new") : placed.inline;
  const outsideNotes = showMonaco ? [...placed.outside, ...placed.inline.filter((n) => n.side !== "new")] : placed.outside;
  // §34.1: line / hunk side questions name the whole review's lines and hunks — offered in that view only.
  const wholeReview = diffSince === "review";
  const rangeEmpty = !wholeReview && selectedDiff !== null && !selectedDiff.isBinary && selectedDiff.hunks.length === 0;

  return (
    <div className="pane diff" data-testid="Diff pane">
      <DiffHeader
        file={file}
        noteCount={notes.filter((n) => !n.sent).length}
        absolutePath={absolutePath}
        editorLine={editorLine}
        showFullFile={showMonaco}
        onToggleFullFile={() => setShowFullFile((v) => !v)}
        sideBySide={sideBySide}
        onToggleSideBySide={toggleSideBySide}
        collapseUnchanged={collapseUnchanged}
        onToggleCollapseUnchanged={toggleCollapseUnchanged}
        reviewLocked={reviewLocked}
        acceptBlocked={acceptBlocked}
        rejectBlocked={rejectBlocked}
        onAccept={() => accept(file.path)}
        onReject={() => reject(file.path)}
      />
      <DiffRound file={file} />
      <FileNotices file={file} />
      <ChangeCause key={file.path} file={file} />
      {!showMonaco && !diffLoading && selectedDiff && <FileMetaRow diff={selectedDiff} /> /* MARK: wave4b w4b-files — §40.2 */}
      {/* MARK: wave4c w4c-review — §41.3: a changed image before / after */}
      {!showMonaco && !diffLoading && selectedDiff?.isBinary && isPreviewImage(file.path) && !diffUnavailable && <ImagePreview file={file} tree={tree} />}
      {!showMonaco && selectedDiff?.truncated && (
        <div className="banner orange" data-testid="Truncated banner">
          <span className="grow">{t("Diff truncated at 20,000 lines — open in editor to see the whole change")}</span>
          <OpenInEditor absolutePath={absolutePath} line={editorLine} />
        </div>
      )}
      <OutsideNotes notes={outsideNotes} onRemove={removeNote} />
      {/* MARK: wave3 desktop-flow — §36.13: findings no line on screen carries (the full-file view: all of the file's) */}
      <PreReviewUnplaced path={file.path} diff={diffLoading ? null : selectedDiff} placesLines={!showMonaco} />
      {showMonaco && <DiffToolsRow /> /* MARK: wave2 desktop-diff — 줄바꿈 for the full-file view too */}
      {showMonaco ? (
        <FullFileBody
          path={file.path}
          content={content && content.path === file.path ? content : null}
          sideBySide={sideBySide}
          collapseUnchanged={collapseUnchanged}
          notes={inlineNotes}
          composer={composer}
          onOpenComposer={openComposer}
          onCloseComposer={closeComposer}
          onAddNote={onAddNote}
          onRemoveNote={removeNote}
        />
      ) : diffUnavailable ? (
        <div className="empty" data-testid="Diff unavailable">
          <span className="glyph">⏳</span>
          <div className="caption muted">{diffUnavailable}</div>
        </div>
      ) : diffLoading || !selectedDiff ? (
        <Loading label={t("Loading diff…")} />
      ) : rangeEmpty ? (
        <div className="empty" data-testid="Range empty">
          <h2>{t("No changes in this range")}</h2>
          <div className="caption muted">{t("“Whole review” shows the file's whole change")}</div>
        </div>
      ) : ignoreWhitespace && !selectedDiff.isBinary ? (
        // MARK: wave4c w4c-review — §41.3: the same range with whitespace ignored, read-only
        <WhitespaceDiffBody file={file} since={diffSince} tree={tree} />
      ) : (
        <>
          {/* MARK: wave2 desktop-diff — the hunk bar sits in the row above the lines, next to 찾기 / 줄바꿈 */}
          <UnifiedView
            path={file.path}
            wholeReview={wholeReview}
            diff={selectedDiff}
            notes={inlineNotes}
            composer={composer}
            onOpenComposer={openComposer}
            onCloseComposer={closeComposer}
            onAddNote={onAddNote}
            onRemoveNote={removeNote}
            hunkActions={hunk.hunkActions}
            selectedHunks={hunk.selected}
            generated={file.generated}
            truncated={selectedDiff.truncated}
            toolbar={
              <>
                {hunk.bar}
                {file.whitespaceOnly === true && <span className="pill gray diff-tools-note" data-testid="Whitespace only">{t("Only whitespace changed")}</span>}
                <WhitespaceToggle file={file} /* MARK: wave4c w4c-review — §41.3 */ />
              </>
            }
          />
        </>
      )}
      {hunk.dialog}
    </div>
  );
}

function FullFileBody(props: {
  path: string;
  content: { data: FullFileContentEvent | null; error: string | null } | null;
  sideBySide: boolean;
  collapseUnchanged: boolean;
  notes: ReviewNote[];
  composer: LineKey | null;
  onOpenComposer: (target: NoteTarget) => void;
  onCloseComposer: () => void;
  onAddNote: (target: NoteTarget, body: string) => void;
  onRemoveNote: (id: string) => void;
}) {
  const { content } = props;
  if (!content || (!content.data && !content.error)) return <Loading label={t("Loading file…")} />;
  if (content.error) {
    return (
      <div className="empty" data-testid="Full file view">
        <span className="glyph">⚠</span>
        <h2>{t("Could not load file")}</h2>
        <div className="mono caption">{content.error}</div>
      </div>
    );
  }
  const data = content.data!;
  if (data.isBinary || data.isTooLarge || data.oldText === null || data.newText === null) return <FullFilePlaceholder content={data} />;
  return (
    <MonacoDiffView
      path={props.path}
      content={data}
      sideBySide={props.sideBySide}
      collapseUnchanged={props.collapseUnchanged}
      notes={props.notes}
      composer={props.composer}
      onOpenComposer={props.onOpenComposer}
      onCloseComposer={props.onCloseComposer}
      onAddNote={props.onAddNote}
      onRemoveNote={props.onRemoveNote}
    />
  );
}

function Loading({ label }: { label: string }) {
  return <div className="empty"><span className="spinner" /><div className="caption muted">{label}</div></div>;
}

/** The row the external editor should jump to: the first +/− line, else the first line of the patch. */
function firstChangedLine(diff: { hunks: { lines: { kind: string; oldNo: number | null; newNo: number | null }[] }[] } | null): number {
  if (!diff) return 1;
  const lines = diff.hunks.flatMap((h) => h.lines);
  const first = lines.find((l) => l.kind === "add" || l.kind === "del") ?? lines.find((l) => l.kind !== "hunkHeader");
  return first?.newNo ?? first?.oldNo ?? 1;
}
