/**
 * Unified hunk view for the review pane: `UnifiedDiff` plus the hover "+" gutter that opens an
 * inline note composer, and the file's review notes as orange bubbles under their line.
 */
import type { ReactNode } from "react";
import type { DiffHunk, DiffLine, FileDiff, ReviewNote } from "@reviewgate/engine";
import { t } from "../../i18n";
import { LineComposer, UnifiedDiff, keyId, type LineKey } from "../UnifiedDiff";
import { useDiffSide } from "../side/SideAsk";
import { ReviewNoteBubble } from "./NoteCards"; // MARK: wave2 desktop-flow — §34.4 sent notes ("요청함 — 반영 확인")
// MARK: wave2 desktop-diff
import { useCallback, useMemo, useState } from "react";
import { useStore } from "../../store";
import type { DiffContextSource } from "../UnifiedDiff";
import { refusalOf } from "../../engineRequest";
import { refusalMessage } from "../../errorCodes";
import { newLineNear } from "../../diffTools";
import { PreReviewCards, usePreReviewFile } from "../flow/PreReview"; // MARK: wave3 desktop-flow

export type NoteTarget = LineKey & { excerpt: string };

export function noteKey(note: ReviewNote): string | null {
  return note.line === null ? null : keyId({ side: note.side, line: note.line });
}

export function UnifiedView(props: {
  diff: FileDiff;
  notes: ReviewNote[];
  composer: LineKey | null;
  onOpenComposer: (target: NoteTarget) => void;
  onCloseComposer: () => void;
  onAddNote: (target: NoteTarget, body: string) => void;
  onRemoveNote: (id: string) => void;
  hunkActions?: (hunk: DiffHunk) => ReactNode;
  selectedHunks?: ReadonlySet<number>;
  /** §21: the file the diff is of — enables the side-question "?" on lines and hunk headers. */
  path?: string;
  // MARK: wave2 desktop-diff
  /** §34.7 `changedFiles[].generated` (the diff starts folded). */
  generated?: string;
  /** The engine cut the diff at 20 000 lines. */
  truncated?: boolean;
  /** The left part of the row above the lines (DiffPane's hunk-reject bar). */
  toolbar?: ReactNode;
  /**
   * §34.1: the diff is the whole review (A → B, default). Another range's old-side numbers and hunk ids are not A's, so
   * line / hunk side questions and old-side notes wait for "전체" there (as on the Mac); copying, the editor and
   * "20줄 더 보기" stay.
   */
  wholeReview?: boolean;
}) {
  const wholeReview = props.wholeReview !== false;
  const side = useDiffSide(wholeReview ? (props.path ?? null) : null);
  // MARK: wave2 desktop-diff — "20줄 더 보기", and the line menu's 에디터에서 열기 at the clicked line
  const context = useFullFileContext(props.path ?? null);
  const root = useStore((s) => s.state.project?.root ?? "");
  const editor = useStore((s) => s.settings?.preferredEditor);
  const { diff, path } = props;
  const onOpenLine = useCallback(
    (line: DiffLine) => {
      if (!path) return;
      void window.rg.openInEditor(root ? `${root}/${path}` : path, newLineNear(diff, line), editor);
    },
    [root, path, diff, editor],
  );
  const byLine = new Map<string, ReviewNote[]>();
  for (const n of props.notes) {
    const k = noteKey(n);
    if (!k) continue;
    byLine.set(k, [...(byLine.get(k) ?? []), n]);
  }
  const composerId = props.composer ? keyId(props.composer) : null;
  // MARK: wave3 desktop-flow — §36.13: the AI pre-review's findings on new-side lines (a mark and a card under the line).
  const findings = usePreReviewFile(props.path);

  const extra = (line: DiffLine, key: LineKey | null) => {
    if (!key) return null;
    const id = keyId(key);
    const notes = byLine.get(id) ?? [];
    const open = composerId === id;
    const cards = key.side === "new" ? (findings?.byLine.get(key.line) ?? []) : [];
    if (notes.length === 0 && !open && cards.length === 0) return null;
    return (
      <>
        {cards.length > 0 && <PreReviewCards items={cards} excerpt={line.text} />}
        {notes.map((n) => (
          <ReviewNoteBubble key={n.id} note={n} onRemove={() => props.onRemoveNote(n.id)} />
        ))}
        {open && (
          <LineComposer
            title={t("Note on {0}", `${key.side === "old" ? "−" : "+"}${key.line}`)}
            submitTitle={t("Add note")}
            testId="Note composer"
            onSubmit={(body) => props.onAddNote({ ...key, excerpt: line.text }, body)}
            onCancel={props.onCloseComposer}
          />
        )}
      </>
    );
  };

  return (
    <UnifiedDiff
      diff={props.diff}
      highlighted={new Set(byLine.keys())}
      onAdd={(line, key) => props.onOpenComposer({ ...key, excerpt: line.text })}
      noteSides={wholeReview ? "both" : "new"}
      extra={extra}
      hunkActions={props.hunkActions}
      selectedHunks={props.selectedHunks}
      onAsk={side.onAsk}
      hunkAside={side.hunkAside}
      anchoredLines={side.anchoredLines}
      path={props.path}
      generated={props.generated}
      truncated={props.truncated}
      context={context}
      toolbar={props.toolbar}
      onOpenLine={onOpenLine}
      markedLines={findings?.marked}
      markTitle={t("AI pre-review finding on this line")}
    />
  );
}

// MARK: wave2 desktop-diff
/**
 * The selected file's new side for "20줄 더 보기": `full_file` is asked on the first click only (the store caches it until
 * B changes); a refusal / a binary or too large file says why in the expander rows.
 */
export function useFullFileContext(path: string | null): DiffContextSource | undefined { // MARK: wave4c w4c-review — exported for the whitespace-ignoring view
  const fullFile = useStore((s) => s.fullFile);
  const tree = useStore((s) => s.state.gate.reviewEndTree ?? s.state.gate.turnEndTree);
  const key = path === null ? null : `${tree ?? ""}\u0000${path}`;
  const [box, setBox] = useState<{ key: string | null; lines: readonly string[] | null; loading: boolean; unavailable: string | null }>({ key: null, lines: null, loading: false, unavailable: null });
  const cur = box.key === key ? box : { key, lines: null, loading: false, unavailable: null };
  const load = useCallback(() => {
    if (path === null) return;
    setBox({ key, lines: null, loading: true, unavailable: null });
    fullFile(path)
      .then((reply) => {
        const unavailable = reply.isBinary ? t("Binary file") : reply.isTooLarge ? t("File too large") : null;
        setBox((b) => (b.key === key ? { key, lines: unavailable ? null : reply.lines, loading: false, unavailable } : b));
      })
      .catch((e: unknown) => {
        const why = `${t("Could not load file")} — ${refusalMessage(refusalOf(e))}`;
        setBox((b) => (b.key === key ? { key, lines: null, loading: false, unavailable: why } : b));
      });
  }, [fullFile, path, key]);
  return useMemo(() => (path === null ? undefined : { lines: cur.lines, loading: cur.loading, unavailable: cur.unavailable, load }), [path, cur.lines, cur.loading, cur.unavailable, load]);
}

