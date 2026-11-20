/**
 * §57.5 / §57.17 (plan §4.3): a terminal chat's window — terminal-first. The terminal takes the width and the review
 * panel (the diff pane) opens on its left, next to the file list, while something is pending. Where 80 columns of
 * terminal and the panel's 360 px floor fit side by side the panel is a pane beside it (the divider remembers the
 * terminal's share); in a narrower window it is a drawer over the terminal's left side, under the chat tabs, and the
 * terminal keeps its whole width — no resize, no reflow of the TUI — while it opens and closes. Rules: terminalLayout.ts.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ReviewState } from "@reviewgate/engine";
import type { ProjectUI } from "../../../shared/ipc";
import { reviewPanelCollapsed } from "../../friction";
import { t } from "../../i18n";
import { isComposing } from "../../ime";
import { useStore } from "../../store";
import { measureCellWidth, reviewDrawerWidth, reviewPanelWidth, reviewWidthForShare, terminalMinWidth, terminalReviewLayout, terminalShareOf, REVIEW_FLOOR, type TerminalReviewLayout } from "../../terminalLayout";
import { focusLiveTerminal, liveTerminalChatId } from "../../terminal/terminalChat";
import { clampFontSize, TERMINAL_FONT_FAMILY } from "../../terminal/termHostOptions";
import ChatPane from "../chat/ChatPane";
import DiffPane from "../diff/DiffPane";
import { LiveDiffPane } from "../diff/LiveDiffPane";
import { Divider } from "../Divider";
import { ErrorBoundary } from "../ErrorBoundary";
import { HistoryDiffPane } from "../history/HistoryDiffPane";
import "./terminal.css";

/** The edge tab's width (styles.css `.diff-edge-tab`). */
const EDGE_TAB = 26;

export function TerminalSplit() {
  const ref = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState(0);
  const [tabsHeight, setTabsHeight] = useState(34);
  const collapsed = useStore((s) => reviewPanelCollapsed(s.state, s.ui, s.selectedPath, true));
  const historyOpen = useStore((s) => s.historyView !== null);
  const liveOpen = useStore((s) => s.liveView !== null && s.historyView === null);
  const share = useStore((s) => s.ui.terminalReviewSplit);
  const fontSize = useStore((s) => clampFontSize(s.settings?.terminalFontSize));
  const setUI = useStore((s) => s.setUI);
  const cell = useMemo(() => measureCellWidth(`${fontSize}px ${TERMINAL_FONT_FAMILY}`), [fontSize]);
  const minTerminal = terminalMinWidth(cell);
  const layout = terminalReviewLayout(area, minTerminal);
  const open = !collapsed || historyOpen || liveOpen;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragged = useRef<number | null>(null);
  const reviewWidth = dragWidth ?? reviewWidthForShare(share, area, minTerminal);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setArea(Math.max(0, el.getBoundingClientRect().width - EDGE_TAB));
      const tabs = el.querySelector<HTMLElement>(".pane.chat .chat-tabs");
      if (tabs) setTabsHeight(tabs.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggle = () => useStore.getState().toggleDiffPane(!open);
  const close = () => {
    useStore.getState().setUI({ diffCollapsed: true });
    focusLiveTerminal();
  };
  /** Esc in the drawer (not in one of its text fields, never the IME's) closes it and gives the terminal the keyboard. */
  const onDrawerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || isComposing(e) || e.defaultPrevented) return;
    const el = e.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
    e.preventDefault();
    close();
  };

  return (
    <div className="terminal-split" ref={ref} data-layout={layout} data-testid="Terminal split">
      <ReviewEdgeTab open={open} layout={layout} onToggle={toggle} />
      {open && layout === "side" && (
        <>
          <div className="review-side" style={{ flex: `0 0 ${Math.round(reviewWidth)}px`, minWidth: Math.min(REVIEW_FLOOR, area) }} role="region" aria-label={t("Review panel")} data-testid="Review panel">
            <ReviewPane />
          </div>
          <Divider
            testId="Review panel divider"
            label={t("Drag to resize the review panel")}
            onDrag={(dx) => {
              dragged.current = reviewPanelWidth((dragged.current ?? reviewWidth) + dx, area, minTerminal);
              setDragWidth(dragged.current);
            }}
            onEnd={() => {
              // Live frames are not written; the release is.
              if (dragged.current !== null) setUI({ terminalReviewSplit: terminalShareOf(dragged.current, area) });
              dragged.current = null;
              setDragWidth(null);
            }}
          />
        </>
      )}
      <ErrorBoundary name="Chat" className="pane chat">
        <ChatPane />
      </ErrorBoundary>
      {open && layout === "drawer" && (
        <div
          className="review-drawer"
          style={{ left: EDGE_TAB, top: tabsHeight, width: reviewDrawerWidth(area) }}
          role="region"
          aria-label={t("Review panel over the terminal")}
          aria-description={t("Esc or ⌘⇧D closes it; the terminal behind it keeps its width")}
          onKeyDown={onDrawerKey}
          data-testid="Review drawer"
        >
          <ReviewPane />
        </div>
      )}
    </div>
  );
}

/** What the review panel shows: a past round's file, the running turn's change so far, or the review. */
function ReviewPane() {
  const historyOpen = useStore((s) => s.historyView !== null);
  const liveOpen = useStore((s) => s.liveView !== null && s.historyView === null);
  if (historyOpen) return <ErrorBoundary key="history" name="History" className="pane diff"><HistoryDiffPane /></ErrorBoundary>;
  if (liveOpen) return <ErrorBoundary key="live" name="Live diff" className="pane diff"><LiveDiffPane /></ErrorBoundary>;
  return <ErrorBoundary key="diff" name="Diff" className="pane diff"><DiffPane /></ErrorBoundary>;
}

/** The thin tab left of the review panel, next to the file list: opens or hides it (⌘⇧D); says where it opens. */
function ReviewEdgeTab(props: { open: boolean; layout: TerminalReviewLayout; onToggle: () => void }) {
  const changed = useStore((s) => s.state.changedFiles.length);
  const label = changed > 0 ? t("Changes ({0})", changed) : t("Changes");
  const help = props.open
    ? t("Hide the review panel — the terminal takes the width (⌘⇧D)")
    : props.layout === "side"
      ? t("Show the review panel between the file list and the terminal (⌘⇧D)")
      : t("Show the review panel over the terminal, next to the file list — the window is too narrow for both side by side (⌘⇧D)");
  return (
    <button type="button" className="diff-edge-tab" onClick={props.onToggle} title={help} aria-label={help} aria-expanded={props.open} data-testid="Review edge tab">
      <span className="chev" aria-hidden="true">{props.open ? "◂" : "▸"}</span>
      <span className="label">{label}</span>
    </button>
  );
}

/**
 * §57.5 (App-wide): a terminal chat's review panel opens again on each turn that ends with files to review — a ⌘⇧D
 * collapse lasts until the next review.
 */
export function useTerminalReviewReopen(): void {
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.state !== prev.state && reopensReviewPanel(prev.state, s.state, s.ui)) s.setUI({ diffCollapsed: undefined });
      }),
    [],
  );
}

/** The live terminal chat's turn ended with files to review while the user had the panel collapsed. */
export function reopensReviewPanel(prev: ReviewState, next: ReviewState, ui: ProjectUI): boolean {
  if (ui.diffCollapsed !== true || liveTerminalChatId(next) === null) return false;
  return next.gate.phase === "reviewing" && prev.gate.phase !== "reviewing" && next.gate.pendingCount > 0;
}
