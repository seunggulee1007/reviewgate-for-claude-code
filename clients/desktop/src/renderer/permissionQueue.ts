/**
 * §33 permission requests on the client (pure, unit-tested; docs/PROTOCOL.md §33): the open requests oldest first
 * (`state.session.pendingPermissions`, or an older engine's single `pendingPermission`), the card a shortcut answers
 * (the one that has waited longest), each card's state, and its words — the agent chip, the §33.3 reason line, the
 * §33.6 "always allow" choices, the §29 peer badge — plus the agent panel's "waiting for permission" match.
 */
import type { PermissionRequest, SessionState, WorkbenchInfo } from "@reviewgate/engine";
import { agentTypeLabel } from "./agents";
import { t } from "./i18n";
import type { ChatItem } from "./store";

type QueueSession = Pick<SessionState, "pendingPermission" | "pendingPermissions">;

const NO_REQUESTS: PermissionRequest[] = [];

/** Every open request, oldest first. An engine without the queue (before §33.1) sends only `pendingPermission`. */
export function pendingPermissionsOf(s: { session: QueueSession }): PermissionRequest[] {
  const list = s.session.pendingPermissions;
  if (Array.isArray(list)) return list;
  return s.session.pendingPermission ? [s.session.pendingPermission] : NO_REQUESTS;
}

export function isPermissionPending(s: { session: QueueSession }, requestId: string): boolean {
  return pendingPermissionsOf(s).some((p) => p.requestId === requestId);
}

/**
 * The request ⌘↩ / ⌥⌘↩ / ⌘⌫ (Ctrl elsewhere) answer: the one that has waited longest that is not a question — a question
 * card has its own keys (wave3 check-clients: as the Mac's `shortcutPermission`; before, a question at the head of the
 * queue left every shortcut answering nothing).
 */
export function shortcutTargetId(s: { session: QueueSession }): string | null {
  return pendingPermissionsOf(s).find((p) => p.toolName !== "AskUserQuestion")?.requestId ?? null;
}

/** The request that has waited longest, a question included (the HUD's "권한 대기" jumps to it, as on the Mac). */
export function oldestRequestId(s: { session: QueueSession }): string | null {
  return pendingPermissionsOf(s)[0]?.requestId ?? null;
}

/** `permission_request` arrived: queued at the end (or refreshed in place); `pendingPermission` stays the first (§33.1). */
export function sessionWithRequest<S extends QueueSession>(session: S, request: PermissionRequest): S {
  const list = pendingPermissionsOf({ session });
  const known = list.some((p) => p.requestId === request.requestId);
  const next = known ? list.map((p) => (p.requestId === request.requestId ? request : p)) : [...list, request];
  return { ...session, pendingPermissions: next, pendingPermission: next[0] ?? null };
}

/** Answered from this window: off the local queue right away (the next snapshot is the authority). */
export function sessionWithoutRequest<S extends QueueSession>(session: S, requestId: string): S {
  const list = pendingPermissionsOf({ session });
  if (!list.some((p) => p.requestId === requestId)) return session;
  const next = list.filter((p) => p.requestId !== requestId);
  return { ...session, pendingPermissions: next, pendingPermission: next[0] ?? null };
}

/**
 * A card: still open (`active`), answered from this card (`decided`), or gone from the queue without our answer —
 * answered by the engine (a remembered key / pattern), withdrawn, interrupted or ended with the turn (`handled`).
 */
export type PermissionCardStatus = "active" | "decided" | "handled";

export function permissionCardStatus(decision: boolean | null, pending: boolean): PermissionCardStatus {
  if (decision !== null) return "decided";
  return pending ? "active" : "handled";
}

/** SendMessage (§33.2) and a request with a `reason` (§33.3) are never remembered nor saved as an allow pattern. */
export function canAllowBeyondOnce(request: Pick<PermissionRequest, "toolName" | "reason">): boolean {
  return !request.reason && request.toolName !== "SendMessage";
}

/**
 * MARK: r2-peers — §33.2 "이 세션으로 보내는 메시지는 세션 동안 허용": a SendMessage card whose receiving session's
 * conversation is known (`toSession.sessionId`) can be remembered — the engine stores `SendMessage:<that id>`.
 */
export function remembersSession(request: Pick<PermissionRequest, "toolName" | "reason" | "toSession">): boolean {
  return request.toolName === "SendMessage" && !request.reason && typeof request.toSession?.sessionId === "string" && request.toSession.sessionId.length > 0;
}

/** Whether `remember: true` may ride on an allow of `request` (§10 / §33.2). */
export function canRemember(request: Pick<PermissionRequest, "toolName" | "reason" | "toSession">): boolean {
  return canAllowBeyondOnce(request) || remembersSession(request);
}

// MARK: r2-peers — §33.1: several waiting cards answered at once (as the Mac's PermissionCardOptions.bundles)

/** The orange reasons — a call outside what this window's review sees — that may go along with others. */
const BUNDLED_REASONS: ReadonlySet<string> = new Set(["outside_project", "nested_repository", "other_worktree"]);

/**
 * Whether "대기 중 N개 모두 허용" / "이 에이전트의 요청은 이번 턴 동안 허용" may answer `request` without its own click: never
 * a question (it needs its answers), a plan, a SendMessage (what it says goes to another session) or a card whose reason is
 * red (a git command that throws away work or rewrites the remote, Claude Code's own settings, a worktree command or
 * isolation) — nor one with a reason this client does not know. A call outside the review (orange) may: it is listed
 * afterwards, as with a single allow.
 */
export function bundles(request: Pick<PermissionRequest, "toolName" | "reason">): boolean {
  if (request.toolName === "AskUserQuestion" || request.toolName === "SendMessage" || request.toolName === "ExitPlanMode") return false;
  return !request.reason || BUNDLED_REASONS.has(request.reason.code);
}

/** The open requests "대기 중 N개 모두 허용" answers, oldest first — empty unless two or more of them wait. */
export function permissionBundle(pending: readonly PermissionRequest[]): PermissionRequest[] {
  const bundled = pending.filter(bundles);
  return bundled.length >= 2 ? bundled : NO_REQUESTS;
}

/** The open requests of the subagent `agentId` that "이 에이전트의 요청은 이번 턴 동안 허용" answers now. */
export function agentBundle(pending: readonly PermissionRequest[], agentId: string): PermissionRequest[] {
  return pending.filter((p) => p.agent?.agentId === agentId && bundles(p));
}

/**
 * "이 프로젝트에서 항상 허용" choices: the client-derived Bash pattern first, then the engine's `allowPatterns` (§33.6 — MARK:
 * r2-skills-side, M21: for Bash the CLI's own suggestions, `Bash(./mvnw test:*)` where nothing is derived).
 */
export function alwaysAllowChoices(request: Pick<PermissionRequest, "toolName" | "reason" | "allowPatterns">, bashPattern: string | null): string[] {
  if (!canAllowBeyondOnce(request)) return [];
  const fromEngine = (request.allowPatterns ?? []).filter((p) => typeof p === "string" && p.trim().length > 0);
  return [...new Set([...(bashPattern ? [bashPattern] : []), ...fromEngine])];
}

/**
 * wave3 check-clients — the card shows "이 프로젝트에서 항상 허용" (as the Mac's PermissionCardOptions.showsAlwaysAllow):
 * for Bash always — disabled with its reason when no safe pattern exists (a chain, a redirection, sudo / sh -c, quoting),
 * so a blocked action is not hidden — for any other tool only with `choices`; never with a reason or for SendMessage.
 */
export function showsAlwaysAllow(request: Pick<PermissionRequest, "toolName" | "reason">, choices: readonly string[]): boolean {
  if (!canAllowBeyondOnce(request) || request.toolName === "AskUserQuestion") return false;
  return request.toolName === "Bash" || choices.length > 0;
}

/** `mcp__<server>__<tool>` → its parts (the server ends at the first `__` after the prefix, like the engine's split). */
function mcpParts(pattern: string): { server: string; tool: string | null } | null {
  if (!pattern.startsWith("mcp__")) return null;
  const rest = pattern.slice(5);
  const cut = rest.indexOf("__");
  if (cut < 0) return rest.length > 0 ? { server: rest, tool: null } : null;
  const server = rest.slice(0, cut);
  const tool = rest.slice(cut + 2);
  return server.length > 0 ? { server, tool: tool.length > 0 ? tool : null } : null;
}

/** A choice in words: `mcp__a__b` → "이 도구만 (b)", `mcp__a__*` / `mcp__a` → "a 서버 전체", `WebFetch(domain:x)` → "이 도메인 (x)"; anything else as written. */
export function allowPatternLabel(pattern: string): string {
  const mcp = mcpParts(pattern);
  if (mcp) return mcp.tool === null || mcp.tool === "*" ? t("The whole {0} server", mcp.server) : t("This tool only ({0})", mcp.tool);
  const domain = /^WebFetch\(domain:(.+)\)$/.exec(pattern);
  if (domain) return t("This domain ({0})", domain[1]!);
  return pattern;
}

/** The card's head chip: "🧩 executor · 컴파일" for a subagent (plugin prefix dropped), "메인 에이전트" for the main agent. */
export function agentChipText(request: Pick<PermissionRequest, "agent">): string {
  const agent = request.agent;
  if (!agent) return t("Main agent");
  const type = agent.subagentType ? agentTypeLabel(agent.subagentType) : t("Subagent");
  const description = agent.description?.trim();
  return description ? `🧩 ${type} · ${description}` : `🧩 ${type}`;
}

/** §29: "{senders} 요청" while the running review turn is accepted peer messages (card and HUD badge). */
export function peerTurnText(session: Pick<SessionState, "peerTurn">): string | null {
  const turn = session.peerTurn;
  if (!turn) return null;
  const names = (turn.fromNames ?? []).map((n) => (typeof n === "string" ? n.trim() : "")).filter((n) => n.length > 0);
  return t("Requested by {0}", names.length > 0 ? names.join(", ") : t("another session"));
}

/** `/a/b/c/d` → `c/d`, `C:\\a\\b\\c` → `b/c` (the card keeps the whole path in its tooltip). */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length <= 2 ? parts.join("/") || path : parts.slice(-2).join("/");
}

export type ReasonTone = "red" | "orange";
/** The card's warning line for a §33.3 reason; `path` is the full path (tooltip, "open as workbench"). */
export type ReasonView = { code: string; text: string; tone: ReasonTone; path: string | null };

/**
 * §33.3 / §33.4 / §33.9 reason → the warning line ("리뷰에 잡히지 않는 위치", Claude Code's own settings files for
 * `claude_config`). `code` is read as a string so a code a later engine adds still shows: the engine's English `message`.
 * `file` stands in for a missing `reason.path` (an edit's target).
 */
export function reasonView(reason: { code: string; message: string; path?: string; otherRepository?: true; keys?: string[] } | undefined, file?: string): ReasonView | null {
  if (!reason) return null;
  const code: string = reason.code;
  const path = reason.path ?? file ?? null;
  const short = path ? shortPath(path) : null;
  const view = (text: string, tone: ReasonTone): ReasonView => ({ code, text, tone, path });
  switch (code) {
    // wave3 check-clients — the tone follows the Mac (PermissionReasonText.level): orange for a place this window's review
    // does not see, red where work leaves it for good or cannot be reverted (a new worktree, an isolated agent, settings).
    case "outside_project":
      return view(t("A file outside the project — the review does not capture it"), "orange");
    case "nested_repository":
      return view(short ? t("Inside a nested repository (submodule · worktree · clone) — the review does not capture it ({0})", short) : t("Inside a nested repository (submodule · worktree · clone) — the review does not capture it"), "orange");
    case "other_worktree":
      return view(short ? t("A location in another worktree ({0}) — this window's review does not capture it", short) : t("A location in another worktree — this window's review does not capture it"), "orange");
    case "worktree_command":
      // §39.4: another repository's worktree — this chat cannot follow it there.
      if (reason.otherRepository) {
        return view(short ? t("Creates a git worktree of another repository ({0}) — this chat cannot move there; open that folder in ReviewGate to work there with a review", short) : t("Creates a git worktree of another repository — this chat cannot move there; open that folder in ReviewGate to work there with a review"), "red");
      }
      return view(short ? t("Creates a new git worktree ({0}) — work inside it is outside this window's review", short) : t("Creates a new git worktree — work inside it is outside this window's review"), "red");
    case "worktree_isolation":
      return view(t("This agent works outside this folder (an isolated worktree, …) — its changes are not in this window's review"), "red");
    case "claude_config":
      // M22 (§33.9): an edit whose risky settings the engine named — which ones, and why the card is here at all.
      if (reason.keys?.length) {
        const list = reason.keys.join(", ");
        return view(
          short
            ? t("Changes Claude Code settings ({0}: {1}) — they take effect before the review, so the review cannot undo them", short, list)
            : t("Changes Claude Code settings ({0}) — they take effect before the review, so the review cannot undo them", list),
          "red",
        );
      }
      return view(
        short
          ? t("Changes a Claude Code settings file ({0}) — hooks, permissions and MCP settings change, and settings.local.json is not kept in the review, so it cannot be undone", short)
          : t("Changes a Claude Code settings file — hooks, permissions and MCP settings change, and settings.local.json is not kept in the review, so it cannot be undone"),
        "red",
      );
    // MARK: r1-git — §46: only a git command that throws away uncommitted work or rewrites the remote has this card (red,
    // as on the Mac); it used to fall through to the engine's English message in orange.
    case "git_command":
      return view(t("A git command that throws away uncommitted work or rewrites the remote — the review cannot bring it back"), "red");
    default:
      return view(reason.message || code, "orange");
  }
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const x = norm(a);
  const y = norm(b);
  return /^[A-Za-z]:\//.test(x) || /^[A-Za-z]:\//.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** The workbench a reason's path is — another worktree of this repository, opened in its own window ("워크벤치로 열기"). */
export function workbenchAt(list: readonly WorkbenchInfo[], path: string | null | undefined): WorkbenchInfo | null {
  if (!path) return null;
  return list.find((w) => !w.isCurrent && samePath(w.path, path)) ?? null;
}

/** The open request one of `hud.agents` waits on (`agent.agentToolUseId` = that agent's `toolUseId`). */
export function requestWaitingFor(pending: readonly PermissionRequest[], agentToolUseId: string): PermissionRequest | null {
  return pending.find((p) => p.agent?.agentToolUseId === agentToolUseId) ?? null;
}

/** HUD chip: one open request → "권한 대기 중", more → "권한 요청 n개 대기"; none → nothing. */
export function hudPermissionText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? t("Permission pending") : t("{0} permission requests waiting", count);
}

// ---------------------------------------------------------------- transcript rows

type PermissionRow = Extract<ChatItem, { kind: "permission" }>;

export function hasPermissionRow(items: readonly ChatItem[], requestId: string): boolean {
  return items.some((it) => it.kind === "permission" && it.request.requestId === requestId);
}

/** Sets (or with null clears) the decision on the newest row of `requestId`; the same array when there is none. */
export function markPermissionRow(items: ChatItem[], requestId: string, allowed: boolean | null, answers?: Record<string, string>): ChatItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "permission" || item.request.requestId !== requestId) continue;
    const { answers: old, ...rest } = item;
    const keep = allowed === null ? undefined : (answers ?? old);
    const row: PermissionRow = { ...rest, allowed, ...(keep ? { answers: keep } : {}) };
    const next = [...items];
    next[i] = row;
    return next;
  }
  return items;
}

/** Open requests without a card in the transcript (their event never reached this view: a reload, a reconnect). */
export function requestsWithoutRow(items: readonly ChatItem[], pending: readonly PermissionRequest[]): PermissionRequest[] {
  if (pending.length === 0) return NO_REQUESTS;
  const seen = new Set<string>();
  for (const it of items) if (it.kind === "permission") seen.add(it.request.requestId);
  return pending.filter((p) => !seen.has(p.requestId));
}
