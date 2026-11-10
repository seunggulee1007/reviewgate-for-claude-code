/**
 * MARK: wave4b w4b-auto — docs/PROTOCOL.md §39.5: the auto mode that does not ask for every command.
 *
 * In `permissionMode: "auto"` the PreToolUse hooks no longer force `ask` on the tools that are not edits and not
 * read-only (Bash, WebFetch, MCP tools, …): the CLI's own rules and its auto-mode classifier decide, as in the terminal.
 * Everything the review gate owns stays as it was — the git card for what throws away work or rewrites the remote (§46),
 * the budget, the worktree / isolation rules (§33.4), the reason cards (§33.3, §33.9) and the review of every file a call
 * changed (the post-Bash snapshot). What the classifier blocked becomes a gray chat row; a CLI that cannot run auto mode
 * (the model, a policy) is said once.
 */
import { basename, isAbsolute, join } from "node:path";
import type { PermissionMode } from "../protocol.js";
import { CommandRefused } from "../errors.js";
import { redactDetail } from "./cliRecords.js";
import { parseCommands, walkCommands } from "./gitDestructive.js";
import { userRuleApplies, type McpToolHints } from "./permissionRules.js";

/**
 * Tools that keep the app's card in auto mode too: a message to another session or agent (§33.2: it can make another
 * session act), a question for the user and ExitPlanMode (the engine turns it into the plan card, §11). EnterPlanMode
 * does not (MARK: wave6 w6-terminal, §44.1): it only restricts Claude, and the CLI itself runs it without asking in auto mode.
 * MARK: r2-peers — SendMessage keeps it only for a recipient the session cannot verify: one of the user's live sessions or
 * this session's own subagent goes to the CLI before this is consulted (hooks.ts `sendMessageDecision`, §33.2).
 */
export const AUTO_MODE_KEEPS_CARD: ReadonlySet<string> = new Set(["SendMessage", "AskUserQuestion", "ExitPlanMode"]);

/**
 * MARK: r2-peers — the engine runs the session in auto mode and the CLI says so too (`cliMode`, the hook input's
 * `permission_mode`; absent — an older CLI — counts as the engine's word). Plan mode entered from auto mode is not it.
 */
export function inAutoMode(engineMode: PermissionMode | undefined, cliMode: unknown): boolean {
  return engineMode === "auto" && (cliMode === undefined || cliMode === null || cliMode === "auto");
}

/**
 * True when the PreToolUse hook leaves a call that would otherwise get the card (`needsAsk`, no allow rule of the app) to
 * the CLI: the engine runs the session in auto mode and the CLI says so too — `cliMode` is the hook input's
 * `permission_mode` (CLI 2.1.309: `"default"` when the model or a policy cannot run auto mode — then the cards stay);
 * absent (an older CLI) counts as the engine's mode. Never for `AUTO_MODE_KEEPS_CARD`. Consulted only after every deny
 * and every reason card was decided.
 *
 * MARK: wave6 w6-terminal — §44.1: plan mode entered from auto mode (`prePlanMode: "auto"`, by Claude's EnterPlanMode or the
 * mode menu) is still the user's auto mode: what cannot change anything (`userRuleApplies`: WebFetch, WebSearch, Agent, MCP
 * tools that only read, …) and a command the plan rules did not deny (M19, §19.4: only one that clearly writes) go to the CLI too, which
 * judges them with its classifier in plan mode. Edits stay denied there; a writing MCP call and any other tool keep the card.
 */
export function autoModeDecides(
  toolName: string,
  engineMode: PermissionMode | undefined,
  cliMode: unknown,
  input?: Record<string, unknown>,
  prePlanMode?: PermissionMode,
  hints?: McpToolHints,
): boolean {
  const planFromAuto = engineMode === "plan" && prePlanMode === "auto";
  if (engineMode !== "auto" && !planFromAuto) return false;
  if (cliMode !== undefined && cliMode !== null && cliMode !== "auto" && !(planFromAuto && cliMode === "plan")) return false;
  if (AUTO_MODE_KEEPS_CARD.has(toolName)) return false;
  if (toolName === "Bash" && autoModeKeepsCommandCard(typeof input?.command === "string" ? input.command : "")) return false; // MARK: wave4b w4b-check4
  if (toolName.startsWith("mcp__") && autoModeKeepsMcpCard(input)) return false; // MARK: wave4c w4c-trust (§41.2)
  if (planFromAuto) return toolName === "Bash" || toolName === "EnterPlanMode" || userRuleApplies(toolName, hints);
  return true;
}

// MARK: wave4c w4c-trust — §41.2: an MCP tool (a filesystem server) writing into `.git/` asks (r1-git: a Bash command only
// for ReviewGate's own state there, below).

/** Input keys that name a path (not the written content): `path`, `file_path`, `source`, `destination`, `paths`, a `uri` … */
const MCP_PATH_KEY_RE = /path|source|destination|target|dir|file|uri|location/i;
/** A path segment `.git` (`/repo/.git/hooks/x`, `C:\r\.git\config`, `/repo/.git`); not `.gitignore` / `.github`. */
const GIT_SEGMENT_RE = /(?:^|[/\\])\.git(?:[/\\]|$)/;

/**
 * True when an MCP call names a path inside a `.git` folder in one of its path arguments (top-level strings or string
 * arrays): a hook written there runs on the next commit; another worktree's `reviewgate/incoming/*.json` moves a chat.
 */
export function autoModeKeepsMcpCard(input: Record<string, unknown> | undefined): boolean {
  if (!input) return false;
  for (const [key, value] of Object.entries(input)) {
    if (!MCP_PATH_KEY_RE.test(key)) continue;
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === "string" && GIT_SEGMENT_RE.test(v.trim()))) return true;
  }
  return false;
}

// MARK: wave4b w4b-check4 — §40.1; r1-git — git in auto mode runs as in the terminal.

/**
 * ReviewGate's own state inside git: `<git dir>/reviewgate/` (chats, remembered allows, attachments), `<git dir>/reviewgate-
 * review.json` and `refs/reviewgate/` (the review's pinned trees) — also through a linked worktree's `.git/worktrees/<name>/`.
 */
const REVIEWGATE_STATE_RE =
  /(?:^|[\s'"=:/\\(<>|;&])\.git[/\\](?:[^\s'"`;&|<>]*[/\\])?reviewgate|(?:^|[\s'"=:/\\(<>|;&^])refs[/\\]reviewgate(?![\w-])/i;

/**
 * The `.git` folder itself (`rm -rf .git`, `mv .git x`, `./.git/`), which holds ReviewGate's state and the commits. Not
 * `.gitignore` / `.github`; any other path inside `.git` only when a command deletes or overwrites what holds the commits
 * (`GIT_STORE_RE`).
 */
const GIT_FOLDER_RE = /(?:^|[\s'"=:/\\(<>|;&])\.git[/\\]?(?=[\s'"`)<>|;&]|$)/i;

/** ReviewGate's state or the `.git` folder itself, named in a text. */
function namesGitState(text: string): boolean {
  return REVIEWGATE_STATE_RE.test(text) || GIT_FOLDER_RE.test(text);
}

/**
 * Inside `.git`, what holds the commits and branches the review cannot bring back: `refs`, `objects`, `logs` (with what is
 * in them), `packed-refs`, `index`, `HEAD` — a linked worktree's under `worktrees/<name>/` too — or a glob over the folder
 * (`.git/*`): the stash, unpushed commits and the review's pinned trees. Not a lock file (`index.lock`), `info/`, `hooks/`
 * or `config`: the CLI's to judge, as in the terminal.
 */
const GIT_STORE_RE = /(?:^|[/\\])\.git[/\\](?:worktrees[/\\][^/\\]+[/\\])?(?:[^/\\]*[*?[]|(?:refs|objects|logs)(?:[/\\]|$)|(?:packed-refs|index|HEAD)$)/i;

/** Commands that delete or overwrite every file they are given. */
const REMOVERS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "mv", "tee"]);
/** Commands that write their last operand (or the folder of `-t`). */
const COPIERS: ReadonlySet<string> = new Set(["cp", "ln", "install", "rsync", "ditto"]);

/** The files a command deletes or overwrites, as written: every operand of `rm` / `mv` / …, `cp`'s target, `dd of=`, `find … -delete`'s start points. */
export function writtenPaths(w: readonly string[]): string[] {
  const name = basename(w[0]!);
  const ops = w.slice(1).filter((a) => !a.startsWith("-"));
  if (REMOVERS.has(name)) return ops;
  if (COPIERS.has(name)) {
    const t = w.findIndex((a) => a === "-t" || a === "--target-directory");
    const eq = w.find((a) => a.startsWith("--target-directory="));
    return [ops[ops.length - 1], t > 0 ? w[t + 1] : undefined, eq?.slice("--target-directory=".length)].filter((x): x is string => !!x);
  }
  if (name === "dd") return w.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
  if (name === "find" && w.includes("-delete")) {
    const end = w.findIndex((a, k) => k > 0 && (a.startsWith("-") || a === "(" || a === "!"));
    return w.slice(1, end === -1 ? w.length : end);
  }
  return [];
}

/** Flags whose value is what a command leaves out (`--exclude .git`, `--exclude-dir .git`, `--ignore .git`). */
const EXCLUDE_FLAG_RE = /^--(?:exclude|ignore)(?:-dir)?$/i;
/** The same with the value attached: any `--…exclude…=` / `--…ignore…=` (`--exclude=.git`, `--exclude-dir=.git`). */
const EXCLUDE_ASSIGN_RE = /^--[\w-]*(?:exclude|ignore)[\w-]*=/i;
/** find's tests that take a name or path pattern. */
const FIND_PATTERN_TEST_RE = /^-(?:i?name|i?path|i?wholename|i?regex)$/;
/** find's actions that change what a test matched. */
const FIND_ACTION_RE = /^-(?:delete|exec|execdir|ok|okdir)$/;

/**
 * The words of a command (indexes into `w`, its program's words) that only name what it leaves out: an exclusion flag's
 * value (`tar --exclude=.git`, `rsync --exclude .git`, `grep --exclude-dir=.git`) — unless the command deletes what it
 * excludes (`rsync --delete-excluded`) — and the pattern of a find test it prunes without acting on it (`find . -path ./.git
 * -prune -o …`, `find . \( -name .git -o -name node_modules \) -prune -o …`). A negated test (`! -name .git`) is not one:
 * it leaves the folder's contents in.
 */
function leftOutWords(w: readonly string[]): Set<number> {
  const out = new Set<number>();
  if (w.length > 0 && basename(w[0]!) === "find") {
    for (let k = 1; k + 1 < w.length; k++) if (FIND_PATTERN_TEST_RE.test(w[k]!) && findPrunesOnly(w, k + 2)) out.add(k + 1);
  }
  if (w.includes("--delete-excluded")) return out;
  for (let k = 1; k < w.length; k++) {
    if (EXCLUDE_ASSIGN_RE.test(w[k]!)) out.add(k);
    else if (EXCLUDE_FLAG_RE.test(w[k]!) && k + 1 < w.length) out.add(++k);
  }
  return out;
}

/**
 * Whether the and-chain of a find test, from `k` on (after its pattern), prunes what the test matched and does nothing else
 * to it: a `-prune` before the chain's `-o` / `,` / end and no `-delete` / `-exec` / `-ok`. A chain that ends inside a group
 * (`\( -name .git -o -name node_modules \)`) goes on after the group's `\)`.
 */
function findPrunesOnly(w: readonly string[], k: number): boolean {
  let prune = false;
  let depth = 0;
  for (let i = k; i < w.length; i++) {
    const a = w[i]!;
    if (FIND_ACTION_RE.test(a)) return false;
    if (a === "-prune") prune = true;
    else if (a === "(") depth++;
    else if (a === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (a === "-o" || a === "-or" || a === ",")) {
      let d = 0;
      let j = i + 1;
      for (; j < w.length; j++) {
        if (w[j] === "(") d++;
        else if (w[j] === ")" && d-- === 0) break;
      }
      if (j >= w.length) break;
      i = j;
    }
  }
  return prune;
}

/** Where `walkCommands` starts a line: a folder of its own, so a path written after a `cd` is read where it points. */
const LINE_START = "/";

/**
 * True when a Bash command keeps the app's card in auto mode too: it names ReviewGate's own state in git or the `.git` folder
 * itself (`REVIEWGATE_STATE_RE`, `GIT_FOLDER_RE`), or deletes / overwrites what holds the commits (`GIT_STORE_RE`: `rm -rf
 * .git/refs`, `rm -rf .git/*`, `> .git/index`, `cd .git && rm -rf refs`; also in a script a shell runs, `walkCommands`). A
 * name that only leaves the folder out does not count: an exclusion flag's value or a find path it prunes (`leftOutWords`:
 * `tar --exclude=.git`, `find . -path ./.git -prune -o …`). r1-git: a push, `git config`, a ref write and any other path
 * inside `.git/` go to the CLI's rules and classifier (a push that rewrites the remote has the git card in every mode, §46).
 * Read-only commands never get here: the app's read-only rule allowed them first.
 */
export function autoModeKeepsCommandCard(command: string): boolean {
  if (!/git|reviewgate/i.test(command.replace(/['"\\]/g, ""))) return false;
  const kept = (p: string) => namesGitState(p) || GIT_STORE_RE.test(p);
  // A redirection's file — a shell's too (walkCommands goes into its script instead of handing the shell on).
  if (parseCommands(command).some((c) => (c.writes ?? []).some(kept))) return true;
  let hit = false;
  walkCommands(command, LINE_START, ({ words, cmd, dir }) => {
    if (hit) return;
    const at = (p: string) => (dir === LINE_START || isAbsolute(p) ? [p] : [p, join(dir, p)]);
    const skip = leftOutWords(words);
    const offset = cmd.words.length - words.length; // `words` is `cmd.words` without its wrappers and assignments
    hit =
      REVIEWGATE_STATE_RE.test(dir) ||
      [...writtenPaths(words), ...(cmd.writes ?? [])].flatMap(at).some(kept) ||
      cmd.words.some((w, k) => !skip.has(k - offset) && namesGitState(w)) ||
      (cmd.input !== undefined && namesGitState(cmd.input));
  });
  return hit;
}

/** The `permission_mode` of a hook input (CLI 2.1.30x), undefined when it carries none. */
export function hookPermissionMode(input: unknown): unknown {
  return input && typeof input === "object" ? (input as { permission_mode?: unknown }).permission_mode : undefined;
}

/** The notices of §39.5: chat rows (`error{fatal: false, scope: "session"}`, no `state.lastError`, never a stopped queue). */
export const AUTO_MODE_NOTICE_CODES: ReadonlySet<string> = new Set(["auto_mode_denied", "auto_mode_unavailable"]);

export function isAutoModeNotice(code: string | undefined): boolean {
  return code !== undefined && AUTO_MODE_NOTICE_CODES.has(code);
}

export type AutoModeNotice = {
  code: "auto_mode_denied" | "auto_mode_unavailable";
  message: string;
  /** auto_mode_denied: `<the call> — <the classifier's reason>` (masked, one line) — the merge key of repeats. */
  detail?: string;
  toolName?: string;
};

/** Longest call text a row keeps (the command's first line). */
const CALL_MAX = 160;

/** What a denied call did, for its row: a Bash command's first line, a URL / query / path, else nothing (the tool name says it). */
export function autoCallText(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const pick = (k: string) => (typeof input[k] === "string" && (input[k] as string).trim() ? (input[k] as string) : undefined);
  const raw = toolName === "Bash" ? pick("command") : pick("url") ?? pick("query") ?? pick("file_path") ?? pick("path") ?? pick("description");
  if (!raw) return "";
  const line = redactDetail(raw);
  return line.length > CALL_MAX ? line.slice(0, CALL_MAX - 1) + "…" : line;
}

/**
 * `system/permission_denied` (CLI 2.1.309) of the auto-mode classifier (`decision_reason_type: "classifier"`) →
 * `auto_mode_denied`; other denials (a deny rule, dontAsk, …) → null (the tool row says it failed). `input` is the denied
 * call's input (from its `tool_use`, which arrives first). Verified with haiku: an `autoMode.soft_deny` rule against
 * `mvn` gave `decision_reason: "[Security Weaken]"` and no `can_use_tool`.
 */
export function autoModeDeniedNotice(msg: { tool_name?: unknown; decision_reason_type?: unknown; decision_reason?: unknown }, input?: Record<string, unknown>): AutoModeNotice | null {
  if (msg.decision_reason_type !== "classifier") return null;
  const toolName = typeof msg.tool_name === "string" && msg.tool_name ? msg.tool_name : "tool";
  const call = autoCallText(toolName, input) || toolName;
  const why = typeof msg.decision_reason === "string" && msg.decision_reason.trim() ? redactDetail(msg.decision_reason) : "";
  const detail = why ? `${call} — ${why}` : call;
  return { code: "auto_mode_denied", message: `Auto mode blocked: ${detail}`, detail, toolName };
}

/** The session asked for auto mode and the CLI started (or stayed) in another one: the model or a policy cannot run it. */
export function autoModeUnavailableNotice(cliMode: string): AutoModeNotice {
  return {
    code: "auto_mode_unavailable",
    message: `Auto mode is not available here (this model or a policy turns it off); Claude Code runs in ${cliMode} mode and asks for commands.`,
    detail: cliMode,
  };
}

/**
 * `Query.setPermissionMode("auto")` rejected by the CLI ("Cannot set permission mode to auto: auto mode unavailable for
 * this model", CLI 2.1.309) → the refusal `auto_mode_unavailable` clients localize; anything else → null (rethrown as is).
 */
export function autoModeRefusal(mode: PermissionMode, e: unknown): CommandRefused | null {
  if (mode !== "auto") return null;
  const text = e instanceof Error ? e.message : String(e);
  return /auto mode (is )?(unavailable|disabled|not available)/i.test(text) ? new CommandRefused(`auto_mode_unavailable: ${text}`) : null;
}
