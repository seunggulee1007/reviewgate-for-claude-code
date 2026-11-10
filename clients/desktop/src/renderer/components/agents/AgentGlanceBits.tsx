/**
 * MARK: wave4b w4b-agents — subagents at a glance (docs/PROTOCOL.md §39.3; rules in `agentGlance.ts`): the card's current step
 * and badges, the isolated-worktree badge, the panel's "이전 턴", a finished group's numbers, MCP / Skill names in tool rows,
 * which agent changed a file (the list's chips and filter) and the turn summary's "에이전트별 변경".
 */
import { useMemo, useState } from "react";
import type { AgentNode, ChangedFileState, TurnSummaryFile } from "@reviewgate/engine";
import {
  agentBadges,
  authorFilters,
  changesByAgent,
  fileAuthors,
  historyByTurn,
  historyLine,
  historyOf,
  isolationBadge,
  stepLine,
  stepOf,
  toolTitle,
  type FileAuthor,
} from "../../agentGlance";
import { indexTranscript, isLive, type TranscriptIndex } from "../../agents";
import { openAgentDetail, revealAgentGroup } from "../../agentUi";
import { t } from "../../i18n";
import { samePath } from "../Sidebar";
import { pendingPermissionsOf, requestWaitingFor } from "../../permissionQueue";
import { useStore } from "../../store";
import { toolLabel } from "../../toolLabel";
import { useViewing } from "../../viewedChat"; // wave4b integration (§39.2)
import "./glance.css";

/** "▸ Bash · ./gradlew :acme-api:test · 4분 12초" — what a live agent is doing now (its tool name on an older engine). */
export function StepLine({ agent, now }: { agent: AgentNode; now: number }) {
  if (!isLive(agent.status)) return null;
  const step = stepOf(agent);
  if (!step) return agent.lastTool ? <div className="agent-last tiny mono">▸ {toolTitle(agent.lastTool)}</div> : null;
  const text = stepLine(step, now);
  return (
    <div className={`agent-last tiny mono truncate ${step.endedAt !== undefined ? "ended" : ""}`} title={text} data-testid="Agent step">
      ▸ {text}
    </div>
  );
}

/** "재시도 3/10" · "응답 없음 2분" on a live card (none while it waits for a permission answer: that badge says it). */
export function GlanceBadges({ agent, now }: { agent: AgentNode; now: number }) {
  const waiting = useStore((s) => requestWaitingFor(pendingPermissionsOf(s.state), agent.toolUseId) !== undefined);
  const badges = agentBadges(agent, now, waiting);
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((b) => (
        <span key={b.kind} className={`pill ${b.kind === "retry" ? "amber" : "red"} glance-badge`} title={b.title} data-testid={`Agent ${b.kind}`}>
          {b.text}
        </span>
      ))}
    </>
  );
}

/** "격리 worktree · 리뷰 밖" + opening that worktree as a workbench (a folder window when it is no known worktree). */
export function IsolationBadge({ agent }: { agent: AgentNode }) {
  const workbenches = useStore((s) => s.state.workbenches.list);
  const badge = isolationBadge(agent);
  if (!badge) return null;
  const path = agent.worktreePath;
  const known = path ? workbenches.some((w) => samePath(w.path, path)) : false;
  return (
    <div className="glance-isolation row" data-testid="Agent isolation">
      <span className="pill orange" title={badge.title}>{badge.text}</span>
      {path && (
        <button
          type="button"
          className="plain tiny"
          title={path}
          onClick={(e) => {
            e.stopPropagation();
            void (known ? window.rg.openWorkbenchWindow(path) : window.rg.openInNewWindow(path));
          }}
          data-testid="Agent open worktree"
        >
          {t("Open its worktree as a workbench")}
        </button>
      )}
    </div>
  );
}

const NO_HISTORY: AgentNode[] = [];

/** The panel's "이전 턴": this chat's finished agents of earlier turns, one line each, by turn (newest first). */
export function EarlierAgents() {
  const raw = useStore((s) => s.state.hud.agentHistory ?? NO_HISTORY);
  const groups = useMemo(() => historyByTurn(historyOf(raw)), [raw]);
  const [open, setOpen] = useState(true);
  if (groups.length === 0) return null;
  return (
    <section className="agent-earlier" data-testid="Earlier agents">
      <button type="button" className="plain agent-earlier-head" aria-expanded={open} onClick={() => setOpen(!open)} title={t("Finished subagents of this chat's earlier turns")}>
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="bold">{t("Earlier turns")}</span>
        <span className="tiny faint num">{groups.reduce((n, g) => n + g.agents.length, 0)}</span>
      </button>
      {open &&
        groups.map((g) => (
          <div key={g.turn ?? "none"} className="agent-earlier-turn">
            {g.turn !== null && <div className="tiny faint">{t("Turn {0}", g.turn)}</div>}
            {g.agents.map((a) => {
              const line = historyLine(a);
              return (
                <div key={a.toolUseId} className="agent-earlier-row row" data-testid={`Earlier agent ${a.toolUseId}`}>
                  <button type="button" className="plain grow truncate tiny" title={line} onClick={() => revealAgentGroup(a.toolUseId)}>
                    {line}
                  </button>
                  <button type="button" className="plain tiny" onClick={() => openAgentDetail(a.toolUseId)} title={t("Agent details")} aria-label={t("Agent details")}>
                    ⓘ
                  </button>
                </div>
              );
            })}
          </div>
        ))}
    </section>
  );
}

/** A tool row's name: "github · get issue" (server chip) for an MCP call, "✦ 스킬" for a Skill call, the name otherwise. */
export function ToolNameLabel({ name, input }: { name: string; input: Record<string, unknown> }) {
  const l = toolLabel(name, input);
  if (l.kind === "mcp")
    return (
      <span className="name tool-name-mcp" title={name}>
        <span className="pill gray mcp-server">{l.server}</span> {l.name}
      </span>
    );
  if (l.kind === "skill") return <span className="name" title={name}>✦ {t("Skill")}</span>;
  return <span className="name">{name}</span>;
}

/** A tool row's detail for MCP / Skill calls (the representative argument, the skill and its args); null: the row's own. */
export function labelDetail(name: string, input: Record<string, unknown>): string | null {
  const l = toolLabel(name, input);
  if (l.kind === "mcp") return l.arg ?? "";
  if (l.kind === "skill") return [l.name, l.arg].filter(Boolean).join(" ");
  return null;
}

// ------------------------------------------------------------------ who changed a file

/** Authors per changed path, from the transcript's tool rows (recomputed when rows are added, not on a streaming delta). */
export function useFileAuthors(files: readonly { path: string; toolUseIds?: string[] }[], inShownChat = false): Map<string, FileAuthor[]> {
  const rows = useStore((s) => s.transcript.length);
  const agents = useStore((s) => s.state.hud.agents);
  // wave4b integration (§39.2 × §39.3): a turn summary card of a chat shown read-only names the authors from that chat's
  // rows, not the running chat's (the review list keeps the running chat's: its review is that chat's).
  const viewing = useViewing();
  const shown = inShownChat && viewing ? viewing.items : null;
  return useMemo(() => {
    const index: TranscriptIndex = indexTranscript(shown ?? useStore.getState().transcript);
    return new Map(files.map((f) => [f.path, fileAuthors(f.toolUseIds, index, shown ? [] : agents ?? [])] as const));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, rows, agents, shown]);
}

/** The changed-file row's agent chips (the main agent's own changes get none). */
export function FileAuthorChips({ authors }: { authors: FileAuthor[] | undefined }) {
  const agents = (authors ?? []).filter((a) => a.agentToolUseId !== null);
  if (agents.length === 0) return null;
  return (
    <span className="file-authors" data-testid="File authors">
      {agents.slice(0, 3).map((a) => (
        <span key={a.key} className="pill purple author-chip" title={t("Changed by {0}", a.label)}>
          ◆ {a.label}
        </span>
      ))}
      {agents.length > 3 && <span className="tiny faint" title={agents.slice(3).map((a) => a.label).join(", ")}>+{agents.length - 3}</span>}
    </span>
  );
}

/** "전체 · 메인 · executor · test-engineer" above the list (only with two or more authors). */
export function AuthorFilterChips({ offered, value, onChange }: { offered: FileAuthor[]; value: string | null; onChange: (key: string | null) => void }) {
  if (offered.length < 2) return null;
  const current = value && offered.some((a) => a.key === value) ? value : null;
  return (
    <li className="author-filters row" role="group" aria-label={t("Changes by agent")} data-testid="Author filters">
      <button type="button" className={`plain tiny author-filter ${current === null ? "active" : ""}`} aria-pressed={current === null} onClick={() => onChange(null)}>
        {t("All files")}
      </button>
      {offered.map((a) => (
        <button
          key={a.key}
          type="button"
          className={`plain tiny author-filter ${current === a.key ? "active" : ""}`}
          aria-pressed={current === a.key}
          title={t("Only the changes of {0}", a.label)}
          onClick={() => onChange(current === a.key ? null : a.key)}
          data-testid={`Author filter ${a.key}`}
        >
          {a.label}
        </button>
      ))}
    </li>
  );
}

/** The files of the list the filter keeps (all when no filter / the author is gone). */
export function useAuthorFilter(files: readonly ChangedFileState[]): {
  offered: FileAuthor[];
  value: string | null;
  setValue: (key: string | null) => void;
  authors: Map<string, FileAuthor[]>;
  keep: (path: string) => boolean;
} {
  const authors = useFileAuthors(files);
  const offered = useMemo(() => authorFilters([...authors.values()]), [authors]);
  const [value, setValue] = useState<string | null>(null);
  const active = value && offered.some((a) => a.key === value) ? value : null;
  const keep = (path: string) => active === null || (authors.get(path) ?? []).some((a) => a.key === active);
  return { offered, value: active, setValue, authors, keep };
}

/** The turn summary's "에이전트별 변경": each author with its files (click → the diff / the agent's group). */
export function AgentChangesSection({ files }: { files: TurnSummaryFile[] }) {
  const authors = useFileAuthors(files, true);
  const revealFile = useStore((s) => s.revealFile);
  const live = useStore((s) => s.state.changedFiles);
  const rows = useMemo(() => changesByAgent(files, (f) => authors.get(f.path) ?? []), [files, authors]);
  if (rows.length === 0) return null;
  return (
    <div className="ts-agents" data-testid="Summary agent changes">
      <div className="tiny bold muted">{t("Changes by agent")}</div>
      {rows.map(({ author, paths }) => (
        <div key={author.key} className="ts-agent-row row">
          <button
            type="button"
            className="plain tiny bold"
            disabled={author.agentToolUseId === null}
            onClick={() => author.agentToolUseId && revealAgentGroup(author.agentToolUseId)}
            title={author.agentToolUseId ? t("Show in chat") : undefined}
          >
            {author.agentToolUseId ? "◆ " : ""}
            {author.label}
          </button>
          <span className="ts-agent-files">
            {paths.map((p) => {
              const inReview = live.some((f) => f.path === p);
              return (
                <button key={p} type="button" className="file-link" disabled={!inReview} title={inReview ? p : t("{0} — not in the current review", p)} onClick={() => revealFile(p)}>
                  {p.split("/").pop()}
                </button>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}
