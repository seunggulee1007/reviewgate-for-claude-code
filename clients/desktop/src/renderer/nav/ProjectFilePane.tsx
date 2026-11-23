/**
 * §62 / §47 on Windows — a file of the project opened by Go to Definition / Find References that is not one of the review's
 * changed files: read-only (`project_file`), in the diff pane's place, at the line with the name marked. Ctrl+click in it
 * goes on; Back / Forward, Open in IDE and "Back to review" are in its header.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { languageFor, monaco } from "../monaco";
import { useStore } from "../store";
import { OpenInEditor } from "../components/diff/OpenInEditor";
import { attachMonacoNav } from "./monacoNav";
import { splitPath, searchedWord } from "./navModel";
import { useNav } from "./navStore";
import { NavHistoryButtons } from "./NavViews";
import "../components/diff/diff.css";
import "./nav.css";

export function ProjectFilePane() {
  const file = useNav((s) => s.file);
  const here = useNav((s) => s.here);
  const root = useStore((s) => s.state.project?.root ?? "");
  const hostRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const path = file?.path ?? "";
  const data = file?.data && file.data.path === path ? file.data : null;

  // One editor while the pane is open; a model per file.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !data || data.isBinary) return;
    const model = monaco.editor.createModel(data.lines.join("\n"), languageFor(path));
    const ed = monaco.editor.create(host, {
      model,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      fontSize: 12,
      glyphMargin: false,
    });
    const nav = attachMonacoNav(ed, { path, from: (line) => ({ kind: "file", path, line, column: 1 }) });
    const caret = ed.onDidChangeCursorPosition((e) => useNav.getState().setHere(path, e.position.lineNumber));
    setEditor(ed);
    return () => {
      caret.dispose();
      nav.dispose();
      setEditor(null);
      ed.dispose();
      model.dispose();
    };
  }, [path, data]);

  // Bring the line into view with the name marked (again on every jump to this file).
  const seq = file?.seq;
  useEffect(() => {
    if (!editor || !file) return;
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(1, file.line), model.getLineCount());
    const text = model.getLineContent(line);
    const word = file.symbol ? searchedWord(file.symbol) : "";
    const col = Math.max(1, Math.min(file.column, text.length + 1));
    const at = word && text.slice(col - 1, col - 1 + word.length) === word ? col : word ? text.indexOf(word) + 1 : 0;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: at > 0 ? at : col });
    const marks = editor.createDecorationsCollection([
      { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "rg-nav-target-line" } },
      ...(at > 0 ? [{ range: new monaco.Range(line, at, line, at + word.length), options: { inlineClassName: "rg-nav-target-symbol" } }] : []),
    ]);
    return () => marks.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, seq]);

  if (!file) return null;
  const { name, folder } = splitPath(file.path);
  const absolutePath = root ? `${root}/${file.path}` : file.path;
  const line = here?.path === file.path ? here.line : file.line;
  return (
    <div className="pane diff project-file" data-testid="Project file pane">
      <div className="pane-header diff-header project-file-head">
        <div className="row" style={{ gap: 8 }}>
          <NavHistoryButtons always />
          <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
            <span className="bold truncate" title={file.path} data-testid="Project file path">
              {name}
            </span>
            <span className="caption truncate folder" title={file.path}>
              {folder}
              {data && !data.isBinary ? ` · ${t("{0} lines", data.lines.length)}` : ""}
            </span>
          </div>
          <span className="pill gray" style={{ flex: "none" }} title={t("Files outside the review open read-only")}>
            {t("Read-only")}
          </span>
          <OpenInEditor absolutePath={absolutePath} line={line} ide={{ path: file.path, line, column: 1 }} />
          <button type="button" className="small primary" onClick={() => useNav.getState().closeFile()} data-testid="Project file back to review">
            {t("Back to review")}
          </button>
        </div>
      </div>
      {data?.truncated && (
        <div className="banner orange">
          <span className="grow">{t("Only the first {0} lines are shown — open it in the IDE for the rest", data.lines.length)}</span>
        </div>
      )}
      {file.error ? (
        <div className="empty" data-testid="Project file error">
          <span className="glyph">⚠</span>
          <h2>{t("Could not load file")}</h2>
          <div className="caption">{file.error}</div>
        </div>
      ) : !data ? (
        <div className="empty">
          <span className="spinner" />
          <div className="caption muted">{t("Loading file…")}</div>
        </div>
      ) : data.isBinary ? (
        <div className="empty">
          <span className="glyph">🗜</span>
          <h2>{t("Binary file")}</h2>
          <div>{t("No textual view is available for this file.")}</div>
        </div>
      ) : (
        <div className="monaco-host" data-testid="Project file view">
          <div className="editor" ref={hostRef} />
        </div>
      )}
    </div>
  );
}
