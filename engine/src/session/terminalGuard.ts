/**
 * MARK: terminal-guard — docs/PROTOCOL.md §57.8: the PreToolUse guard of a terminal chat. Claude Code's TUI keeps its own
 * permission flow (its modes, rules and classifier); on top of it ReviewGate makes the TUI ask the user — in every mode —
 * before a git command that changes the repository (a commit, a push, a merge, a checkout, …) and before an edit the review
 * does not see (outside the project, a nested repository, `.git`, Claude Code's settings), and blocks a git command that
 * throws away uncommitted work or rewrites the remote (§46 `destructiveGitReason`). The command line is read as §46 reads
 * it (`gitInvocations`: chains, pipes, `bash -c` / `sh -c` / `eval`, substitutions, `xargs`, `find -exec`, `git -C`).
 */
import { gitWordsAreReadOnly } from "./bashClass.js";
import { programName } from "../platform/paths.js";
import { destructiveGitReason, gitInvocations, programWords, shellCommands, type GitProbe } from "./gitDestructive.js";
import { isClaudeMemoryFile, isOutsideRoot } from "./hooks.js";
import { editScopeReason } from "./reviewScope.js";

/** What the guard answers a PreToolUse with (null: nothing — the TUI's own permission flow decides). */
export type GuardDecision = { decision: "ask" | "deny"; reason: string };

export const TERMINAL_GIT_ASK_REASON =
  "ReviewGate: this git command changes the repository — confirm it (the review of this turn is not accepted yet)";
export const TERMINAL_GIT_DENY_REASON =
  "ReviewGate blocked this git command: it throws away uncommitted work or rewrites the remote, which the review cannot " +
  "bring back. Do not run it or a workaround; ask the user in the chat whether they want it run.";
/** `bypassPermissions` / `dontAsk`: the TUI would not ask, so what would ask is blocked with this (the user can switch modes). */
export const TERMINAL_GIT_NO_ASK_REASON =
  "ReviewGate blocked this git command: it changes the repository and the review of this turn is not accepted yet, and in " +
  "this permission mode Claude Code cannot ask the user. Ask the user in the chat whether to run it.";
export const terminalEditAskReason = (message: string): string => `ReviewGate: ${message} Confirm this edit.`;
export const terminalEditNoAskReason = (message: string): string =>
  `ReviewGate blocked this edit: ${message} In this permission mode Claude Code cannot ask the user — ask them in the chat first.`;

/** git verbs outside `isReadOnlyCommand`'s list that change neither the working tree, the index nor a branch. */
const HARMLESS_VERBS: ReadonlySet<string> = new Set(["version", "help", "fetch", "ls-remote", "check-ignore", "shortlog", "var", "count-objects"]);

/** Modes in which Claude Code never shows its permission dialog: an `ask` there would not reach the user. */
const NO_ASK_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "dontAsk"]);

/** True when one of the line's git commands may change the repository (or `gh pr checkout|merge`, which moves HEAD). */
export function gitChangesRepository(command: string, cwd: string): boolean {
  if (!/g[ih]/i.test(command)) return false;
  for (const g of gitInvocations(command, cwd)) {
    if (g.verb === null) continue; // `git --version`, a bare `git`
    if (HARMLESS_VERBS.has(g.verb)) {
      if (g.verb === "fetch" && g.args.some((a) => a === "--prune" || a === "-p" || a.startsWith("--prune"))) return true;
      continue;
    }
    if (g.verb === "reflog") {
      const sub = g.args.find((a) => !a.startsWith("-"));
      if (sub === "expire" || sub === "delete") return true;
      continue;
    }
    // What xargs / find -exec add at run time may be anything: only a read-only verb with read-only words stays quiet.
    if (!gitWordsAreReadOnly(g.globals, g.verb, g.args)) return true;
  }
  return shellCommands(command).some((w) => {
    const p = programWords(w);
    return p.length >= 3 && programName(p[0]!) === "gh" && p[1] === "pr" && (p[2] === "checkout" || p[2] === "merge");
  });
}

export type BashGuardOptions = {
  /** Where the command runs (the hook's `cwd`). */
  cwd: string;
  /** The checkpoint root (the review's paths are relative to it). */
  root: string;
  /** Repo-relative paths still under review. */
  reviewPaths: ReadonlySet<string>;
  /** The TUI's permission mode (the hook's `permission_mode`, `bypassPermissions` / `dontAsk` included). */
  mode?: string | undefined;
  probe?: GitProbe;
};

/** A Bash command: deny what destroys work (§46), ask before any other git change; null for everything else. */
export async function terminalBashDecision(command: string, o: BashGuardOptions): Promise<GuardDecision | null> {
  if (!/g[ih]/i.test(command)) return null;
  const destroys = await destructiveGitReason(command, { cwd: o.cwd, root: o.root, reviewPaths: o.reviewPaths, ...(o.probe ? { probe: o.probe } : {}) });
  if (destroys) return { decision: "deny", reason: TERMINAL_GIT_DENY_REASON };
  if (!gitChangesRepository(command, o.cwd)) return null;
  return o.mode !== undefined && NO_ASK_MODES.has(o.mode)
    ? { decision: "deny", reason: TERMINAL_GIT_NO_ASK_REASON }
    : { decision: "ask", reason: TERMINAL_GIT_ASK_REASON };
}

export type EditGuardOptions = {
  root: string;
  scratchDirs?: readonly string[] | undefined;
  mode?: string | undefined;
  /** A plan file (plan mode) or Claude's memory: never asked for. */
  isPlanFile?: (file: string) => boolean;
};

/** An edit tool's target the review does not see (§33.3 `editScopeReason`): ask; null for a file of the review. */
export function terminalEditDecision(file: string, o: EditGuardOptions): GuardDecision | null {
  if (o.isPlanFile?.(file) || isClaudeMemoryFile(file)) return null;
  const reason = editScopeReason(file, o.root, isOutsideRoot, [], o.scratchDirs);
  if (!reason) return null;
  const message = reason.message;
  return o.mode !== undefined && NO_ASK_MODES.has(o.mode)
    ? { decision: "deny", reason: terminalEditNoAskReason(message) }
    : { decision: "ask", reason: terminalEditAskReason(message) };
}
