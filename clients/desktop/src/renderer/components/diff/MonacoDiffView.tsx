/**
 * "Full file" view: a read-only Monaco `DiffEditor` over `full_file_content.oldText/newText`
 * (inline or side-by-side, scrolled to the first change). A click on the modified editor's glyph
 * margin opens the note composer for that line (side "new"); notes and the composer are view zones
 * whose DOM nodes are filled through React portals.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FullFileContentEvent, ReviewNote } from "@reviewgate/engine";
import { t } from "../../i18n";
import { languageFor, monaco } from "../../monaco";
import { LineComposer, type LineKey } from "../UnifiedDiff";
import { type NoteTarget } from "./UnifiedView";
import { ReviewNoteBubble } from "./NoteCards"; // MARK: wave2 desktop-flow — §34.4 sent notes
import { useDiffPrefs } from "../../diffPrefs"; // MARK: wave2 desktop-diff — "줄바꿈" applies here too

type Zone = { id: string; key: string; node: HTMLElement; note: ReviewNote | null };

export function MonacoDiffView(props: {
  path: string;
  content: FullFileContentEvent;
  sideBySide: boolean;
  /** Monaco `hideUnchangedRegions` (§1.12): folds unchanged stretches, 3 context lines around each change. */
  collapseUnchanged: boolean;
  notes: ReviewNote[];
  composer: LineKey | null;
  onOpenComposer: (target: NoteTarget) => void;
  onCloseComposer: () => void;
  onAddNote: (target: NoteTarget, body: string) => void;
  onRemoveNote: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [editor, setEditor] = useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const callbacks = useRef(props);
  callbacks.current = props;
  const wrap = useDiffPrefs((s) => s.wrap); // MARK: wave2 desktop-diff

  // ---- editor lifecycle (per file)
  useEffect(() => {
    const host = hostRef.current;
    if (!host || props.content.oldText === null || props.content.newText === null) return;
    const language = languageFor(props.path);
    const original = monaco.editor.createModel(props.content.oldText, language);
    const modified = monaco.editor.createModel(props.content.newText, language);
    const ed = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: props.sideBySide,
      hideUnchangedRegions: { enabled: props.collapseUnchanged, contextLineCount: 3 },
      useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true,
      glyphMargin: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      diffWordWrap: wrap ? "on" : "off",
      fontSize: 12,
    });
    ed.setModel({ original, modified });
    editorRef.current = ed;
    setEditor(ed);

    const mod = ed.getModifiedEditor();
    const hover = mod.createDecorationsCollection();
    const disposables: monaco.IDisposable[] = [];

    // Scroll to the first change once the diff is computed.
    const once = ed.onDidUpdateDiff(() => {
      once.dispose();
      const first = ed.getLineChanges()?.[0];
      if (!first) return;
      mod.revealLineInCenter(Math.max(1, first.modifiedStartLineNumber || first.modifiedEndLineNumber || 1));
    });
    disposables.push(once);

    // Hover "+" glyph on the line under the pointer.
    let hoverLine = 0;
    disposables.push(
      mod.onMouseMove((e) => {
        const line = e.target.position?.lineNumber ?? 0;
        if (line === hoverLine) return;
        hoverLine = line;
        hover.set(
          line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "note-glyph", glyphMarginHoverMessage: { value: t("Add note") } } }] : [],
        );
      }),
    );
    disposables.push(
      mod.onMouseLeave(() => {
        hoverLine = 0;
        hover.clear();
      }),
    );
    disposables.push(
      mod.onMouseDown((e) => {
        if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
        const line = e.target.position.lineNumber;
        const excerpt = mod.getModel()?.getLineContent(line) ?? "";
        callbacks.current.onOpenComposer({ side: "new", line, excerpt });
      }),
    );

    return () => {
      for (const d of disposables) d.dispose();
      hover.clear();
      editorRef.current = null;
      setEditor(null);
      setZones([]);
      ed.dispose();
      original.dispose();
      modified.dispose();
    };
    // The file (and therefore the models) changes only with `path` / `content`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path, props.content]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: props.sideBySide });
  }, [props.sideBySide]);
  useEffect(() => {
    editorRef.current?.updateOptions({ hideUnchangedRegions: { enabled: props.collapseUnchanged, contextLineCount: 3 } });
  }, [props.collapseUnchanged]);
  // MARK: wave2 desktop-diff
  useEffect(() => {
    editorRef.current?.updateOptions({ diffWordWrap: wrap ? "on" : "off" });
  }, [wrap]);

  // ---- note lines + view zones (notes on side "new", plus the open composer)
  const noteLines = props.notes.filter((n) => n.side === "new" && n.line !== null);
  const zoneKeys = noteLines.map((n) => `n:${n.id}:${n.line}`).join("|") + (props.composer ? `|c:${props.composer.side}:${props.composer.line}` : "");
  useEffect(() => {
    if (!editor) return;
    const mod = editor.getModifiedEditor();
    const lineCount = mod.getModel()?.getLineCount() ?? 0;
    const marks = mod.createDecorationsCollection(
      noteLines
        .filter((n) => (n.line ?? 0) <= lineCount)
        .map((n) => ({ range: new monaco.Range(n.line!, 1, n.line!, 1), options: { isWholeLine: true, className: "note-line" } })),
    );
    const created: Zone[] = [];
    const observers: ResizeObserver[] = [];
    mod.changeViewZones((acc) => {
      const add = (key: string, afterLine: number, note: ReviewNote | null) => {
        if (afterLine < 1 || afterLine > lineCount) return;
        // Monaco sizes the outer node to the zone height; the inner node grows with its content.
        const outer = document.createElement("div");
        outer.className = "zone";
        const node = document.createElement("div");
        outer.appendChild(node);
        const zone: monaco.editor.IViewZone = { afterLineNumber: afterLine, heightInPx: 72, domNode: outer, suppressMouseDown: true };
        const id = acc.addZone(zone);
        created.push({ id, key, node, note });
        const ro = new ResizeObserver(() => {
          const h = node.offsetHeight + 8;
          if (node.offsetHeight > 0 && h !== zone.heightInPx) {
            zone.heightInPx = h;
            mod.changeViewZones((a) => a.layoutZone(id));
          }
        });
        ro.observe(node);
        observers.push(ro);
      };
      for (const n of noteLines) add(`n:${n.id}`, n.line!, n);
      if (props.composer && props.composer.side === "new") add("composer", props.composer.line, null);
    });
    setZones(created);
    if (props.composer?.side === "new") mod.revealLineInCenterIfOutsideViewport(props.composer.line);
    return () => {
      for (const ro of observers) ro.disconnect();
      // The editor may already be disposed when the file changed.
      if (editorRef.current !== editor) return;
      marks.clear();
      mod.changeViewZones((acc) => created.forEach((z) => acc.removeZone(z.id)));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, zoneKeys]);

  const composerTarget = (): NoteTarget | null => {
    if (!props.composer || props.composer.side !== "new") return null;
    const excerpt = editor?.getModifiedEditor().getModel()?.getLineContent(props.composer.line) ?? "";
    return { ...props.composer, excerpt };
  };

  return (
    <div className="monaco-host" data-testid="Full file view">
      <div className="editor" ref={hostRef} />
      {zones.map((z) =>
        createPortal(
          z.note ? (
            <ReviewNoteBubble note={z.note} onRemove={() => props.onRemoveNote(z.note!.id)} />
          ) : (
            <LineComposer
              title={t("Note on {0}", `+${props.composer?.line ?? ""}`)}
              submitTitle={t("Add note")}
              testId="Note composer"
              onSubmit={(body) => {
                const target = composerTarget();
                if (target) props.onAddNote(target, body);
              }}
              onCancel={props.onCloseComposer}
            />
          ),
          z.node,
          z.key,
        ),
      )}
    </div>
  );
}

/** Placeholder for binary / too-large files in the full-file view. */
export function FullFilePlaceholder(props: { content: FullFileContentEvent }) {
  if (props.content.isBinary) {
    return (
      <div className="empty">
        <span className="glyph">🗜</span>
        <h2>{t("Binary file")}</h2>
        <div>{t("No textual view is available for this file.")}</div>
      </div>
    );
  }
  return (
    <div className="empty">
      <span className="glyph">📄</span>
      <h2>{t("File too large")}</h2>
      <div>{t("Files over 20,000 lines or 2 MB are not shown in full; use the diff view.")}</div>
    </div>
  );
}
