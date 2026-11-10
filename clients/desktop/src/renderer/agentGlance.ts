/**
 * MARK: wave4b w4b-agents — subagents at a glance (docs/PROTOCOL.md §39.3), the same rules as the Mac's `AgentGlance.swift`:
 * what an agent is doing now ("Bash · ./gradlew :acme-api:test · 4분 12초"), its badges (재시도 3/10, 응답 없음 2분), the
 * HUD's line while subagents run, a finished group's numbers ("✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2"), the turns of the
 * earlier agents, and which agent changed a file (the changed-file list's chips and filter, the turn summary's section).
 * Read leniently: an engine before §39.3 sends no `lastStep` / `retry` / `activeAt` / `turn` / `agentHistory` and every
 * function then answers what the screens showed before (nothing extra).
 */
import type { AgentNode, AgentStatus, AgentStep, AgentUsage } from "@reviewgate/engine";
import { t } from "./i18n";
import { formatElapsed } from "./elapsed";
import { toolLabel } from "./toolLabel";
import { agentTypeLabel, EDIT_TOOLS, isAgentTool, isLive, statusLabel, type TranscriptIndex } from "./agents";

/** No progress of a live agent for this long reads "응답 없음 N분". */
export const STALE_AFTER_MS = 120_000;

/** A tool by name and its detail: "Bash · ./gradlew test", "github · get issue · 1800", "스킬 acme-tools:smoke". */
export function toolTitle(tool: string, detail?: string | null, sep = " · "): string {
  const d = detail && detail.trim() ? detail : null;
  if (tool === "Skill") return d ? t("Skill {0}", d) : t("Skill");
  const l = toolLabel(tool);
  const name = l.kind === "mcp" ? `${l.server} · ${l.name}` : l.name;
  return d ? `${name}${sep}${d}` : name;
}

/** A call by name and input: "github · get issue · 1800", "스킬 acme-tools:smoke", else its name (the permission card). */
export function callTitle(name: string, input: Record<string, unknown> | null | undefined): string {
  const l = toolLabel(name, input);
  if (l.kind === "mcp") return [`${l.server} · ${l.name}`, l.arg].filter(Boolean).join(" · ");
  if (l.kind === "skill") return l.name ? t("Skill {0}", l.name) : t("Skill");
  return name;
}

/** The agent's current step: "Bash · ./gradlew :acme-api:test · 4분 12초" (how long that call has run, or ran). */
export function stepLine(step: AgentStep, now: number): string {
  const ms = Math.max(0, (step.endedAt ?? now) - step.since);
  return `${toolTitle(step.tool, step.detail)} · ${formatElapsed(ms / 1000)}`;
}

/** A valid §39.3 step (lenient: a malformed one reads as none). */
export function stepOf(a: AgentNode): AgentStep | null {
  const s = a.lastStep as Partial<AgentStep> | undefined;
  if (!s || typeof s.tool !== "string" || !s.tool || typeof s.since !== "number" || !Number.isFinite(s.since)) return null;
  return {
    tool: s.tool,
    since: s.since,
    ...(typeof s.detail === "string" && s.detail ? { detail: s.detail } : {}),
    ...(typeof s.endedAt === "number" && Number.isFinite(s.endedAt) ? { endedAt: s.endedAt } : {}),
  };
}

export type AgentBadge = { kind: "retry" | "stale"; text: string; title: string };

/** Whole minutes, at least 1: "2분" / "2m". */
function minutes(ms: number): string {
  return t("{0} min", Math.max(1, Math.floor(ms / 60_000)));
}

/**
 * The live agent's warnings: the CLI retrying its API request ("재시도 3/10") and no progress for 2 minutes ("응답 없음 2분").
 * None while it waits for a permission answer (that badge says it) or is paused.
 */
export function agentBadges(a: AgentNode, now: number, awaitingPermission = false): AgentBadge[] {
  if (!isLive(a.status) || a.status === "paused" || awaitingPermission) return [];
  const out: AgentBadge[] = [];
  const r = a.retry;
  if (r && typeof r.attempt === "number" && typeof r.max === "number") {
    const why = typeof r.status === "number" ? t("API error {0} — Claude Code is retrying", r.status) : t("Connection error — Claude Code is retrying");
    out.push({ kind: "retry", text: t("Retry {0}/{1}", r.attempt, r.max), title: why });
  }
  if (typeof a.activeAt === "number" && now - a.activeAt >= STALE_AFTER_MS) {
    out.push({ kind: "stale", text: t("No response {0}", minutes(now - a.activeAt)), title: t("Nothing heard from this agent for {0}", formatElapsed((now - a.activeAt) / 1000)) });
  }
  return out;
}

/**
 * The HUD while subagents run: "서브에이전트 3개 실행 중 — executor: Edit CartService.java" (the agent whose call started
 * last); null when none is live (the HUD keeps its own words).
 */
export function agentsHudLine(agents: readonly AgentNode[]): string | null {
  const live = agents.filter((a) => isLive(a.status));
  if (live.length === 0) return null;
  let best: { a: AgentNode; step: AgentStep } | null = null;
  for (const a of live) {
    const step = stepOf(a);
    if (!step) continue;
    if (!best || (best.step.endedAt === undefined) < (step.endedAt === undefined) || ((best.step.endedAt === undefined) === (step.endedAt === undefined) && step.since > best.step.since)) best = { a, step };
  }
  if (!best) return t("{0} subagents running", live.length);
  return t("{0} subagents running — {1}", live.length, `${agentTypeLabel(best.a.type)}: ${toolTitle(best.step.tool, best.step.detail, " ")}`);
}

/** Compact token count: 950 → "950", 35_200 → "35.2k", 1_200_000 → "1.2M". */
export function compactTokens(n: number): string {
  const trim = (v: number) => {
    const s = v.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (n >= 1_000_000) return trim(n / 1_000_000) + "M";
  if (n >= 1_000) return trim(n / 1_000) + "k";
  return String(n);
}

/** A finished agent's numbers: "✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2" (null while it runs). */
export function finishedLine(status: AgentStatus, usage: Partial<AgentUsage> | null, files: number, stoppedByUser = false): string | null {
  if (isLive(status)) return null;
  const mark = status === "completed" ? "✓" : status === "failed" ? "✕" : "■";
  const parts = [`${mark} ${stoppedByUser ? t("Stopped by you") : statusLabel(status)}`];
  if (typeof usage?.durationMs === "number") parts.push(formatElapsed(usage.durationMs / 1000));
  if (typeof usage?.tokens === "number") parts.push(t("{0} tokens", compactTokens(usage.tokens)));
  if (files > 0) parts.push(t("Files {0}", files));
  return parts.join(" · ");
}

/** Distinct files the edit calls under the Agent call `toolUseId` named (any depth) — the rows survive a restart. */
export function groupFiles(index: TranscriptIndex, toolUseId: string): string[] {
  const out = new Set<string>();
  const walk = (id: string, seen: Set<string>) => {
    for (const c of index.children.get(id) ?? []) {
      if (c.kind !== "toolUse" || seen.has(c.toolUseId)) continue;
      seen.add(c.toolUseId);
      if (EDIT_TOOLS.has(c.name) && c.file) out.add(c.file);
      walk(c.toolUseId, seen);
    }
  };
  walk(toolUseId, new Set());
  return [...out];
}

// ------------------------------------------------------------------ earlier turns (agents-08)

/** `hud.agentHistory` read leniently: finished nodes with a tool_use id, newest first. */
export function historyOf(raw: unknown): AgentNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is AgentNode => typeof a === "object" && a !== null && typeof (a as AgentNode).toolUseId === "string" && typeof (a as AgentNode).type === "string");
}

/** Earlier agents by turn, newest turn first (agents without a turn number last, as one group). */
export function historyByTurn(history: readonly AgentNode[]): { turn: number | null; agents: AgentNode[] }[] {
  const groups = new Map<number | null, AgentNode[]>();
  for (const a of history) {
    const turn = typeof a.turn === "number" ? a.turn : null;
    const list = groups.get(turn);
    if (list) list.push(a);
    else groups.set(turn, [a]);
  }
  return [...groups.entries()]
    .sort(([x], [y]) => (x === null ? 1 : y === null ? -1 : y - x))
    .map(([turn, agents]) => ({ turn, agents }));
}

/** One line for an earlier agent: "executor · 배치 모듈 영향 확인 · ✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2". */
export function historyLine(a: AgentNode): string {
  const usage = typeof a.tokens === "number" && typeof a.durationMs === "number" ? { tokens: a.tokens, toolUses: a.toolUses ?? 0, durationMs: a.durationMs } : null;
  const fin = finishedLine(a.status, usage, a.files?.length ?? 0, a.stoppedBy === "user");
  return [agentTypeLabel(a.type), a.description || null, fin].filter(Boolean).join(" · ");
}

// ------------------------------------------------------------------ who changed a file (agents-13)

/** A changed file's author: the subagent whose call changed it (its Agent call id and type), or the main agent. */
export type FileAuthor = { key: string; label: string; agentToolUseId: string | null };

export const MAIN_AUTHOR = "main";

/** The nearest Agent / Task call above `toolUseId` (the call itself excluded), or null: the main agent made it. */
function agentAbove(index: TranscriptIndex, toolUseId: string): string | null {
  let cur = index.uses.get(toolUseId)?.parentToolUseId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const use = index.uses.get(cur);
    if (!use) return cur; // a parent the transcript does not hold is still a subagent (rows paged out)
    if (isAgentTool(use.name)) return cur;
    cur = use.parentToolUseId;
  }
  return null;
}

/** The authors of a changed file (`ChangedFile.toolUseIds`), in call order; [] when the engine sends no ids. */
export function fileAuthors(toolUseIds: readonly string[] | undefined, index: TranscriptIndex, agents: readonly AgentNode[] = []): FileAuthor[] {
  if (!toolUseIds || toolUseIds.length === 0) return [];
  const out: FileAuthor[] = [];
  const seen = new Set<string>();
  for (const id of toolUseIds) {
    const agentId = agentAbove(index, id);
    const key = agentId ?? MAIN_AUTHOR;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!agentId) {
      out.push({ key, label: t("Main"), agentToolUseId: null });
      continue;
    }
    const use = index.uses.get(agentId);
    const type = typeof use?.input?.["subagent_type"] === "string" && use.input["subagent_type"] ? (use.input["subagent_type"] as string) : agents.find((a) => a.toolUseId === agentId)?.type ?? "agent";
    out.push({ key, label: agentTypeLabel(type), agentToolUseId: agentId });
  }
  return out;
}

/** The filter chips above the list — "전체 · 메인 · executor · test-engineer" — only when two or more authors changed files. */
export function authorFilters(authorsPerFile: readonly FileAuthor[][]): FileAuthor[] {
  const all = new Map<string, FileAuthor>();
  for (const list of authorsPerFile) for (const a of list) if (!all.has(a.key)) all.set(a.key, a);
  if (all.size < 2) return [];
  const main = all.get(MAIN_AUTHOR);
  const rest = [...all.values()].filter((a) => a.key !== MAIN_AUTHOR);
  // Two agents of one type read apart: "executor", "executor 2".
  const count = new Map<string, number>();
  const named = rest.map((a) => {
    const n = (count.get(a.label) ?? 0) + 1;
    count.set(a.label, n);
    return n > 1 ? { ...a, label: `${a.label} ${n}` } : a;
  });
  return [...(main ? [main] : []), ...named];
}

/** Files of one author (`key`), or all when `key` is null / no longer offered. */
export function filterByAuthor<T>(files: readonly T[], authorsOf: (f: T) => FileAuthor[], key: string | null, offered: readonly FileAuthor[]): T[] {
  if (!key || !offered.some((a) => a.key === key)) return [...files];
  return files.filter((f) => authorsOf(f).some((a) => a.key === key));
}

/** The turn summary's "에이전트별 변경": each subagent with the files it changed (none when only the main agent did). */
export function changesByAgent<T extends { path: string }>(files: readonly T[], authorsOf: (f: T) => FileAuthor[]): { author: FileAuthor; paths: string[] }[] {
  const by = new Map<string, { author: FileAuthor; paths: string[] }>();
  for (const f of files) {
    for (const a of authorsOf(f)) {
      const entry = by.get(a.key);
      if (entry) entry.paths.push(f.path);
      else by.set(a.key, { author: a, paths: [f.path] });
    }
  }
  if (![...by.keys()].some((k) => k !== MAIN_AUTHOR)) return [];
  return [...by.values()];
}

// ------------------------------------------------------------------ isolation (agents-14)

/** "격리 worktree · 리뷰 밖" for an agent that ran with `isolation` (not a denied call), else null. */
export function isolationBadge(a: AgentNode): { text: string; title: string } | null {
  const iso = typeof a.isolation === "string" ? a.isolation : "";
  if (!iso || iso === "none") return null;
  if (a.status === "failed" && !a.worktreePath) return null; // the hooks denied it (§33.4): it never ran apart
  const where = [a.worktreePath, a.worktreeBranch].filter(Boolean).join(" · ");
  const text = iso === "worktree" ? t("Isolated worktree · outside the review") : t("Isolated ({0}) · outside the review", iso);
  return { text, title: where ? t("Its changes stay in {0}; this window's review does not see them.", where) : t("Its changes stay outside this folder; this window's review does not see them.") };
}
