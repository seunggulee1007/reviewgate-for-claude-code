/**
 * §65.8 on Windows — the quick-open palettes, at the top of the window:
 * - Go to File (Ctrl+P): `list_files {query, filesOnly: true, limit: 50}` per keystroke (50 ms; the newest reply wins);
 *   basename (matched letters bold) and folder; `path:42` opens at the line.
 * - Symbols in This File (Ctrl+F12): `document_symbols {path}` once, filtered here; indented by depth, container dimmed.
 * - Symbols in Project (Ctrl+Alt+Shift+N): `workspace_symbols {query, limit: 100}` per keystroke (80 ms); "Indexing… N / M
 *   files" while the index builds, the query sent again when it is ready.
 * ↑ / ↓ pick, Enter or a click opens where §62 opens a result (Back returns), Esc or a click outside closes.
 */
import { useEffect, useRef, useState } from "react";
import type { DocumentSymbol, WorkspaceSymbol } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "../engineRequest";
import { refusalMessage } from "../errorCodes";
import { t } from "../i18n";
import { useStore } from "../store";
import { splitPath } from "./navModel";
import { currentLocation, useNav } from "./navStore";
import { boldParts, fileRows, filterDocumentSymbols, indexLine, PALETTE_DEBOUNCE_MS, parseFileQuery, type PaletteMode } from "./quickOpenModel";

type Row = { key: string; name: string; marks: number[]; detail: string; kind?: string; depth?: number; path: string; line: number; column: number; symbol?: string; changed?: boolean };

const titleOf = (mode: PaletteMode) => (mode === "files" ? t("Go to File") : mode === "fileSymbols" ? t("Symbols in This File") : t("Symbols in Project"));
const placeholderOf = (mode: PaletteMode) =>
  mode === "files" ? t("File name — path:line opens at the line") : mode === "fileSymbols" ? t("Filter the symbols of this file") : t("Symbol name — camel humps work: UsrSvc, Cart.tot");

const symbolRow = (s: (DocumentSymbol | WorkspaceSymbol) & { marks?: number[] }, withFolder: boolean): Row => {
  const folder = withFolder ? splitPath(s.path).folder || splitPath(s.path).name : "";
  return {
    key: `${s.path}:${s.line}:${s.column}:${s.name}`,
    name: s.name,
    marks: "matches" in s ? s.matches : (s.marks ?? []),
    detail: [s.container, folder].filter(Boolean).join(" · "),
    kind: s.kind,
    ...("depth" in s ? { depth: s.depth } : {}),
    path: s.path,
    line: s.line,
    column: s.column,
    symbol: s.name,
  };
};

export function QuickOpen() {
  const palette = useNav((s) => s.palette)!;
  const { mode } = palette;
  const index = useStore((s) => s.state.nav?.index);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [docSymbols, setDocSymbols] = useState<DocumentSymbol[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const close = () => useNav.getState().closePalette();

  useEffect(() => {
    inputRef.current?.focus();
  }, [palette.seq]);

  // Symbols in This File: the file's outline once.
  useEffect(() => {
    if (mode !== "fileSymbols" || !palette.path) return;
    const my = ++seq.current;
    setLoading(true);
    engineRequest({ type: "document_symbols", path: palette.path })
      .then((r) => {
        if (my !== seq.current) return;
        setDocSymbols(r.symbols);
        setTruncated(r.truncated);
        setError(null);
      })
      .catch((e: unknown) => my === seq.current && setError(refusalMessage(refusalOf(e))))
      .finally(() => my === seq.current && setLoading(false));
  }, [mode, palette.path, palette.seq]);

  // The query (and, for the project's symbols, the index becoming ready) asks again.
  const ready = index?.status === "ready";
  useEffect(() => {
    if (mode === "fileSymbols") {
      setRows(docSymbols ? filterDocumentSymbols(docSymbols, query).map((s) => symbolRow(s, false)) : []);
      setSelected(0);
      return;
    }
    const parsed = mode === "files" ? parseFileQuery(query) : { query: query.trim() };
    if (mode === "projectSymbols" && !parsed.query) {
      seq.current++;
      setRows([]);
      setLoading(false);
      setError(null);
      setTruncated(false);
      return;
    }
    const my = ++seq.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      const ask =
        mode === "files"
          ? engineRequest({ type: "list_files", query: parsed.query, filesOnly: true, limit: 50 }).then((r) => ({
              rows: fileRows(r.items, parsed.query).map((f): Row => ({ key: f.path, name: f.name, marks: f.marks, detail: f.folder, path: f.path, line: parsed.line ?? 1, column: 1, changed: f.changed })),
              truncated: false,
            }))
          : engineRequest({ type: "workspace_symbols", query: parsed.query, limit: 100 }).then((r) => ({ rows: r.symbols.map((s) => symbolRow(s, true)), truncated: r.truncated }));
      ask
        .then((r) => {
          if (my !== seq.current) return;
          setRows(r.rows);
          setTruncated(r.truncated);
          setSelected(0);
          setError(null);
        })
        .catch((e: unknown) => my === seq.current && setError(refusalMessage(refusalOf(e))))
        .finally(() => my === seq.current && setLoading(false));
    }, PALETTE_DEBOUNCE_MS[mode]);
    return () => window.clearTimeout(timer);
  }, [mode, query, docSymbols, mode === "projectSymbols" && ready]);

  useEffect(() => {
    listRef.current?.querySelector(".nav-palette-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const open = (row: Row | undefined) => {
    if (!row) return;
    close();
    useNav.getState().openTarget({ path: row.path, line: row.line, column: row.column, ...(row.symbol ? { symbol: row.symbol } : {}) }, currentLocation());
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length > 0) setSelected((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      open(rows[selected]);
    }
  };

  const status = mode === "projectSymbols" ? indexLine(index, t) : null;
  const title = titleOf(mode);
  const empty = !loading && !error && rows.length === 0;
  return (
    <div className="nav-palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()} data-testid="Palette backdrop">
      <div className="nav-palette" role="dialog" aria-label={title} data-testid={`Palette ${mode}`}>
        <div className="nav-palette-head">
          <span className="bold">{title}</span>
          {mode === "fileSymbols" && palette.path && <span className="folder truncate" title={palette.path}>{palette.path}</span>}
          <span className="grow" />
          {loading && <span className="spinner" aria-hidden="true" />}
          <span className="tiny faint">↑↓ ↩ Esc</span>
        </div>
        <input
          ref={inputRef}
          className="nav-palette-input"
          value={query}
          placeholder={placeholderOf(mode)}
          aria-label={title}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          data-testid="Palette query"
        />
        {status && (
          <div className={`nav-palette-status caption ${status.failed ? "red" : "muted"}`} role="status" data-testid="Palette index status">
            <span className="grow truncate">{status.text}</span>
            {status.failed && (
              <button type="button" className="small" onClick={() => void engineRequest({ type: "nav_index_build" }).catch(() => undefined)} data-testid="Palette index retry">
                {t("Try Again")}
              </button>
            )}
          </div>
        )}
        <div ref={listRef} className="nav-palette-list" role="listbox" aria-label={title}>
          {error && <div className="caption red nav-palette-note" role="alert">{error}</div>}
          {empty && (
            <div className="caption muted nav-palette-note">
              {mode === "projectSymbols" && !query.trim() ? t("Type a name to search the project's symbols") : t("Nothing found")}
            </div>
          )}
          {rows.map((r, i) => (
            <button
              key={r.key}
              type="button"
              role="option"
              aria-selected={i === selected}
              className={`nav-palette-row${i === selected ? " selected" : ""}`}
              style={r.depth ? { paddingLeft: 10 + Math.min(r.depth, 8) * 14 } : undefined}
              onMouseMove={() => i !== selected && setSelected(i)}
              onClick={() => open(r)}
              title={`${r.path}:${r.line}`}
              data-testid={`Palette row ${r.path}:${r.line}`}
            >
              {r.kind && <span className="nav-kind">{r.kind}</span>}
              <span className="name">{boldParts(r.name, r.marks).map((p, k) => (p.bold ? <b key={k}>{p.text}</b> : <span key={k}>{p.text}</span>))}</span>
              {r.changed && <span className="pill gray" title={t("Changed in this review")}>{t("changed")}</span>}
              <span className="detail truncate">{r.detail}</span>
              {mode !== "files" && <span className="tiny faint">:{r.line}</span>}
            </button>
          ))}
        </div>
        {(truncated || index?.truncated) && (
          <div className="nav-palette-foot caption muted">
            {truncated && <span>{mode === "files" ? t("Showing the best 50") : mode === "projectSymbols" ? t("Showing the first 100") : t("The file has more symbols than shown")}</span>}
            {mode === "projectSymbols" && index?.truncated && <span>{t("The project is larger than the index — some symbols are missing")}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
