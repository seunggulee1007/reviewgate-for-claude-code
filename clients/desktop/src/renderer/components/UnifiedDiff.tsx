/**
 * Unified hunk list from a `FileDiff` (the fallback for binary / too-large files and the PR diff pane).
 * Every commentable line gets a hover "+" gutter; `extra(line)` renders bubbles / composers under it.
 * MARK: wave2 desktop-diff (docs/PROTOCOL.md §34.7; audit comp-07, comp-18, comp-19, polish-09): the changed words of a
 * paired line (`segments`; a whitespace-only pair dimmed), "줄바꿈" (on by default) or one horizontal scroll for every row,
 * generated files and large diffs folded (diffFold.ts — the DOM of a 20 000-line diff is bounded), "20줄 더 보기" around
 * the hunks (`context`, diffContext.ts), a right-click menu (줄 복사 / 경로:줄 복사, LineMenu.tsx) and "diff에서 찾기"
 * (⌘F while the diff has the focus; folded hits unfold). Code rows are memoized: a state snapshot re-renders the pane,
 * not every row.
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DiffHunk, DiffLine, FileDiff } from "@reviewgate/engine";
import { t } from "../i18n";
// MARK: wave2 desktop-diff
import { CONTEXT_STEP, contextMatches, contextRow, diffGaps, gapView, revealGap, type ContextState, type Gap } from "../diffContext";
import { NO_FOLDS, expandFold, openGenerated, planFolds, revealLine, type FoldState } from "../diffFold";
import { useDiffPrefs } from "../diffPrefs";
import { segmentParts } from "../diffSegments";
import { MAX_FIND_MATCHES, findInDiff } from "../diffTools";
import { stepIndex } from "../transcriptFind";
import { DiffFindBar, DiffToolsRow } from "./diff/DiffTools";
import { LineMenu, type LineMenuAt, type LineMenuItem } from "./diff/LineMenu";
import "./diff/diffLines.css";
import { isEnter } from "../ime";
import { fileMetaLines } from "../fileMeta"; // MARK: wave4b w4b-files
import { diffLinePrefix } from "../a11yText"; // MARK: wave4d w4d-speed
import "./a11y.css";
import { windowKey } from "../keymap"; // MARK: wave4d w4d-windows

export type LineKey = { side: "old" | "new"; line: number };

export function lineKey(line: DiffLine): LineKey | null {
  if (line.kind === "hunkHeader") return null;
  if (line.kind === "del") return line.oldNo !== null ? { side: "old", line: line.oldNo } : null;
  return line.newNo !== null ? { side: "new", line: line.newNo } : null;
}

export function keyId(k: LineKey): string {
  return `${k.side}:${k.line}`;
}

// MARK: wave2 desktop-diff
/** The file's new side for "20줄 더 보기" (the review pane loads `full_file` on the first click). */
export type DiffContextSource = {
  /** `full_file_content.lines`; null until loaded. */
  lines: readonly string[] | null;
  loading: boolean;
  /** Why no context can be shown (a refusal, a binary / too large file); null when it can. */
  unavailable: string | null;
  load(): void;
};

const NO_CONTEXT: ContextState = {};
type FindState = { open: boolean; query: string; current: number; focusSeq: number };
const FIND_CLOSED: FindState = { open: false, query: "", current: 0, focusSeq: 0 };
/** Hits painted at once (the current one always is). */
const MAX_PAINTED = 600;

/** State that starts over whenever `dep` (the shown diff) changes — folds and revealed context belong to one diff. */
function useStateFor<T>(dep: unknown, initial: T): [T, (f: (cur: T) => T) => void] {
  const [box, setBox] = useState<{ dep: unknown; value: T }>(() => ({ dep, value: initial }));
  const value = box.dep === dep ? box.value : initial;
  const update = useCallback((f: (cur: T) => T) => setBox((b) => ({ dep, value: f(b.dep === dep ? b.value : initial) })), [dep, initial]);
  return [value, update];
}

export function UnifiedDiff(props: {
  diff: FileDiff;
  onAdd?: (line: DiffLine, key: LineKey) => void;
  extra?: (line: DiffLine, key: LineKey | null) => ReactNode;
  highlighted?: Set<string>;
  /** Controls rendered at the right end of each hunk's header row (§17 hunk-level reject). */
  hunkActions?: (hunk: DiffHunk) => ReactNode;
  /** Hunk ids drawn as selected (accent bar on their lines). */
  selectedHunks?: ReadonlySet<number>;
  /** §21: the hover "?" in the gutter — ask a side question about this line. */
  onAsk?: (line: DiffLine, key: LineKey, hunk: DiffHunk) => void;
  /** §21: always-shown controls on each hunk header, left of `hunkActions` ("왜?" + the "곁질문 N" badge). */
  hunkAside?: (hunk: DiffHunk) => ReactNode;
  /** Lines (`keyId`) a side thread is anchored on (accent bar). */
  anchoredLines?: ReadonlySet<string>;
  // MARK: wave2 desktop-diff
  /** Repo-relative path the diff is of (경로:줄 복사). */
  path?: string;
  /** §34.7 `changedFiles[].generated`: the diff starts as one fold. */
  generated?: string;
  /** The engine cut the diff at 20 000 lines: nothing is offered below its last hunk. */
  truncated?: boolean;
  /** "20줄 더 보기" around the hunks (the review pane). */
  context?: DiffContextSource;
  /** The left part of the tools row above the lines (the review pane's hunk-reject bar). */
  toolbar?: ReactNode;
  /** The line menu's "에디터에서 열기" at a line (the review pane: the file is on disk). */
  onOpenLine?: (line: DiffLine) => void;
  /** Which lines take a note through the "+" gutter (default both; "new": not the old side of a §34.1 range). */
  noteSides?: "both" | "new";
  // MARK: wave3 desktop-flow
  /** §36.13: lines (`keyId`) an AI pre-review finding is on — a mark at the row's end; never folded away. */
  markedLines?: ReadonlySet<string>;
  /** The mark's tooltip / accessible name. */
  markTitle?: string;
  /** §36.14: the pane's own entries of a line's right-click menu (the PR diff's "Ask in a side thread"). */
  lineMenuItems?: (line: DiffLine) => LineMenuItem[];
  /** MARK: wave4c w4c-review — false: a line shown by "20줄 더 보기" takes no "+" / "?" (the PR diff: GitHub comments need a diff line). */
  revealedActions?: boolean;
}) {
  const { diff } = props;
  const wrap = useDiffPrefs((s) => s.wrap);
  const [folds, setFolds] = useStateFor<FoldState>(diff, NO_FOLDS);
  const [revealed, setRevealed] = useStateFor<ContextState>(diff, NO_CONTEXT);
  const [menu, setMenu] = useState<LineMenuAt | null>(null);
  const [find, setFind] = useState<FindState>(FIND_CLOSED);
  const paneRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Memoized rows get stable callbacks; they read the latest props through this ref.
  const latest = useRef(props);
  latest.current = props;
  const onAdd = useCallback((line: DiffLine, key: LineKey) => latest.current.onAdd?.(line, key), []);
  const onAsk = useCallback((line: DiffLine, key: LineKey) => {
    const p = latest.current;
    const hunk = hunkNear(p.diff, line);
    if (hunk) p.onAsk?.(line, key, hunk);
  }, []);

  // ---- find (⌘F inside the diff)
  const matches = useMemo(() => (find.open ? findInDiff(diff, find.query) : []), [find.open, find.query, diff]);
  const current = matches.length === 0 ? -1 : Math.min(Math.max(find.current, 0), matches.length - 1);
  const currentMatch = current >= 0 ? matches[current]! : null;
  const openFind = useCallback(() => setFind((f) => ({ ...f, open: true, focusSeq: f.focusSeq + 1 })), []);
  const closeFind = useCallback(() => {
    setFind((f) => ({ ...f, open: false }));
    scrollRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // MARK: wave4d w4d-windows (polish-08): ⌥⌘F / Ctrl+Alt+F — the Mac's "Find in Diff…" — finds in the diff in front
      // (the first one shown) wherever the focus is.
      if (windowKey(e) === "findInDiff") {
        const pane = paneRef.current;
        if (!pane || document.querySelector('[role="dialog"]') || document.querySelector(".unified-pane") !== pane) return;
        e.preventDefault();
        openFind();
        return;
      }
      // The physical key too: with the Korean 2-set layout active the F key can arrive as "ㄹ".
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key.toLowerCase() !== "f" && e.code !== "KeyF")) return;
      const pane = paneRef.current;
      const active = document.activeElement;
      if (!pane || !active || !pane.contains(active)) return;
      e.preventDefault();
      openFind();
    };
    // Capture: runs before the chat's own ⌘F (which yields to a handled key).
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [openFind]);
  // The current hit is never folded away.
  const matchLine = currentMatch?.lineId;
  useEffect(() => {
    if (matchLine === undefined) return;
    setFolds((f) => revealLine(f, diff, matchLine));
  }, [matchLine, diff, setFolds]);

  // ---- "20줄 더 보기"
  const src = props.context;
  const fileLines = src?.lines ?? null;
  const fileFits = useMemo(() => (fileLines ? contextMatches(diff, fileLines) : true), [diff, fileLines]);
  const usable = fileLines !== null && fileFits ? fileLines : null;
  const contextBlocked = src?.unavailable ?? (fileFits ? null : t("The file changed on disk after this diff — its other lines cannot be shown"));
  const gaps = useMemo(
    () => (src && !diff.isBinary ? diffGaps(diff, { fileLines: usable ? usable.length : null, truncated: props.truncated }) : []),
    [src, diff, usable, props.truncated],
  );
  const expand = useCallback(
    (gap: Gap, dir: "up" | "down") => {
      setRevealed((c) => revealGap(c, gap, dir));
      const s = latest.current.context;
      if (s && s.lines === null && !s.loading) s.load();
    },
    [setRevealed],
  );

  // Paint the hits (CSS Custom Highlight API: React's DOM is never touched) and bring the current one into view.
  const scrolledTo = useRef<string>("");
  useEffect(() => {
    const reg = highlights();
    if (!reg) return;
    const root = scrollRef.current;
    if (!find.open || !root || matches.length === 0) {
      reg.delete("rg-diff-find");
      reg.delete("rg-diff-find-current");
      return;
    }
    const rows = new Map<number, Element>();
    root.querySelectorAll<HTMLElement>(".line[data-id]").forEach((el) => rows.set(Number(el.dataset["id"]), el));
    const len = find.query.length;
    const ranges: Range[] = [];
    let cur: Range | null = null;
    let curRow: Element | null = null;
    matches.forEach((m, i) => {
      if (i !== current && ranges.length >= MAX_PAINTED) return;
      const row = rows.get(m.lineId);
      const text = row?.querySelector(".text");
      const r = text ? rangeIn(text, m.start, m.start + len) : null;
      if (!r) return;
      if (i === current) {
        cur = r;
        curRow = row ?? null;
      } else ranges.push(r);
    });
    reg.set("rg-diff-find", makeHighlight(ranges));
    if (cur) reg.set("rg-diff-find-current", makeHighlight([cur]));
    else reg.delete("rg-diff-find-current");
    const at = currentMatch ? `${find.query}\u0000${currentMatch.lineId}:${currentMatch.start}` : "";
    if (curRow && at !== scrolledTo.current) {
      scrolledTo.current = at;
      (curRow as HTMLElement).scrollIntoView({ block: "center" });
    }
  });
  useEffect(
    () => () => {
      highlights()?.delete("rg-diff-find");
      highlights()?.delete("rg-diff-find-current");
    },
    [],
  );

  // ---- right-click menu
  const linesById = useRef(new Map<number, DiffLine>());
  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    const target = e.target as Element;
    const row = typeof target.closest === "function" ? target.closest<HTMLElement>(".line[data-id]") : null;
    const line = row ? linesById.current.get(Number(row.dataset["id"])) : undefined;
    if (!line || line.kind === "hunkHeader") return;
    e.preventDefault();
    const sel = window.getSelection();
    const selection = sel && !sel.isCollapsed && scrollRef.current?.contains(sel.anchorNode) ? sel.toString() : "";
    setMenu({ x: e.clientX, y: e.clientY, line, selection });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // MARK: wave4b w4b-files — §40.2 (comp-11): a move, a mode change or a binary's sizes say what changed.
  const meta = diff.isBinary || diff.hunks.length === 0 ? fileMetaLines(diff) : [];
  if (diff.isBinary) {
    return (
      <div className="empty" data-testid="Diff binary">
        <h2>{t("Binary file")}</h2>
        {meta.length > 0 ? meta.map((line) => <div key={line}>{line}</div>) : <div>{t("No textual diff is available for this file.")}</div>}
      </div>
    );
  }
  if (diff.hunks.length === 0) {
    return (
      <div className="empty" data-testid={meta.length > 0 ? "Diff meta only" : "Diff empty"}>
        <h2>{meta.length > 0 ? meta[0] : t("No changes")}</h2>
        <div>{meta.length > 1 ? meta.slice(1).join(" · ") : meta.length > 0 ? t("No line of the file changed.") : t("The patch for this file is empty.")}</div>
      </div>
    );
  }

  // A line with a note or a side thread is never folded away (the user's own note must not disappear in a fold).
  const plan = planFolds(diff, props.generated, pinnedLines(diff, props.highlighted, props.anchoredLines, props.markedLines).reduce((f, id) => revealLine(f, diff, id), folds));
  const byId = new Map<number, DiffLine>();
  linesById.current = byId;
  const rows: ReactNode[] = [];

  const codeRow = (line: DiffLine, hunk: DiffHunk | null, flags: string, actions?: ReactNode) => {
    byId.set(line.id, line);
    const key = lineKey(line);
    const id = key ? keyId(key) : null;
    const hl = id && props.highlighted?.has(id) ? " note-line" : "";
    const anchored = id && props.anchoredLines?.has(id) ? " side-anchored" : "";
    const marked = id !== null && props.markedLines?.has(id) === true; // MARK: wave3 desktop-flow — §36.13
    rows.push(
      <Fragment key={line.id}>
        <Row
          line={line}
          hunkId={hunk && line.id >= 0 ? hunk.id : null}
          flags={`${hl}${flags}${anchored}${marked ? " prereview-line" : ""}`}
          mark={marked ? (props.markTitle ?? "") : null}
          canAdd={props.onAdd !== undefined && (props.noteSides !== "new" || line.kind !== "del") && (props.revealedActions !== false || line.id >= 0)}
          canAsk={props.onAsk !== undefined && (props.revealedActions !== false || line.id >= 0)}
          onAdd={onAdd}
          onAsk={onAsk}
          header={hunk?.header}
          actions={actions}
        />
        {props.extra?.(line, key)}
      </Fragment>,
    );
  };

  /** A gap's revealed lines around its "20줄 더 보기" row (the lines below the previous hunk, then those above the next). */
  let blockedShown = false;
  const gapRows = (gap: Gap, dirs: ("up" | "down")[], next: DiffHunk | null) => {
    const view = gapView(gap, usable ? revealed[gap.index] : undefined, usable ? usable.length : null);
    const near = next ?? diff.hunks[diff.hunks.length - 1] ?? null;
    for (const n of view.down) codeRow(contextRow(usable!, n, gap.oldOffset), near, " context-extra");
    if (view.hidden !== 0) {
      const reason = contextBlocked;
      rows.push(
        <ExpanderRow
          key={`gap-${gap.index}`}
          gap={gap}
          dirs={dirs}
          hidden={view.hidden}
          loading={src?.loading === true}
          blocked={reason}
          showReason={reason !== null && !blockedShown}
          onExpand={expand}
        />,
      );
      if (reason) blockedShown = true;
    }
    for (const n of view.up) codeRow(contextRow(usable!, n, gap.oldOffset), near, " context-extra");
  };

  if (plan.kind === "generated") {
    rows.push(
      <FoldRow key="generated" label={t("Generated file · +{0} lines · Expand", plan.lines)} title={generatedHelp(plan.generated)} onClick={() => setFolds(openGenerated)} testId="Generated fold" />,
    );
  } else {
    const gapAt = new Map(gaps.map((g) => [g.index, g]));
    plan.hunks.forEach((fold, i) => {
      const h = fold.hunk;
      const prevWhole = i === 0 || plan.hunks[i - 1]!.hidden === 0;
      const gap = gapAt.get(i);
      if (gap && prevWhole) gapRows(gap, i === 0 ? ["up"] : ["down", "up"], h);
      const aside = props.hunkAside?.(h);
      const own = props.hunkActions?.(h);
      const actions =
        aside || own ? (
          <>
            {aside && <span className="hunk-aside">{aside}</span>}
            {own}
          </>
        ) : undefined;
      const sel = props.selectedHunks?.has(h.id) ? " hunk-sel" : "";
      const hasHeader = h.lines.some((l) => l.kind === "hunkHeader");
      if (actions && !hasHeader) {
        rows.push(
          <div key={`head-${h.id}`} className={`line hunk${sel}`}>
            <span className="sr-only">{t("Changed part:")} </span>{/* MARK: wave4d w4d-speed — polish-10 */}
            <span className="text">{h.header}</span>
            <span className="hunk-actions">{actions}</span>
          </div>,
        );
      }
      for (let k = 0; k < fold.shown; k++) {
        const line = h.lines[k]!;
        codeRow(line, h, sel, line.kind === "hunkHeader" ? actions : undefined);
      }
      if (fold.hidden > 0) {
        rows.push(<FoldRow key={`fold-${h.id}`} label={t("Large diff · {0} lines · Expand", fold.hidden)} onClick={() => setFolds((f) => expandFold(f, fold))} testId={`Large fold ${h.id}`} />);
      }
    });
    const last = plan.hunks[plan.hunks.length - 1];
    const tail = gapAt.get(plan.hunks.length);
    if (tail && last && last.hidden === 0) gapRows(tail, ["down"], null);
  }

  return (
    <div className="unified-pane" ref={paneRef}>
      <DiffToolsRow onFind={openFind}>{props.toolbar}</DiffToolsRow>
      {find.open && (
        <DiffFindBar
          query={find.query}
          onQuery={(query) => setFind((f) => ({ ...f, query, current: 0 }))}
          count={matches.length}
          current={current}
          capped={matches.length >= MAX_FIND_MATCHES}
          onStep={(dir) => setFind((f) => ({ ...f, current: stepIndex(current, matches.length, dir) }))}
          onClose={closeFind}
          focusSeq={find.focusSeq}
        />
      )}
      <div
        className={`unified scroll ${wrap ? "wrap" : "nowrap"}`}
        data-testid="Unified diff"
        ref={scrollRef}
        tabIndex={0}
        onContextMenu={onContextMenu}
      >
        <div className="unified-rows">{rows}</div>
      </div>
      {menu && createPortal(<LineMenu at={menu} path={props.path} oldPath={diff.oldPath} onClose={closeMenu} onOpen={props.onOpenLine} items={props.lineMenuItems?.(menu.line)} />, document.body)}
    </div>
  );
}

// MARK: wave2 desktop-diff — rows

type RowProps = {
  line: DiffLine;
  /** The hunk the line belongs to (`data-hunk`); null for a revealed context line. */
  hunkId: number | null;
  /** Extra classes (note-line / hunk-sel / side-anchored / context-extra), each with its leading space. */
  flags: string;
  canAdd: boolean;
  canAsk: boolean;
  onAdd: (line: DiffLine, key: LineKey) => void;
  onAsk: (line: DiffLine, key: LineKey) => void;
  /** The hunk's header text (a header row whose own text is empty). */
  header?: string;
  /** Header rows: the hunk's controls at the row's right end. */
  actions?: ReactNode;
  /** MARK: wave3 desktop-flow — §36.13: a pre-review mark at the row's end (its title); null / absent: none. */
  mark?: string | null;
};

const Row = memo(function Row(p: RowProps) {
  const { line } = p;
  const key = lineKey(line);
  const cls = line.kind === "add" ? "add" : line.kind === "del" ? "del" : line.kind === "hunkHeader" ? "hunk" : "";
  const ws = line.wsOnly === true && (line.kind === "add" || line.kind === "del");
  return (
    <div
      className={`line ${cls}${ws ? " ws-only" : ""}${p.flags}`}
      data-id={line.id}
      data-hunk={p.hunkId ?? undefined}
      data-side={key?.side}
      data-line={key?.line}
      title={ws ? t("Only whitespace changed") : undefined}
    >
      {/* MARK: wave4d w4d-speed — polish-10: read as "추가된 줄 42: …" (the numbers and the sign are not read; the hover gutters are hidden until hovered) */}
      <span className="sr-only">{diffLinePrefix(line)} </span>
      <span className="no" aria-hidden="true">{line.oldNo ?? ""}</span>
      <span className="no" aria-hidden="true">{line.newNo ?? ""}</span>
      <span className="gutter-add" onClick={() => key && p.canAdd && p.onAdd(line, key)} title={p.canAdd && key ? t("{0} ({1})", t("Add note"), "⌥⌘N") : undefined}>
        {p.canAdd && key ? "+" : ""}
      </span>
      {p.canAsk && (
        <span
          className="gutter-ask"
          onClick={() => key && p.onAsk(line, key)}
          title={key ? t("Ask why about this line (side question)") : undefined}
          data-testid={key ? `Ask line ${key.side}:${key.line}` : undefined}
        >
          {key ? "?" : ""}
        </span>
      )}
      <span className="sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
      <LineText line={line} header={p.header} />
      {ws && <span className="sr-only">, {t("Only whitespace changed")}</span>}
      {line.kind === "hunkHeader" && p.actions && <span className="hunk-actions">{p.actions}</span>}
      {typeof p.mark === "string" && (
        <span className="prereview-mark" title={p.mark || undefined} aria-label={p.mark || undefined} data-testid="Pre-review line mark">
          ✦
        </span>
      )}
    </div>
  );
});

/** The code of a line, its §34.7 changed parts marked (`.seg`). */
function LineText({ line, header }: { line: DiffLine; header?: string }) {
  if (line.kind === "hunkHeader") return <span className="text">{line.text || header}</span>;
  const parts = line.segments ? segmentParts(line.text, line.segments) : null;
  if (!parts || (parts.length === 1 && !parts[0]!.changed)) return <span className="text">{line.text}</span>;
  return (
    <span className="text">
      {parts.map((part, i) => (part.changed ? <span key={i} className="seg">{part.text}</span> : <Fragment key={i}>{part.text}</Fragment>))}
    </span>
  );
}

function FoldRow(props: { label: string; title?: string; onClick: () => void; testId: string }) {
  return (
    <div className="diff-fold" data-testid={props.testId}>
      <button type="button" className="plain small" onClick={props.onClick} title={props.title}>
        <span aria-hidden="true">⋯</span> {props.label}
      </button>
    </div>
  );
}

/** "20줄 더 보기" between hunks: ↓ under the previous hunk, ↑ over the next; a gap of at most 20 lines opens whole. */
function ExpanderRow(props: {
  gap: Gap;
  dirs: ("up" | "down")[];
  /** Lines still hidden (null: unknown until the file is loaded). */
  hidden: number | null;
  loading: boolean;
  /** Why it cannot expand (disabled with this reason). */
  blocked: string | null;
  /** The reason is spelled out on the first blocked row only (no repeated notice). */
  showReason: boolean;
  onExpand: (gap: Gap, dir: "up" | "down") => void;
}) {
  const whole = props.hidden !== null && props.hidden <= CONTEXT_STEP && props.dirs.length === 2;
  const dirs = whole ? (["up"] as const) : props.dirs;
  const label = t("Show 20 more lines");
  return (
    <div className="diff-expander" data-testid={`Expand context ${props.gap.index}`}>
      {dirs.map((d) => (
        <button
          key={d}
          type="button"
          className="plain small"
          disabled={props.blocked !== null || props.loading}
          title={props.blocked ?? undefined}
          aria-label={`${label} ${d === "down" ? "↓" : "↑"}`}
          onClick={() => props.onExpand(props.gap, d)}
          data-testid={`Expand context ${props.gap.index} ${d}`}
        >
          <span aria-hidden="true">{whole ? "↕" : d === "down" ? "↓" : "↑"}</span> {label}
        </button>
      ))}
      {props.loading && <span className="spinner" />}
      {props.blocked && props.showReason && <span className="tiny faint truncate">{props.blocked}</span>}
    </div>
  );
}

function generatedHelp(kind: string): string | undefined {
  return kind === "lockfile" ? t("Build / dependency configuration or a lockfile") : undefined;
}

/** Ids of the diff lines a note (`highlighted`), a side thread (`anchored`) or a pre-review finding (`marked`) sits on; [] without any (no scan). */
function pinnedLines(diff: FileDiff, highlighted: ReadonlySet<string> | undefined, anchored: ReadonlySet<string> | undefined, marked?: ReadonlySet<string>): number[] {
  if (!highlighted?.size && !anchored?.size && !marked?.size) return [];
  const out: number[] = [];
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      const k = lineKey(l);
      if (!k) continue;
      const id = keyId(k);
      if (highlighted?.has(id) || anchored?.has(id) || marked?.has(id)) out.push(l.id);
    }
  }
  return out;
}

/** The hunk a line is in (a revealed context line: the hunk right after it, else the last one). */
function hunkNear(diff: FileDiff, line: DiffLine): DiffHunk | null {
  const own = diff.hunks.find((h) => h.lines.includes(line));
  if (own) return own;
  if (line.newNo !== null) {
    const after = diff.hunks.find((h) => h.lines.some((l) => l.newNo !== null && l.newNo > line.newNo!));
    if (after) return after;
  }
  return diff.hunks[diff.hunks.length - 1] ?? null;
}

// ---- find highlights (the chat's find bar uses the same API under other names)

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = (): HighlightRegistry | null => (typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: HighlightRegistry }).highlights : null);
const makeHighlight = (ranges: Range[]): unknown => new (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(...ranges);

/** The DOM range of `[start, end)` of an element's text (its text nodes in order: the line's segment spans included). */
function rangeIn(el: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let from: { node: Node; off: number } | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.nodeValue?.length ?? 0;
    if (!from && start < pos + len) from = { node: n, off: start - pos };
    if (from && end <= pos + len) {
      const r = document.createRange();
      r.setStart(from.node, from.off);
      r.setEnd(n, end - pos);
      return r;
    }
    pos += len;
  }
  return null;
}

/** Inline composer under a diff line (notes, PR drafts, replies). */
export function LineComposer(props: { title: string; submitTitle: string; busy?: boolean; onSubmit: (body: string) => void; onCancel: () => void; testId?: string }) {
  return (
    <form
      className="note-composer"
      data-testid={props.testId ?? "Line composer"}
      onSubmit={(e) => {
        e.preventDefault();
        const ta = e.currentTarget.querySelector("textarea")!;
        if (ta.value.trim()) props.onSubmit(ta.value);
      }}
    >
      <span className="caption muted">{props.title}</span>
      <textarea
        autoFocus
        placeholder={props.submitTitle}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
          if (isEnter(e) && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <span className="tiny faint">{t("⌘↩ to {0}", props.submitTitle)}</span>
        <button type="button" className="small" onClick={props.onCancel}>{t("Cancel")}</button>
        <button type="submit" className="primary small" disabled={props.busy}>{props.submitTitle}</button>
      </div>
    </form>
  );
}
