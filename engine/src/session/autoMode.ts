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
import type { PermissionMode } from "../protocol.js";
import { CommandRefused } from "../errors.js";
import { redactDetail } from "./cliRecords.js";
import { userRuleApplies, type McpToolHints } from "./permissionRules.js";

/**
 * Tools that keep the app's card in auto mode too: a message to another session or agent (§33.2: it can make another
 * session act), a question for the user and ExitPlanMode (the engine turns it into the plan card, §11). EnterPlanMode
 * does not (MARK: wave6 w6-terminal, §44.1): it only restricts Claude, and the CLI itself runs it without asking in auto mode.
 */
export const AUTO_MODE_KEEPS_CARD: ReadonlySet<string> = new Set(["SendMessage", "AskUserQuestion", "ExitPlanMode"]);

/**
 * True when the PreToolUse hook leaves a call that would otherwise get the card (`needsAsk`, no allow rule of the app) to
 * the CLI: the engine runs the session in auto mode and the CLI says so too — `cliMode` is the hook input's
 * `permission_mode` (CLI 2.1.309: `"default"` when the model or a policy cannot run auto mode — then the cards stay);
 * absent (an older CLI) counts as the engine's mode. Never for `AUTO_MODE_KEEPS_CARD`. Consulted only after every deny
 * and every reason card was decided.
 *
 * MARK: wave6 w6-terminal — §44.1: plan mode entered from auto mode (`prePlanMode: "auto"`, by Claude's EnterPlanMode or the
 * mode menu) is still the user's auto mode: what cannot change anything (`userRuleApplies`: WebFetch, WebSearch, Agent, MCP
 * tools that only read, …) and a read-only command (the plan rules denied every other one first) go to the CLI too, which
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
 * review.json` and `refs/reviewgate/` (the review's pinned trees) — also through a linked worktree's `.git/worktrees/<name>/`
 * — and the `.git` folder itself (`rm -rf .git`, `mv .git x`), which holds them. Not `.gitignore` / `.github`, and no
 * other path inside `.git` (`.git/index.lock`, `.git/info/exclude`, `.git/hooks/x`: the CLI's to judge, as in the terminal).
 */
const REVIEWGATE_STATE_RE =
  /(?:^|[\s'"=:/\\(<>|;&])\.git(?:[/\\](?:[^\s'"`;&|<>]*[/\\])?reviewgate|[/\\]?(?=[\s'"`)<>|;&]|$))|(?:^|[\s'"=:/\\(<>|;&^])refs[/\\]reviewgate(?![\w-])/i;

/**
 * True when a Bash command keeps the app's card in auto mode too: it names ReviewGate's own state in git (`REVIEWGATE_STATE_RE`).
 * r1-git: a push, `git config`, a ref write and any other path inside `.git/` go to the CLI's rules and classifier (a push
 * that rewrites the remote has the git card in every mode, §46). Read-only commands never get here: the app's read-only
 * rule allowed them first.
 */
export function autoModeKeepsCommandCard(command: string): boolean {
  return REVIEWGATE_STATE_RE.test(command);
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
