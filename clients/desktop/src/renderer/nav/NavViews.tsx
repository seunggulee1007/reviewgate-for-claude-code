/**
 * §62 code navigation on Windows — the window-wide parts: Ctrl+click / the Ctrl-held underline in the DOM diffs (review,
 * History, PR), F12 / Shift+F12 / Alt+← / Alt+→ / Ctrl+Alt+O, the peek list at the click, the "no definition" notice,
 * the references panel under the panes, and the Back / Forward buttons.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { useStore } from "../store";
import { showToast } from "../toast";
import { navKey } from "../keymap";
import { isTerminalTarget } from "../terminal/terminalKeys";
import { domTargetAt, domTargetAtSelection, navModifier, type DomNavTarget } from "./domTarget";
import { groupByFile, peekKey, splitPath, type NavLocation, type RefRow } from "./navModel";
import { currentLocation, endHover, hoverTimer, useNav } from "./navStore";
import { NavHistoryButtons, Preview } from "./NavBits";
import { openInIde } from "./openInIde";
import { useBandSlot } from "./bandSlot"; // §65.8
import { PeekBand } from "./PeekBand";
import { QuickOpen } from "./QuickOpen";
import { ctrlClickAction } from "./peekModel";
import "./nav.css";

export { NavHistoryButtons, Preview } from "./NavBits";

const APPROXIMATE = () => t("Search-based: may list look-alikes");

/** Where a jump from a DOM diff starts: the review's line, or the History / PR pane. */
function fromDom(target: DomNavTarget): NavLocation | null {
  const s = useStore.getState();
  if (s.tab === "prs") return { kind: "pane", pane: "prs" };
  if (s.historyView) return { kind: "pane", pane: "history" };
  return { kind: "review", path: target.path, line: target.line ?? 1 };
}

export function goFromDom(target: DomNavTarget, x: number, y: number): void {
  const from = fromDom(target);
  if (from?.kind === "review") useNav.getState().setHere(from.path, from.line);
  useNav.getState().goToDefinition({ symbol: target.symbol, fromPath: target.path, ...(target.line ? { line: target.line } : {}), column: target.column, ...(target.receiver ? { receiver: target.receiver } : {}), x, y, from });
}

/** §65.8 Peek Definition from a DOM diff: the band under the name's row. */
export function peekFromDom(target: DomNavTarget): void {
  const from = fromDom(target);
  if (from?.kind === "review") useNav.getState().setHere(from.path, from.line);
  useNav.getState().peekDefinition({
    symbol: target.symbol,
    fromPath: target.path,
    ...(target.line ? { line: target.line } : {}),
    column: target.column,
    ...(target.receiver ? { receiver: target.receiver } : {}),
    anchor: { kind: "dom", path: target.path, rowId: target.rowId },
    from,
  });
}

/** Ctrl+click: Settings › Review › Code navigation says peek (the default) or jump. */
export function ctrlClickPeeks(): boolean {
  return ctrlClickAction(useStore.getState().settings?.navCtrlClick) === "peek";
}

const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");

/** The underline while Ctrl is held over a name, and Ctrl+click → Go to Definition, in the DOM diffs. */
function useDomNav(): void {
  useEffect(() => {
    const reg = typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: { set(n: string, h: unknown): void; delete(n: string): void } }).highlights : null;
    let shown = false;
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    const clear = () => {
      if (!shown) return;
      shown = false;
      endHover(); // §65.8
      reg?.delete("rg-nav-link");
      document.body.classList.remove("rg-nav-pointer");
    };
    const paint = (held: boolean) => {
      const target = held && pointer ? domTargetAt(pointer.x, pointer.y) : null;
      if (!target) return clear();
      shown = true;
      reg?.set("rg-nav-link", new (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(target.range));
      document.body.classList.add("rg-nav-pointer");
      // §65.8: resting on the name with Ctrl held shows its definition after 600 ms.
      const box = target.range.getBoundingClientRect();
      const key = `${target.path}|${target.rowId}|${target.column}|${target.symbol}`;
      const q = { symbol: target.symbol, fromPath: target.path, ...(target.line ? { line: target.line } : {}), column: target.column, ...(target.receiver ? { receiver: target.receiver } : {}), x: box.left, y: box.bottom };
      if (hoverTimer.move(key, q)) useNav.getState().hideHover();
    };
    const onMove = (e: MouseEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      const held = navModifier(e);
      if (!held) return clear();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => paint(true));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") paint(navModifier(e));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") clear();
    };
    const onScroll = () => {
      if (useNav.getState().hover) endHover();
    };
    const onDown = (e: MouseEvent) => {
      if (useNav.getState().hover) endHover();
      if (e.button !== 0 || !navModifier(e) || e.altKey || e.shiftKey) return;
      const target = domTargetAt(e.clientX, e.clientY);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      clear();
      if (ctrlClickPeeks()) peekFromDom(target);
      else goFromDom(target, e.clientX, e.clientY);
    };
    document.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", clear);
    return () => {
      cancelAnimationFrame(frame);
      clear();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", clear);
    };
  }, []);
}

/** The line Open in IDE opens in front: the caret's / selection's row in a diff, else where the user last was. */
function ideTargetNow(): { path: string; line: number } | null {
  const s = useStore.getState();
  const nav = useNav.getState();
  if (nav.file) return { path: nav.file.path, line: nav.here?.path === nav.file.path ? nav.here.line : nav.file.line };
  if (s.tab === "prs") return null;
  const path = s.historyView ? s.historyView.path : s.selectedPath;
  if (!path) return null;
  const sel = domTargetAtSelection();
  const line = sel?.path === path && sel.line ? sel.line : nav.here?.path === path ? nav.here.line : 1;
  return { path, line };
}

/** F12 / Shift+F12 on the caret's name in a DOM diff; Alt+← / Alt+→; Ctrl+Alt+O. Monaco editors take their own (monacoNav.ts). */
function useNavKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // §65.8: Esc closes the peek band wherever the keyboard is — but a text field or a terminal keeps its own Esc.
      if (e.key === "Escape" && useNav.getState().band && !e.defaultPrevented && !editable(e.target) && !isTerminalTarget(e.target) && !useStore.getState().dialog) {
        e.preventDefault();
        useNav.getState().closeBand();
        return;
      }
      const k = navKey(e);
      if (!k || e.defaultPrevented || useStore.getState().dialog || isTerminalTarget(e.target)) return;
      const inMonaco = e.target instanceof Element && e.target.closest(".monaco-editor") !== null;
      // §65.8: the palettes open from anywhere but a terminal (a text field and Monaco too).
      if (k === "goToFile" || k === "fileSymbols" || k === "projectSymbols") {
        e.preventDefault();
        useNav.getState().openPalette(k === "goToFile" ? "files" : k);
        return;
      }
      if (k === "nextReference" || k === "previousReference") {
        if (useNav.getState().stepReferences(k === "nextReference" ? 1 : -1)) e.preventDefault();
        return;
      }
      if (k === "back" || k === "forward") {
        if (editable(e.target) && !inMonaco) return;
        e.preventDefault();
        if (k === "back") useNav.getState().back();
        else useNav.getState().forward();
        return;
      }
      if (inMonaco || editable(e.target)) return;
      if (k === "openInIde") {
        const target = ideTargetNow();
        if (!target) return;
        e.preventDefault();
        void openInIde(target.path, target.line);
        return;
      }
      const target = domTargetAtSelection();
      if (!target) {
        if (document.querySelector(".unified-pane[data-nav-path]")) {
          e.preventDefault();
          showToast(t("Click a name in the diff first, or Ctrl+click it"));
        }
        return;
      }
      e.preventDefault();
      if (k === "references") useNav.getState().findReferences({ symbol: target.symbol, fromPath: target.path });
      else if (k === "peek") peekFromDom(target);
      else {
        const box = target.range.getBoundingClientRect();
        goFromDom(target, box.left, box.bottom);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Mounted once: the listeners, the peek list and the peek band (portalled into the slot under its line). */
export function NavLayer() {
  useDomNav();
  useNavKeys();
  const peek = useNav((s) => s.peek);
  const band = useNav((s) => s.band !== null);
  const slot = useBandSlot((s) => s.slot);
  const hover = useNav((s) => s.hover !== null);
  const palette = useNav((s) => s.palette?.seq ?? null);
  return (
    <>
      {peek && createPortal(<PeekPopover />, document.body)}
      {hover && !peek && createPortal(<HoverCard />, document.body)}
      {palette !== null && createPortal(<QuickOpen key={palette} />, document.body)}
      {band && slot && createPortal(<PeekBand />, slot)}
    </>
  );
}

/** §65.8: the hover card under the name — the signature in bold, then the doc comment and the next lines. */
function HoverCard() {
  const hover = useNav((s) => s.hover)!;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: hover.x, top: hover.y + 4 });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const top = hover.y + 4 + r.height > window.innerHeight - 4 ? Math.max(4, hover.y - r.height - 24) : hover.y + 4;
    setPos({ left: Math.max(4, Math.min(hover.x, window.innerWidth - r.width - 4)), top });
  }, [hover.seq, hover.x, hover.y]);
  const { name, folder } = splitPath(hover.path);
  return (
    <div ref={ref} className="nav-hover" style={pos} role="tooltip" data-testid="Hover preview">
      <div className="nav-hover-sig">{hover.signature}</div>
      <div className="nav-hover-where">
        {name}:{hover.line}
        {folder ? ` · ${folder}` : ""}
      </div>
      <div className="nav-hover-code">
        {hover.lines.map((l) => (
          <div key={l.no} className={l.target ? "target" : undefined}>
            {l.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

function PeekPopover() {
  const peek = useNav((s) => s.peek)!;
  const close = useNav((s) => s.closePeek);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: peek.x, top: peek.y + 6 });
  // A search that answers fast never flashes a spinner.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!peek.loading) return;
    const id = window.setTimeout(() => setSlow(true), 300);
    return () => window.clearTimeout(id);
  }, [peek.loading]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = peek.y + 18;
    const top = below + r.height > window.innerHeight - 4 ? Math.max(4, peek.y - r.height - 6) : below;
    setPos({ left: Math.max(4, Math.min(peek.x - 12, window.innerWidth - r.width - 4)), top });
  }, [peek.x, peek.y, peek.loading, peek.rows.length, peek.error]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      const p = useNav.getState().peek;
      if (!p) return;
      const r = peekKey(e.key, p.selected, p.loading || p.error ? 0 : p.rows.length);
      if (!r) return;
      e.preventDefault();
      e.stopPropagation();
      if (r.kind === "close") close();
      else if (r.kind === "select") useNav.getState().setPeekSelected(r.index);
      else {
        const row = p.rows[r.index]!;
        useNav.getState().openTarget({ path: row.path, line: row.line, column: row.column, symbol: p.symbol }, p.from);
      }
    };
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [close]);

  // The selected row stays in view while ↑ / ↓ move.
  useEffect(() => {
    ref.current?.querySelector(".nav-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [peek.selected]);

  if (peek.loading && !slow) return <div ref={ref} className="nav-peek" style={{ position: "fixed", left: pos.left, top: pos.top, visibility: "hidden" }} />;
  const findRefs = () => useNav.getState().findReferences({ symbol: peek.symbol, ...(peek.fromPath ? { fromPath: peek.fromPath } : {}) });
  return (
    <div ref={ref} className="nav-peek" style={{ left: pos.left, top: pos.top }} role="group" aria-label={t("Go to Definition")} data-testid="Definition peek">
      {peek.loading ? (
        <div className="nav-peek-head">
          <span className="spinner" aria-hidden="true" />
          <span className="grow truncate">{t("Looking for the definition of {0}…", peek.symbol)}</span>
        </div>
      ) : peek.error ? (
        <div className="nav-peek-note" role="alert">
          <span className="bold">{t("No definition found")}</span>
          <span className="caption muted">{peek.error}</span>
        </div>
      ) : peek.rows.length === 0 ? (
        <div className="nav-peek-note" data-testid="No definition found">
          <span>
            <span className="bold">{t("No definition found")}</span> · <span className="mono">{peek.symbol}</span>
          </span>
          <span className="caption muted">{APPROXIMATE()}</span>
          {peek.timedOut && <span className="caption orange">{t("Search stopped after 10 s")}</span>}
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="small" onClick={findRefs} data-testid="Peek find references">
              {t("Find References")}
            </button>
            <button type="button" className="small" onClick={() => useNav.getState().findInProject(peek.symbol)} data-testid="Peek find in project">
              {t("Find in Project")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="nav-peek-head">
            <span className="grow truncate">
              {t("Definitions of {0}", peek.symbol)} <span className="faint">· {peek.rows.length}</span>
            </span>
            <span className="tiny faint" title={APPROXIMATE()}>↑↓ ↩ Esc</span>
          </div>
          <div className="nav-peek-list" role="listbox" aria-label={t("Definitions of {0}", peek.symbol)}>
            {peek.rows.map((row, i) => (
              <button
                key={`${row.path}:${row.line}`}
                type="button"
                role="option"
                aria-selected={i === peek.selected}
                className={`nav-row${i === peek.selected ? " selected" : ""}`}
                onMouseEnter={() => useNav.getState().setPeekSelected(i)}
                onClick={() => useNav.getState().openTarget({ path: row.path, line: row.line, column: row.column, symbol: peek.symbol }, peek.from)}
                title={`${row.path}:${row.line}`}
                data-testid={`Definition ${row.path}:${row.line}`}
              >
                <span className="nav-row-top">
                  <span className="name">{row.name}</span>
                  <span className="faint">:{row.line}</span>
                  <span className="folder">{row.folder}</span>
                  <span className="nav-kind">{row.kind}</span>
                </span>
                <Preview text={row.preview} symbol={peek.symbol} />
              </button>
            ))}
          </div>
          {(peek.truncated || peek.timedOut) && (
            <div className="nav-peek-foot caption orange">
              {peek.truncated && <span>{t("Showing the best 50")}</span>}
              {peek.timedOut && <span>{t("Search stopped after 10 s")}</span>}
            </div>
          )}
          <div className="nav-peek-foot">
            <button type="button" className="plain small" onClick={findRefs} data-testid="Peek find references">
              {t("Find References")} <span className="tiny faint">Shift+F12</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** "N references in M files" under the panes; a row opens like a definition. */
export function NavRefsPanel() {
  const refs = useNav((s) => s.refs);
  const close = useNav((s) => s.closeRefs);
  if (!refs) return null;
  const groups = groupByFile(refs.rows);
  const open = (row: RefRow) => useNav.getState().openTarget({ path: row.path, line: row.line, column: row.column, symbol: refs.symbol }, currentLocation());
  const title = refs.mode === "references" ? t("References to {0}", refs.symbol) : t("Find in Project: {0}", refs.symbol);
  return (
    <div className="nav-refs" role="region" aria-label={title} data-testid="References panel">
      <div className="nav-refs-head">
        <span className="bold truncate" title={APPROXIMATE()}>{title}</span>
        {refs.loading ? (
          <span className="spinner" aria-hidden="true" />
        ) : refs.error ? (
          <span className="caption red truncate">{refs.error}</span>
        ) : (
          <span className="caption muted" data-testid="References count">
            {refs.mode === "references" ? t("{0} references in {1} files", refs.rows.length, refs.files) : t("{0} matches in {1} files", refs.rows.length, refs.files)}
          </span>
        )}
        {refs.truncated && <span className="caption orange">{t("Only the first {0}", refs.rows.length)}</span>}
        {refs.timedOut && <span className="caption orange">{refs.mode === "references" ? t("Search stopped after 15 s") : t("Search stopped after 20 s")}</span>}
        <span className="grow" />
        <NavHistoryButtons />
        <button type="button" className="plain small" onClick={close} title={t("Close")} aria-label={t("Close")} data-testid="Close references">
          ×
        </button>
      </div>
      <div className="nav-refs-list">
        {!refs.loading && !refs.error && refs.rows.length === 0 && <div className="caption muted" style={{ padding: 10 }}>{t("Nothing found")}</div>}
        {groups.map((g) => (
          <div key={g.path}>
            <div className="nav-refs-file" title={g.path}>
              <span className="name">{g.name}</span>
              <span className="folder">{g.folder}</span>
              <span className="tiny faint">{g.rows.length}</span>
            </div>
            {g.rows.map((row) => (
              <button key={`${row.line}:${row.column}`} type="button" className="nav-ref" onClick={() => open(row)} title={`${row.path}:${row.line}`} data-testid={`Reference ${row.path}:${row.line}`}>
                <span className="no">{row.line}</span>
                <Preview text={row.preview} symbol={refs.symbol} />
                {row.kind && <span className="nav-kind pill gray" title={t("Looks like the definition")}>{row.kind}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
