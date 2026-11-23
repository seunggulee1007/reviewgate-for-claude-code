/**
 * docs/PROTOCOL.md §64: review first — Claude's next work waits until the user has reviewed its last changes. One decision
 * for both kinds of chat: a classic chat's PreToolUse hooks (hooks.ts) and a terminal chat's (terminalSession.ts) ask the
 * engine for what waits (`reviewFirstWaiting`) and deny what would change files (`reviewFirstToolReason`); the engine
 * refuses a prompt in `prompts` mode (`reviewFirstPromptReason`) and tells Claude the rule with every prompt while files
 * wait (`reviewFirstContext`).
 */
import { isReadOnlyCommand, type ReadOnlyContext } from "./bashClass.js";

/** `edits` (the default): file-changing tools are denied while files wait; `prompts`: a new prompt too; `off`: neither. */
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

const EDIT_TOOLS_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

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

/** What Claude gets for a denied call (verbatim). */
export function reviewFirstToolReason(paths: readonly string[]): string {
  return (
    `[Review gate] ${countFiles(paths.length)} waiting for the user's review (${named(paths)}). Do not change files until the ` +
    "user accepts or rejects them — answer questions, read and plan only."
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
export function reviewFirstContext(paths: readonly string[]): string {
  return `[Review gate] ${paths.length === 1 ? "1 file awaits" : `${paths.length} files await`} review; questions only until then.`;
}

/**
 * The rule for one tool call: the deny reason, or null when it may go on (nothing waits, or it changes no file).
 * `waiting` is `reviewFirstWaiting`'s answer at the moment of the call.
 */
export function reviewFirstToolDecision(
  waiting: readonly string[] | null,
  toolName: string,
  input: Record<string, unknown>,
  opts: { file?: string; exempt?: (file: string) => boolean; ro?: ReadOnlyContext } = {},
): string | null {
  if (!waiting || waiting.length === 0) return null;
  return changesFiles(toolName, input, opts) ? reviewFirstToolReason(waiting) : null;
}

/**
 * The rule for a new prompt: the block reason in `prompts` mode while files wait, else null. A slash command (`/compact`,
 * `/clear`) starts no work of Claude's on the code and is never held.
 */
export function reviewFirstPromptDecision(mode: ReviewFirstMode, waiting: readonly string[] | null, prompt: string): string | null {
  if (mode !== "prompts" || !waiting || waiting.length === 0 || prompt.trim().startsWith("/")) return null;
  return reviewFirstPromptReason(waiting);
}
