/**
 * §65.8 on Windows — the peek band: the definition's lines inline under the clicked line (a DOM diff's row or a Monaco
 * view zone, nav/bandSlot.ts), syntax-coloured, the definition line marked; "File.kt:42 — Container.member" with
 * [Open] [Find References] [×]; several candidates listed on the right (↑ / ↓ switch the preview, Enter or a double
 * click opens, Esc closes). Nothing above the line moves: the band only grows below it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { searchedWord } from "./navModel";
import { useNav } from "./navStore";
import { BAND_VISIBLE_LINES, bandKey, bandLines, bandScrollLine, bandTitle, type BandLine } from "./peekModel";

const LINE_PX = 18;

/** Monaco's colours for the lines (its own tokenizer; HTML it escaped itself), null until ready or when it fails. */
function useColorized(lines: readonly BandLine[] | null, path: string): string[] | null {
  const [html, setHtml] = useState<{ key: string; lines: string[] } | null>(null);
  const key = lines ? `${path}\u0000${lines.map((l) => l.text).join("\n")}` : "";
  useEffect(() => {
    if (!lines || lines.length === 0) return;
    let live = true;
    // Monaco loads with the first band, not with the window's navigation layer.
    import("../monaco")
      .then(({ languageFor, monaco }) => monaco.editor.colorize(lines.map((l) => l.text).join("\n"), languageFor(path), { tabSize: 4 }))
      .then((out) => {
        const parts = out.split("<br/>");
        if (live && parts.length >= lines.length) setHtml({ key, lines: parts.slice(0, lines.length) });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return html && html.key === key ? html.lines : null;
}

/** Wheel and keys stay in the band (inside Monaco its own listeners would scroll the editor / move the caret). */
function useOwnEvents(ref: React.RefObject<HTMLElement | null>, onKey: (e: KeyboardEvent) => boolean) {
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const box = (e.target as Element | null)?.closest?.(".nav-band-code, .nav-band-list");
      if (box && box.scrollHeight > box.clientHeight) e.stopPropagation();
    };
    const key = (e: KeyboardEvent) => {
      if (keyRef.current(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("keydown", key);
    };
  }, [ref]);
}

export function PeekBand() {
  const band = useNav((s) => s.band);
  const ref = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const [slow, setSlow] = useState(false);
  const row = band ? (band.rows[band.selected] ?? null) : null;
  const preview = band && row ? band.previews[band.selected] : undefined;
  const data = preview && typeof preview !== "string" ? preview : null;
  const lines = data ? bandLines(data) : null;
  const html = useColorized(lines, row?.path ?? "");

  useOwnEvents(ref, (e) => {
    const b = useNav.getState().band;
    if (!b) return false;
    // A focused button keeps its Enter / Space (Open, References, ×, a candidate); Esc and the arrows are the band's.
    if (e.key === "Enter" && e.target instanceof HTMLButtonElement) return false;
    const r = bandKey(e.key, b.selected, b.loading || b.error ? 0 : b.rows.length);
    if (!r) return false;
    if (r.kind === "close") useNav.getState().closeBand();
    else if (r.kind === "select") useNav.getState().setBandSelected(r.index);
    else useNav.getState().openBandSelected();
    return true;
  });

  // The keys go to the band; the page does not scroll for it (the line clicked stays where it is).
  const seq = band?.seq;
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    setSlow(false);
    const id = window.setTimeout(() => setSlow(true), 300);
    return () => window.clearTimeout(id);
  }, [seq]);

  // A band below the bottom edge of a DOM diff comes into view by the least scroll (Monaco's zone does it itself).
  const ready = band !== null && !band.loading;
  useEffect(() => {
    const el = ref.current;
    if (!ready || !el || el.closest(".monaco-editor")) return;
    const box = el.closest(".unified.scroll");
    if (!box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, Math.max(0, r.top - b.top - 40));
  }, [ready, seq]);

  // The definition line near the top of the code box (only the box scrolls).
  useLayoutEffect(() => {
    const box = codeRef.current;
    if (!box || !lines) return;
    box.scrollTop = bandScrollLine(lines) * LINE_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!band) return null;
  const { symbol } = band;
  const findRefs = () => useNav.getState().findReferences({ symbol, ...(band.fromPath ? { fromPath: band.fromPath } : {}) });
  const close = (
    <button type="button" className="plain small" onClick={() => useNav.getState().closeBand()} title={t("Close (Esc)")} aria-label={t("Close")} data-testid="Peek band close">
      ×
    </button>
  );

  return (
    <div ref={ref} className="nav-band" tabIndex={-1} role="region" aria-label={t("Peek Definition")} data-testid="Peek band">
      {band.loading ? (
        <div className="nav-band-head" style={slow ? undefined : { visibility: "hidden" }}>
          <span className="spinner" aria-hidden="true" />
          <span className="grow truncate">{t("Looking for the definition of {0}…", symbol)}</span>
          {close}
        </div>
      ) : band.error || band.rows.length === 0 ? (
        <div className="nav-band-head" data-testid="Peek band empty">
          <span className="grow truncate">
            <span className="bold">{t("No definition found")}</span> · <span className="mono">{symbol}</span>
            {band.error && <span className="caption muted"> · {band.error}</span>}
            {band.timedOut && <span className="caption orange"> · {t("Search stopped after 10 s")}</span>}
          </span>
          <button type="button" className="small" onClick={findRefs} data-testid="Peek band find references">
            {t("Find References")}
          </button>
          <button type="button" className="small" onClick={() => useNav.getState().findInProject(symbol)} data-testid="Peek band find in project">
            {t("Find in Project")}
          </button>
          {close}
        </div>
      ) : (
        <>
          <div className="nav-band-head">
            <span className="bold truncate" title={`${row!.path}:${row!.line}`} data-testid="Peek band title">
              {bandTitle(row!, data?.symbol, searchedWord(symbol))}
            </span>
            <span className="nav-kind">{data?.symbol?.kind ?? row!.kind}</span>
            <span className="folder grow truncate" title={row!.path}>{row!.folder}</span>
            {band.rows.length > 1 && <span className="tiny faint" title={t("↑ / ↓ switch the definition")}>{t("Definition {0} of {1}", band.selected + 1, band.rows.length)}</span>}
            {band.truncated && <span className="caption orange">{t("Showing the best 50")}</span>}
            <button type="button" className="small primary" onClick={() => useNav.getState().openBandSelected()} title={t("Open it in the diff or the file view (Enter)")} data-testid="Peek band open">
              {t("Open")}
            </button>
            <button type="button" className="small" onClick={findRefs} title={t("Find References") + " (Shift+F12)"} data-testid="Peek band find references">
              {t("References")}
            </button>
            {close}
          </div>
          <div className="nav-band-body">
            <div ref={codeRef} className="nav-band-code" style={{ maxHeight: BAND_VISIBLE_LINES * LINE_PX }} data-testid="Peek band code">
              {preview === undefined ? (
                <div className="caption muted nav-band-note">{t("Loading…")}</div>
              ) : typeof preview === "string" ? (
                <div className="caption red nav-band-note" role="alert">{preview}</div>
              ) : (
                lines!.map((l, i) => (
                  <div key={l.no} className={`nav-band-line${l.target ? " target" : ""}`}>
                    <span className="no">{l.no}</span>
                    {html ? <span className="code" dangerouslySetInnerHTML={{ __html: html[i]! }} /> : <span className="code">{l.text}</span>}
                  </div>
                ))
              )}
            </div>
            {band.rows.length > 1 && (
              <div className="nav-band-list" role="listbox" aria-label={t("Definitions of {0}", symbol)}>
                {band.rows.map((c, i) => (
                  <button
                    key={`${c.path}:${c.line}`}
                    type="button"
                    role="option"
                    aria-selected={i === band.selected}
                    className={`nav-row${i === band.selected ? " selected" : ""}`}
                    onClick={() => useNav.getState().setBandSelected(i)}
                    onDoubleClick={() => useNav.getState().openBandSelected()}
                    title={`${c.path}:${c.line}`}
                    data-testid={`Peek band candidate ${c.path}:${c.line}`}
                  >
                    <span className="nav-row-top">
                      <span className="name">{c.name}</span>
                      <span className="faint">:{c.line}</span>
                      <span className="nav-kind">{c.kind}</span>
                    </span>
                    <span className="folder truncate">{c.container ? `${c.container} · ${c.folder}` : c.folder}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
