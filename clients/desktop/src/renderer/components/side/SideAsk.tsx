/**
 * Entry points of the side questions (docs/PROTOCOL.md §21): the small "왜?" button that opens the side panel on a
 * new question about an anchor, and the "곁질문 N" badge on a file / hunk / tool row that already has threads.
 */
import { useCallback, useMemo, type MouseEvent, type ReactNode } from "react";
import type { DiffHunk, DiffLine, SideAnchor, SideThread } from "@reviewgate/engine";
import { t } from "../../i18n";
import { sortedThreads, threadsOnFile, threadsOnHunk, threadsOnTool } from "../../sideThreads";
import { useStore } from "../../store";
import { keyId, type LineKey } from "../UnifiedDiff";
import "./side.css";

/** The current chat's threads, newest first (memoized on the thread map). */
export function useSideThreads(): SideThread[] {
  const threads = useStore((s) => s.side.threads);
  return useMemo(() => sortedThreads({ mainSessionId: null, threads, live: {} }), [threads]);
}

/** Threads on one file / tool call (badge input). */
export function useFileThreads(path: string, entryId?: string): SideThread[] {
  const all = useSideThreads();
  return useMemo(() => threadsOnFile(all, path, entryId), [all, path, entryId]);
}
export function useToolThreads(toolUseId: string): SideThread[] {
  const all = useSideThreads();
  return useMemo(() => threadsOnTool(all, toolUseId), [all, toolUseId]);
}

/** The diff's side-question hooks: the gutter "?" per line, "왜?" + badge per hunk header, anchored-line marks. */
export function useDiffSide(path: string | null, entryId?: string): {
  onAsk: ((line: DiffLine, key: LineKey, hunk: DiffHunk) => void) | undefined;
  hunkAside: ((hunk: DiffHunk) => ReactNode) | undefined;
  anchoredLines: ReadonlySet<string>;
  threads: SideThread[];
} {
  const askAbout = useStore((s) => s.askAbout);
  const hasProject = useStore((s) => s.state.project !== null);
  const fileThreads = useFileThreads(path ?? "", entryId);
  const onAsk = useCallback(
    (line: DiffLine, key: LineKey) => {
      if (!path) return;
      askAbout({ path, line: key.line, side: key.side, ...(entryId ? { entryId } : {}) }, { context: line.text });
    },
    [askAbout, path, entryId],
  );
  const hunkAside = useCallback(
    (h: DiffHunk) =>
      path ? (
        <>
          <SideBadge threads={threadsOnHunk(fileThreads, path, h, entryId)} testId={`Side badge hunk ${h.id}`} />
          <AskButton anchor={{ path, hunkId: h.id, ...(entryId ? { entryId } : {}) }} title={t("Ask why this part changed (side question)")} testId={`Ask hunk ${h.id}`} />
        </>
      ) : null,
    [path, entryId, fileThreads],
  );
  const anchoredLines = useMemo(() => {
    const set = new Set<string>();
    for (const th of fileThreads) if (th.anchor?.line !== undefined) set.add(keyId({ side: th.anchor.side ?? "new", line: th.anchor.line }));
    return set;
  }, [fileThreads]);
  if (!path || !hasProject) return { onAsk: undefined, hunkAside: undefined, anchoredLines, threads: fileThreads };
  return { onAsk, hunkAside, anchoredLines, threads: fileThreads };
}

export function AskButton(props: {
  anchor: SideAnchor | null;
  question?: string;
  context?: string;
  label?: string;
  title?: string;
  className?: string;
  testId?: string;
}) {
  const askAbout = useStore((s) => s.askAbout);
  const hasProject = useStore((s) => s.state.project !== null);
  if (!hasProject) return null;
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    askAbout(props.anchor, { ...(props.question ? { question: props.question } : {}), ...(props.context ? { context: props.context } : {}) });
  };
  return (
    <button
      type="button"
      className={`side-ask ${props.className ?? ""}`}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={props.title ?? t("Ask a side question about this — the main conversation is not affected (⌥⌘/)")}
      data-testid={props.testId ?? "Ask why"}
    >
      <span className="q" aria-hidden="true">?</span>
      {props.label ?? t("Why?")}
    </button>
  );
}

/** "곁질문 2" — opens the newest thread (or the list when there are several on the same anchor). */
export function SideBadge({ threads, testId }: { threads: SideThread[]; testId?: string }) {
  const open = useStore((s) => s.openSideThread);
  const showList = useStore((s) => s.showSideList);
  const toggle = useStore((s) => s.toggleSidePanel);
  if (threads.length === 0) return null;
  const running = threads.some((th) => th.status === "running");
  const newest = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!;
  return (
    <button
      type="button"
      className={`side-badge ${running ? "live" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (threads.length === 1) open(newest.id);
        else {
          showList();
          toggle(true);
        }
      }}
      title={threads.map((th) => `• ${th.title}`).join("\n")}
      data-testid={testId ?? "Side badge"}
    >
      {running ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">💬</span>}
      {t("Side {0}", threads.length)}
    </button>
  );
}
