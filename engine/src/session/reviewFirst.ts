/**
 * docs/PROTOCOL.md §64: review first — Claude's next work waits until the user has reviewed its last changes. One decision
 * for both kinds of chat: a classic chat's PreToolUse hooks (hooks.ts) and a terminal chat's (terminalSession.ts) ask the
 * engine what holds Claude back (`ReviewFirstHold`) and deny what the rule does not let through
 * (`reviewFirstToolDecision`); the engine refuses a prompt in `prompts` mode (`reviewFirstPromptReason`) and tells Claude
 * the rule with every prompt while files wait (`reviewFirstContext`).
 */
import { HOST_FLAVOR, toRepoRelative } from "../platform/paths.js";
import { isReadOnlyCommand, type ReadOnlyContext } from "./bashClass.js";

/**
 * `edits` (the default): while files wait, Claude may fix the files under review, but not edit any other file;
 * `prompts`: every file-changing call is denied and a new prompt is refused; `off`: neither. (Before 0.5.26 `edits`
 * denied every file-changing call, as `prompts` still does.)
 */
export const REVIEW_FIRST_MODES = ["edits", "prompts", "off"] as const;
export type ReviewFirstMode = (typeof REVIEW_FIRST_MODES)[number];

/** The setting as sent (absent, unknown: the default, `edits`). */
export function reviewFirstMode(v: unknown): ReviewFirstMode {
  return typeof v === "string" && (REVIEW_FIRST_MODES as readonly string[]).includes(v) ? (v as ReviewFirstMode) : "edits";
}

/** What the rule needs of the review: the collected list (a turn's own files reach it only when the turn ended). */
export type ReviewFirstReview = {
  files: readonly { path: string; state: string }[];
  /** A change request runs (`gate.isRequestingChanges`, or its notes went to Claude at a terminal Stop): that turn is meant to edit. */
  requestingChanges: boolean;
};

/**
 * The paths the rule waits on — pending or changes-requested files of the review — or null when nothing holds Claude
 * back: the rule is off, nothing waits, or a change request runs. A running turn's own changes are not in the list
 * until its collection, so the turn that makes them is never held back by them.
 */
export function reviewFirstWaiting(mode: ReviewFirstMode, review: ReviewFirstReview): string[] | null {
  if (mode === "off" || review.requestingChanges) return null;
  const paths = review.files.filter((f) => f.state === "pending" || f.state === "changesRequested").map((f) => f.path);
  return paths.length > 0 ? paths : null;
}

/**
 * What holds Claude back at the moment of a call (null: nothing — the rule is off, nothing waits, a change request runs,
 * or the user allowed the current turn).
 */
export type ReviewFirstHold = {
  mode: Exclude<ReviewFirstMode, "off">;
  /** The files waited on (pending, changes requested) — named in the reason. */
  waiting: readonly string[];
  /** `edits`: the repo-relative files of the review Claude may still fix (every state but rejected). */
  fixable: readonly string[];
  /** The repository root the review's paths are relative to (null: no repository open — nothing is fixable). */
  root: string | null;
};

const EDIT_TOOLS_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/** Every file in the review but a rejected one: what `edits` lets Claude fix. */
export function reviewFirstFixable(files: readonly { path: string; state: string }[]): string[] {
  return files.filter((f) => f.state !== "rejected").map((f) => f.path);
}

/**
 * True when the edit tool's `file` (absolute) is one of `fixable` (repo-relative to `root`): resolved as the gate resolves
 * paths (`toRepoRelative`: symlinks, and the on-disk case on macOS / Windows); a file that does not exist yet is compared
 * without regard to case there too, as those file systems are case-insensitive by default.
 */
export function isFixable(file: string, fixable: readonly string[], root: string | null): boolean {
  if (!root || fixable.length === 0) return false;
  const rel = toRepoRelative(file, root);
  if (rel === null) return false;
  if (fixable.includes(rel)) return true;
  if (HOST_FLAVOR !== "win32" && process.platform !== "darwin") return false;
  const key = rel.toLowerCase();
  return fixable.some((p) => p.toLowerCase() === key);
}

/**
 * True when `toolName` / `input` would change files: an edit tool (but for `exempt` files — a plan file in plan mode,
 * Claude's memory: outside the review) or a Bash command the read-only classifier does not pass (`ro`: where it runs,
 * §19.3). Every other tool — reads, searches, subagents (their own calls are checked), MCP tools — follows the usual
 * permission flow.
 */
export function changesFiles(toolName: string, input: Record<string, unknown>, opts: { file?: string; exempt?: (file: string) => boolean; ro?: ReadOnlyContext } = {}): boolean {
  if (EDIT_TOOLS_RE.test(toolName)) return !(opts.file && opts.exempt?.(opts.file));
  if (toolName === "Bash") return !isReadOnlyCommand(typeof input.command === "string" ? input.command : "", opts.ro);
  return false;
}

const SHOWN = 3;

function countFiles(n: number): string {
  return n === 1 ? "1 file is" : `${n} files are`;
}

function named(paths: readonly string[]): string {
  return paths.slice(0, SHOWN).join(", ") + (paths.length > SHOWN ? ", …" : "");
}

/** What Claude gets for a denied call in `prompts` mode (verbatim). */
export function reviewFirstToolReason(paths: readonly string[]): string {
  return (
    `[Review gate] ${countFiles(paths.length)} waiting for the user's review (${named(paths)}). Do not change files until the ` +
    "user accepts or rejects them — answer questions, read and plan only."
  );
}

/** What Claude gets for a denied edit in `edits` mode — of a file not under review (verbatim). */
export function reviewFirstFixReason(paths: readonly string[]): string {
  return (
    `[Review gate] ${countFiles(paths.length)} waiting for the user's review (${named(paths)}). You may fix those files; ` +
    "changes to other files wait until the user has reviewed them."
  );
}

/** What a blocked terminal prompt shows in the TUI (`prompts` mode). */
export function reviewFirstPromptReason(paths: readonly string[]): string {
  return (
    `ReviewGate: finish the review first — ${countFiles(paths.length)} waiting (${named(paths)}). Accept or reject them in ` +
    "ReviewGate, then send this again."
  );
}

/** The one line every prompt carries while files wait (a chat's message, a terminal prompt's `additionalContext`). */
export function reviewFirstContext(mode: ReviewFirstMode, paths: readonly string[]): string {
  const n = paths.length === 1 ? "1 file awaits" : `${paths.length} files await`;
  if (mode === "prompts") return `[Review gate] ${n} review; questions only until then.`;
  return `[Review gate] ${n} review. Fixing ${paths.length === 1 ? "it" : "them"} is fine; other changes wait until the user reviewed ${paths.length === 1 ? "it" : "them"}.`;
}

/**
 * The rule for one tool call: the deny reason, or null when it may go on. `edits`: only an edit tool's change to a file
 * that is not under review is denied (Bash runs — tests and builds go with a fix, and what a command changes reaches the
 * review anyway); `prompts`: every call that changes files (`changesFiles`).
 */
export function reviewFirstToolDecision(
  hold: ReviewFirstHold | null,
  toolName: string,
  input: Record<string, unknown>,
  opts: { file?: string; exempt?: (file: string) => boolean; ro?: ReadOnlyContext } = {},
): string | null {
  if (!hold || hold.waiting.length === 0) return null;
  if (hold.mode === "prompts") return changesFiles(toolName, input, opts) ? reviewFirstToolReason(hold.waiting) : null;
  if (!EDIT_TOOLS_RE.test(toolName)) return null;
  if (opts.file && (opts.exempt?.(opts.file) || isFixable(opts.file, hold.fixable, hold.root))) return null;
  return reviewFirstFixReason(hold.waiting);
}

/**
 * The rule for a new prompt: the block reason in `prompts` mode while files wait, else null. A slash command (`/compact`,
 * `/clear`) starts no work of Claude's on the code and is never held.
 */
export function reviewFirstPromptDecision(mode: ReviewFirstMode, waiting: readonly string[] | null, prompt: string): string | null {
  if (mode !== "prompts" || !waiting || waiting.length === 0 || prompt.trim().startsWith("/")) return null;
  return reviewFirstPromptReason(waiting);
}
