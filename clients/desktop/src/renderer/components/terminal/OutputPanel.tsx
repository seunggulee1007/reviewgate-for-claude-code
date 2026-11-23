/**
 * MARK: c-panel — §57.18: the bottom panel's Output tab — the window's log and Claude's Bash commands (outputLog.ts),
 * read-only and selectable, following new lines while scrolled to the end. The controls (source, search, Copy, Clear)
 * sit in the panel's bar.
 */
import { useLayoutEffect, useRef } from "react";
import { t } from "../../i18n";
import { Icon } from "../../icons";
import { clearOutputLog, filterOutput, outputText, useOutputLog, type OutputFilter } from "../../outputLog";
import { showToast } from "../../toast";
import { panelTabTitle } from "../../terminal/shellPanel";

const FILTERS: OutputFilter[] = ["all", "reviewGate", "claude"];

export function outputFilterTitle(f: OutputFilter): string {
  return f === "all" ? t("All") : f === "reviewGate" ? "ReviewGate" : t("Claude commands");
}

function outputFilterHelp(f: OutputFilter): string {
  return f === "all" ? t("Every line") : f === "reviewGate" ? t("ReviewGate's own log — the engine, notices and errors") : t("The Bash commands Claude ran in this window and their output");
}

export function OutputControls(props: { filter: OutputFilter; onFilter: (f: OutputFilter) => void; query: string; onQuery: (q: string) => void }) {
  const lines = useOutputLog((s) => s.lines);
  const shown = filterOutput(lines, props.filter, props.query);
  const copy = () => {
    void navigator.clipboard.writeText(outputText(shown)).then(
      () => showToast(t("Copied")),
      () => undefined,
    );
  };
  return (
    <div className="row output-controls">
      <select
        value={props.filter}
        onChange={(e) => props.onFilter(e.target.value as OutputFilter)}
        aria-label={t("Output source")}
        title={t("Which lines to show: {0}", outputFilterHelp(props.filter))}
        data-testid="Output source"
      >
        {FILTERS.map((f) => (
          <option key={f} value={f} title={outputFilterHelp(f)}>
            {outputFilterTitle(f)}
          </option>
        ))}
      </select>
      <input type="search" value={props.query} onChange={(e) => props.onQuery(e.target.value)} placeholder={t("Search output")} aria-label={t("Search output")} title={t("Show only the lines holding this text")} data-testid="Output search" />
      <button type="button" className="plain small" disabled={shown.length === 0} aria-label={t("Copy output")} title={shown.length === 0 ? t("Nothing to copy") : t("Copy the lines shown")} onClick={copy} data-testid="Output copy">
        <Icon name="copy" size={12} />
      </button>
      <button type="button" className="plain small" disabled={lines.length === 0} aria-label={t("Clear output")} title={lines.length === 0 ? t("The output is empty") : t("Clear the output — the daily log file keeps its lines")} onClick={clearOutputLog} data-testid="Output clear">
        <Icon name="trash" size={12} />
      </button>
    </div>
  );
}

export function OutputPanel(props: { filter: OutputFilter; query: string }) {
  const lines = useOutputLog((s) => s.lines);
  const shown = filterOutput(lines, props.filter, props.query);
  const ref = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  });
  if (shown.length === 0) {
    return (
      <div className="output-empty muted" role="status" data-testid="Output empty">
        {lines.length === 0 ? t("No output yet — ReviewGate's log and the Bash commands Claude runs show here.") : t("No line matches.")}
      </div>
    );
  }
  return (
    <pre
      ref={ref}
      className="output-log"
      tabIndex={0}
      role="log"
      aria-label={panelTabTitle("output")}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      }}
      data-testid="Output log"
    >
      {outputText(shown)}
    </pre>
  );
}
