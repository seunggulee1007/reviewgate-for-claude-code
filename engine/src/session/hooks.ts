import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PermissionMode, PermissionReason } from "../protocol.js";
import { openCheckpoint, type GitCheckpoint } from "../git/checkpoint.js";
import { matchesIgnore } from "../git/ignore.js";
import { isModsPath } from "../git/mods.js";
import { commonDir, gitDir, listWorktrees, sameRepository, type GitWorktree } from "../git/worktrees.js";
import { HOST_FLAVOR, hasGitComponent, isInside, isInsidePath, normalizeForCompare, realpathLenient, relativeInside, samePath, toRepoRelative } from "../platform/paths.js";
import { isReadOnlyCommand, isRemembered, matchesAllowPatterns, type ReadOnlyContext } from "./bashClass.js";
import { BudgetState, estimateEditLines, resolveToolPath } from "./budget.js";
import type { GitCommandResult, SessionEvent, SessionLog } from "./events.js";
import { isReadMcpTool, matchesToolPattern, rememberable, userBashRuleAllows, userRuleAllows, type McpToolHints, type UserRules } from "./permissionRules.js";
import { changedWithin, isMcpTool, WINDOW_MARGIN_MS, type ToolWindow } from "./provenance.js";
import { skillCallName } from "./skillTools.js"; // MARK: r2-skills-side (§33.5, M20)
import { autoModeDecides, hookPermissionMode, inAutoMode } from "./autoMode.js"; // MARK: wave4b w4b-auto (§39.5)
import { remembersSessions, sendMessageKey, type SendTarget } from "./peerSend.js"; // MARK: r2-peers (§33.2)
import { changedPaths, dirState, type DirState } from "./outsideWatch.js";
import { clearlyWrites } from "./shellWrites.js";
import { settingsEditRisk } from "./settingsDiff.js";
import { destructiveGitReason, dirtyPaths, entriesSince, gitCommandCardReason, headReflog, isOwnCommitSubject, movesHead, stashesWork, type GitProbe, type ReflogEntry } from "./gitDestructive.js"; // MARK: r1-git (§46)
import {
  bashClaudeConfigTarget,
  bashOutsideDirs,
  bashScopeReason,
  CLAUDE_CONFIG_ASK_REASON,
  claudeConfigFile,
  claudeConfigReason,
  editScopeReason,
  inputClaudeConfigTarget,
  isolatedCall,
  isolatedResult,
  isScratchPath,
  nestedRepoRoot,
  SCOPE_ASK_REASON,
  SCOPE_MESSAGES,
  OTHER_REPO_WORKTREE_MESSAGE,
  readOnlyContext,
  worktreeAddRepoDir,
  worktreeToolBlocked,
  ENTER_WORKTREE_MESSAGE,
  enterWorktreeTarget,
  EXIT_WORKTREE_KEEP_NOTE,
  type ScopeNotice,
} from "./reviewScope.js";

export { CLAUDE_CONFIG_ASK_REASON };

export const EDIT_TOOLS_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";
const EDIT_TOOLS_RE = new RegExp(`^(${EDIT_TOOLS_MATCHER})$`);
/** MCP tools (`mcp__<server>__<tool>`): their PostToolUse closes the execution window (§31). */
export const MCP_TOOLS_MATCHER = "mcp__.*";

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
/** MARK: r2-skills-side — §33.5 (M20): the running skill / slash command listed it in its `allowed-tools`. */
export const SKILL_ALLOWED_REASON = "ReviewGate: allowed by the running skill's allowed-tools";
export const OUTSIDE_REASON = "ReviewGate: edit outside the project — needs approval";
export const NESTED_REASON = "ReviewGate: edit inside a nested repository (submodule, worktree or clone) — the review does not see it; needs approval";
export const PLAN_FILE_REASON = "ReviewGate: plan file (plan mode)";
export const UNPROMPTED_REASON =
  "ReviewGate: no user request is running — Claude Code continued on its own, and changes made now would bypass the review. " +
  "This call was blocked. Do not make changes; stop and wait for the user's next message.";
/**
 * MARK: r2-peers — §18 to a subagent (the call carries an `agent_id`): no "stop and wait" — that ended a subagent's whole
 * run; it reports what it could not do instead, and the user's [이어서 계속] picks the work up as a review turn.
 */
export const UNPROMPTED_AGENT_REASON =
  "ReviewGate: no user request is running, so the review cannot take this change and the call was not run. " +
  "Do not retry it; finish without it and say in your report what was left undone.";
export const PLAN_MODE_EDIT_REASON =
  "ReviewGate: plan mode — files may not be edited yet. Investigate with read-only tools, then propose the change with ExitPlanMode; " +
  "the user approves the plan in ReviewGate and the edits happen after that.";
export const PLAN_MODE_BASH_REASON =
  "ReviewGate: plan mode — this command changes files, packages or the repository, and nothing may change yet. Investigate " +
  "with commands that only read; propose the plan with ExitPlanMode (the user approves it in ReviewGate).";
export const GIT_INTERNAL_REASON =
  "ReviewGate: this is git's own data or ReviewGate's state inside the git directory (objects, refs, index, HEAD, logs, " +
  "reviewgate/, …) or its configuration (config, info/attributes) — edit tools may not change it; use git commands (`git config`). " +
  "Files in .git/hooks/, .git/info/exclude and .git/info/sparse-checkout may be edited.";

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
 * linked worktree live outside it). Nothing there passes the review: `gitInternalKind` says which part an edit
 * tool may change at all (M23).
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

/**
 * M23 — docs/PROTOCOL.md §4, §33.3: inside a git dir, what an edit tool may change like any file the review does not see —
 * its hooks, `info/exclude`, `info/sparse-checkout` and `description` (compared case-insensitively, as macOS / Windows file
 * systems do). Everything else there is git's own data (objects, refs, the index, HEAD, logs, packed-refs, a linked
 * worktree's `worktrees/<name>/`, a submodule's `modules/<name>/`, the `.git` file itself) or ReviewGate's state
 * (`reviewgate/`, `reviewgate-review.json`, `refs/reviewgate/`) — release-2 review: and so are `config`, `config.worktree`
 * and the rest of `info/` (`attributes`, `grafts`): a `[filter "x"] clean = …` in the config with `* filter=x` in
 * info/attributes ran in the engine's own `git add -A` (the next snapshot), outside Claude Code's permissions and before any
 * review (`git config` through Bash is judged like any command). A name with a `:` (a Windows stream) is never one.
 */
const GIT_DIR_EDITABLE_RE = /^(?:hooks(?:\/[^/:]+)+|info\/(?:exclude|sparse-checkout)|description)$/i;

/** A git dir component the path holds but `gitDirRelative` cannot read past (on Windows `.git.`, `GIT~1`, a stream). */
const UNREADABLE = Symbol("unreadable");

/**
 * Where `p` (absolute) lies inside a git dir: its path there (POSIX; "" for the git dir itself) — the deepest of `gitDirs`
 * holding it, else what follows its first `.git` component (a nested repository's, another repository's) — null when it
 * is in none.
 */
function gitDirRelative(p: string, gitDirs: readonly string[]): string | null | typeof UNREADABLE {
  let best: { rel: string; depth: number } | null = null;
  for (const d of gitDirs) {
    const dir = realpathLenient(d);
    const rel = samePath(p, dir) ? "" : relativeInside(p, dir);
    if (rel !== null && (best === null || dir.length > best.depth)) best = { rel, depth: dir.length };
  }
  if (best) return best.rel;
  const parts = p.split(/[\\/]+/);
  const k = parts.findIndex((c) => c.toLowerCase() === ".git");
  if (k >= 0) return parts.slice(k + 1).join("/");
  return hasGitComponent(p) ? UNREADABLE : null;
}

/**
 * M23 (§4, §33.3): what an edit of `file` would change in a git dir — `machinery`: git's own data, its configuration or
 * ReviewGate's state, always denied; `other`: a hook, `info/exclude`, … (`GIT_DIR_EDITABLE_RE`), handled like an edit outside the
 * project (the default mode asks with `outside_project`; auto mode leaves it to the CLI and lists it in `changedOutside`);
 * null outside every git dir. Read as named and through symlinks: when either is git's own data, it is `machinery`.
 */
export function gitInternalKind(file: string, gitDirs: readonly string[]): "machinery" | "other" | null {
  if (!isGitInternalPath(file, gitDirs)) return null;
  let other = false;
  for (const view of [resolve(file), realpathLenient(file)]) {
    const rel = gitDirRelative(view, gitDirs);
    if (rel === null) continue;
    if (rel === UNREADABLE || !GIT_DIR_EDITABLE_RE.test(rel)) return "machinery";
    other = true;
  }
  return other ? "other" : "machinery";
}

/** `gitInternalKind` against the session repository's git dirs. */
export async function gitInternalEditKind(file: string, ctx: HookContext): Promise<"machinery" | "other" | null> {
  return gitInternalKind(file, await gitInternalDirs(ctx));
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
 * §46: a git command whose file changes are git's, not Claude's (postBash attributes none of them). MARK: r1-git — not
 * `commit`: it changes no file, so in `sed -i … && git commit -am x` the files are Claude's (its commit keeps them in the
 * review, and they would read "outside the app"). Also matches option
 * groups before the verb: `git -C x reset`, `git -c k=v reset`, `git --no-pager merge`. The verb ends
 * at a non-word, non-dash character, so the read-only `merge-tree` / `merge-base` / `cherry` are not it; nor are
 * `stash list` / `stash show`. `"git"` quoted, option values quoted with spaces (`-C "My Repo"`, `-c user.name="A B"`), `bisect` and
 * `gh pr checkout|merge` count too. git and gh by their name (§20 `programName`): any case, with `.exe`, at the end of a
 * path (`git.exe merge`, `GIT pull`, `"C:\Program Files\Git\cmd\git.exe" rebase`); the verb keeps its case, as git reads it.
 * An option's separate value never starts with `-`: else `-a -b -c …` splits
 * into options and values in 2^n ways when no verb follows (30 options took 60 ms, each one more doubled it).
 * MARK: r1-git — no longer what asks: the card is `gitCommandReason`'s (destructive commands only).
 */
export const GIT_MUTATING_RE =
  /\b[Gg][Ii][Tt](?:\.[Ee][Xx][Ee])?["']?(?:\s+-{1,2}[\w-]+(?:=(?:[^\s"']|"[^"]*"|'[^']*')+|\s+(?:[^\s"'-]|"[^"]*"|'[^']*')(?:[^\s"']|"[^"]*"|'[^']*')*)?)*\s+(checkout|switch|reset|restore|stash(?!\s+(?:list|show)(?![\w-]))|clean|rebase|merge|apply|am|pull|cherry-pick|revert|bisect)(?![\w-])|\b[Gg][Hh](?:\.[Ee][Xx][Ee])?["']?\s+pr\s+(?:checkout|merge)(?![\w-])/;
export const GIT_ASK_REASON = "ReviewGate: a git command that throws away uncommitted work or rewrites the remote — needs the user's approval";

const NO_PATHS: ReadonlySet<string> = new Set();

/**
 * MARK: r1-git — §46: the card reason of a Bash command one of whose git commands throws away uncommitted work or rewrites
 * the remote (`destructiveGitReason`: reset --hard, clean -f, checkout / restore over files under review or with
 * uncommitted changes, branch -D, stash drop / clear, a force push, …), null for anything else — a commit, a branch, a
 * pull, a plain push run as in the terminal. Such a command always gets the card, in every permission mode, whatever a
 * pattern, a remembered key or the user's rules say. `cwd`: where the command runs (the shell's directory).
 */
export async function gitCommandReason(toolName: string, input: Record<string, unknown>, ctx: HookContext, cwd: string = ctx.cwd): Promise<PermissionReason | null> {
  if (toolName !== "Bash") return null;
  const command = typeof input.command === "string" ? input.command : "";
  if (!/git/i.test(command)) return null; // `GIT.EXE` too: the scanner knows a program by its name (§46)
  const root = await containmentRoot(ctx);
  return destructiveGitReason(command, { cwd, root, reviewPaths: ctx.reviewPaths?.() ?? NO_PATHS, ...(ctx.gitProbe ? { probe: ctx.gitProbe } : {}) });
}

const SHELL_MUTATING_RE =
  /(>|>>|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\bchmod\b|\bnpm\s+(i|install)\b|\bnpx\b|\bpip\s+install)/;
/** Redirections that write no file: into /dev/null (`>/dev/null`, `2>> /dev/null`, `&>/dev/null`) or onto another stream (`2>&1`, `>&2`). */
const HARMLESS_REDIRECT_RE = /(?:\d*|&)>>?\s*\/dev\/null\b|\d*>&\s*(?:\d+|-)/g;

/** §54: after a budget deny, a Bash command that writes files is refused too — `npm test 2>&1 | tail` is not one. */
export function writesFiles(command: string): boolean {
  return SHELL_MUTATING_RE.test(command.replace(HARMLESS_REDIRECT_RE, " "));
}

/** §54: "12/10", or "12" for a count without a limit (0). */
const usedOf = (n: number, max: number): string => (max > 0 ? `${n}/${max}` : `${n}`);

/**
 * §54: what Claude is told after an edit once the opt-in budget is reached — the numbers and where the hard stop is, not
 * "stop and report" (that made Claude stop at the soft limit, half way to the deny).
 */
export function budgetNote(files: number, maxFiles: number, lines: number, maxLines: number, hardMultiplier: number): string {
  return (
    `Budget note: ${usedOf(lines, maxLines)} lines, ${usedOf(files, maxFiles)} files used this turn — the user's change limit is reached; ` +
    `edits past ${hardMultiplier}× it are denied.`
  );
}

export function reviewGateReason(files: number, maxFiles: number, lines: number, maxLines: number): string {
  return (
    `REVIEW GATE: per-turn change budget exceeded (files ${usedOf(files, maxFiles)}, lines ${usedOf(lines, maxLines)}). ` +
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
  // MARK: r2-skills-side — §33.5 (M20)
  /**
   * The `allowed-tools` of the skills / slash command running this turn (skillTools.ts): Bash forms through
   * `matchesAllowPattern`, other tools through `matchesToolPattern`. Reset per turn by ClaudeSession.
   */
  turnAllowPatterns?: readonly string[];
  /**
   * A skill's `allowed-tools` by its name (`Skill` tool input), resolved by the engine (project, user, plugin skills).
   * Release-2 review: `since` — a skill file changed at or after it (this turn's start) gives none.
   */
  skillAllowedTools?: (name: string, since?: number) => Promise<readonly string[]>;
  /** Release-2 review (§33.5): when the turn started (wall clock, ms) — a skill written since gives no `allowed-tools`. */
  turnWallStart?: number;
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
   * §31: tool_use ids of the turn's Bash calls judged read-only at their PreToolUse (not run in the background): their
   * PostToolUse takes no snapshot and leaves `bashBaseTree` as it is. Reset per turn.
   */
  readOnlyBash?: Set<string>;
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
  /**
   * §52.2: `settings.subagentsInTurn` (opt-in, with background work on) — Agent / Task calls get `run_in_background: false`
   * so they finish inside the turn. Off (the default) they run as in the terminal: in the background unless Claude says not.
   */
  keepAgentsInTurn?: boolean;
  /**
   * §52.2: whether a hook's `agent_id` (canUseTool's `agentID`) is a subagent the CLI runs in the background, or one it
   * started — its calls are no unprompted turn: it may work while no turn of ours runs (what it changes reaches the next
   * review, A being kept, §52.1).
   */
  backgroundAgent?: (agentId: string) => boolean;
  /**
   * MARK: r2-peers — §33.2: whom a SendMessage reaches (`peerSend.ts`): this session's own subagent, a live session of the
   * user's registry, or null (unverified). Absent: every SendMessage keeps its card.
   */
  sendTarget?: (input: Record<string, unknown>) => Promise<SendTarget>;
  /** A tool call was blocked by the unprompted-turn guard (`unpromptedBlocked`). */
  onUnprompted?: (toolName: string) => void;
  /** Settings.allowWorktreeIsolation (§33.4; M05b: default on): isolated agents run (a card outside auto mode) instead of a deny. */
  allowWorktreeIsolation?: boolean;
  /**
   * §33.3–33.4: why the hooks put a call on a card although it would otherwise run (it works outside the review), by
   * tool_use id — `canUseTool` puts it on the `permission_request`, the post-tool hook raises the notice. Reset per turn.
   */
  scopeReasons?: Map<string, PermissionReason>;
  /**
   * §33.4: Bash calls that run in another worktree or a nested repository, by tool_use id — each folder with its `git status`
   * before the call; after it, a notice lists what changed there (none when nothing did). Reset per turn.
   */
  scopeWatches?: Map<string, ScopeWatch>;
  /** The repository's other worktrees (absolute; `git worktree list` minus the root), cached per turn by `otherWorktrees`. */
  worktrees?: string[];
  /** §33.4: work outside this window's review was blocked / happened (EnterWorktree, isolated agents, worktree commands). */
  onScopeNotice?: (notice: ScopeNotice) => void;
  /**
   * §8 / §39.5: an edit tool changed a file this window's review does not see (outside the root, in a nested repository,
   * Claude's memory; not a throwaway file in a temporary folder, a plan file or a settings file the review lists): it
   * goes to `changedOutside`.
   */
  onOutsideEdit?: (file: string) => void;
  // MARK: r1-git — §46
  /** Repo-relative paths still under review (pending, changes requested): a git command overwriting one asks first. */
  reviewPaths?: () => ReadonlySet<string>;
  /** Test seam: what the git card asks the repository (`gitDestructive.gitProbe`). */
  gitProbe?: GitProbe;
  /** What a git command of Claude's did (`postGitCommand`): files a `git stash` took out of the working tree, a HEAD move. */
  onGitCommand?: (result: GitCommandResult) => void;
  /** What the PreToolUse hook read before a git command ran, by tool_use id (`noteGitBefore` → `postGitCommand`). */
  gitBefore?: Map<string, GitBefore>;
  emit: (msg: SessionEvent) => void;
  log: SessionLog;
};

/**
 * §33.4: a Bash call's folders outside this window's review, with their state before it ran (null: git did not answer);
 * §39.5 `worktree`: a worktree command left to the CLI in auto mode — the path it names and the repository's worktrees
 * before it ran (null: git did not answer), for the engine's §39.4 bookkeeping.
 */
export type ScopeWatch = {
  targets: { code: PermissionReason["code"]; path: string; before: DirState | null }[];
  worktree?: { path?: string; before: GitWorktree[] | null };
};

function allow(): HookJSONOutput {
  return {};
}

// MARK: r1-git — §46: what Claude's git commands did, read around the call.

/**
 * The state a git command may change, read by the PreToolUse hook: the dirty files before a `git stash`; HEAD and the newest
 * HEAD reflog entry (`marker`, null: no reflog yet) before a command that may move it; `at`: when (epoch ms).
 */
export type GitBefore = { dirty?: string[]; head?: { sha: string | null; branch: string | null }; marker?: ReflogEntry | null; at: number };

/** Before a Bash call: what `postGitCommand` compares with — the dirty files when it stashes work away, HEAD when it may move it. */
async function noteGitBefore(ctx: HookContext, input: HookInput, command: string): Promise<void> {
  const id = toolUseIdOf(input);
  if (!id || !ctx.onGitCommand || !/git|\bgh\b/i.test(command)) return;
  const cwd = hookCwd(input, ctx);
  const stash = stashesWork(command, cwd);
  const moves = movesHead(command, cwd);
  if (!stash && !moves) return;
  try {
    const root = await containmentRoot(ctx);
    const before: GitBefore = { at: ctx.now?.() ?? Date.now() };
    if (stash) {
      const dirty = await dirtyPaths(root);
      if (dirty) before.dirty = dirty;
    }
    if (moves) {
      if (!ctx.checkpoint) ctx.checkpoint = await openCheckpoint(ctx.cwd);
      const [head, log] = await Promise.all([ctx.checkpoint.head(), headReflog(root, 1)]);
      before.head = head;
      before.marker = log[0] ?? null;
    }
    if (!ctx.gitBefore) ctx.gitBefore = new Map();
    ctx.gitBefore.set(id, before);
  } catch (e) {
    ctx.log("debug", `git state before Bash failed: ${String(e)}`);
  }
}

/**
 * After that call (it ran, or failed after it ran): what changed — a stash that took files out of the working tree, a HEAD
 * move with the commits Claude's `git commit` made in it (the reflog's commit entries written while the call ran; a move
 * from before — the user's, while the card waited — makes it `foreign`).
 */
async function noteGitAfter(ctx: HookContext, input: HookInput): Promise<void> {
  const id = toolUseIdOf(input);
  const before = id ? ctx.gitBefore?.get(id) : undefined;
  if (!id || !before) return;
  ctx.gitBefore!.delete(id);
  try {
    const root = await containmentRoot(ctx);
    const result: GitCommandResult = { toolUseId: id };
    if (before.dirty) {
      const after = await dirtyPaths(root);
      if (after) {
        const left = new Set(after);
        const stashed = before.dirty.filter((p) => !left.has(p));
        if (stashed.length > 0) result.stashed = stashed;
      }
    }
    if (before.head && ctx.checkpoint) {
      const to = await ctx.checkpoint.head();
      if (to.sha !== before.head.sha || to.branch !== before.head.branch) {
        result.from = before.head;
        result.to = to;
        // The call ran from `now - duration_ms` (CLI 2.1.308; else since the PreToolUse hook): reflog times are in seconds.
        const now = ctx.now?.() ?? Date.now();
        const duration = (input as { duration_ms?: unknown }).duration_ms;
        const ranFrom = typeof duration === "number" && duration >= 0 ? Math.max(before.at, now - duration) : before.at;
        const since = Math.floor(ranFrom / 1000) - 1;
        const all = await headReflog(root);
        const entries = entriesSince(all, before.marker ?? null, since);
        const mine = entries.filter((e) => e.at >= since && isOwnCommitSubject(e.subject));
        if (mine.length > 0) result.ownCommits = [...new Set(mine.map((e) => e.sha).reverse())];
        // An amend's entry follows the one of the commit it replaced (that commit's changes are in the amended one).
        const amended = mine.filter((e) => e.subject.startsWith("commit (amend):")).map((e) => all[all.indexOf(e) + 1]?.sha).filter((x): x is string => !!x);
        if (amended.length > 0) result.amended = [...new Set(amended)];
        if (entries.some((e) => e.at < since)) result.foreign = true;
      }
    }
    if (result.stashed || result.from) ctx.onGitCommand?.(result);
  } catch (e) {
    ctx.log("debug", `git state after Bash failed: ${String(e)}`);
  }
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
 * must ask: a read-only Bash command (`autoAllowReadOnlyBash !== false`; judged where it runs with `ro`, §19.3), a
 * `bashAllowPatterns` match (for other tools its MCP / WebFetch / WebSearch / Agent forms, §33.6), a key the user
 * remembered for this session, or the user's own Claude Code allow rule for a tool that cannot change files (§33.5).
 * Consulted by the PreToolUse hooks and by canUseTool.
 */
export function autoAllowReason(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Pick<HookContext, "autoAllowReadOnlyBash" | "bashAllowPatterns" | "rememberedAllows" | "userRules" | "mcpToolHints" | "turnAllowPatterns">,
  ro?: ReadOnlyContext,
): string | undefined {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (ctx.autoAllowReadOnlyBash !== false && isReadOnlyCommand(command, ro)) return READ_ONLY_BASH_REASON;
    // §19.3 (M21): judged where it runs too — a leading `cd` into the repository needs no match of its own; each command
    // of a chain may match another pattern of the list.
    if (matchesAllowPatterns(ctx.bashAllowPatterns ?? [], command, ro)) return ALLOW_PATTERN_REASON;
    // MARK: r2-skills-side — §33.5 (M20): what the running skill pre-allowed (`allowed-tools: Bash(git add:*)`).
    if (matchesAllowPatterns(ctx.turnAllowPatterns ?? [], command, ro)) return SKILL_ALLOWED_REASON;
  } else if ((ctx.bashAllowPatterns ?? []).some((p) => matchesToolPattern(p, toolName, input))) {
    return ALLOW_PATTERN_REASON;
  } else if ((ctx.turnAllowPatterns ?? []).some((p) => matchesToolPattern(p, toolName, input))) {
    return SKILL_ALLOWED_REASON;
  }
  if (rememberable(toolName) && isRemembered(toolName, input, ctx.rememberedAllows, ro)) return REMEMBERED_REASON;
  if (userRuleAllows(toolName, input, ctx.userRules, ctx.mcpToolHints)) return USER_RULE_REASON;
  // MARK: r2-skills-side — §33.5 (M20): the user's `Bash(mvn:*)` rules, like an app pattern (`applyUserBashRules`).
  if (toolName === "Bash" && userBashRuleAllows(typeof input.command === "string" ? input.command : "", ctx.userRules, ro)) return USER_RULE_REASON;
  return undefined;
}

/**
 * True when `toolName` must be denied because no engine-started turn is running (`ctx.turnActive === false`):
 * everything except the read-only tools and a read-only Bash command that is auto-allowed anyway (`ro`: where it runs).
 * §52.2: never a call of a subagent working in the background (`agentId`, `ctx.backgroundAgent`).
 */
export function unpromptedBlocked(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Pick<HookContext, "turnActive" | "autoAllowReadOnlyBash" | "backgroundAgent">,
  ro?: ReadOnlyContext,
  agentId?: string,
): boolean {
  if (ctx.turnActive !== false) return false;
  if (agentId && ctx.backgroundAgent?.(agentId)) return false;
  if (READ_ONLY_TOOLS.has(toolName)) return false;
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return !(ctx.autoAllowReadOnlyBash !== false && isReadOnlyCommand(command, ro));
  }
  return true;
}

/**
 * The deny reason for `toolName` in plan mode (docs/PROTOCOL.md §19.4), undefined when it may proceed: edit tools are
 * denied except a write to the CLI's plan file (`isPlanFile`). M19: Bash is denied only when the command clearly writes
 * (`clearlyWrites`: a file — not a throwaway one in a temporary folder —, packages, the repository); a read-only one runs as
 * `autoAllowReadOnlyBash` says, anything else goes the usual way — a card in plan mode from the default mode, the CLI's
 * classifier in plan mode from auto (§44.1). Other tools are unaffected. `ro`: where the command runs (§19.3).
 */
export function planModeBlocked(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Pick<HookContext, "permissionMode" | "plansDir" | "cwd" | "scratchDirs">,
  ro?: ReadOnlyContext,
): string | undefined {
  if (ctx.permissionMode !== "plan") return undefined;
  if (EDIT_TOOLS_RE.test(toolName)) {
    const file = toolFile(input, ctx.cwd);
    return file && isPlanFile(file, ctx) ? undefined : PLAN_MODE_EDIT_REASON;
  }
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (isReadOnlyCommand(command, ro)) return undefined;
    // `abs` may be a folder (find's start point): a repository there is no throwaway place.
    const scratch = (abs: string) => isScratchPath(join(abs, "_"), ctx.scratchDirs);
    return clearlyWrites(command, ro?.cwd ?? ctx.cwd, scratch) ? PLAN_MODE_BASH_REASON : undefined;
  }
  return undefined;
}

/** Denies (and reports) a call made outside an engine-started turn; undefined when the guard does not apply. */
async function guardUnprompted(toolName: string, input: Record<string, unknown>, ctx: HookContext, ro: ReadOnlyContext | undefined, hook: HookInput): Promise<HookJSONOutput | undefined> {
  // §52: a turn Claude started itself is being taken as a review turn — nothing runs before its snapshot A.
  if (ctx.adoption) await ctx.adoption;
  const agentId = agentIdOf(hook);
  if (!unpromptedBlocked(toolName, input, ctx, ro, agentId)) return undefined;
  ctx.onUnprompted?.(toolName);
  return denyPre(agentId ? UNPROMPTED_AGENT_REASON : UNPROMPTED_REASON); // MARK: r2-peers
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

/** §19.3: the read-only classifier's context for a command run in `cwd` — the root and the worktrees (both cached per turn). */
export async function readOnlyContextOf(ctx: HookContext, cwd: string): Promise<ReadOnlyContext> {
  return readOnlyContext(cwd, await containmentRoot(ctx), await otherWorktrees(ctx));
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

/** The tool a PreToolUse / PostToolUse input is about. */
function toolNameOf(input: HookInput): string {
  const name = (input as { tool_name?: unknown }).tool_name;
  return typeof name === "string" ? name : "";
}

/** The subagent a hook fired in (`agent_id`, CLI 2.1.x); undefined on the main thread. */
function agentIdOf(input: HookInput): string | undefined {
  const id = (input as { agent_id?: unknown }).agent_id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * §33.4: agents that run outside this folder (`isolation`, a `cwd` elsewhere, a Workflow whose agents use `isolation`) are
 * denied while the user turned `allowWorktreeIsolation` off (default on); otherwise they get a card with the reason — M05b:
 * in auto mode none (the CLI's call; the row after it ran says where it worked, §39.3's agent card too). EnterWorktree /
 * ExitWorktree: `enterWorktree` / `exitWorktree`. Undefined for anything else.
 */
async function guardWorktreeTools(input: HookInput, ti: Record<string, unknown>, ctx: HookContext): Promise<HookJSONOutput | undefined> {
  const toolName = toolNameOf(input);
  const toolUseId = toolUseIdOf(input);
  if (toolName === "EnterWorktree") return enterWorktree(input, ti, ctx);
  if (toolName === "ExitWorktree") return exitWorktree(input, ti, ctx);
  if (toolName !== "Workflow" && !/^(Agent|Task)$/.test(toolName)) return undefined;
  const root = await containmentRoot(ctx);
  const deny = worktreeToolBlocked(toolName, ti, root, ctx.allowWorktreeIsolation !== false);
  if (deny) {
    const path = typeof ti.cwd === "string" && ti.cwd ? resolve(root, ti.cwd) : undefined;
    ctx.onScopeNotice?.({ code: "worktree_blocked", toolName, ...(toolUseId ? { toolUseId } : {}), ...(path ? { path } : {}) });
    return denyPre(deny);
  }
  if (!isolatedCall(toolName, ti, root)) return undefined;
  rememberScope(ctx, toolUseId, { code: "worktree_isolation", message: SCOPE_MESSAGES.worktree_isolation });
  return scopeCliDecides(ctx, input) ? undefined : askPre(SCOPE_ASK_REASON);
}

/**
 * M05b — §39.4: EnterWorktree moves the CLI into a worktree (a new `.claude/worktrees/<name>`, or the existing one its `path`
 * names). The repository's worktrees are read before it runs (did this chat make it: the follow's review baseline). In
 * auto mode it is the CLI's call and the chat follows once it ran (`postWorktreeTool`, the engine); otherwise the card says
 * where it goes (`worktree_command`, `path` when the call names it), with "허용하고 따라가기".
 */
async function enterWorktree(input: HookInput, ti: Record<string, unknown>, ctx: HookContext): Promise<HookJSONOutput | undefined> {
  const toolUseId = toolUseIdOf(input);
  const root = await containmentRoot(ctx);
  const target = enterWorktreeTarget(ti, root);
  // A subagent's EnterWorktree moves only that agent (the chat stays): an isolated agent's rules (§33.4) — denied while the
  // user turned them off, else its card outside auto mode — and its row after.
  const agentId = agentIdOf(input);
  if (agentId !== undefined) {
    const deny = worktreeToolBlocked("EnterWorktree", ti, root, ctx.allowWorktreeIsolation !== false, agentId);
    if (deny) {
      ctx.onScopeNotice?.({ code: "worktree_blocked", toolName: "Agent", ...(toolUseId ? { toolUseId } : {}), ...(target ? { path: target } : {}) });
      return denyPre(deny);
    }
    rememberScope(ctx, toolUseId, { code: "worktree_isolation", message: SCOPE_MESSAGES.worktree_isolation, ...(target ? { path: target } : {}) });
    return scopeCliDecides(ctx, input) ? undefined : askPre(SCOPE_ASK_REASON);
  }
  if (toolUseId) {
    const before = await listWorktrees(root).catch(() => null);
    (ctx.scopeWatches ??= new Map()).set(toolUseId, { targets: [], worktree: { ...(target ? { path: target } : {}), before } });
  }
  if (scopeCliDecides(ctx, input)) return undefined;
  rememberScope(ctx, toolUseId, { code: "worktree_command", message: ENTER_WORKTREE_MESSAGE, ...(target ? { path: target } : {}) });
  return askPre(SCOPE_ASK_REASON);
}

/**
 * M05b — §39.4: ExitWorktree takes the CLI back to the folder it entered from; once it ran the chat follows (the engine).
 * In a window on a linked worktree — the one the CLI leaves, the chat having followed it here — `action: "remove"` would
 * delete the folder this window reviews and this chat's rows with it: it is changed to `keep` and Claude is told why.
 * Elsewhere, removing a worktree with `discard_changes` throws away its uncommitted work: the §46 card, in every mode.
 */
async function exitWorktree(input: HookInput, ti: Record<string, unknown>, ctx: HookContext): Promise<HookJSONOutput | undefined> {
  if (ti.action !== "remove") return undefined;
  const linked = (await gitInternalDirs(ctx)).length > 1 && isInside(hookCwd(input, ctx), await containmentRoot(ctx));
  if (linked) {
    const { discard_changes: _discard, ...rest } = ti;
    const out = withUpdatedInput(askOrAllow(toolNameOf(input), ti, ctx, hookPermissionMode(input)), { ...rest, action: "keep" });
    const spec = (out as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
    return { ...out, hookSpecificOutput: { ...spec, additionalContext: EXIT_WORKTREE_KEEP_NOTE } } as HookJSONOutput;
  }
  if (ti.discard_changes !== true) return undefined;
  rememberScope(ctx, toolUseIdOf(input), gitCommandCardReason());
  return askPre(GIT_ASK_REASON);
}

/**
 * §39.5: the engine runs in auto mode and the CLI says so too (the hook input's `permission_mode`; absent — an older CLI —
 * is the engine's word). There work outside this window's review (another worktree of the repository, a nested
 * repository) is the CLI's call, as in the terminal, and listed after it instead of a card.
 */
function scopeCliDecides(ctx: HookContext, input: HookInput): boolean {
  if (ctx.permissionMode !== "auto") return false;
  const cli = hookPermissionMode(input);
  return cli === undefined || cli === null || cli === "auto";
}

/** §33.4: before a command that runs in another worktree / a nested repository, the state of each of those folders. */
async function watchOutside(ctx: HookContext, toolUseId: string | undefined, command: string, cwd: string, root: string, worktrees: readonly string[]): Promise<void> {
  if (!toolUseId) return;
  const targets = await Promise.all(bashOutsideDirs(command, cwd, root, worktrees).map(async (r) => ({ code: r.code, path: r.path!, before: await dirState(r.path!) })));
  if (targets.length === 0) return;
  if (!ctx.scopeWatches) ctx.scopeWatches = new Map();
  ctx.scopeWatches.set(toolUseId, { targets });
}

/**
 * §33.4: after a Bash call that ran in another worktree or a nested repository — one notice per folder it changed, with
 * the changed files (none when nothing changed there; no list when git could not tell). Any other call: `noticeAfterTool`.
 */
async function noticeAfterBash(input: HookInput, ctx: HookContext): Promise<void> {
  const toolUseId = toolUseIdOf(input);
  const watch = toolUseId ? ctx.scopeWatches?.get(toolUseId) : undefined;
  if (!toolUseId || !watch) {
    noticeAfterTool("Bash", input, ctx);
    return;
  }
  ctx.scopeWatches!.delete(toolUseId);
  ctx.scopeReasons?.delete(toolUseId); // its card (if any) was answered
  if (watch.worktree) {
    const w = watch.worktree;
    ctx.onScopeNotice?.({ code: "worktree_outside_review", toolName: "Bash", toolUseId, ...(w.path ? { path: w.path } : {}), reasonCode: "worktree_command", ...(w.before ? { worktreesBefore: w.before } : {}) });
  }
  for (const t of watch.targets) {
    const after = t.before ? await dirState(t.path) : null;
    const files = t.before && after ? await changedPaths(t.path, t.before, after) : undefined;
    if (files && files.length === 0) continue;
    ctx.onScopeNotice?.({ code: "worktree_outside_review", toolName: "Bash", toolUseId, path: t.path, ...(files ? { files } : {}), reasonCode: t.code });
  }
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
 * or the user's rules say — it writes one of Claude Code's own settings files (`.claude/settings.json`,
 * `.claude/settings.local.json`, `.mcp.json`, …; M22: a Bash command as a write target, `bashClaudeConfigTarget`, never for
 * naming one). Null for anything else: a read-only command (it cannot change the file), an
 * MCP tool that only reads, any other tool (edit tools are decided on their target: `claudeConfigFile` / `editScopeReason`).
 * `cwd` is where a command runs (the shell's directory), `root` the project relative paths of an MCP call belong to.
 */
export function configScopeReason(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  root: string,
  ctx: Pick<HookContext, "mcpToolHints">,
  ro?: ReadOnlyContext,
): PermissionReason | null {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (isReadOnlyCommand(command, ro)) return null;
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
 * MARK: r2-skills-side — §33.5 (M20): a Skill call's `allowed-tools` join the turn's allow patterns (a failed read adds none).
 * Release-2 review: once the call succeeded (PostToolUse), and only from a skill file unchanged since the turn started
 * (`turnWallStart`; the engine also leaves out one still under review and every pattern that covers any command).
 */
async function noteSkill(ctx: HookContext, input: Record<string, unknown>): Promise<void> {
  const name = skillCallName(input);
  if (!name || !ctx.skillAllowedTools) return;
  try {
    const tools = await ctx.skillAllowedTools(name, ctx.turnWallStart);
    if (tools.length > 0) ctx.turnAllowPatterns = [...new Set([...(ctx.turnAllowPatterns ?? []), ...tools])];
  } catch (e) {
    ctx.log("debug", `skill ${name}: allowed-tools not read: ${String(e)}`);
  }
}

/**
 * Deny decisions are returned before this is consulted, so deny always wins over ask. `cliMode` is the hook input's
 * `permission_mode`: in auto mode (§39.5) a call no app rule allows is left to the CLI's rules and classifier instead of
 * the card — the reason cards (§33.3–33.4, §33.9) were decided before this, too.
 */
function askOrAllow(toolName: string, input: Record<string, unknown>, ctx: HookContext, cliMode?: unknown, ro?: ReadOnlyContext): HookJSONOutput {
  if (!needsAsk(toolName, ctx.autoAllowTools)) return allow();
  const reason = autoAllowReason(toolName, input, ctx, ro);
  if (reason) return allowPre(reason);
  // MARK: wave4b w4b-auto (§39.5); input: w4b-check4 (§40.1); prePlanMode / hints: wave6 w6-terminal (§44.1)
  if (autoModeDecides(toolName, ctx.permissionMode, cliMode, input, ctx.prePlanMode, ctx.mcpToolHints)) return allow();
  return askPre();
}

/**
 * MARK: r2-peers — §33.2: a SendMessage whose recipient the session can verify (`ctx.sendTarget`: this session's own
 * subagent, a live session of the user's registry) needs no card in auto mode — it goes to the CLI, which runs a message
 * to a local session or a subagent without asking, as in the terminal (its deny rules and cross-machine checks still
 * apply). In any mode a live session whose key "이 세션으로 보내는 메시지는 세션 동안 허용" stored (`SendMessage:<session
 * id>`) is allowed. Undefined: the usual rules decide (`askOrAllow` — an unverified recipient keeps the card in every mode).
 */
async function sendMessageDecision(input: Record<string, unknown>, ctx: HookContext, cliMode: unknown): Promise<HookJSONOutput | undefined> {
  if (!ctx.sendTarget) return undefined;
  const auto = inAutoMode(ctx.permissionMode, cliMode);
  if (!auto && !remembersSessions(ctx.rememberedAllows)) return undefined;
  const target = await ctx.sendTarget(input);
  if (target?.kind === "session") {
    const key = sendMessageKey(target.session);
    if (key && ctx.rememberedAllows?.has(key)) return allowPre(REMEMBERED_REASON);
  }
  return auto && target ? allow() : undefined;
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
 * Before the turn's first Bash call that may write (§31: a read-only one takes none): the tree its post-Bash snapshot is
 * diffed against, so Bash file attribution never picks up what earlier turns left on disk (a request-changes turn keeps
 * the old A).
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
    const unprompted = await guardUnprompted(input.tool_name, ti, ctx, undefined, input);
    if (unprompted) return unprompted;
    const file = toolFile(ti, ctx.cwd);
    // Never into git's own data or ReviewGate's state (objects, refs, the index, HEAD, reviewgate/): checked before anything
    // can allow it. M23: a hook, info/exclude or the config is handled like an edit outside the project (below).
    const gitKind = file ? await gitInternalEditKind(file, ctx) : null;
    if (gitKind === "machinery") return denyPre(GIT_INTERNAL_REASON);
    if (file && isPlanFile(file, ctx)) {
      ctx.planFiles?.add(file);
      return allowPre(PLAN_FILE_REASON);
    }
    const planDeny = planModeBlocked(input.tool_name, ti, ctx);
    if (planDeny) return denyPre(planDeny);
    // A throwaway file in a temporary folder (Claude Code's scratchpad, /tmp) outside any repository: not the user's code,
    // so neither the budget nor the outside-the-project card.
    if (file && ctx.scratchDirs && isOutsideRoot(file, await containmentRoot(ctx)) && isScratchPath(file, ctx.scratchDirs)) return allow();
    // §39.5: in auto mode an edit the review does not see (Claude's memory, outside the project, a nested repository) is the
    // CLI's call, as in the terminal, and listed after the turn (postEditScope) — Claude Code's own settings keep their card.
    const cliDecides = scopeCliDecides(ctx, input);
    // §33.9: a change to Claude Code's own settings asks — M22: in auto mode not when it only changes keys that neither run
    // code nor widen what Claude may do (`settingsEditRisk` → []): the CLI's call, reviewed after (mods group, §32). The
    // card names the keys that take effect first (`reason.keys`; a location reason, decided by canUseTool, comes first).
    const settingsCard = (config: string, cardRoot: string | null): HookJSONOutput => {
      const keys = settingsEditRisk(input.tool_name, ti, config);
      if (cliDecides && keys !== null && keys.length === 0) return allow();
      if (cardRoot !== null && keys?.length) rememberScope(ctx, toolUseIdOf(input), claudeConfigReason(config, cardRoot, keys));
      return askPre(CLAUDE_CONFIG_ASK_REASON);
    };
    // Claude's own memory (~/.claude/projects/<project>/memory) is not in the review: the budget neither counts nor blocks
    // it (a turn over budget can still note what it learned); it keeps the outside-the-project card (not in auto mode) —
    // unless the file is one of Claude Code's settings through a symlink there (§33.9: checked first, as named or resolved).
    if (file && isClaudeMemoryFile(file, ctx.claudeHome)) {
      const config = claudeConfigFile(file);
      if (config) return settingsCard(config, null);
      return cliDecides ? allow() : askPre(OUTSIDE_REASON);
    }
    // §54: the change budget is opt-in — without one (the default) an edit is neither counted nor denied.
    if (b.active) {
      const est = estimateEditLines(input.tool_name, ti, ctx.cwd);

      const projectedFiles = new Set(b.files);
      if (file) projectedFiles.add(file);
      const projectedLines = b.lines + est;

      if (b.denied || b.wouldExceedHard(projectedFiles.size, projectedLines)) {
        b.denied = true;
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
    // never auto-allowed; `ask` reaches canUseTool, which puts it on the permission card. §39.5: in auto mode it is the
    // CLI's call — unless it is one of Claude Code's own settings files (`~/.claude/settings.json`), checked first. M23: so is
    // a file in a git dir that is not git's own data (a hook, info/exclude, config): no snapshot sees it either.
    if (file && (gitKind === "other" || isOutsideRoot(file, await containmentRoot(ctx)))) {
      if (!cliDecides) return askPre(OUTSIDE_REASON);
      const config = claudeConfigFile(file);
      return config ? settingsCard(config, null) : allow();
    }
    // §33.3: inside the root but in a nested repository (submodule, worktree, clone) the snapshot only sees a gitlink.
    if (file && nestedRepoRoot(file, await containmentRoot(ctx))) {
      if (!cliDecides) return askPre(NESTED_REASON);
      const config = claudeConfigFile(file);
      return config ? settingsCard(config, null) : allow();
    }
    // §33.9: Claude Code's own settings (hooks, permission rules, MCP servers) never change without the card — in every
    // permission mode but auto, and there whenever a key that takes effect before the review changes (M22): this `ask`
    // reaches canUseTool in acceptEdits / auto too (CLI 2.1.308).
    const config = file ? claudeConfigFile(file) : null;
    return config ? settingsCard(config, await containmentRoot(ctx)) : allow();
  };

  const preBash: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return allow();
    noteCliMode(input, ctx); // MARK: wave6 w6-terminal (§44.1)
    const b = ctx.budget;
    const ti = toolInput(input);
    // §19.3: a command is judged where it runs — a `cd` / `git -C` into the repository's own worktrees stays read-only.
    const cwd = hookCwd(input, ctx);
    const ro = await readOnlyContextOf(ctx, cwd);
    const unprompted = await guardUnprompted(input.tool_name, ti, ctx, ro, input);
    if (unprompted) return unprompted;
    const command = String(ti.command ?? "");
    await noteGitBefore(ctx, input, command); // MARK: r1-git (§46): what a git command may change, read before it runs
    const planDeny = planModeBlocked(input.tool_name, ti, ctx, ro);
    if (planDeny) return denyPre(planDeny);
    // §54: after a budget deny only change attempts are refused — never a command that just reads or tests, and the turn
    // goes on (it is never interrupted): Claude reports what it did and what remains.
    if (b.active && b.denied && writesFiles(command)) {
      return denyPre(reviewGateReason(b.files.size, b.budget.maxFiles, b.lines, b.budget.maxLines));
    }
    const readOnly = isReadOnlyCommand(command, ro);
    // §31: a read-only command (not one run in the background) changes nothing — no baseline before it, no snapshot after.
    const toolUseId = toolUseIdOf(input);
    if (readOnly && ti.run_in_background !== true && toolUseId) (ctx.readOnlyBash ??= new Set()).add(toolUseId);
    else await bashBaseline(ctx);
    // §31: the window opens before any card — `duration_ms` at its end leaves the wait for the user out.
    openWindow(ctx, input, command);
    // §33.4: a command that creates a worktree, or runs in / `cd`s into another worktree or a nested repository, reaches
    // the card with the reason — never an allow pattern or a remembered key (a read-only one still runs). §39.5: in auto
    // mode another worktree of the repository and a nested repository are the CLI's call (no card; the row after the call
    // lists what changed there) — the settings-file and git checks below still apply, so this never returns early then.
    const root = ro.root;
    let scope = bashScopeReason(command, cwd, root, ro.sameRepoDirs);
    // §39.4: a worktree of another repository (the command `cd`s / `-C`s there) — no chat of this window can follow it.
    if (scope?.code === "worktree_command") {
      const repoDir = worktreeAddRepoDir(command, cwd);
      if (repoDir && (await sameRepository(repoDir, root)) === false) scope = { ...scope, otherRepository: true, message: OTHER_REPO_WORKTREE_MESSAGE };
    }
    if (scope && !(ctx.autoAllowReadOnlyBash !== false && readOnly)) {
      // §33.4: what it changes in the other worktrees / nested repositories it runs in is listed after the call.
      if (scope.code !== "worktree_command") await watchOutside(ctx, toolUseId, command, cwd, root, ro.sameRepoDirs);
      // §39.5: a worktree of this repository may be made without a card too (another repository's keeps it: no chat can
      // follow there); the engine is told once it ran, with the worktrees there were before, and offers to move the chat.
      const cliDecides = scopeCliDecides(ctx, input) && !scope.otherRepository;
      if (cliDecides && scope.code === "worktree_command" && toolUseId) {
        const before = await listWorktrees(root).catch(() => null);
        if (!ctx.scopeWatches) ctx.scopeWatches = new Map();
        const prior = ctx.scopeWatches.get(toolUseId);
        ctx.scopeWatches.set(toolUseId, { targets: prior?.targets ?? [], worktree: { ...(scope.path ? { path: scope.path } : {}), before } });
      }
      if (!cliDecides) {
        rememberScope(ctx, toolUseId, scope);
        return askPre(SCOPE_ASK_REASON);
      }
    }
    // §33.9: so does a command writing one of Claude Code's own settings files (M22: reading or naming one is no card).
    const config = configScopeReason(input.tool_name, ti, cwd, root, ctx, ro);
    if (config) {
      rememberScope(ctx, toolUseIdOf(input), config);
      return askPre(CLAUDE_CONFIG_ASK_REASON);
    }
    // MARK: r1-git — §46: git runs as in the terminal (auto mode: the CLI's rules and classifier; default: the ordinary card,
    // which can be remembered). Only a command that throws away uncommitted work or rewrites the remote reaches the card
    // with the reason — in every mode, never remembered; this `ask` reaches canUseTool in acceptEdits / auto too.
    const git = await gitCommandReason(input.tool_name, ti, ctx, hookCwd(input, ctx));
    if (git) {
      rememberScope(ctx, toolUseIdOf(input), git);
      return askPre(GIT_ASK_REASON);
    }
    return askOrAllow(input.tool_name, ti, ctx, hookPermissionMode(input), ro);
  };

  /** Every other tool forces `ask` (needsAsk) — reads, subagents and the to-do list are never counted or refused by the budget (§54). */
  const preOther: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return allow();
    if (/^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/.test(input.tool_name)) return allow();
    noteCliMode(input, ctx); // MARK: wave6 w6-terminal (§44.1)
    const ti = toolInput(input);
    const unprompted = await guardUnprompted(input.tool_name, ti, ctx, undefined, input);
    if (unprompted) return unprompted;
    // MARK: r2-skills-side — §33.5 (M20): a skill that starts says what it may run for the rest of the turn; §31.1 (M35): what
    // its !`command` lines change while it loads is its own (a window, as an MCP call's).
    if (input.tool_name === "Skill") openWindow(ctx, input);
    const worktree = await guardWorktreeTools(input, ti, ctx);
    if (worktree) return worktree;
    // An MCP tool may write files (an IDE's MCP server, a filesystem server): its window attributes them (§31).
    // §52.2: only with `subagentsInTurn` (opt-in) does a subagent finish inside the turn that started it: the CLI backgrounds
    // an Agent call unless its input says `run_in_background: false` (2.1.318). By default it runs as in the terminal and
    // the main agent stays free to answer; what the subagent changes reaches a review all the same (§52.1, §52.2).
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
    // MARK: r2-peers — §33.2: a message to a recipient the session can verify.
    if (input.tool_name === "SendMessage") {
      const peer = await sendMessageDecision(ti, ctx, hookPermissionMode(input));
      if (peer) return peer;
    }
    return askOrAllow(input.tool_name, ti, ctx, hookPermissionMode(input));
  };

  /** Release-2 review (§33.5): a Skill call that succeeded says what it may run for the rest of the turn. */
  const postSkill: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") await noteSkill(ctx, toolInput(input));
    return allow();
  };

  /** PostToolUse / PostToolUseFailure of an MCP or a Skill call: only closes its window (no snapshot per call). */
  const postWriter: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") finishWindow(ctx, input);
    return allow();
  };

  /** §33.4: an approved Agent / Task / Workflow that ran outside this folder keeps its warning. */
  const postIsolated: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") noticeAfterTool(input.tool_name, input, ctx);
    return allow();
  };

  /**
   * M05b — §39.4: EnterWorktree ran — where it went (its result's `worktreePath` / `worktreeBranch`) goes to the engine with
   * the worktrees before it, which moves the chat there in auto mode and offers the move otherwise; ExitWorktree ran — the
   * folder the CLI went back to (`originalCwd`), where the chat follows it.
   */
  const postWorktreeTool: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return allow();
    const toolUseId = toolUseIdOf(input);
    const response = (input as { tool_response?: unknown }).tool_response;
    ctx.worktrees = undefined; // a worktree may have been added
    if (input.tool_name === "EnterWorktree" && agentIdOf(input) !== undefined) {
      // A subagent went into a worktree (only it moved): the row of an isolated agent says where it works.
      noticeAfterTool("Agent", input, ctx);
    } else if (input.tool_name === "EnterWorktree") {
      const watch = toolUseId ? ctx.scopeWatches?.get(toolUseId) : undefined;
      if (toolUseId) {
        ctx.scopeWatches?.delete(toolUseId);
        ctx.scopeReasons?.delete(toolUseId);
      }
      const result = isolatedResult(response);
      const path = result.path ?? watch?.worktree?.path;
      const before = watch?.worktree?.before;
      ctx.onScopeNotice?.({ code: "worktree_outside_review", toolName: "EnterWorktree", ...(toolUseId ? { toolUseId } : {}), ...(path ? { path } : {}), ...(result.branch ? { branch: result.branch } : {}), reasonCode: "worktree_command", ...(before ? { worktreesBefore: before } : {}) });
    } else if (input.tool_name === "ExitWorktree" && agentIdOf(input) === undefined) {
      if (toolUseId) ctx.scopeReasons?.delete(toolUseId);
      const back = response && typeof response === "object" ? (response as { originalCwd?: unknown }).originalCwd : undefined;
      if (typeof back === "string" && back) ctx.onScopeNotice?.({ code: "worktree_exited", toolName: "ExitWorktree", ...(toolUseId ? { toolUseId } : {}), path: back });
    }
    return allow();
  };

  const postEdit: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return allow();
    const b = ctx.budget;
    if (!b.active || !b.exceedsSoft()) return allow();
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: budgetNote(b.files.size, b.budget.maxFiles, b.lines, b.budget.maxLines, b.hardMultiplier),
      },
    };
  };

  /**
   * §8 / §39.5: after an edit the review does not see — outside the root, in a nested repository, in Claude's memory (the
   * locations `editScopeReason` names; not a settings file of the review's own, a throwaway file or a plan file) — the
   * file goes to `changedOutside` (in auto mode no card listed it).
   */
  const postEditScope: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || !ctx.onOutsideEdit) return allow();
    const file = toolFile(toolInput(input), ctx.cwd);
    if (!file || isPlanFile(file, ctx)) return allow();
    const reason = editScopeReason(file, await containmentRoot(ctx), isOutsideRoot, [], ctx.scratchDirs);
    if (reason && reason.code !== "claude_config") ctx.onOutsideEdit(file);
    return allow();
  };

  /**
   * After a Bash call — PostToolUse, or PostToolUseFailure for a command that exited non-zero (CLI 2.1.308) — the
   * worktree is snapshotted: the files changed since the previous snapshot that also changed inside this call's
   * execution window are the call's (§31); a change made between calls (the IDE, another session, `git pull`) is
   * nobody's and stays out of the budget, which counts the turn's edit-tool and Bash files only. Not after a read-only
   * command (§31).
   */
  const postBash: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return allow();
    const window = finishWindow(ctx, input);
    // §33.4: an approved command outside the review ran (a failing one too: it may have written before it failed).
    await noticeAfterBash(input, ctx);
    // A worktree may have been added / moved / removed: list them again for the next call (§33.4).
    if (/\bworktree\b/.test(String(toolInput(input).command ?? ""))) ctx.worktrees = undefined;
    // §31: a read-only command (judged at its PreToolUse) wrote nothing — no snapshot, no diff, the base tree stays. A file
    // one wrote all the same still reaches the review at the turn's end (snapshot B), without this call as its cause.
    const toolUseId = toolUseIdOf(input);
    if (toolUseId && ctx.readOnlyBash?.delete(toolUseId)) return allow();
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

  /** MARK: r1-git — §46: after a Bash call (it ran, or exited non-zero after running): what its git commands did. */
  const postGitCommand: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") await noteGitAfter(ctx, input);
    return allow();
  };

  return {
    PreToolUse: [
      { matcher: EDIT_TOOLS_MATCHER, hooks: [preEdit] },
      { matcher: "Bash", hooks: [preBash] },
      { hooks: [preOther] },
    ],
    PostToolUse: [
      { matcher: EDIT_TOOLS_MATCHER, hooks: [postEdit, postEditScope] },
      { matcher: "Bash", hooks: [postBash, postGitCommand] },
      { matcher: MCP_TOOLS_MATCHER, hooks: [postWriter] },
      { matcher: "Agent|Task|Workflow", hooks: [postIsolated] },
      { matcher: "EnterWorktree|ExitWorktree", hooks: [postWorktreeTool] }, // M05b (§39.4)
      { matcher: "Skill", hooks: [postWriter, postSkill] }, // MARK: r2-skills-side (§31.1, M35; §33.5, M20)
    ],
    PostToolUseFailure: [
      { matcher: "Bash", hooks: [postBash, postGitCommand] },
      { matcher: MCP_TOOLS_MATCHER, hooks: [postWriter] },
      { matcher: "Skill", hooks: [postWriter] }, // MARK: r2-skills-side (§31.1, M35)
    ],
  };
}
