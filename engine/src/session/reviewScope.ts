import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PermissionReason } from "../protocol.js";
import { HOST_FLAVOR, isInside, parseAbs, realpathLenient, relativeInside, samePath, toRepoRelative } from "../platform/paths.js";
import { scanCommand, type ReadOnlyContext } from "./bashClass.js";

/**
 * What the review of this window can see (docs/PROTOCOL.md §33.3–33.4): the snapshot is `git add -A` of the checkpoint
 * root into a temporary index, so a submodule, a nested clone or a worktree below the root is recorded as one gitlink
 * line — edits inside it never reach the review — and a worktree elsewhere is not looked at at all. Pure helpers; the
 * hooks and `canUseTool` decide with them.
 */

/** `path = x` entries of `<root>/.gitmodules` (POSIX, repo-relative): submodules, initialized or not. */
export function submodulePaths(root: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(root, ".gitmodules"), "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]!.replace(/^["']|["']$/g, "").replace(/\\/g, "/").replace(/\/+$/, ""));
  }
  return out;
}

/**
 * The root of the repository `file` lies in when that is a nested one strictly below `root` — a directory between
 * them holding a `.git` entry (a clone, a submodule, a linked worktree such as `.claude/worktrees/<name>`) or listed
 * as a submodule path in `.gitmodules` — else null. The outermost one wins; symlinks are resolved first.
 */
export function nestedRepoRoot(file: string, root: string): string | null {
  const realRoot = realpathLenient(root);
  const rel = relativeInside(realpathLenient(file), realRoot);
  if (rel === null) return null;
  const parts = rel.split("/");
  const submodules = new Set(submodulePaths(realRoot));
  for (let k = 1; k < parts.length; k++) {
    const relDir = parts.slice(0, k).join("/");
    const dir = join(realRoot, ...parts.slice(0, k));
    if (submodules.has(relDir) || existsSync(join(dir, ".git"))) return dir;
  }
  return null;
}

/**
 * §19.3: a folder inside the root or one of the repository's other `worktrees` that lies in a nested repository of its own
 * (a clone, a submodule) — its config is not the repository's. A nested worktree of the repository itself is not foreign.
 */
export function foreignRepoDir(dir: string, root: string, worktrees: readonly string[]): boolean {
  // The deepest of the root and the worktrees holding `dir` is where a nested repository starts.
  let base: string | null = null;
  for (const b of [root, ...worktrees]) {
    if (isInside(dir, b) && (base === null || realpathLenient(b).length > realpathLenient(base).length)) base = b;
  }
  if (base === null) return false;
  const nested = nestedRepoRoot(join(dir, "_"), base);
  return nested !== null && !worktrees.some((w) => samePath(realpathLenient(w), nested));
}

/** §19.3: the read-only classifier's context for a command run in `cwd`: the root, the repository's other worktrees. */
export function readOnlyContext(cwd: string, root: string, worktrees: readonly string[]): ReadOnlyContext {
  return { cwd, root, sameRepoDirs: worktrees, foreignDir: (dir) => foreignRepoDir(dir, root, worktrees) };
}

/** English fallbacks of the §33 card reasons (clients localize on `code`); `claude_config` names its file (`claudeConfigMessage`). */
/** §39.4: the `worktree_command` card of a worktree of another repository. */
export const OTHER_REPO_WORKTREE_MESSAGE =
  "This command creates a git worktree of another repository: work there is outside this window's review, and this chat cannot move there.";

export const SCOPE_MESSAGES: Record<Exclude<PermissionReason["code"], "claude_config">, string> = {
  outside_project: "This edit is outside the project: the review does not show it.",
  nested_repository: "This location is inside a nested repository (submodule, worktree or clone): the review does not show changes there.",
  other_worktree: "This location is in another worktree of the repository: this window's review does not show changes there — open it as a workbench.",
  worktree_command: "This command creates a git worktree: work inside it is outside this window's review.",
  worktree_isolation: "This runs outside this folder (an isolated worktree, another folder or the Workflow tool): its changes are not in this window's review.",
  git_command:
    "This git command changes the repository (a commit, merge, pull, checkout, reset, stash, …): what it brings in is not counted as Claude's edits, and a commit cannot be reverted from the review.",
};

/** Why a directory is outside what the review sees: a nested repository under `root`, or another worktree of the repository. */
export function dirScopeReason(dir: string, root: string, worktrees: readonly string[]): PermissionReason | null {
  const nested = nestedRepoRoot(join(dir, "_"), root);
  if (nested) return { code: "nested_repository", message: SCOPE_MESSAGES.nested_repository, path: nested };
  if (isInside(dir, root)) return null;
  const wt = worktrees.find((w) => isInside(dir, w));
  return wt ? { code: "other_worktree", message: SCOPE_MESSAGES.other_worktree, path: wt } : null;
}

/**
 * Why an edit tool's target needs the card (§33.3): outside the checkpoint root (in another worktree of the
 * repository: `other_worktree`), or inside a nested repository under it (`path` = that repository's root) — or, where
 * the review does see it, one of Claude Code's own settings files (`claude_config`, §33.9; `path` = that file). Null for
 * any other path.
 */
export function editScopeReason(file: string, root: string, isOutside: (file: string, root: string) => boolean, worktrees: readonly string[] = [],
  scratchDirs?: readonly string[]): PermissionReason | null {
  if (isOutside(file, root)) {
    if (isScratchPath(file, scratchDirs)) return null;
    const wt = worktrees.find((w) => isInside(file, w));
    return wt ? { code: "other_worktree", message: SCOPE_MESSAGES.other_worktree, path: wt } : { code: "outside_project", message: SCOPE_MESSAGES.outside_project };
  }
  const nested = nestedRepoRoot(file, root);
  if (nested) return { code: "nested_repository", message: SCOPE_MESSAGES.nested_repository, path: nested };
  const config = claudeConfigFile(file);
  return config ? claudeConfigReason(config, root) : null;
}

// ------------------------------------------------------------------ scratch folders

/**
 * The system's temporary folders — `os.tmpdir()` ($TMPDIR; on macOS under /var/folders), /tmp, /private/tmp, /var/tmp —
 * where Claude Code keeps its scratchpad and Claude writes throwaway files. Real paths of the ones that exist.
 */
export function defaultScratchDirs(): string[] {
  const out: string[] = [];
  for (const d of [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/folders"]) {
    if (!existsSync(d)) continue;
    const real = realpathLenient(d);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * True when an edit target outside the project is a throwaway file: inside one of `scratchDirs` and in no git repository
 * there — a clone or worktree made in /tmp is real work and keeps the outside-the-project card.
 */
export function isScratchPath(file: string, scratchDirs: readonly string[] | undefined): boolean {
  if (!scratchDirs?.length) return false;
  const real = realpathLenient(file);
  const scratch = scratchDirs.find((d) => isInside(real, d));
  if (!scratch) return false;
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return false;
    if (dir === scratch || dirname(dir) === dir || !isInside(dir, scratch)) return true;
  }
}

// ------------------------------------------------------------------ Claude Code's own settings (§33.9)

/**
 * True when `p` names one of Claude Code's own settings files: `settings.json` / `settings.local.json` in a `.claude`
 * folder, or `.mcp.json` — at the project root or in any folder below it (a module the CLI may be started in). They decide
 * which hooks run, which tools are allowed (§33.5 applies the local file's allow rules) and which MCP servers start.
 * Lexical and case-insensitive (macOS / Windows file systems are); on Windows trailing dots / spaces are dropped first.
 */
export function isClaudeConfigPath(p: string): boolean {
  const parts = parseAbs(resolve(p), HOST_FLAVOR).parts;
  const name = parts[parts.length - 1]?.toLowerCase();
  if (name === ".mcp.json") return true;
  return (name === "settings.json" || name === "settings.local.json") && parts[parts.length - 2]?.toLowerCase() === ".claude";
}

/** The settings file (§33.9) an edit tool's target is — as named, else through symlinks (absolute, native) — or null. */
export function claudeConfigFile(file: string): string | null {
  const named = resolve(file);
  if (isClaudeConfigPath(named)) return named;
  const real = realpathLenient(file);
  return isClaudeConfigPath(real) ? real : null;
}

export const CLAUDE_CONFIG_ASK_REASON = "ReviewGate: changes Claude Code's own settings (hooks, permissions, MCP servers) — needs approval";

/** English fallback of the `claude_config` card reason (clients localize on `code` and show `path`). */
export function claudeConfigMessage(display: string): string {
  return (
    `Changes Claude Code's own settings (${display}) — hooks, permissions and MCP servers there change how Claude runs; ` +
    ".claude/settings.local.json is not kept in the review and cannot be reverted."
  );
}

/** `abs` for the message: project-relative when inside `root`, `~/…` under the home folder, else as is. */
function displayPath(abs: string, root: string): string {
  const rel = toRepoRelative(abs, root) ?? relativeInside(resolve(abs), resolve(root));
  if (rel) return rel;
  const home = relativeInside(resolve(abs), homedir());
  return home ? `~/${home}` : abs;
}

/** The card reason of a change to the settings file `abs` (§33.9). */
export function claudeConfigReason(abs: string, root: string): PermissionReason {
  return { code: "claude_config", message: claudeConfigMessage(displayPath(abs, root)), path: abs };
}

/** Anything that may be a settings file's name, `--file=` / `>` / quotes / brackets around it left out. */
const CONFIG_WORD_RE = /[^\s"'`<>|&;()=,]*(?:settings(?:\.local)?\.json|\.mcp\.json)(?![\w.-])/gi;
/** The names a command mentioning counts as touching the project's own file, however it builds the path (a script, …). */
const CONFIG_MENTION_RE = /(?<![\w-])(?:settings\.local\.json|\.claude[\\/]+settings\.json|\.mcp\.json)(?![\w-])/i;
/**
 * Quotes and backslashes split a name for the shell only (`settings.loc""al.json`, `settings.lo\cal.json`); a Windows path
 * keeps its backslashes, so both forms are looked at.
 */
const unquote = (s: string): string => s.replace(/["'\\]/g, "");
const spellings = (s: string): string[] => [...new Set([s, unquote(s)])];

function expandHome(p: string): string {
  if (p === "~" || p === "$HOME" || p === "${HOME}") return homedir();
  const m = /^(?:~|\$HOME|\$\{HOME\})[\\/](.*)$/s.exec(p);
  return m ? join(homedir(), m[1]!) : p;
}

/** The settings file (§33.9) a word names, resolved against `dir`, or null. */
function configInWord(word: string, dir: string): string | null {
  for (const text of spellings(word)) {
    for (const m of text.matchAll(CONFIG_WORD_RE)) {
      const abs = resolve(dir, expandHome(m[0].replace(/^file:\/\//i, "")));
      if (isClaudeConfigPath(abs)) return abs;
    }
  }
  return null;
}

/**
 * The project's own settings file a bare mention stands for (`settings.local.json` → `<root>/.claude/settings.local.json`),
 * absolute and native like the resolved words (`resolve`, not `join`: a drive-less root still gets the host's drive on Windows).
 */
function mentionedConfig(text: string, root: string): string | null {
  const m = spellings(text).map((t) => CONFIG_MENTION_RE.exec(t)).find((x) => x !== null);
  if (!m) return null;
  const name = m[0].toLowerCase();
  if (name === ".mcp.json") return resolve(root, ".mcp.json");
  return resolve(root, ".claude", name.endsWith("settings.local.json") ? "settings.local.json" : "settings.json");
}

/**
 * The Claude Code settings file (§33.9) a Bash command names (absolute): a word that resolves — against the shell's
 * directory after the command's own `cd` / `pushd` — to one (`cd .claude && sed -i … settings.json`, `> .mcp.json`,
 * `~/.claude/settings.json`, a path in a `python3 -c` script), else any mention of `settings.local.json`,
 * `.claude/settings.json` or `.mcp.json` (the project's own file). Null for a command that names none of them; a plain
 * `settings.json` elsewhere (`.vscode/`, the project root) is not one.
 */
export function bashClaudeConfigTarget(command: string, cwd: string, root: string): string | null {
  if (!spellings(command).some((t) => /settings(?:\.local)?\.json|\.mcp\.json/i.test(t))) return null;
  let dir = cwd;
  for (const words of segments(command)) {
    const w = commandWords(words);
    if (w[0] === "cd" || w[0] === "pushd") {
      const arg = w.slice(1).find((a) => !a.startsWith("-"));
      if (arg !== undefined) dir = resolveDir(dir, arg);
      continue;
    }
    for (const word of words) {
      const hit = configInWord(word, dir);
      if (hit) return hit;
    }
  }
  return mentionedConfig(command, root);
}

/** Input keys whose value is a command line (an MCP server that runs commands). */
const COMMAND_KEYS: ReadonlySet<string> = new Set(["command", "commands", "cmd", "script", "shell", "commandline", "command_line"]);
/**
 * MARK: wave2 check-engine — §35.6: input keys whose value is one path (`path`, `file_path`, `filePath`, `pathInProject`,
 * `destination`, `uri`, …), spaces included — a project folder may be called "My Project".
 */
const PATH_KEY_RE = /^path|(?:path|file|filename|uri|dir|directory|destination|dest|target)$/i;

/** The settings file (§33.9) a one-path value names, the whole value read as a path (a `file://` URI decoded), or null. */
function configInPathValue(value: string, root: string): string | null {
  if (value.length > 4096 || /[\r\n]/.test(value)) return null;
  let p = value.trim();
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, "");
    try {
      p = decodeURIComponent(p);
    } catch {
      // kept as written
    }
  }
  const abs = resolve(root, expandHome(p));
  return isClaudeConfigPath(abs) ? abs : null;
}

/**
 * The Claude Code settings file (§33.9) a tool call's input names (absolute; relative paths are the project's): a
 * path-like string value (no whitespace — `pathInProject`, `path`, `file`, nested `edits[].file`, a `file://` URI; under a
 * one-path key such as `path` / `destination` spaces too, §35.6), or a command-line value (`command`, …) read like a Bash
 * command. Free text (a file's new content, a message) never counts.
 */
export function inputClaudeConfigTarget(input: Record<string, unknown>, root: string): string | null {
  const walk = (v: unknown, key: string, depth: number): string | null => {
    if (typeof v === "string") {
      if (COMMAND_KEYS.has(key.toLowerCase())) return bashClaudeConfigTarget(v, root, root);
      if (PATH_KEY_RE.test(key)) {
        const hit = configInPathValue(v, root);
        if (hit) return hit;
      }
      return v.length <= 4096 && !/\s/.test(v) ? configInWord(v, root) : null;
    }
    if (depth >= 4 || !v || typeof v !== "object") return null;
    // An array's items keep the key they are listed under (`commands: [...]`).
    const entries: [string, unknown][] = Array.isArray(v) ? v.map((x) => [key, x]) : Object.entries(v);
    for (const [k, x] of entries) {
      const hit = walk(x, k, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(input, "", 0);
}

// ------------------------------------------------------------------ worktree tools (§33.4)

/** Notices the session raises about work outside this window's review (§33.4); the engine turns them into `error` events. */
export type ScopeNotice = {
  code: "worktree_blocked" | "worktree_outside_review";
  toolName: string;
  toolUseId?: string;
  /** The worktree / nested repository concerned (absolute). */
  path?: string;
  /** The branch Claude wanted (EnterWorktree `name`) or the isolated agent's worktree branch. */
  branch?: string;
  /** MARK: wave4b w4b-follow — §39.4: why the call was on a card (`worktree_command`: it created `path`); engine-internal. */
  reasonCode?: PermissionReason["code"];
  /**
   * §33.4: a command run in another worktree or a nested repository — the files it changed there (relative to `path`,
   * POSIX, sorted, at most 100): what that folder's `git status` shows differently after the call.
   */
  files?: string[];
};

/** English fallback of a notice's `error.message` (clients localize on `code`). */
export function scopeNoticeMessage(n: ScopeNotice): string {
  if (n.code === "worktree_blocked") {
    const what = n.toolName === "EnterWorktree" ? `a git worktree${n.branch ? ` ("${n.branch}")` : ""}` : `${n.toolName} outside this folder`;
    return `Claude tried to work in ${what}; ReviewGate blocked it because this window's review would not see that work. For parallel work, open a separate workbench.`;
  }
  const text = `${n.toolName} worked outside this window's review${n.path ? ` (${n.path})` : ""}: those changes are not reviewed here. Open it as a workbench to review them.`;
  return n.files?.length ? `${text} Changed: ${n.files.join(", ")}` : text;
}

export const ENTER_WORKTREE_REASON =
  "ReviewGate: EnterWorktree is not available here — this window reviews only this folder, and a worktree's changes would bypass that review. " +
  "Keep working in this folder. If the work needs its own branch or worktree, tell the user: they open a separate ReviewGate workbench for it.";
export const ISOLATION_REASON =
  "ReviewGate: agents run in this folder only — `isolation`, an Agent `cwd` outside the project and the Workflow tool put their changes outside " +
  "this window's review, so they are blocked. Run the agent again without `isolation` / `cwd`, or do the work here. If a separate worktree is " +
  "really needed, tell the user: they open a ReviewGate workbench, or allow worktree isolation in ReviewGate's settings.";
export const SCOPE_ASK_REASON = "ReviewGate: works outside this window's review — needs approval";

const SUBAGENT_RE = /^(Agent|Task)$/;

/**
 * A call that runs work outside this folder: the Workflow tool (its agents run in worktrees / in the background), an
 * Agent/Task with `isolation` (`worktree`, `remote`) or with a `cwd` outside the project or in a nested repository.
 */
export function isolatedCall(toolName: string, input: Record<string, unknown>, root: string): boolean {
  if (toolName === "Workflow") return true;
  if (!SUBAGENT_RE.test(toolName)) return false;
  const iso = input.isolation;
  if (typeof iso === "string" && iso.trim() !== "" && iso !== "none") return true;
  const cwd = input.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) return false;
  const dir = resolve(root, cwd);
  return !isInside(dir, root) || nestedRepoRoot(join(dir, "_"), root) !== null;
}

/** The deny reason for a worktree tool (§33.4), undefined when it may proceed: EnterWorktree always, isolated calls unless allowed. */
export function worktreeToolBlocked(toolName: string, input: Record<string, unknown>, root: string, allowIsolation: boolean): string | undefined {
  if (toolName === "EnterWorktree") return ENTER_WORKTREE_REASON;
  if (!allowIsolation && isolatedCall(toolName, input, root)) return ISOLATION_REASON;
  return undefined;
}

/**
 * The engine's own system instruction (appended after the client's): work in this folder. MARK: wave4b w4b-follow — §39.4:
 * a team that makes a worktree per issue may let Claude create one, said at once; the user moves the chat there (the
 * review follows). EnterWorktree stays denied: it would move the whole session out of the review.
 */
export function scopeInstruction(cwd: string, allowIsolation: boolean): string {
  return (
    `ReviewGate reviews every change you make in this folder (${cwd}). Work inside it; never use EnterWorktree. ` +
    "If the task needs its own git worktree, you may create it with `git worktree add`, but tell the user right away in one line: " +
    "changes there are not reviewed until they move this chat into that worktree (ReviewGate offers it), so do not change files " +
    "there before that. Do not `cd` into another worktree or a nested repository to change files there. " +
    (allowIsolation
      ? "Agents with `isolation: \"worktree\"` and the Workflow tool are allowed by the user, but their changes are outside this window's review — prefer working here. "
      : "Agents with `isolation` and the Workflow tool are not available: their changes would be outside the review, so ReviewGate blocks them. ") +
    "If parallel work on another branch is needed, say so: the user opens a separate ReviewGate workbench for it."
  );
}

/**
 * §46: the engine's word on git, after the client's text — which may still be an older default that says never to commit.
 * Each command that changes the repository reaches the user's approval card (hooks.ts `gitCommandReason`).
 */
export const GIT_INSTRUCTION =
  "Git: when the user asks you to merge, pull, rebase, cherry-pick, commit, stash or resolve merge conflicts, do it with git as usual — " +
  "ReviewGate shows the user an approval card for every git command that changes the repository. An instruction never to run " +
  "git commit / checkout / reset / stash means: not on your own initiative. What a merge or pull brings in is not counted as your " +
  "change; your conflict resolutions and edits are reviewed as usual. After resolving merge conflicts, leave the merge uncommitted " +
  "and do not git add the resolved files unless the user asked you to commit — the user reviews the resolutions and commits the " +
  "merge from ReviewGate. If the user denies the card, stop and ask. Never put a git worktree, clone or copy of the project " +
  "under /tmp, /private/tmp or /var/folders: macOS deletes files there that were not opened for a few days, .git included.";

// ------------------------------------------------------------------ Bash

/**
 * Simple commands of `command` as word lists: the tokenizer's when the line parses, else a rough split (detection only).
 * MARK: wave2 check-engine — §35.6: a subshell / brace group / command substitution opener (`(cd x && …)`, `{ cd x; …; }`,
 * `$(cd x …)`) is not part of the command's first word, so its `cd` still moves the directory for detection.
 */
function segments(command: string): string[][] {
  const scan = scanCommand(command);
  if (scan) return scan.segments;
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim().replace(/^(?:\$\(|[({`]|\s)+/, "").split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/^["']|["']$/g, "")))
    .filter((s) => s.length > 0);
}

/** The words after leading `NAME=value` assignments. */
function commandWords(words: string[]): string[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  return words.slice(i);
}

/** `$NAME` / `${NAME}` the environment defines (`$HOME/worktrees/x`); an unknown one stays as written. */
function expandVars(arg: string): string {
  return arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    const value = name === "HOME" ? homedir() : process.env[name];
    return value !== undefined && value !== "" ? value : m;
  });
}

function resolveDir(base: string, raw: string): string {
  const arg = raw.includes("$") ? expandVars(raw) : raw;
  if (arg === "~") return homedir();
  if (arg.startsWith("~/")) return join(homedir(), arg.slice(2));
  return resolve(base, arg);
}

/** git global options that take a separate value (`-C <path>`, `-c <k=v>`, …). */
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);
/** `git worktree add` options that take a separate value. */
const WORKTREE_ADD_WITH_VALUE = new Set(["-b", "-B", "--reason"]);

/**
 * One simple command's words → the resolved path `git … worktree add … <path>` creates; undefined when the command is
 * not a `git worktree add`, null when it is but names no path. `cwd` is where it runs (`-C` is applied).
 */
export function gitWorktreeAddTarget(words: string[], cwd: string): string | null | undefined {
  return parseWorktreeAdd(words, cwd)?.target;
}

/** `git … worktree add …`: the directory git runs in (`-C` applied) and the new worktree's path (null: none named). */
function parseWorktreeAdd(words: string[], cwd: string): { base: string; target: string | null } | undefined {
  const w = commandWords(words);
  if (w.length === 0 || basename(w[0]!) !== "git") return undefined;
  let base = cwd;
  let i = 1;
  while (i < w.length && w[i]!.startsWith("-")) {
    const opt = w[i]!;
    if (GIT_GLOBAL_WITH_VALUE.has(opt)) {
      if (opt === "-C" && w[i + 1] !== undefined) base = resolveDir(base, w[i + 1]!);
      i += 2;
    } else i++;
  }
  if (w[i] !== "worktree" || w[i + 1] !== "add") return undefined;
  for (let j = i + 2; j < w.length; j++) {
    const a = w[j]!;
    if (a === "--") return { base, target: w[j + 1] !== undefined ? resolveDir(base, w[j + 1]!) : null };
    if (WORKTREE_ADD_WITH_VALUE.has(a)) {
      j++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return { base, target: resolveDir(base, a) };
  }
  return { base, target: null };
}

/**
 * §39.4: the directory a command's `git worktree add` runs in (after its `cd`s and `-C`) — its repository is the one the
 * new worktree belongs to. Null when the command adds no worktree.
 */
export function worktreeAddRepoDir(command: string, cwd: string): string | null {
  let dir = cwd;
  for (const words of segments(command)) {
    const w = commandWords(words);
    if (w[0] === "cd" || w[0] === "pushd") {
      const arg = w.slice(1).find((a) => !a.startsWith("-"));
      if (arg !== undefined) dir = resolveDir(dir, arg);
      continue;
    }
    const add = parseWorktreeAdd(w, dir);
    if (add) return add.base;
  }
  return null;
}

/** Where a Bash command works: the shell's current directory, every `cd` / `pushd` target (in order) and every `git -C` directory. */
export function bashWorkDirs(command: string, cwd: string): string[] {
  const dirs = [cwd];
  let cur = cwd;
  for (const words of segments(command)) {
    const w = commandWords(words);
    if (w[0] === "cd" || w[0] === "pushd") {
      const arg = w.slice(1).find((a) => !a.startsWith("-"));
      if (arg !== undefined) {
        cur = resolveDir(cur, arg);
        dirs.push(cur);
      }
      continue;
    }
    if (w.length > 0 && basename(w[0]!) === "git") {
      for (let i = 1; i < w.length - 1 && w[i]!.startsWith("-"); i++) {
        if (w[i] === "-C") dirs.push(resolveDir(cur, w[i + 1]!));
        if (GIT_GLOBAL_WITH_VALUE.has(w[i]!)) i++;
      }
    }
  }
  return dirs;
}

/**
 * Why a Bash command works outside what the review sees (§33.4): it creates a worktree (`worktree_command`, `path` =
 * the new worktree), or it runs in / `cd`s into a nested repository or another worktree. Null otherwise.
 */
export function bashScopeReason(command: string, cwd: string, root: string, worktrees: readonly string[]): PermissionReason | null {
  let dir = cwd;
  for (const words of segments(command)) {
    const w = commandWords(words);
    if (w[0] === "cd" || w[0] === "pushd") {
      const arg = w.slice(1).find((a) => !a.startsWith("-"));
      if (arg !== undefined) dir = resolveDir(dir, arg);
      continue;
    }
    const target = gitWorktreeAddTarget(w, dir);
    if (target !== undefined) return { code: "worktree_command", message: SCOPE_MESSAGES.worktree_command, ...(target ? { path: target } : {}) };
  }
  for (const d of bashWorkDirs(command, cwd)) {
    const reason = dirScopeReason(d, root, worktrees);
    if (reason) return reason;
  }
  return null;
}

/**
 * §33.4: the other worktrees and nested repositories a Bash command runs in (`bashWorkDirs`: the shell's directory, its
 * `cd`s and `git -C`s), each once, in order — the folders its after-notice compares.
 */
export function bashOutsideDirs(command: string, cwd: string, root: string, worktrees: readonly string[]): PermissionReason[] {
  const out: PermissionReason[] = [];
  for (const d of bashWorkDirs(command, cwd)) {
    const reason = dirScopeReason(d, root, worktrees);
    if (reason?.path && !out.some((r) => r.path === reason.path)) out.push(reason);
  }
  return out;
}

/** `worktreePath` / `worktreeBranch` of an isolated agent's tool response, when the CLI reports them. */
export function isolatedResult(response: unknown): { path?: string; branch?: string } {
  if (!response || typeof response !== "object") return {};
  const r = response as { worktreePath?: unknown; worktreeBranch?: unknown };
  return {
    ...(typeof r.worktreePath === "string" && r.worktreePath ? { path: r.worktreePath } : {}),
    ...(typeof r.worktreeBranch === "string" && r.worktreeBranch ? { branch: r.worktreeBranch } : {}),
  };
}
