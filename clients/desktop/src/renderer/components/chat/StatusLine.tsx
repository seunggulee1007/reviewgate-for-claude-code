/**
 * MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the user's Claude Code status line (their `statusLine` command —
 * the OMC HUD, …) under the composer, drawn as the terminal draws it: monospaced, the ANSI colors and styles, OSC 8
 * links that open in the browser, each line cut with "…" instead of wrapping. It tells the engine how many columns it
 * has (the command's `COLUMNS`, measured with the font's "0") and whether it is on screen (the window not hidden; the
 * engine runs the command only then). The Mac's `StatusLineView` sits in the same place, under the composer's buttons.
 */
import { useEffect, useRef, useState, type MouseEvent, type Ref } from "react";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { onThemeChange, resolvedTheme, type Theme } from "../../theme";
import { openableLink, truncateRuns, type AnsiRun } from "../../ansi";
import { columnsFor, runCss, shownRuns, useStatusLine } from "../../statusLine";
import "./statusLine.css";

/** "0" ten times: the probe's width / 10 is one column of the status line's font. */
const PROBE = "0000000000";

export function StatusLine() {
  const root = useStore((s) => s.state.project?.root ?? null);
  const reply = useStatusLine((s) => s.reply);
  const runs = useStatusLine((s) => s.runs);
  const boxRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [columns, setColumns] = useState(0);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [theme, setTheme] = useState<Theme>(() => resolvedTheme());
  const told = useRef(0);

  useEffect(() => onThemeChange(setTheme), []);
  useEffect(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe || typeof ResizeObserver === "undefined") return;
    // The box's content width (its 12 px gutters left out; statusLine.padding stays in, as the terminal's COLUMNS has it).
    const measure = () => {
      const cs = getComputedStyle(box);
      const width = box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      setColumns(columnsFor(width, probe.getBoundingClientRect().width / PROBE.length));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    measure();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  // Another project: what the last one showed goes, and the engine hears the width again (the same one: nothing blinks).
  useEffect(() => useStatusLine.getState().setRoot(root), [root]);
  // A new width settles first (a window being resized), then the engine hears it once.
  useEffect(() => {
    if (!root || columns <= 0) return;
    const timer = setTimeout(() => {
      told.current = columns;
      void useStatusLine.getState().tell(columns, visible);
    }, 250);
    return () => clearTimeout(timer);
  }, [root, columns, visible]);
  // The chat goes (another tab, the project closes): nothing runs for it any more.
  useEffect(
    () => () => {
      if (told.current > 0) void useStatusLine.getState().tell(told.current, false);
    },
    [],
  );

  const why = reply?.error ? (reply.error.code === "timeout" ? t("it did not answer in time") : reply.error.message) : null;
  return (
    <StatusLineView
      lines={shownRuns({ reply, runs })}
      padding={reply?.padding ?? 0}
      columns={columns}
      dark={theme === "dark"}
      failure={why}
      boxRef={boxRef}
      probeRef={probeRef}
    />
  );
}

function openLink(e: MouseEvent<HTMLAnchorElement>): void {
  e.preventDefault();
  const href = openableLink(e.currentTarget.getAttribute("href") ?? undefined);
  if (href) void window.rg.openExternal(href);
}

/** One line's runs as spans; an http(s) link is an anchor the browser opens. */
function Line({ runs, dark }: { runs: AnsiRun[]; dark: boolean }) {
  return (
    <div className="sl-line">
      {runs.map((r, i) => {
        const href = openableLink(r.link);
        const style = runCss(r, dark);
        return href ? (
          <a key={i} href={href} style={style} title={href} onClick={openLink}>
            {r.text}
          </a>
        ) : (
          <span key={i} style={style}>
            {r.text}
          </span>
        );
      })}
    </div>
  );
}

/** What the status line draws (a pure view: the tests render it without the engine). */
export function StatusLineView(props: {
  lines: AnsiRun[][];
  padding: number;
  columns: number;
  dark: boolean;
  failure?: string | null;
  boxRef?: Ref<HTMLDivElement>;
  probeRef?: Ref<HTMLSpanElement>;
}) {
  const { lines, padding, columns, dark, failure } = props;
  const textColumns = columns > 0 ? Math.max(1, columns - 2 * padding) : Infinity;
  const empty = lines.length === 0;
  return (
    <div
      ref={props.boxRef}
      className={empty ? "status-line sl-empty" : "status-line"}
      title={!empty && failure ? t("The status line command failed: {0}. Showing its last output.", failure) : undefined}
      aria-label={empty ? undefined : t("Claude Code status line")}
      data-testid="Claude Code status line"
    >
      <span ref={props.probeRef} className="sl-probe" aria-hidden="true">
        {PROBE}
      </span>
      {!empty && (
        <div className="sl-lines" style={padding > 0 ? { paddingLeft: `${padding}ch`, paddingRight: `${padding}ch` } : undefined}>
          {lines.map((runs, i) => (
            <Line key={i} runs={Number.isFinite(textColumns) ? truncateRuns(runs, textColumns) : runs} dark={dark} />
          ))}
        </div>
      )}
    </div>
  );
}
