/**
 * §62 in a Monaco editor (the review's full-file view, the project file view): Ctrl+click a name (⌘-click on a Mac
 * development build) goes to its definition, the name is underlined while Ctrl is held over it; the editor's context menu
 * and keys carry Go to Definition (F12), Find References (Shift+F12) and Open in IDE (Ctrl+Alt+O).
 * §65.8: Peek Definition (Alt+F12, and Ctrl+click while Settings says "Peek") shows the peek band in a view zone under
 * the line (nav/bandSlot.ts).
 */
import { t } from "../i18n";
import { monaco } from "../monaco";
import { navModifier } from "./domTarget";
import { identifierAt, isSendableSymbol } from "./identifier";
import type { NavLocation } from "./navModel";
import { endHover, hoverTimer, useNav } from "./navStore";
import { setBandSlot, useBandSlot, type BandAnchor } from "./bandSlot";
import { ctrlClickAction } from "./peekModel";
import { useStore } from "../store";
import { openInIde } from "./openInIde";

type Opts = {
  /** The file's repo-relative path. */
  path: string;
  /** Where the user is when they jump from `line` (Back returns there). */
  from: (line: number) => NavLocation | null;
};

/** The name at a position of the editor's model, or at its selection when a name is selected. */
function symbolAt(ed: monaco.editor.ICodeEditor, pos: monaco.IPosition, path: string, useSelection: boolean) {
  const model = ed.getModel();
  if (!model) return null;
  const sel = ed.getSelection();
  if (useSelection && sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) {
    const chosen = model.getValueInRange(sel).trim();
    if (isSendableSymbol(chosen)) return { symbol: chosen, line: sel.startLineNumber, start: sel.startColumn, end: sel.endColumn };
  }
  const found = identifierAt(model.getLineContent(pos.lineNumber), pos.column - 1, path);
  return found ? { symbol: found.symbol, line: pos.lineNumber, start: found.start + 1, end: found.end + 1, ...(found.receiver ? { receiver: found.receiver } : {}) } : null;
}

export function attachMonacoNav(ed: monaco.editor.IStandaloneCodeEditor, opts: Opts): monaco.IDisposable {
  const link = ed.createDecorationsCollection();
  const disposables: monaco.IDisposable[] = [];
  let lastMouse: monaco.editor.IEditorMouseEvent | null = null;

  const underline = (e: monaco.editor.IEditorMouseEvent | null, held: boolean) => {
    const pos = e?.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT ? e.target.position : null;
    const found = held && pos ? symbolAt(ed, pos, opts.path, false) : null;
    link.set(found ? [{ range: new monaco.Range(found.line, found.start, found.line, found.end), options: { inlineClassName: "rg-nav-link" } }] : []);
    // §65.8: resting on the name with Ctrl held shows its definition after 600 ms.
    if (!found) {
      if (hovering) {
        hovering = false;
        endHover();
      }
      return;
    }
    hovering = true;
    const vis = ed.getScrolledVisiblePosition({ lineNumber: found.line, column: found.start });
    const box = ed.getDomNode()?.getBoundingClientRect();
    const q = { symbol: found.symbol, fromPath: opts.path, line: found.line, column: found.start, ...(found.receiver ? { receiver: found.receiver } : {}), x: (box?.left ?? 0) + (vis?.left ?? 0), y: (box?.top ?? 0) + (vis?.top ?? 0) + (vis?.height ?? 16) };
    if (hoverTimer.move(`${ed.getId()}|${found.line}|${found.start}|${found.symbol}`, q)) useNav.getState().hideHover();
  };
  let hovering = false;
  disposables.push(
    ed.onMouseMove((e) => {
      lastMouse = e;
      underline(e, navModifier(e.event));
    }),
    ed.onMouseLeave(() => {
      lastMouse = null;
      link.clear();
      if (hovering) {
        hovering = false;
        endHover();
      }
    }),
    ed.onKeyDown((e) => {
      if (e.keyCode === monaco.KeyCode.Ctrl || e.keyCode === monaco.KeyCode.Meta) underline(lastMouse, true);
    }),
    ed.onKeyUp(() => {
      link.clear();
      if (hovering) {
        hovering = false;
        endHover();
      }
    }),
    ed.onDidScrollChange(() => {
      if (hovering) {
        hovering = false;
        endHover();
      }
    }),
    ed.onMouseDown((e) => {
      if (hovering) {
        hovering = false;
        endHover();
      }
      if (!e.event.leftButton || !navModifier(e.event) || e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !e.target.position) return;
      const found = symbolAt(ed, e.target.position, opts.path, false);
      if (!found) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      link.clear();
      const b = e.event.browserEvent;
      if (ctrlClickAction(useStore.getState().settings?.navCtrlClick) === "peek") peek(found);
      else useNav.getState().goToDefinition({ symbol: found.symbol, fromPath: opts.path, line: found.line, column: found.start, receiver: found.receiver, x: b.clientX, y: b.clientY, from: opts.from(found.line) });
    }),
  );

  // ---- §65.8 the peek band: a view zone under the line while the band's anchor is this editor's
  function peek(found: { symbol: string; line: number; start: number; receiver?: string }) {
    useNav.getState().peekDefinition({
      symbol: found.symbol,
      fromPath: opts.path,
      line: found.line,
      column: found.start,
      ...(found.receiver ? { receiver: found.receiver } : {}),
      anchor: { kind: "monaco", editorId: ed.getId(), line: found.line },
      from: opts.from(found.line),
    });
  }
  let zone: { id: string; anchor: BandAnchor & { kind: "monaco" }; outer: HTMLElement; observer: ResizeObserver } | null = null;
  const zoneWidth = () => {
    const info = ed.getLayoutInfo();
    return `${Math.max(200, info.contentWidth - info.verticalScrollbarWidth)}px`;
  };
  const removeZone = () => {
    if (!zone) return;
    const z = zone;
    zone = null;
    z.observer.disconnect();
    ed.changeViewZones((acc) => acc.removeZone(z.id));
    setBandSlot(null, z.anchor);
  };
  const syncZone = () => {
    const a = useBandSlot.getState().anchor;
    const mine = a?.kind === "monaco" && a.editorId === ed.getId() ? a : null;
    if (zone && mine && zone.anchor.line === mine.line) return;
    removeZone();
    const model = ed.getModel();
    if (!mine || !model || mine.line < 1 || mine.line > model.getLineCount()) return;
    const outer = document.createElement("div");
    outer.className = "nav-band-zone";
    outer.style.width = zoneWidth();
    const node = document.createElement("div");
    outer.appendChild(node);
    const def: monaco.editor.IViewZone = { afterLineNumber: mine.line, heightInPx: 34, domNode: outer, suppressMouseDown: true };
    let id = "";
    ed.changeViewZones((acc) => (id = acc.addZone(def)));
    let shown = false;
    const observer = new ResizeObserver(() => {
      const h = node.offsetHeight;
      if (h <= 0 || h === def.heightInPx) return;
      def.heightInPx = h;
      ed.changeViewZones((acc) => acc.layoutZone(id));
      if (shown) return;
      shown = true;
      // The band comes into view by the least scroll; the clicked line stays on screen.
      const lineTop = ed.getTopForLineNumber(mine.line);
      const bottom = ed.getTopForLineNumber(mine.line + 1) + h;
      const view = ed.getScrollTop() + ed.getLayoutInfo().height;
      if (bottom > view) ed.setScrollTop(Math.min(lineTop, ed.getScrollTop() + bottom - view));
    });
    observer.observe(node);
    zone = { id, anchor: mine, outer, observer };
    setBandSlot(node, mine);
  };
  disposables.push({ dispose: useBandSlot.subscribe(syncZone) }, ed.onDidLayoutChange(() => zone && (zone.outer.style.width = zoneWidth())));
  syncZone();

  /** The caret's name, the popover placed at it. */
  const atCaret = () => {
    const pos = ed.getPosition();
    if (!pos) return null;
    const found = symbolAt(ed, pos, opts.path, true);
    if (!found) return null;
    const vis = ed.getScrolledVisiblePosition({ lineNumber: found.line, column: found.start });
    const box = ed.getDomNode()?.getBoundingClientRect();
    return { ...found, x: (box?.left ?? 0) + (vis?.left ?? 0), y: (box?.top ?? 0) + (vis?.top ?? 0) + (vis?.height ?? 16) };
  };
  disposables.push(
    ed.addAction({
      id: "rg.nav.definition",
      label: t("Go to Definition"),
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1,
      run: () => {
        const at = atCaret();
        if (at) useNav.getState().goToDefinition({ symbol: at.symbol, fromPath: opts.path, line: at.line, column: at.start, receiver: at.receiver, x: at.x, y: at.y, from: opts.from(at.line) });
      },
    }),
    ed.addAction({
      id: "rg.nav.peek",
      label: t("Peek Definition"),
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.F12],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.5,
      run: () => {
        const at = atCaret();
        if (at) peek(at);
      },
    }),
    ed.addAction({
      id: "rg.nav.references",
      label: t("Find References"),
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 2,
      run: () => {
        const at = atCaret();
        if (at) useNav.getState().findReferences({ symbol: at.symbol, fromPath: opts.path, line: at.line, column: at.start });
      },
    }),
    ed.addAction({
      id: "rg.nav.openInIde",
      label: t("Open in IDE"),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyO],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 3,
      run: () => {
        const pos = ed.getPosition();
        void openInIde(opts.path, pos?.lineNumber ?? 1, pos?.column ?? 1);
      },
    }),
  );

  return {
    dispose: () => {
      for (const d of disposables) d.dispose();
      removeZone();
      link.clear();
    },
  };
}
