/**
 * §65.8 on Windows — the bottom panel's References tab (next to Terminal · Output · Run): Shift+F12 / Find References
 * fill it. Left: the hits grouped by file (name, folder, count; line, the line with the name marked, "definition" on a
 * definition line); right: the selected hit's context (`definition_preview`, its line marked). ↑ / ↓ pick, Enter or a
 * click opens it where §62 opens a result; F4 / Shift+F4 (anywhere) open the next / previous one.
 */
import { useEffect, useRef } from "react";
import { t } from "../i18n";
import { Icon } from "../icons";
import { groupByFile, markSymbol, splitPath } from "./navModel";
import { useNav } from "./navStore";
import { bandLines } from "./peekModel";
import { LspStartingNote, NavHistoryButtons, NavSourceBadge, Preview } from "./NavBits";

const APPROXIMATE = () => t("Search-based: may list look-alikes");

export function ReferencesPanel() {
  const refs = useNav((s) => s.refs);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = refs?.selected ?? -1;
  useEffect(() => {
    listRef.current?.querySelector(".nav-ref.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected, refs?.seq]);

  if (!refs) {
    return (
      <div className="nav-refs-tab empty-tab" data-testid="References tab empty">
        <span className="muted">{t("Shift+F12 on a name lists its references here — F4 / Shift+F4 step through them")}</span>
      </div>
    );
  }
  const groups = groupByFile(refs.rows);
  const indexOf = new Map(refs.rows.map((r, i) => [r, i]));
  const title = refs.mode === "references" ? t("References to {0}", refs.symbol) : t("Find in Project: {0}", refs.symbol);
  const onKey = (e: React.KeyboardEvent) => {
    const n = refs.rows.length;
    if (n === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = selected < 0 ? 0 : (selected + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      useNav.getState().selectReference(i);
    } else if (e.key === "Enter" && selected >= 0) {
      e.preventDefault();
      useNav.getState().openReference(selected);
    }
  };
  const preview = refs.preview && refs.preview.index === selected ? refs.preview : null;
  const row = selected >= 0 ? refs.rows[selected] : undefined;

  return (
    <div className="nav-refs-tab" role="region" aria-label={title} data-testid="References tab">
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
        {refs.loading && <LspStartingNote />}
        {!refs.loading && !refs.error && refs.mode === "references" && <NavSourceBadge source={refs.source} fallback={refs.fallback} />}
        {refs.truncated && <span className="caption orange">{t("Only the first {0}", refs.rows.length)}</span>}
        {refs.timedOut && <span className="caption orange">{refs.mode === "references" ? t("Search stopped after 15 s") : t("Search stopped after 20 s")}</span>}
        <span className="grow" />
        <span className="tiny faint">{t("F4 / Shift+F4: next / previous")}</span>
        <NavHistoryButtons />
        <button
          type="button"
          className="plain small"
          disabled={refs.loading}
          onClick={() => useNav.getState().refreshReferences()}
          title={refs.loading ? t("Searching…") : t("Search again")}
          aria-label={t("Search again")}
          data-testid="References refresh"
        >
          <Icon name="refresh" size={12} />
        </button>
        <button type="button" className="plain small" onClick={() => useNav.getState().closeRefs()} title={t("Clear the references")} aria-label={t("Clear the references")} data-testid="Close references">
          ×
        </button>
      </div>
      <div className="nav-refs-split">
        <div ref={listRef} className="nav-refs-list" role="listbox" tabIndex={0} aria-label={title} onKeyDown={onKey} data-testid="References list">
          {!refs.loading && !refs.error && refs.rows.length === 0 && <div className="caption muted" style={{ padding: 10 }}>{t("Nothing found")}</div>}
          {groups.map((g) => (
            <div key={g.path}>
              <div className="nav-refs-file" title={g.path}>
                <span className="name">{g.name}</span>
                <span className="folder">{g.folder}</span>
                <span className="tiny faint">{g.rows.length}</span>
              </div>
              {g.rows.map((r) => {
                const i = indexOf.get(r)!;
                return (
                  <button
                    key={`${r.line}:${r.column}`}
                    type="button"
                    role="option"
                    aria-selected={i === selected}
                    className={`nav-ref${i === selected ? " selected" : ""}`}
                    onClick={() => useNav.getState().selectReference(i)}
                    onDoubleClick={() => useNav.getState().openReference(i)}
                    title={t("{0} — double-click or Enter opens it", `${r.path}:${r.line}`)}
                    data-testid={`Reference ${r.path}:${r.line}`}
                  >
                    <span className="no">{r.line}</span>
                    <Preview text={r.preview} symbol={refs.symbol} />
                    {r.kind && <span className="nav-kind pill gray" title={t("Looks like the definition")}>{t("definition")}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="nav-refs-preview" data-testid="References preview">
          {!row ? null : (
            <>
              <div className="nav-refs-preview-head">
                <span className="bold truncate">{`${splitPath(row.path).name}:${row.line}`}</span>
                <span className="folder truncate">{splitPath(row.path).folder}</span>
                <span className="grow" />
                <button type="button" className="small" onClick={() => useNav.getState().openReference(selected)} title={t("Open it in the diff or the file view (Enter)")} data-testid="References open">
                  {t("Open")}
                </button>
              </div>
              <div className="nav-refs-preview-code">
                {!preview || (!preview.data && !preview.error) ? (
                  <div className="caption muted nav-band-note">{t("Loading…")}</div>
                ) : preview.error ? (
                  <div className="caption red nav-band-note">{preview.error}</div>
                ) : (
                  bandLines(preview.data!).map((l) => (
                    <div key={l.no} className={`nav-band-line${l.target ? " target" : ""}`}>
                      <span className="no">{l.no}</span>
                      <span className="code">
                        {l.target ? markSymbol(l.text, refs.symbol).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)) : l.text}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
