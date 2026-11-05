import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PermissionMode, PermissionReason } from "../protocol.js";
import { openCheckpoint, type GitCheckpoint } from "../git/checkpoint.js";
import { matchesIgnore } from "../git/ignore.js";
import { isModsPath } from "../git/mods.js";
import { commonDir, gitDir, listWorktrees, sameRepository } from "../git/worktrees.js";
import { HOST_FLAVOR, hasGitComponent, isInside, isInsidePath, normalizeForCompare, realpathLenient, samePath, toRepoRelative } from "../platform/paths.js";
import { isReadOnlyCommand, isRemembered, matchesAllowPattern } from "./bashClass.js";
import { BudgetState, estimateEditLines, resolveToolPath } from "./budget.js";
import type { SessionEvent, SessionLog } from "./events.js";
import { isReadMcpTool, matchesToolPattern, rememberable, userRuleAllows, type McpToolHints, type UserRules } from "./permissionRules.js";
import { changedWithin, isMcpTool, WINDOW_MARGIN_MS, type ToolWindow } from "./provenance.js";
import { autoModeDecides, hookPermissionMode } from "./autoMode.js"; // MARK: wave4b w4b-auto (§39.5)
import {
  bashClaudeConfigTarget,
  bashScopeReason,
  CLAUDE_CONFIG_ASK_REASON,
  claudeConfigFile,
  claudeConfigReason,
  inputClaudeConfigTarget,
  isolatedCall,
  isolatedResult,
  isScratchPath,
  nestedRepoRoot,
  SCOPE_ASK_REASON,
  SCOPE_MESSAGES,
  OTHER_REPO_WORKTREE_MESSAGE,
  worktreeAddRepoDir,
  worktreeToolBlocked,
  type ScopeNotice,
} from "./reviewScope.js";

export { CLAUDE_CONFIG_ASK_REASON };

export const EDIT_TOOLS_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const EDIT_TOOLS_RE = new RegExp(`^(${EDIT_TOOLS_MATCHER})$`);
/** MCP tools (`mcp__<server>__<tool>`): their PostToolUse closes the execution window (§31). */
export const MCP_TOOLS_MATCHER = "mcp__.*";
export const MAX_CALLS_AFTER_DENY = 5;

/**
 * Tools that only read state or bookkeeping; the CLI runs them without a prompt and so do we.
 * `Skill` only loads a skill's instructions into context — every tool the skill then calls is gated on its own.
 * `ListAgents` only lists the agents / local sessions a message could go to (§33); `SendMessage` keeps its card.
 * `ReportFindings` (§36.13, `CLAUDE_CODE_REPORT_FINDINGS=1`) only hands `/code-review`'s findings to the host — it changes
 * nothing (the CLI itself never asks for it either; verified with CLI 2.1.309).
 * `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` (§43.5) only keep Claude's to-do list, as TodoWrite does; `TaskStop`
 * (stops a background task) and `Task` / `Agent` (start a subagent) still ask.
 * Everything else that is not an edit tool (Bash, WebFetch, WebSearch, Agent/Task, MCP tools, …)
 * is forced through canUseTool by the ask hook. (Tool names as the CLI reports them in `system/init.tools`.)
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Glob", "Grep", "LS", "TodoWrite", "TodoRead", "NotebookRead", "BashOutput", "KillShell", "ToolSearch", "Skill",
  "ListAgents",
  "ReportFindings", // MARK: wave3 engine-flow (§36.13)
  // MARK: wave5 w5-fixes — §43.5: the to-do list tools
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
]);
export const ASK_REASON = "ReviewGate: human approval required";
export const READ_ONLY_BASH_REASON = "ReviewGate: read-only command";
export const ALLOW_PATTERN_REASON = "ReviewGate: matches an allow pattern";
export const REMEMBERED_REASON = "ReviewGate: allowed for this session";
export const USER_RULE_REASON = "ReviewGate: allowed by your Claude Code settings";
export const OUTSIDE_REASON = "ReviewGate: edit outside the project — needs approval";
export const NESTED_REASON = "ReviewGate: edit inside a nested repository (submodule, worktree or clone) — the review does not see it; needs approval";
export const PLAN_FILE_REASON = "ReviewGate: plan file (plan mode)";
export const UNPROMPTED_REASON =
  "ReviewGate: no user request is running — Claude Code continued on its own, and changes made now would bypass the review. " +
  "This call was blocked. Do not make changes; stop and wait for the user's next message.";
export const PLAN_MODE_EDIT_REASON =
  "ReviewGate: plan mode — files may not be edited yet. Investigate with read-only tools, then propose the change with ExitPlanMode; " +
  "the user approves the plan in ReviewGate and the edits happen after that.";
export const PLAN_MODE_BASH_REASON =
  "ReviewGate: plan mode — only read-only shell commands may run. Do not change anything; propose the plan with ExitPlanMode " +
  "(the user approves it in ReviewGate).";
export const GIT_INTERNAL_REASON =
  "ReviewGate: edits inside the git directory (.git/) are not allowed — the app manages git; edit the working tree instead.";

/**
 * Where plan mode writes its plans (`<home>/.claude/plans/`; docs/M20-MODES.md). There is no
 * `ExitPlanMode` tool in SDK sessions: the plan arrives as a `Write`/`Edit` to a file in here.
 */
export function plansDir(home: string = homedir()): string {
  return realpathLenient(join(home, ".claude", "plans"));
}

/**
 * True while the session is in plan mode and `file` is inside the plans directory. Such a write is
 * auto-allowed (it is outside the repo, so the containment ask would otherwise prompt) and recorded
 * in `ctx.planFiles` — never counted in the budget, the review or `changedOutside`.
 */
export function isPlanFile(file: string, ctx: Pick<HookContext, "permissionMode" | "plansDir">): boolean {
  if (ctx.permissionMode !== "plan") return false;
  return toRepoRelative(file, ctx.plansDir ?? plansDir()) !== null;
}

export { realpathLenient };

/** True when `file` is in Claude Code's per-project memory folder: `<home>/.claude/projects/<project>/memory/…`. */
export function isClaudeMemoryFile(file: string, home: string = homedir()): boolean {
  const rel = toRepoRelative(file, realpathLenient(join(home, ".claude", "projects")));
  if (rel === null) return false;
  const parts = rel.split(/[\\/]/);
  return parts.length >= 3 && parts[1] === "memory";
}

/**
 * True when an edit to `file` would land in git's own state: any path component (as given or resolved
 * through symlinks / 8.3 short names) is `.git` (`hasGitComponent`: case-insensitive; on Windows also
 * `.git.`, `.git::$INDEX_ALLOCATION`, `GIT~1`) — this also covers a linked worktree's `.git` file — or
 * the resolved path is inside one of `gitDirs` (`rev-parse --git-dir` / `--git-common-dir`, which for a
 * linked worktree live outside it). A hook or config written there would run the next time the app
 * runs git, without ever passing the review; so edit tools are always denied there.
 */
export function isGitInternalPath(file: string, gitDirs: readonly string[]): boolean {
  const real = realpathLenient(file);
  if (hasGitComponent(file) || hasGitComponent(resolve(file)) || hasGitComponent(real)) return true;
  // allowUnsafe: `gd::$INDEX_ALLOCATION\hooks\x` or `gd\config:s` are still the git dir.
  return gitDirs.some((d) => isInsidePath(real, realpathLenient(d), HOST_FLAVOR, { allowUnsafe: true }) || isInsidePath(resolve(file), realpathLenient(d), HOST_FLAVOR, { allowUnsafe: true }));
}

/** Resolved `--git-dir` and `--git-common-dir` of the containment root's repository (cached; empty outside a repo). */
export async function gitInternalDirs(ctx: HookContext): Promise<string[]> {
  if (ctx.gitDirs) return ctx.gitDirs;
  const root = await containmentRoot(ctx);
  try {
    const dirs = await Promise.all([gitDir(root), commonDir(root)]);
    ctx.gitDirs = [...new Set(dirs.map((d) => realpathLenient(d)))];
  } catch {
    ctx.gitDirs = [];
  }
  return ctx.gitDirs;
}

/** True when `file` is in git's state of the session's repository (`isGitInternalPath`). */
export async function isGitInternalEdit(file: string, ctx: HookContext): Promise<boolean> {
  return isGitInternalPath(file, await gitInternalDirs(ctx));
}

/**
 * True when `file` (resolved through symlinks) is not `root` or inside it — also for a path Windows
 * would not map to a plain reviewable file (alternate data stream, device name; `isInside`).
 */
export function isOutsideRoot(file: string, root: string): boolean {
  return !isInside(file, root);
}

/**
 * Whether the PreToolUse hook must return `permissionDecision: "ask"` for `toolName`.
 * A hook `ask` runs before the CLI's permission rules, so user/project `permissions.allow` entries
 * (e.g. `Bash(ln:*)`) can no longer bypass the app's permission card. Edit tools are handled by the
 * budget hook + canUseTool, read-only tools and `autoAllowTools` never prompt.
 */
export function needsAsk(toolName: string, autoAllowTools: ReadonlySet<string>): boolean {
  if (EDIT_TOOLS_RE.test(toolName)) return false;
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  if (autoAllowTools.has(toolName)) return false;
  return true;
}

/**
 * Also matches option groups before the verb: `git -C x commit`, `git -c k=v reset`, `git --no-pager merge`. The verb ends
 * at a non-word, non-dash character, so the read-only `merge-tree` / `merge-base` / `cherry` are not it; nor are
 * `stash list` / `stash show`. `"git"` quoted, option values quoted with spaces (`-C "My Repo"`, `-c user.name="A B"`), `bisect` and
 * `gh pr checkout|merge` count too (ref writes keep their own card, §40.1). An option's separate value never starts with `-`: else `-a -b -c …` splits
 * into options and values in 2^n ways when no verb follows (30 options took 60 ms, each one more doubled it).
 */
export const GIT_MUTATING_RE =
  /\bgit["']?(?:\s+-{1,2}[\w-]+(?:=(?:[^\s"']|"[^"]*"|'[^']*')+|\s+(?:[^\s"'-]|"[^"]*"|'[^']*')(?:[^\s"']|"[^"]*"|'[^']*')*)?)*\s+(commit|checkout|switch|reset|restore|stash(?!\s+(?:list|show)(?![\w-]))|clean|rebase|merge|apply|am|pull|cherry-pick|revert|bisect)(?![\w-])|\bgh\s+pr\s+(?:checkout|merge)(?![\w-])/;
export const GIT_ASK_REASON = "ReviewGate: a git command that changes the repository — needs the user's approval";

/**
 * §46: the card reason of a Bash command that changes the repository (`GIT_MUTATING_RE`: a commit, merge, pull, checkout, …),
 * null for anything else. Such a command always gets the card — in every permission mode, whatever a pattern, a remembered
 * key or the user's rules say — and the files it changes are not Claude's edits (postBash).
 */
export function gitCommandReason(toolName: string, input: Record<string, unknown>): PermissionReason | null {
  if (toolName !== "Bash") return null;
  const command = typeof input.command === "string" ? input.command : "";
  return GIT_MUTATING_RE.test(command) ? { code: "git_command", message: SCOPE_MESSAGES.git_command } : null;
}

const SHELL_MUTATING_RE =
  /(>|>>|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\bchmod\b|\bnpm\s+(i|install)\b|\bnpx\b|\bpip\s+install)/;

export function reviewGateReason(files: number, maxFiles: number, lines: number, maxLines: number): string {
  // §54: a count without a limit (0) shows no "/0".
  const count = (n: number, max: number): string => (max > 0 ? `${n}/${max}` : `${n}`);
  return (
    `REVIEW GATE: per-turn change budget exceeded (files ${count(files, maxFiles)}, lines ${count(lines, maxLines)}). ` +
    "Do NOT make further edits, do NOT work around this with shell commands. " +
    "Stop now and reply with a short report: (1) what you changed, (2) what remains, (3) exact next step."
  );
}

/** Mutable context shared between claude.ts and the hook callbacks. */
export type HookContext = {
  budget: BudgetState;
  cwd: string;
  /** Containment root for edit tools (the checkpoint root); resolved lazily from cwd when unset. */
  root?: string;
  /** git tree SHA at the turn's own start (§34.1; A only for a fresh turn): the budget's numstat base (§54), Bash attribution's fallback */
  checkpointTree?: string;
  /** Settings.ignorePatterns — paths skipped by the post-Bash numstat */
  ignorePatterns: string[];
  /** Live permission mode of the session (docs/M20-MODES.md); plan mode and (§39.5) auto mode change hook behavior. */
  permissionMode?: PermissionMode;
  // MARK: wave6 w6-terminal — §44.1
  /** While `permissionMode` is `plan`: the mode before it (`auto`: non-mutating calls stay the CLI's to judge, autoMode.ts). */
  prePlanMode?: PermissionMode;
  /** A main-thread hook input's `permission_mode` (the CLI's live mode): ClaudeSession follows the CLI into plan mode. */
  onCliMode?: (mode: unknown) => void;
  /** Override of the home folder for `isClaudeMemoryFile` (test seam). */
  claudeHome?: string;
  /** Temporary folders whose files outside any repository are throwaway (`isScratchPath`); none: every outside edit asks. */
  scratchDirs?: readonly string[];
  /** Override of `plansDir()` (test seam). */
  plansDir?: string;
  /** Absolute plan files written this turn, in order; reset per turn by ClaudeSession. */
  planFiles?: Set<string>;
  /** Settings.autoAllowTools — never forced to `ask` */
  autoAllowTools: ReadonlySet<string>;
  /** Settings.autoAllowReadOnlyBash (default true): read-only Bash commands are allowed without a prompt (docs/M16-FRICTION.md). */
  autoAllowReadOnlyBash?: boolean;
  /** Settings.bashAllowPatterns (`Bash(npm test:*)`, `Bash(git *)`), evaluated before `ask`. */
  bashAllowPatterns?: readonly string[];
  /** Keys stored by `permission_response { remember: true }` (bashClass.ts rememberKey); shared with the engine. */
  rememberedAllows?: ReadonlySet<string>;
  /** §33.5: the user's Claude Code allow / deny+ask rules, applied to tools that cannot change files. */
  userRules?: UserRules;
  /** §33.5: MCP tool annotations (readOnly / destructive) from `mcpServerStatus()`, by CLI tool name. */
  mcpToolHints?: McpToolHints;
  /** Checkpoint of the repository containing cwd, opened lazily (numstat paths are repo-relative). */
  checkpoint?: GitCheckpoint;
  /** Resolved git dir + common dir of the containment root's repository, cached by `gitInternalDirs`. */
  gitDirs?: string[];
  /** Tree of the previous post-Bash snapshot this turn (the next one diffs against it); reset per turn. */
  bashBaseTree?: string;
  /**
   * Files (absolute) a Bash call changed: the diff between the previous post-Bash snapshot and this one, narrowed
   * to what changed inside the call's execution window (§31) when the window is known.
   */
  onBashFiles?: (toolUseId: string, files: string[]) => void;
  /** §34.6 (wave2 engine-why): every post-Bash snapshot's tree and the repository root it is of (the engine's live tree). */
  onBashSnapshot?: (toolUseId: string, tree: string, root: string) => void;
  /** Execution windows of the turn's Bash and MCP calls by tool_use id (§31); reset per turn by ClaudeSession. */
  toolWindows?: Map<string, ToolWindow>;
  /** Test seams: the clock of the windows (epoch ms) and the slack before a window's start (`WINDOW_MARGIN_MS`). */
  now?: () => number;
  windowMarginMs?: number;
  /**
   * False while no turn the engine started is running (between turn_end and the next send): a turn the
   * CLI runs on its own (e.g. after a background task finished) must not change anything, since nothing
   * collects it into the review. Undefined counts as running (test contexts). docs/PROTOCOL.md §18.
   */
  turnActive?: boolean;
  /**
   * §52: set while the engine takes a turn the CLI started itself (snapshot A first): every call waits for it, then the
   * guard decides with `turnActive` as the engine left it.
   */
  adoption?: Promise<void>;
  /** §52: background work is on — Agent / Task calls get `run_in_background: false` so they finish inside the turn. */
  keepAgentsInTurn?: boolean;
  /** A tool call was blocked by the unprompted-turn guard (`unpromptedBlocked`). */
  onUnprompted?: (toolName: string) => void;
  /** Set when the budget hook interrupted the turn; claude.ts reports `stopReason: "interrupted"`. */
  interrupted: boolean;
  /** Settings.allowWorktreeIsolation (§33.4): Workflow / isolated agents get a card instead of a deny. */
  allowWorktreeIsolation?: boolean;
  /**
   * §33.3–33.4: why the hooks put a call on a card although it would otherwise run (it works outside the review), by
   * tool_use id — `canUseTool` puts it on the `permission_request`, the post-tool hook raises the notice. Reset per turn.
   */
  scopeReasons?: Map<string, PermissionReason>;
  /** The repository's other worktrees (absolute; `git worktree list` minus the root), cached per turn by `otherWorktrees`. */
  worktrees?: string[];
  /** §33.4: work outside this window's review was blocked / happened (EnterWorktree, isolated agents, worktree commands). */
  onScopeNotice?: (notice: ScopeNotice) => void;
  query?: Query;
  emit: (msg: SessionEvent) => void;
  log: SessionLog;
};

function allow(): HookJSONOutput {
  return {};
}

const SUBAGENT_TOOLS_RE = /^(Agent|Task)$/;

/** §52: the same decision, with the call's input replaced (no decision: the CLI's own permission flow, with this input). */
function withUpdatedInput(out: HookJSONOutput, updatedInput: Record<string, unknown>): HookJSONOutput {
  const spec = (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
  return { ...out, hookSpecificOutput: { ...(spec ?? {}), hookEventName: "PreToolUse", updatedInput } } as HookJSONOutput;
}

function denyPre(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function askPre(reason = ASK_REASON): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  };
}

function allowPre(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Why `toolName`/`input` is allowed without a prompt (docs/M16-FRICTION.md §1–2), or undefined when it
 * must ask: a read-only Bash command (`autoAllowReadOnlyBash !== false`), a `bashAllowPatterns` match
 * (for other tools its MCP / WebFetch / WebSearch / Agent forms, §33.6), a key the user remembered for this
 * session, or the user's own Claude Code allow rule for a tool that cannot change files (§33.5). Consulted by
 * the PreToolUse hooks and by canUseTool.
 */
export function autoAllowReason(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Pick<HookContext, "autoAllowReadOnlyBash" | "bashAllowPatterns" | "rememberedAllows" | "userRules" | "mcpToolHints">,
): string | undefined {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (ctx.autoAllowReadOnlyBash !== false && isReadOnlyCommand(command)) return READ_ONLY_BASH_REASON;
    if ((ctx.bashAllowPatterns ?? []).some((p) => matchesAllowPattern(p, command))) return ALLOW_PATTERN_REASON;
  } else if ((ctx.bashAllowPatterns ?? []).some((p) => matchesToolPattern(p, toolName, input))) {
    return ALLOW_PATTERN_REASON;
  }
  if (rememberable(toolName) && isRemembered(toolName, input, ctx.rememberedAllows)) return REMEMBERED_REASON;
  if (userRuleAllows(toolName, input, ctx.userRules, ctx.mcpToolHints)) return USER_RULE_REASON;
  return undefined;
}

/**
 * True when `toolName` must be denied because no engine-started turn is running (`ctx.turnActive === false`):
 * everything except the read-only tools and a read-only Bash command that is auto-allowed anyway.
 */
export function unpromptedBlocked(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Pick<HookContext, "turnActive" | "autoAllowReadOnlyBash">,
): boolean {
  if (ctx.turnActive !== false) return false;
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return !(ctx.autoAllowReadOnlyBash !== false && isReadOnlyCommand(command));
  }
  return true;
}

/**
 * The deny reason for `toolName` in plan mode (docs/PROTOCOL.md §19.4), undefined when it may proceed: edit tools are
 * denied except a write to the CLI's plan file (`isPlanFile`), Bash is denied unless the command is read-only
 * (`isReadOnlyCommand`; whether it then still prompts follows `autoAllowReadOnlyBash`). Other tools are unaffected.
 */
export function planModeBlocked(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Pick<HookContext, "permissionMode" | "plansDir" | "cwd">,
): string | undefined {
  if (ctx.permissionMode !== "plan") return undefined;
  if (EDIT_TOOLS_RE.test(toolName)) {
    const file = toolFile(input, ctx.cwd);
    return file && isPlanFile(file, ctx) ? undefined : PLAN_MODE_EDIT_REASON;
  }
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return isReadOnlyCommand(command) ? undefined : PLAN_MODE_BASH_REASON;
  }
  return undefined;
}

/** Denies (and reports) a call made outside an engine-started turn; undefined when the guard does not apply. */
async function guardUnprompted(toolName: string, input: Record<string, unknown>, ctx: HookContext): Promise<HookJSONOutput | undefined> {
  // §52: a turn Claude started itself is being taken as a review turn — nothing runs before its snapshot A.
  if (ctx.adoption) await ctx.adoption;
  if (!unpromptedBlocked(toolName, input, ctx)) return undefined;
  ctx.onUnprompted?.(toolName);
  return denyPre(UNPROMPTED_REASON);
}

/** The containment root: the git toplevel of cwd (cached), or cwd itself outside a repository. */
export async function containmentRoot(ctx: HookContext): Promise<string> {
  if (ctx.root) return ctx.root;
  try {
    if (!ctx.checkpoint) ctx.checkpoint = await openCheckpoint(ctx.cwd);
    ctx.root = ctx.checkpoint.root;
  } catch {
    ctx.root = ctx.cwd;
  }
  return ctx.root;
}

/** The repository's worktrees other than the containment root (absolute), cached until the next turn; empty outside a repository. */
export async function otherWorktrees(ctx: HookContext): Promise<string[]> {
  if (ctx.worktrees) return ctx.worktrees;
  const root = await containmentRoot(ctx);
  try {
    const list = await listWorktrees(root);
    ctx.worktrees = list.filter((w) => !w.bare && !samePath(realpathLenient(w.path), realpathLenient(root))).map((w) => w.path);
  } catch {
    ctx.worktrees = [];
  }
  return ctx.worktrees;
}

/** Notes why a call goes on a card (§33.3–33.4) for `canUseTool` and the post-tool notice. */
function rememberScope(ctx: HookContext, toolUseId: string | undefined, reason: PermissionReason): void {
  if (!toolUseId) return;
  if (!ctx.scopeReasons) ctx.scopeReasons = new Map();
  ctx.scopeReasons.set(toolUseId, reason);
}

/** Where the call runs: the CLI's current directory from the hook input (the shell's, after a `cd`), else the session's. */
function hookCwd(input: HookInput, ctx: HookContext): string {
  const cwd = (input as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd ? cwd : ctx.cwd;
}

function toolUseIdOf(input: HookInput): string | undefined {
  const id = (input as { tool_use_id?: unknown }).tool_use_id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * §33.4: EnterWorktree is denied; the Workflow tool and agents that run outside this folder (`isolation`, a `cwd`
 * elsewhere) are denied unless `allowWorktreeIsolation`, then they get a card with the reason. Undefined for anything else.
 */
async function guardWorktreeTools(toolName: string, toolUseId: string | undefined, ti: Record<string, unknown>, ctx: HookContext): Promise<HookJSONOutput | undefined> {
  if (toolName !== "EnterWorktree" && toolName !== "Workflow" && !/^(Agent|Task)$/.test(toolName)) return undefined;
  const root = await containmentRoot(ctx);
  const deny = worktreeToolBlocked(toolName, ti, root, ctx.allowWorktreeIsolation === true);
  if (deny) {
    const name = typeof ti.name === "string" && ti.name ? ti.name : undefined;
    const path = typeof ti.path === "string" && ti.path ? resolve(root, ti.path) : undefined;
    ctx.onScopeNotice?.({ code: "worktree_blocked", toolName, ...(toolUseId ? { toolUseId } : {}), ...(path ? { path } : {}), ...(toolName === "EnterWorktree" && name ? { branch: name } : {}) });
    return denyPre(deny);
  }
  if (!isolatedCall(toolName, ti, root)) return undefined;
  rememberScope(ctx, toolUseId, { code: "worktree_isolation", message: SCOPE_MESSAGES.worktree_isolation });
  return askPre(SCOPE_ASK_REASON);
}

/**
 * After a call the hooks put on a card for working outside the review ran (it was approved): the warning stays (§33.4).
 * A changed settings file (§33.9) is no such place — the review lists it (mods group) or `local_settings_changed` reports it.
 */
function noticeAfterTool(toolName: string, input: HookInput, ctx: HookContext): void {
  const toolUseId = toolUseIdOf(input);
  const reason = toolUseId ? ctx.scopeReasons?.get(toolUseId) : undefined;
  if (!toolUseId || !reason || reason.code === "outside_project") return;
  ctx.scopeReasons!.delete(toolUseId);
  if (reason.code === "claude_config" || reason.code === "git_command") return;
  const result = reason.code === "worktree_isolation" ? isolatedResult((input as { tool_response?: unknown }).tool_response) : {};
  const path = result.path ?? reason.path;
  ctx.onScopeNotice?.({ code: "worktree_outside_review", toolName, toolUseId, ...(path ? { path } : {}), ...(result.branch ? { branch: result.branch } : {}), reasonCode: reason.code });
}

/**
 * §33.9: why a Bash command or a writing MCP call goes on the card whatever a pattern, a remembered key, `autoAllowTools`
 * or the user's rules say — it names one of Claude Code's own settings files (`.claude/settings.json`,
 * `.claude/settings.local.json`, `.mcp.json`). Null for anything else: a read-only command (it cannot change the file), an
 * MCP tool that only reads, any other tool (edit tools are decided on their target: `claudeConfigFile` / `editScopeReason`).
 * `cwd` is where a command runs (the shell's directory), `root` the project relative paths of an MCP call belong to.
 */
export function configScopeReason(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  root: string,
  ctx: Pick<HookContext, "mcpToolHints">,
): PermissionReason | null {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (isReadOnlyCommand(command)) return null;
    const target = bashClaudeConfigTarget(command, cwd, root);
    return target ? claudeConfigReason(target, root) : null;
  }
  if (isMcpTool(toolName) && !isReadMcpTool(toolName, ctx.mcpToolHints)) {
    const target = inputClaudeConfigTarget(input, root);
    return target ? claudeConfigReason(target, root) : null;
  }
  return null;
}

/**
 * Deny decisions are returned before this is consulted, so deny always wins over ask. `cliMode` is the hook input's
 * `permission_mode`: in auto mode (§39.5) a call no app rule allows is left to the CLI's rules and classifier instead of
 * the card — the reason cards (§33.3–33.4, §33.9) were decided before this, too.
 */
function askOrAllow(toolName: string, input: Record<string, unknown>, ctx: HookContext, cliMode?: unknown): HookJSONOutput {
  if (!needsAsk(toolName, ctx.autoAllowTools)) return allow();
  const reason = autoAllowReason(toolName, input, ctx);
  if (reason) return allowPre(reason);
  // MARK: wave4b w4b-auto (§39.5); input: w4b-check4 (§40.1); prePlanMode / hints: wave6 w6-terminal (§44.1)
  if (autoModeDecides(toolName, ctx.permissionMode, cliMode, input, ctx.prePlanMode, ctx.mcpToolHints)) return allow();
  return askPre();
}

/**
 * MARK: wave6 w6-terminal — §44.1: every PreToolUse of the main thread says the CLI's live mode first (Claude may have
 * entered plan mode a moment ago — the plan rules apply from this call on). A subagent's `permission_mode` is its own.
 */
function noteCliMode(input: HookInput, ctx: HookContext): void {
  if (!ctx.onCliMode || (input as { agent_id?: unknown }).agent_id !== undefined) return;
  const mode = hookPermissionMode(input);
  if (mode !== undefined) ctx.onCliMode(mode);
}

function toolInput(input: HookInput): Record<string, unknown> {
  const ti = (input as { tool_input?: unknown }).tool_input;
  return ti && typeof ti === "object" ? (ti as Record<string, unknown>) : {};
}

function toolFile(input: Record<string, unknown>, cwd: string): string | undefined {
  const p = input.file_path ?? input.notebook_path;
  return typeof p === "string" && p.length > 0 ? resolveToolPath(p, cwd) : undefined;
}

async function countAfterDeny(ctx: HookContext): Promise<void> {
  const b = ctx.budget;
  if (!b.denied || !b.active) return;
  b.callsAfterDeny++;
  if (b.callsAfterDeny > MAX_CALLS_AFTER_DENY && ctx.query && !ctx.interrupted) {
    ctx.log("warn", `budget: ${b.callsAfterDeny} tool calls after deny; interrupting`);
    ctx.interrupted = true;
    // Fire-and-forget: awaiting interrupt() inside a PreToolUse hook deadlocks (the CLI waits for
    // the hook result before it can service the interrupt request).
    void ctx.query.interrupt().catch((e) => ctx.log("warn", `interrupt failed: ${String(e)}`));
  }
}

/** Numstat of a post-Bash snapshot `tree` vs `checkpointTree`: per file (absolute) and lines. */
async function treeNumstat(
  cp: GitCheckpoint,
  checkpointTree: string,
  tree: string,
  ignorePatterns: string[],
): Promise<{ file: string; lines: number }[]> {
  const entries: { file: string; lines: number }[] = [];
  for (const f of await cp.changes(checkpointTree, tree)) {
    if (matchesIgnore(f.path, ignorePatterns) && !isModsPath(f.path)) continue;
    entries.push({ file: resolveToolPath(f.path, cp.root), lines: f.added + f.deleted });
  }
  return entries;
}

/** Starts the execution window of a Bash / MCP call (§31); finished by `finishWindow` in PostToolUse(Failure). */
function openWindow(ctx: HookContext, input: HookInput, command?: string): void {
  const id = (input as { tool_use_id?: unknown }).tool_use_id;
  const name = (input as { tool_name?: unknown }).tool_name;
  if (!ctx.toolWindows || typeof id !== "string" || typeof name !== "string") return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : undefined;
  ctx.toolWindows.set(id, { toolUseId: id, name, start: ctx.now?.() ?? Date.now(), end: null, ...(cwd ? { cwd } : {}), ...(command !== undefined ? { command } : {}) });
}

/**
 * Ends the call's window. `duration_ms` (tool execution only, CLI 2.1.308) moves the start up to when the tool
 * really ran, so the time a permission card stayed open is not part of it.
 */
function finishWindow(ctx: HookContext, input: HookInput): ToolWindow | undefined {
  const id = (input as { tool_use_id?: unknown }).tool_use_id;
  const w = typeof id === "string" ? ctx.toolWindows?.get(id) : undefined;
  if (!w) return undefined;
  w.end = ctx.now?.() ?? Date.now();
  if (typeof input.cwd === "string" && input.cwd && input.cwd !== w.cwd) w.cwdAfter = input.cwd;
  const duration = (input as { duration_ms?: unknown }).duration_ms;
  if (typeof duration === "number" && duration >= 0) w.start = Math.min(w.end, Math.max(w.start, w.end - duration));
  return w;
}

/** Files (absolute, ignorePatterns skipped) that differ between two snapshot trees. */
async function changedBetween(cp: GitCheckpoint, a: string, b: string, ignorePatterns: string[]): Promise<string[]> {
  if (a === b) return [];
  const files: string[] = [];
  for (const f of await cp.changes(a, b)) {
    // Mods paths (§32) are never noise: a Bash call that rewrote a hook is that call's change.
    if (!matchesIgnore(f.path, ignorePatterns) || isModsPath(f.path)) files.push(resolveToolPath(f.path, cp.root));
  }
  return files;
}

/**
 * Before the turn's first Bash call: the tree its post-Bash snapshot is diffed against, so Bash file
 * attribution never picks up what earlier turns left on disk (a request-changes turn keeps the old A).
 */
async function bashBaseline(ctx: HookContext): Promise<void> {
  if (!ctx.onBashFiles || !ctx.checkpointTree || ctx.bashBaseTree !== undefined) return;
  try {
    if (!ctx.checkpoint) ctx.checkpoint = await openCheckpoint(ctx.cwd);
    ctx.bashBaseTree = await ctx.checkpoint.snapshot();
  } catch (e) {
    ctx.log("debug", `snapshot before Bash failed: ${String(e)}`);
  }
}

export function buildHooks(ctx: HookContext): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const preEdit: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return allow();
    noteCliMode(input, ctx); // MARK: wave6 w6-terminal (§44.1)
    const b = ctx.budget;
    const ti = toolInput(input);
    const unprompted = await guardUnprompted(input.tool_name, ti, ctx);
    if (unprompted) return unprompted;
    const file = toolFile(ti, ctx.cwd);
    // Never into git's own state (hooks, config, refs): checked before anything can allow it.
    if (file && (await isGitInternalEdit(file, ctx))) return denyPre(GIT_INTERNAL_REASON);
    if (file && isPlanFile(file, ctx)) {
      ctx.planFiles?.add(file);
      return allowPre(PLAN_FILE_REASON);
    }
    const planDeny = planModeBlocked(input.tool_name, ti, ctx);
    if (planDeny) return denyPre(planDeny);
    // A throwaway file in a temporary folder (Claude Code's scratchpad, /tmp) outside any repository: not the user's code,
    // so neither the budget nor the outside-the-project card.
    if (file && ctx.scratchDirs && isOutsideRoot(file, await containmentRoot(ctx)) && isScratchPath(file, ctx.scratchDirs)) return allow();
    // Claude's own memory (~/.claude/projects/<project>/memory) is not in the review: the budget neither counts nor blocks
    // it (a turn over budget can still note what it learned); it keeps the outside-the-project card.
    if (file && isClaudeMemoryFile(file, ctx.claudeHome)) return askPre(OUTSIDE_REASON);
    // §54: the change budget is opt-in — without one (the default) an edit is neither counted nor denied.
    if (b.active) {
      const est = estimateEditLines(input.tool_name, ti, ctx.cwd);

      const projectedFiles = new Set(b.files);
      if (file) projectedFiles.add(file);
      const projectedLines = b.lines + est;

      if (b.denied || b.wouldExceedHard(projectedFiles.size, projectedLines)) {
        b.denied = true;
        await countAfterDeny(ctx);
        ctx.emit({
          type: "budget_event",
          kind: "deny",
          toolName: input.tool_name,
          file,
          files: projectedFiles.size,
          lines: projectedLines,
          budget: b.budget,
        });
        return denyPre(
          reviewGateReason(projectedFiles.size, b.budget.maxFiles, projectedLines, b.budget.maxLines),
        );
      }

      if (file) b.files.add(file);
      b.lines = projectedLines;

      if (!b.warned && b.exceedsSoft()) {
        b.warned = true;
        ctx.emit({
          type: "budget_event",
          kind: "warn",
          toolName: input.tool_name,
          file,
          files: b.files.size,
          lines: b.lines,
          budget: b.budget,
        });
      }
    }
    // Path containment: an edit outside the checkpoint root (or through a symlink escaping it) is
    // never auto-allowed; `ask` reaches canUseTool, which puts it on the permission card.
    if (file && isOutsideRoot(file, await containmentRoot(ctx))) return askPre(OUTSIDE_REASON);
    // §33.3: inside the root but in a nested repository (submodule, worktree, clone) the snapshot only sees a gitlink.
    if (file && nestedRepoRoot(file, await containmentRoot(ctx))) return askPre(NESTED_REASON);
    // §33.9: Claude Code's own settings (hooks, permission rules, MCP servers) never change without the card — in every
    // permission mode: this `ask` reaches canUseTool in acceptEdits / auto too (CLI 2.1.308).
    if (file && claudeConfigFile(file)) return askPre(CLAUDE_CONFIG_ASK_REASON);
    return allow();
  };

  const preBash: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return allow();
    noteCliMode(input, ctx); // MARK: wave6 w6-terminal (§44.1)
    const b = ctx.budget;
    const ti = toolInput(input);
    const unprompted = await guardUnprompted(input.tool_name, ti, ctx);
    if (unprompted) return unprompted;
    const command = String(ti.command ?? "");
    await countAfterDeny(ctx);
    const planDeny = planModeBlocked(input.tool_name, ti, ctx);
    if (planDeny) return denyPre(planDeny);
    if (b.active && b.denied && SHELL_MUTATING_RE.test(command)) {
      return denyPre(reviewGateReason(b.files.size, b.budget.maxFiles, b.lines, b.budget.maxLines));
    }
    await bashBaseline(ctx);
    // §31: the window opens before any card — `duration_ms` at its end leaves the wait for the user out.
    openWindow(ctx, input, command);
    // §33.4: a command that creates a worktree, or runs in / `cd`s into another worktree or a nested repository, reaches
    // the card with the reason — never an allow pattern or a remembered key (a read-only one still runs).
    const root = await containmentRoot(ctx);
    const cwd = hookCwd(input, ctx);
    let scope = bashScopeReason(command, cwd, root, await otherWorktrees(ctx));
    // §39.4: a worktree of another repository (the command `cd`s / `-C`s there) — no chat of this window can follow it.
    if (scope?.code === "worktree_command") {
      const repoDir = worktreeAddRepoDir(command, cwd);
      if (repoDir && (await sameRepository(repoDir, root)) === false) scope = { ...scope, otherRepository: true, message: OTHER_REPO_WORKTREE_MESSAGE };
    }
    if (scope && !(ctx.autoAllowReadOnlyBash !== false && isReadOnlyCommand(command))) {
      rememberScope(ctx, toolUseIdOf(input), scope);
      return askPre(SCOPE_ASK_REASON);
    }
    // §33.9: so does a command naming one of Claude Code's own settings files (reading one still runs).
    const config = configScopeReason(input.tool_name, ti, cwd, root, ctx);
    if (config) {
      rememberScope(ctx, toolUseIdOf(input), config);
      return askPre(CLAUDE_CONFIG_ASK_REASON);
    }
    // §46: and so does a git command that changes the repository (a merge, a commit, …) — Claude runs it when asked, the
    // user approves each one; this `ask` reaches canUseTool in acceptEdits / auto too.
    const git = gitCommandReason(input.tool_name, ti);
    if (git) {
      rememberScope(ctx, toolUseIdOf(input), git);
      return askPre(GIT_ASK_REASON);
    }
    return askOrAllow(input.tool_name, ti, ctx, hookPermissionMode(input));
  };

  /** Counts any other tool call after a deny (edit/bash hooks count themselves) and forces `ask` (needsAsk). */
  const preOther: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return allow();
    if (/^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/.test(input.tool_name)) return allow();
    noteCliMode(input, ctx); // MARK: wave6 w6-terminal (§44.1)
    const ti = toolInput(input);
    const unprompted = await guardUnprompted(input.tool_name, ti, ctx);
    if (unprompted) return unprompted;
    await countAfterDeny(ctx);
    const worktree = await guardWorktreeTools(input.tool_name, toolUseIdOf(input), ti, ctx);
    if (worktree) return worktree;
    // An MCP tool may write files (an IDE's MCP server, a filesystem server): its window attributes them (§31).
    // §52: with background work on, a subagent still finishes inside the turn that started it (its edits are that turn's
    // review): the CLI backgrounds an Agent call unless its input says `run_in_background: false` (2.1.318).
    if (ctx.keepAgentsInTurn && SUBAGENT_TOOLS_RE.test(input.tool_name) && ti.run_in_background !== false) {
      return withUpdatedInput(askOrAllow(input.tool_name, ti, ctx, hookPermissionMode(input)), { ...ti, run_in_background: false });
    }
    if (isMcpTool(input.tool_name)) {
      openWindow(ctx, input);
      // §33.9: a writing MCP call that names one of Claude Code's own settings files reaches the card with the reason.
      const config = configScopeReason(input.tool_name, ti, hookCwd(input, ctx), await containmentRoot(ctx), ctx);
      if (config) {
        rememberScope(ctx, toolUseIdOf(input), config);
        return askPre(CLAUDE_CONFIG_ASK_REASON);
      }
    }
    return askOrAllow(input.tool_name, ti, ctx, hookPermissionMode(input));
  };

  /** PostToolUse / PostToolUseFailure of an MCP call: only closes its window (no snapshot per call). */
  const postWriter: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") finishWindow(ctx, input);
    return allow();
  };

  /** §33.4: an approved Agent / Task / Workflow that ran outside this folder keeps its warning. */
  const postIsolated: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") noticeAfterTool(input.tool_name, input, ctx);
    return allow();
  };

  const postEdit: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return allow();
    const b = ctx.budget;
    if (!b.active || !b.exceedsSoft()) return allow();
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `Budget note: ${b.lines}/${b.budget.maxLines} lines, ${b.files.size}/${b.budget.maxFiles} files used this turn. ` +
          "Finish only the current unit, then stop and report.",
      },
    };
  };

  /**
   * After a Bash call — PostToolUse, or PostToolUseFailure for a command that exited non-zero (CLI 2.1.308) — the
   * worktree is snapshotted: the files changed since the previous snapshot that also changed inside this call's
   * execution window are the call's (§31); a change made between calls (the IDE, another session, `git pull`) is
   * nobody's and stays out of the budget, which counts the turn's edit-tool and Bash files only.
   */
  const postBash: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return allow();
    const window = finishWindow(ctx, input);
    // §33.4: an approved command outside the review ran (a failing one too: it may have written before it failed).
    noticeAfterTool(input.tool_name, input, ctx);
    // A worktree may have been added / moved / removed: list them again for the next call (§33.4).
    if (/\bworktree\b/.test(String(toolInput(input).command ?? ""))) ctx.worktrees = undefined;
    if (!ctx.checkpointTree) return allow();
    const b = ctx.budget;
    try {
      if (!ctx.checkpoint) ctx.checkpoint = await openCheckpoint(ctx.cwd);
      const cp = ctx.checkpoint;
      const tree = await cp.snapshot();
      const base = ctx.bashBaseTree ?? ctx.checkpointTree;
      ctx.bashBaseTree = tree;
      // §46: what a git command changed (a merge brings in another branch's files) is not Claude's: no budget, no attribution.
      const git = GIT_MUTATING_RE.test(String(toolInput(input).command ?? ""));
      const changed = git ? [] : await changedBetween(cp, base, tree, ctx.ignorePatterns);
      const attributed = window ? await changedWithin(changed, window, cp.root, ctx.windowMarginMs ?? WINDOW_MARGIN_MS) : changed;
      if (attributed.length > 0) ctx.onBashFiles?.(input.tool_use_id, attributed);
      ctx.onBashSnapshot?.(input.tool_use_id, tree, cp.root);
      // §54: without a budget (the default) nothing is counted — and the turn's numstat is not even taken.
      if (b.active) {
        for (const f of attributed) b.files.add(f);
        // numstat is cumulative for the whole turn; take the larger of the two measures so edits already
        // counted by the pre-edit estimate are not double-counted. Only Claude's files count (§31).
        const entries = await treeNumstat(cp, ctx.checkpointTree, tree, ctx.ignorePatterns);
        const mine = new Set([...b.files].map((f) => normalizeForCompare(f)));
        const lines = entries.reduce((n, e) => (mine.has(normalizeForCompare(e.file)) ? n + e.lines : n), 0);
        if (lines > b.lines) b.lines = lines;
        if (!b.warned && b.exceedsSoft()) {
          b.warned = true;
          ctx.emit({
            type: "budget_event",
            kind: "warn",
            toolName: "Bash",
            files: b.files.size,
            lines: b.lines,
            budget: b.budget,
          });
        }
      }
    } catch (e) {
      ctx.log("debug", `snapshot after Bash failed: ${String(e)}`);
    }
    return allow();
  };

  return {
    PreToolUse: [
      { matcher: EDIT_TOOLS_MATCHER, hooks: [preEdit] },
      { matcher: "Bash", hooks: [preBash] },
      { hooks: [preOther] },
    ],
    PostToolUse: [
      { matcher: EDIT_TOOLS_MATCHER, hooks: [postEdit] },
      { matcher: "Bash", hooks: [postBash] },
      { matcher: MCP_TOOLS_MATCHER, hooks: [postWriter] },
      { matcher: "Agent|Task|Workflow", hooks: [postIsolated] },
    ],
    PostToolUseFailure: [
      { matcher: "Bash", hooks: [postBash] },
      { matcher: MCP_TOOLS_MATCHER, hooks: [postWriter] },
    ],
  };
}
