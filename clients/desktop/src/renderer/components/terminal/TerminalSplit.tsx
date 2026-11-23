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
import { isComposing, isEnter } from "../../ime";
import { useStore } from "../../store";
import { measureCellWidth, reviewDrawerWidth, reviewHidesSidebar, reviewPanelWidth, reviewWidthForShare, terminalMinWidth, terminalReviewLayout, terminalShareOf, REVIEW_FLOOR, type TerminalReviewLayout } from "../../terminalLayout";
import { focusLiveTerminal, liveTerminalChatId } from "../../terminal/terminalChat";
import { clampFontSize, TERMINAL_FONT_FAMILY } from "../../terminal/termHostOptions";
import ChatPane from "../chat/ChatPane";
import DiffPane from "../diff/DiffPane";
import { LiveDiffPane } from "../diff/LiveDiffPane";
import { Divider } from "../Divider";
import { ErrorBoundary } from "../ErrorBoundary";
import { HistoryDiffPane } from "../history/HistoryDiffPane";
import { PointerMenu } from "../agents/AgentBits";
import "./terminal.css";

/** The edge tab's width (styles.css `.diff-edge-tab`). */
const EDGE_TAB = 26;

/** §57.5 "Hide Sidebar While Reviewing" (per user, on unless turned off from the edge tab's right-click). */
const HIDES_SIDEBAR_KEY = "rg.terminalReviewHidesSidebar";

function readHidesSidebar(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(HIDES_SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeHidesSidebar(on: boolean): void {
  try {
    localStorage.setItem(HIDES_SIDEBAR_KEY, on ? "1" : "0");
  } catch {
    // blocked storage: the choice lasts until the window reloads
  }
}

/** The drawer's first element that scrolls vertically (the diff), for ↑ / ↓. */
function drawerScroller(drawer: HTMLElement): HTMLElement | null {
  for (const el of Array.from(drawer.querySelectorAll<HTMLElement>("*"))) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

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
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerHasFocus = useRef(false);
  const toggleSeq = useStore((s) => s.diffToggleSeq);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const [hidesSidebar, setHidesSidebar] = useState(readHidesSidebar);
  const sidebarWidth = useRef(301);
  /** We hid the file list for the panel; the user brought it back while the panel was open. */
  const sidebarHidden = useRef(false);
  const sidebarKept = useRef(false);

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
  /**
   * In the drawer (not in one of its text fields, never the IME's): Esc closes it and gives the terminal the keyboard, ↑ / ↓
   * scroll the diff, Ctrl+Enter (⌘↩) accepts the file — its Accept button, so the same reasons keep it off.
   */
  const onDrawerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isComposing(e) || e.defaultPrevented) return;
    const el = e.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
    const drawer = drawerRef.current;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.ctrlKey && !e.metaKey && drawer) {
      const scroller = drawerScroller(drawer);
      if (!scroller || scroller.contains(el)) return; // the scroller itself scrolls natively
      e.preventDefault();
      scroller.scrollBy({ top: e.key === "ArrowDown" ? 40 : -40 });
    } else if (isEnter(e) && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && drawer) {
      const accept = drawer.querySelector<HTMLButtonElement>('[data-testid="Accept"]:not(:disabled)');
      if (!accept) return;
      e.preventDefault();
      accept.click();
    }
  };

  // §57.5: the drawer the user opens (⌘⇧D, the edge tab) takes the keyboard — ↑ / ↓ / Ctrl+Enter work at once; one that
  // opens by itself for a review leaves it in the terminal.
  const lastSeq = useRef(toggleSeq);
  useEffect(() => {
    if (toggleSeq === lastSeq.current) return;
    lastSeq.current = toggleSeq;
    if (!open || layout !== "drawer") return;
    const id = requestAnimationFrame(() => {
      const drawer = drawerRef.current;
      if (!drawer) return;
      (drawerScroller(drawer) ?? drawer).focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [toggleSeq, open, layout]);
  // Closing the drawer that held the keyboard (Esc, ⌘⇧D, the last file accepted) gives it back to the terminal.
  useEffect(() => {
    if ((open && layout === "drawer") || !drawerHasFocus.current) return;
    drawerHasFocus.current = false;
    focusLiveTerminal();
  }, [open, layout]);

  // §57.5: the file list steps aside while the open panel would be a drawer beside it — side by side where that makes
  // room, else a wider drawer — and comes back when the panel closes or fits beside it (terminalLayout.reviewHidesSidebar).
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".app > .sidebar");
    if (sidebarVisible && el) sidebarWidth.current = el.getBoundingClientRect().width + 1;
    if (sidebarVisible && sidebarHidden.current) {
      sidebarHidden.current = false; // the user brought it back: left alone until the panel closes
      sidebarKept.current = true;
    }
  }, [sidebarVisible]);
  useEffect(() => {
    if (!open) sidebarKept.current = false;
    const want = hidesSidebar && open && !sidebarKept.current && area > 0 && reviewHidesSidebar(area, sidebarWidth.current, !sidebarVisible, minTerminal);
    const s = useStore.getState();
    if (want && !sidebarHidden.current && s.sidebarVisible) {
      sidebarHidden.current = true;
      s.toggleSidebar();
    } else if (!want && sidebarHidden.current) {
      sidebarHidden.current = false;
      if (!s.sidebarVisible) s.toggleSidebar();
    }
  }, [hidesSidebar, open, area, sidebarVisible, minTerminal]);
  useEffect(
    () => () => {
      // Another chat (not a terminal chat) replaced this split: the file list is back.
      if (sidebarHidden.current && !useStore.getState().sidebarVisible) useStore.getState().toggleSidebar();
    },
    [],
  );
  const setHides = (on: boolean) => {
    writeHidesSidebar(on);
    setHidesSidebar(on);
  };

  return (
    <div className="terminal-split" ref={ref} data-layout={layout} data-testid="Terminal split">
      <ReviewEdgeTab open={open} layout={layout} onToggle={toggle} hidesSidebar={hidesSidebar} onHidesSidebar={setHides} />
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
          ref={drawerRef}
          className="review-drawer"
          style={{ left: EDGE_TAB, top: tabsHeight, width: reviewDrawerWidth(area) }}
          role="region"
          tabIndex={-1}
          aria-label={t("Review panel over the terminal")}
          aria-description={t("↑ / ↓ go through the changes, ⌘↩ accepts the file, Esc or ⌘⇧D closes it")}
          onKeyDown={onDrawerKey}
          onFocus={() => (drawerHasFocus.current = true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drawerHasFocus.current = false;
          }}
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

/**
 * The thin tab left of the review panel, next to the file list: opens or hides it (⌘⇧D). It reads "Review", its badge is
 * the number of files waiting for a verdict, and its tooltip / accessible name say so ("Open review panel · 2 pending")
 * and where it opens. Right-click: "Hide Sidebar While Reviewing".
 */
function ReviewEdgeTab(props: { open: boolean; layout: TerminalReviewLayout; onToggle: () => void; hidesSidebar: boolean; onHidesSidebar: (on: boolean) => void }) {
  const pending = useStore((s) => s.state.changedFiles.filter((f) => f.state === "pending").length);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const label = props.open
    ? pending > 0 ? t("Close review panel · {0} pending", pending) : t("Close review panel")
    : pending > 0 ? t("Open review panel · {0} pending", pending) : t("Open review panel");
  const where = props.open
    ? t("the terminal takes the width")
    : props.layout === "side"
      ? t("between the file list and the terminal")
      : t("over the terminal, next to the file list");
  return (
    <>
      <button
        type="button"
        className="diff-edge-tab"
        onClick={props.onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        title={`${label} — ${where} ${t("(⌘⇧D)")}`}
        aria-label={label}
        aria-expanded={props.open}
        data-testid="Review edge tab"
      >
        <span className="chev" aria-hidden="true">{props.open ? "◂" : "▸"}</span>
        <span className="label">{t("Review")}</span>
        {pending > 0 && (
          <span className="edge-badge" aria-hidden="true" data-testid="Review edge tab badge">
            {pending}
          </span>
        )}
      </button>
      {menuAt && (
        <PointerMenu
          at={menuAt}
          onClose={() => setMenuAt(null)}
          items={[
            {
              label: `${props.hidesSidebar ? "✓ " : ""}${t("Hide Sidebar While Reviewing")}`,
              hint: t("In a terminal chat, the file list steps aside while the review panel is open and would otherwise cover the terminal"),
              onClick: () => props.onHidesSidebar(!props.hidesSidebar),
              testId: "Hide sidebar while reviewing",
            },
          ]}
        />
      )}
    </>
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
