/**
 * MARK: wave5 w5-board — §43.1: the agent board ("관제판") on Windows: a large panel over the window (View › Agent Board,
 * Ctrl+Alt+B; the agent panel's board button) with three tabs — agents (`AgentBoard`), sub-brain (`SubBrainBoard`, w5-brain)
 * and code graph (`CodeGraphBoard`, w5-graph), each a default export without props that reads the store. The tab is
 * remembered per project; Esc, the ✕ or a click outside closes it, and showing an agent in the chat closes it too.
 */
import { useEffect, useRef, useState } from "react";
import { readBoardTab, writeBoardTab, type BoardTab } from "../../agentAvatar";
import { useAgentUi } from "../../agentUi";
import { t } from "../../i18n";
import { useStore } from "../../store";
import type { SideView } from "../../storeSide";
import AgentBoard from "./AgentBoard";
import { BoardGlyph } from "./AvatarGlyphs";
import CodeGraphBoard from "./CodeGraphBoard";
import SubBrainBoard from "./SubBrainBoard";
import "./board.css";

const TABS: { id: BoardTab; label: string; glyph: "agents" | "brain" | "graph" }[] = [
  { id: "agents", label: "Agents", glyph: "agents" },
  { id: "brain", label: "Sub-brain", glyph: "brain" },
  { id: "graph", label: "Code graph", glyph: "graph" },
];

/**
 * Whether the open board steps aside for the side panel: a new side question was opened since the board opened (a new
 * view's nonce) — never an answer arriving or a thread going, which change the side view by themselves.
 */
export function sideStepsAside(start: SideView, now: SideView): boolean {
  return now.kind === "new" && (start.kind !== "new" || now.nonce !== start.nonce);
}

export function BoardDialog() {
  const project = useStore((s) => s.state.project?.path ?? null);
  const projectName = useStore((s) => s.state.project?.name ?? null);
  const close = () => useStore.getState().toggleBoard(false);
  const [tab, setTab] = useState<BoardTab>(() => readBoardTab(project));
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => setTab(readBoardTab(project)), [project]);

  // Showing an agent in the chat (a tile, a face, the menu's "대화에서 보기") lands behind the board: it steps aside.
  useEffect(() => {
    const start = useAgentUi.getState().expand?.nonce;
    return useAgentUi.subscribe((s) => {
      if (s.expand && s.expand.nonce !== start) useStore.getState().toggleBoard(false);
    });
  }, []);

  // §43.5's "왜 시작했는지 묻기" in a tile's menu (the card's menu) opens a new side question beside the chat: the board
  // steps aside for it too (sideStepsAside).
  useEffect(() => {
    const start = useStore.getState().sideView;
    return useStore.subscribe((s) => {
      if (sideStepsAside(start, s.sideView)) useStore.getState().toggleBoard(false);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog above the board (the agent details) closes first.
      if (e.key === "Escape" && !useStore.getState().dialog) {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const choose = (id: BoardTab) => {
    setTab(id);
    writeBoardTab(project, id);
  };

  return (
    <div className="board-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()} data-testid="Agent board backdrop">
      <div
        className="board-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("Agent Board")}
        tabIndex={-1}
        ref={panel}
        // "카드로 이동" scrolls the chat to a permission card behind the board: the board steps aside for it as well.
        onClickCapture={(e) => {
          if ((e.target as HTMLElement).closest('[data-testid="Go to permission card"], button[data-testid="Agent awaiting permission"]')) close();
        }}
        data-testid="Agent board dialog"
      >
        <header className="board-head">
          <h3>{t("Agent Board")}</h3>
          <div className="board-tabs" role="tablist" aria-label={t("Agent Board")}>
            {TABS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={tab === x.id}
                onClick={() => choose(x.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  const i = TABS.findIndex((y) => y.id === tab);
                  const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
                  choose(next.id);
                }}
                data-testid={`Agent board tab ${x.id}`}
              >
                <BoardGlyph kind={x.glyph} />
                {t(x.label)}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {projectName && <span className="caption muted truncate">{projectName}</span>}
          <span className="tiny faint">{t("Toggle ⌥⌘B")}</span>
          <button type="button" className="plain small" onClick={close} title={t("Close")} aria-label={t("Close")} data-testid="Close agent board">
            ✕
          </button>
        </header>
        <div className="board-body" role="tabpanel">
          {tab === "agents" ? <AgentBoard /> : tab === "brain" ? <SubBrainBoard /> : <CodeGraphBoard />}
        </div>
      </div>
    </div>
  );
}
