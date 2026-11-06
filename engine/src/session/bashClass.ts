import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isInside } from "../platform/paths.js";

/**
 * Read-only Bash classifier (docs/M16-FRICTION.md §1, docs/PROTOCOL.md §19.3). A command is read-only when every
 * pipeline / chain segment starts with a command from the read-only set (with per-command argument checks for
 * the few that can write or run code through an option), and the line contains no redirection — other than one into
 * /dev/null or onto another stream (`2>&1`, `2>/dev/null`) — subshell, command substitution or backtick. Anything the
 * scanner does not understand is NOT read-only — a false negative only costs one permission prompt, a false positive
 * would run a write (or an arbitrary program) unasked.
 */

/** Commands that never write when their arguments pass `ARG_CHECKS`. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "which", "type", "echo", "printf", "grep", "rg", "find", "fd", "stat",
  "file", "env", "date", "whoami", "tree", "du", "df", "ps", "id", "uname", "sort", "uniq", "cut", "sed", "tr", "jq",
  "node", "npm", "python3", "git",
  // §19.3: tests and no-ops, GitHub reads, and `xargs` running one of the commands every option of which is harmless.
  "test", "[", "true", "false", "gh", "xargs",
  // `awk` is deliberately absent: its programs can write (`print > f`), pipe (`| "cmd"`), run commands
  // (`system()`, gawk indirect calls `@f()`), load extensions (`-l`, `@load`) and read programs from files (`-f`).
]);

/**
 * §19.3: where a command runs. `cwd` is the shell's directory, `root` the checkpoint root, `sameRepoDirs` the repository's
 * other worktrees (they share its git config, so a `git status` there runs nothing the repository's own would not). With a
 * context a `cd` / `pushd` / `git -C` into `root` or one of `sameRepoDirs` keeps a command read-only; anywhere else it
 * does not — a foreign repository's config could run an fsmonitor or a pager on `git status`. `foreignDir` names the
 * directories inside them that belong to another repository (a nested clone, a submodule): never read-only either.
 */
export type ReadOnlyContext = { cwd: string; root: string; sameRepoDirs: readonly string[]; foreignDir?: (dir: string) => boolean };

/**
 * Commands whose every option is harmless, so an unquoted glob / `$VAR` that expands into an
 * option-looking word (a planted file named `--pre=evil` matched by `*`) cannot turn them into a
 * write. Every other read-only command must not have expandable words at all.
 */
const EXPANSION_SAFE: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "which", "type", "echo", "printf", "grep", "stat", "du", "df", "ps",
  "id", "uname", "cut", "tr", "jq", "whoami",
]);

/** Directories an absolute command path may come from (`/usr/bin/git`); a planted `./bin/ls` is never trusted. */
const SYSTEM_BIN_DIRS: ReadonlySet<string> = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/sbin", "/usr/sbin"]);

/**
 * Environment assignments allowed in front of a command (`LC_ALL=C git log`). Anything else can
 * change what the command runs (`NODE_OPTIONS=--require=x`, `GIT_EXTERNAL_DIFF=`, `PAGER=`, `LD_PRELOAD=`, `DYLD_*`).
 */
const SAFE_ENV_ASSIGN_RE = /^(LC_[A-Z_]+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|COLUMNS|LINES|TERM)=/;

const GIT_READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "rev-parse", "remote", "ls-files", "blame", "describe", "tag",
  // §19.3 (checked below: `stash list|show`, `worktree list`, `config` read forms, `cat-file -p|-t|-s|-e`, `grep` without a pager)
  "grep", "ls-tree", "merge-base", "rev-list", "show-ref", "for-each-ref", "cat-file", "stash", "worktree", "config",
]);

/**
 * git global options that are allowed before the verb. Everything else is refused: `-c k=v` can set
 * `core.fsmonitor` / `core.pager` / `diff.external` / an alias (all run programs), `--git-dir` / `--work-tree` point
 * git at a repository whose config may do the same, `--exec-path` swaps git's helpers. `-C <dir>` is accepted only with a
 * context (§19.3) and only into the repository itself (`ReadOnlyContext`).
 */
const GIT_SAFE_GLOBALS: ReadonlySet<string> = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);

/** git verb options that run programs or write: `--ext-diff` / `--textconv` run configured commands, `--output` writes. */
const GIT_UNSAFE_LONG = ["output", "ext-diff", "textconv"];

/** `-abc` style flag cluster containing `letter` (`-ni` → n, i). Long options never match. */
function hasShortFlag(tok: string, letter: string): boolean {
  return /^-[A-Za-z]+$/.test(tok) && tok.includes(letter);
}

/** Any single-dash token (cluster or attached value) containing `letter` — the conservative short-option check. */
function hasShortChar(tok: string, letter: string): boolean {
  return tok.startsWith("-") && !tok.startsWith("--") && tok.includes(letter);
}

/**
 * Whether `tok` is a long option that GNU-style parsers (getopt_long, git parse-options) would resolve
 * to one of `names`: they accept any unambiguous prefix, so `--comp` is `--compress-program`.
 */
function isLongOpt(tok: string, names: readonly string[]): boolean {
  if (!tok.startsWith("--")) return false;
  const name = tok.slice(2).split("=")[0]!;
  return name.length > 0 && names.some((n) => n.startsWith(name));
}

function positionals(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

/** Simple sed commands that neither write, read other files nor execute (`w`, `W`, `r`, `R`, `e` and `s///w|e` are not here). */
const SED_SIMPLE_COMMANDS = "pPlq=QdDnNgGhHxz}";

/**
 * Whether a sed script only uses address + simple commands and `s` / `y` with harmless flags. A
 * whitelist grammar rather than a blacklist scan: anything it does not recognise (labels, `a`/`i`/`c`
 * text, custom `\cREc` delimiters, `w`/`r`/`e` commands or flags) is refused.
 */
function sedScriptIsSafe(script: string): boolean {
  let i = 0;
  const n = script.length;
  /** Reads a delimited part (`/re/`) starting after the opening `delim`; returns the index after the closing one, or -1. */
  const delimited = (from: number, delim: string): number => {
    let j = from;
    while (j < n) {
      const c = script[j]!;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "\n") return -1;
      if (c === delim) return j + 1;
      j++;
    }
    return -1;
  };
  const address = (): boolean => {
    if (/[0-9]/.test(script[i] ?? "")) {
      while (/[0-9~]/.test(script[i] ?? "")) i++;
    } else if (script[i] === "$") {
      i++;
    } else if (script[i] === "/") {
      const end = delimited(i + 1, "/");
      if (end === -1) return false;
      i = end;
      while (script[i] === "I" || script[i] === "M") i++;
    }
    return true;
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i]!)) i++;
    if (i >= n) break;
    if (!address()) return false;
    if (script[i] === ",") {
      i++;
      if (script[i] === "+" || script[i] === "~") i++;
      if (!address()) return false;
    }
    while (script[i] === " " || script[i] === "!") i++;
    const cmd = script[i];
    if (cmd === undefined) return false;
    i++;
    if (cmd === "s" || cmd === "y") {
      const delim = script[i];
      if (delim === undefined || delim === "\\" || delim === "\n" || /\s/.test(delim)) return false;
      const reEnd = delimited(i + 1, delim);
      if (reEnd === -1) return false;
      const replEnd = delimited(reEnd, delim);
      if (replEnd === -1) return false;
      i = replEnd;
      if (cmd === "s") while (/[gpiImM0-9]/.test(script[i] ?? "")) i++;
    } else if (cmd === "{") {
      continue; // a block opens; its commands follow directly
    } else if (SED_SIMPLE_COMMANDS.includes(cmd)) {
      if (cmd === "q" || cmd === "Q" || cmd === "l") while (/[0-9 ]/.test(script[i] ?? "")) i++;
    } else {
      return false;
    }
    // A command ends at `;`, a newline, `}` or the end of the script.
    while (script[i] === " " || script[i] === "\t") i++;
    if (i < n && !/[;\n}]/.test(script[i]!)) return false;
  }
  return true;
}

const SED_LONG_FLAGS = ["quiet", "silent", "regexp-extended", "separate", "unbuffered", "null-data", "posix", "debug", "sandbox"];

/**
 * `sed -n` with scripts that `sedScriptIsSafe` accepts. Never `-i` / `-I` / `--in-place` (writes the
 * input), `-f` / `--file` (script from a file the check cannot see) or an unknown option.
 */
function sedIsReadOnly(args: string[]): boolean {
  let quiet = false;
  const scripts: string[] = [];
  const operands: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [rawName, value] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const exact = ["expression", "line-length", ...SED_LONG_FLAGS].find((x) => x === rawName);
      const matches = exact ? [exact] : ["expression", "line-length", "file", "in-place", ...SED_LONG_FLAGS].filter((x) => x.startsWith(rawName));
      if (rawName.length === 0 || matches.length !== 1) return false;
      const name = matches[0]!;
      if (name === "expression" || name === "line-length") {
        const v = value ?? args[++k];
        if (v === undefined) return false;
        if (name === "expression") scripts.push(v);
      } else if (SED_LONG_FLAGS.includes(name)) {
        if (value !== undefined) return false;
        if (name === "quiet" || name === "silent") quiet = true;
      } else {
        return false; // --file / --in-place
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let c = 1; c < a.length; c++) {
        const ch = a[c]!;
        if (ch === "n") quiet = true;
        else if ("Ersuz".includes(ch)) continue;
        else if (ch === "e" || ch === "l") {
          const v = c + 1 < a.length ? a.slice(c + 1) : args[++k];
          if (v === undefined) return false;
          if (ch === "e") scripts.push(v);
          break;
        } else return false; // i / I / f / anything unknown
      }
      continue;
    }
    operands.push(a);
  }
  if (scripts.length === 0) {
    const first = operands.shift();
    if (first === undefined) return false;
    scripts.push(first);
  }
  return quiet && scripts.every(sedScriptIsSafe);
}

/** Options `env` accepts before the command; `-S` / `--split-string` (re-parses a string into a command line) is not among them. */
function envIsReadOnly(args: string[]): boolean {
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") {
      k++;
      break;
    }
    if (a === "-i" || a === "-0" || a === "-" || isLongOpt(a, ["ignore-environment"]) || isLongOpt(a, ["null"])) continue;
    if (a === "-u") {
      k++;
      continue;
    }
    if (/^-u./.test(a) || a.startsWith("--unset=")) continue;
    if (a.startsWith("-")) return false; // -S / --split-string / -C / -P / anything unknown
    break;
  }
  const rest = args.slice(k);
  // `env` (optionally with assignments) alone lists the environment; `env A=1 CMD …` runs CMD — classify it.
  let j = 0;
  while (j < rest.length && ENV_ASSIGN_RE.test(rest[j]!)) j++;
  if (j === rest.length) return true;
  return rest.slice(0, j).every((w) => SAFE_ENV_ASSIGN_RE.test(w)) && commandIsReadOnly(rest.slice(j).map((text) => ({ text, expands: false })), undefined);
}

/** Per-command argument checks; true = still read-only. */
const ARG_CHECKS: Record<string, (args: string[]) => boolean> = {
  sed: sedIsReadOnly,
  find: (args) => !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a)),
  // `-Hx cmd` is a clap cluster ending in `-x`, so any single-dash token with x / X is refused.
  fd: (args) => !args.some((a) => hasShortChar(a, "x") || hasShortChar(a, "X") || a.startsWith("--exec")),
  // `--pre` runs a preprocessor per file, `--hostname-bin` runs a program for hyperlinks.
  rg: (args) => !args.some((a) => /^--(pre|pre-glob|hostname-bin)(=|$)/.test(a)),
  // `-o` / `--output` write; `--compress-program` runs a program on temp files.
  sort: (args) => !args.some((a) => hasShortChar(a, "o") || isLongOpt(a, ["output", "compress-program"])),
  uniq: (args) => positionals(args).length < 2, // a second positional is the output file
  tree: (args) => !args.some((a) => a === "-o"),
  // `-C` / `--compile` writes a compiled magic file.
  file: (args) => !args.some((a) => hasShortChar(a, "C") || isLongOpt(a, ["compile"])),
  // `-s` / `--set` (GNU) and a positional that is not a `+format` (BSD `date 0101…`) set the clock.
  date: (args) => !args.some((a) => hasShortChar(a, "s") || isLongOpt(a, ["set"])) && positionals(args).every((a) => a.startsWith("+")),
  env: envIsReadOnly,
  node: (args) => args.length === 1 && (args[0] === "--version" || args[0] === "-v"),
  npm: (args) => args.length >= 1 && (args[0] === "ls" || args[0] === "view" || args[0] === "-v" || args[0] === "--version"),
  python3: (args) => args.length === 1 && (args[0] === "--version" || args[0] === "-V"),
  // §19.3: `test` / `[` only look; bash's `-v` / `-R` evaluate an array subscript (`a[$(cmd)]`), which can run commands.
  test: (args) => !args.some((a) => a === "-v" || a === "-R"),
  "[": (args) => args[args.length - 1] === "]" && !args.some((a) => a === "-v" || a === "-R"),
  true: () => true,
  false: () => true,
  gh: ghIsReadOnly,
};

/** The verb's own checks once the global options passed (`gitIsReadOnly`). */
function gitVerbIsReadOnly(verb: string, rest: string[]): boolean {
  if (rest.some((a) => a === "-o" || isLongOpt(a, GIT_UNSAFE_LONG))) return false; // `git log --output=f` writes
  const pos = positionals(rest);
  switch (verb) {
    case "branch":
      if (rest.some((a) => /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description|--track)$/.test(a) || a.startsWith("--set-upstream-to="))) return false;
      return pos.length === 0 || rest.some((a) => /^(--list|-l|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(a) || hasShortFlag(a, "l"));
    case "remote":
      return pos.length === 0 || pos[0] === "show" || pos[0] === "get-url";
    case "tag":
      if (rest.some((a) => /^(-d|-a|-s|-f|-m|-F|-u|--delete|--annotate|--sign|--force|--message|--file)$/.test(a) || a.startsWith("--message=") || a.startsWith("--file="))) return false;
      return pos.length === 0 || rest.some((a) => /^(--list|-l|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(a) || hasShortFlag(a, "l"));
    // `-O` / `--open-files-in-pager` runs a program on the matches.
    case "grep":
      return !rest.some((a) => hasShortChar(a, "O") || isLongOpt(a, ["open-files-in-pager"]));
    // Only the modes that print one object; `--batch*`, `--textconv` and `--filters` run configured programs.
    case "cat-file":
      return rest.every((a) => !a.startsWith("-") || CAT_FILE_MODES.has(a)) && rest.some((a) => CAT_FILE_MODES.has(a));
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "worktree":
      return rest[0] === "list";
    case "config":
      return gitConfigReads(rest);
    default:
      return true;
  }
}

const CAT_FILE_MODES: ReadonlySet<string> = new Set(["-p", "-t", "-s", "-e"]);
/** `git config` options that change a file or open an editor (git's parse-options takes any unambiguous prefix). */
const GIT_CONFIG_WRITES = ["add", "unset", "unset-all", "replace-all", "edit", "rename-section", "remove-section"];
/** `git config` options that take the next word as their value (`--file x`, `-f x`). */
const GIT_CONFIG_VALUES: ReadonlySet<string> = new Set(["--file", "-f", "--blob", "--type", "-t", "--default", "--value", "--url"]);
/** git ≥ 2.46 subcommands that write (`git config edit` opens an editor on the file). */
const GIT_CONFIG_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(["set", "unset", "rename-section", "remove-section", "edit"]);

/**
 * §19.3: the read forms of `git config` — `--get`, `--get-all`, `--get-regexp`, `--list` / `-l`, `get <key>`, `list`, or one
 * positional key — with no option that writes (`--add`, `--unset*`, `--replace-all`, `--edit` / `-e`, `--rename-section`,
 * `--remove-section`, or a prefix of one) and no short option but `-l`, `-z`, `-f <file>`, `-t <type>`.
 */
function gitConfigReads(rest: string[]): boolean {
  let read = false;
  const pos: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a === "--") {
      pos.push(...rest.slice(k + 1));
      break;
    }
    if (a.startsWith("--")) {
      const name = a.slice(2).split("=")[0]!;
      if (name.length === 0 || GIT_CONFIG_WRITES.some((w) => w.startsWith(name))) return false;
      if (name === "get" || name === "get-all" || name === "get-regexp" || name === "list") read = true;
      if (GIT_CONFIG_VALUES.has(`--${name}`) && !a.includes("=")) k++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (a === "-l") read = true;
      else if (a === "-f" || a === "-t") k++;
      else if (a !== "-z") return false; // -e (edit) and anything unknown
      continue;
    }
    pos.push(a);
  }
  if (read) return true;
  if (pos[0] === "get") return pos.length === 2;
  if (pos[0] === "list") return pos.length === 1;
  return pos.length === 1 && !GIT_CONFIG_WRITE_SUBCOMMANDS.has(pos[0]!);
}

/** §19.3: the `gh` subcommands that only read. */
const GH_READS: Readonly<Record<string, readonly string[]>> = {
  pr: ["view", "list", "diff", "checks", "status"],
  issue: ["view", "list"],
  repo: ["view"],
  run: ["view", "list"],
};

/**
 * §19.3: `gh pr view|list|diff|checks|status`, `gh issue view|list`, `gh repo view`, `gh run view|list`, and `gh api <path>` as
 * a GET — no `-X` / `--method` but GET, and none of `-f` / `-F` / `--field` / `--raw-field` / `--input`, which make it a POST.
 */
function ghIsReadOnly(args: string[]): boolean {
  const [group, verb] = args;
  if (group === undefined) return false;
  if (group !== "api") return verb !== undefined && (GH_READS[group]?.includes(verb) ?? false);
  for (let k = 1; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--method" || a === "-X") {
      if ((args[++k] ?? "").toUpperCase() !== "GET") return false;
      continue;
    }
    if (a.startsWith("--method=")) {
      if (a.slice("--method=".length).toUpperCase() !== "GET") return false;
      continue;
    }
    if (/^-X./.test(a)) {
      if (a.slice(2).toUpperCase() !== "GET") return false;
      continue;
    }
    if (/^--(field|raw-field|input)(=|$)/.test(a)) return false;
    // A cluster of short flags may end in `-f` / `-F` / `-X` (`-if k=v`).
    if (a.startsWith("-") && !a.startsWith("--") && /[fFX]/.test(a.slice(1))) return false;
  }
  return positionals(args.slice(1)).length >= 1;
}

/**
 * A shell word; `expands` = it had an unquoted glob character or `$` (its runtime value is not its text); `quoted` = a
 * quote or a backslash made part of it; `tilde` = it starts with an unquoted `~` (the shell puts the home folder there).
 */
interface Word {
  text: string;
  expands: boolean;
  quoted?: boolean;
  tilde?: boolean;
}

/** Where a redirection's target ends: the end of the line or a character that ends a word. */
const atWordEnd = (cmd: string, j: number): boolean => j >= cmd.length || /[\s;|&)]/.test(cmd[j]!);

/**
 * §19.3: the index after a redirection that writes no file, starting at `i` (`>` or `&>`): into /dev/null (`>/dev/null`,
 * `>> /dev/null`, `&>/dev/null`; the number before `>` is the caller's) or onto another stream (`>&2`, `>&1`); else -1.
 */
function harmlessRedirectEnd(cmd: string, i: number): number {
  let j = i;
  const both = cmd[j] === "&";
  if (both) j++;
  if (cmd[j] !== ">") return -1;
  j++;
  if (!both && cmd[j] === "&") {
    const start = ++j;
    while (j < cmd.length && /[0-9]/.test(cmd[j]!)) j++;
    return j > start && atWordEnd(cmd, j) ? j : -1;
  }
  if (cmd[j] === ">") j++;
  while (cmd[j] === " " || cmd[j] === "\t") j++;
  if (!cmd.startsWith("/dev/null", j)) return -1;
  j += "/dev/null".length;
  return atWordEnd(cmd, j) ? j : -1;
}

/**
 * Splits `cmd` into `;` / `&&` / `||` / `|` / newline separated segments of shell words (quotes and
 * backslashes honoured as bash does: a word's text is the argument the command gets). Returns null when the
 * line contains anything that can write or run code outside the words themselves: `>`, `<`, `(`, `)`,
 * backticks, `$(`, a background `&`, or an unterminated quote. `readOnly` (the classifier's own scan, §19.3): a
 * redirection into /dev/null or onto another stream is dropped (with the file-descriptor number before it), and a lone
 * `{}` word (`xargs -I {}`; literal to the shell) is kept.
 */
function scanWords(cmd: string, readOnly = false): Word[][] | null {
  const segments: Word[][] = [];
  let seg: Word[] = [];
  let tok = "";
  let inTok = false;
  let expands = false;
  let quoted = false;
  let tilde = false;
  const endTok = () => {
    if (inTok) seg.push({ text: tok, expands, ...(quoted ? { quoted } : {}), ...(tilde ? { tilde } : {}) });
    tok = "";
    inTok = false;
    expands = false;
    quoted = false;
    tilde = false;
  };
  const endSeg = () => {
    endTok();
    segments.push(seg);
    seg = [];
  };
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i]!;
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close === -1) return null;
      tok += cmd.slice(i + 1, close);
      inTok = true;
      quoted = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = cmd[j]!;
        if (d === "\\" && j + 1 < n) {
          // POSIX: inside double quotes a backslash escapes only $ ` " \ and a newline (a line continuation); before
          // anything else it is a literal character — `cd "C:\Users\me\wt"` (a Windows path in Git Bash) keeps it.
          const e = cmd[j + 1]!;
          if (e === "\n") {
            j += 2;
            continue;
          }
          if (e === "$" || e === "`" || e === '"' || e === "\\") {
            tok += e;
            j += 2;
            continue;
          }
        }
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "`" || (d === "$" && cmd[j + 1] === "(")) return null; // expands inside double quotes
        if (d === "$") expands = true;
        tok += d;
        j++;
      }
      if (!closed) return null;
      inTok = true;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= n) return null;
      if (cmd[i + 1] === "\n") {
        i += 2; // line continuation
        continue;
      }
      tok += cmd[i + 1]!;
      inTok = true;
      quoted = true;
      i += 2;
      continue;
    }
    if (readOnly && (c === ">" || (c === "&" && cmd[i + 1] === ">"))) {
      const end = harmlessRedirectEnd(cmd, i);
      if (end === -1) return null;
      // `2>/dev/null`: an unquoted number right before `>` is the stream it redirects, not a word.
      if (c === ">" && inTok && !quoted && /^[0-9]+$/.test(tok)) {
        tok = "";
        inTok = false;
      } else endTok();
      i = end;
      continue;
    }
    if (c === "`" || c === ">" || c === "<" || c === "(" || c === ")") return null;
    if (readOnly && c === "{" && !inTok && cmd[i + 1] === "}" && atWordEnd(cmd, i + 2)) {
      tok = "{}";
      inTok = true;
      i += 2;
      continue;
    }
    if ((c === "{" || c === "}") && !inTok) return null; // brace group / expansion
    if (c === "$" && cmd[i + 1] === "(") return null;
    if (c === "#" && !inTok) {
      const nl = cmd.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "|" || c === "&" || c === ";" || c === "\n") {
      if (c === "&" && cmd[i + 1] !== "&") return null; // background job
      if (c === "|" && cmd[i + 1] === "&") return null; // `|&` redirects stderr
      endSeg();
      i += c === "\n" || c === ";" ? 1 : cmd[i + 1] === c ? 2 : 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endTok();
      i++;
      continue;
    }
    if (c === "*" || c === "?" || c === "[" || c === "$") expands = true;
    if (c === "~" && !inTok) tilde = true;
    tok += c;
    inTok = true;
    i++;
  }
  endSeg();
  return segments.filter((s) => s.length > 0);
}

type Scan = { segments: string[][] } | null;

/** `scanWords` as plain word lists (exported for tests and the protocol layer). */
export function scanCommand(cmd: string): Scan {
  const words = scanWords(cmd);
  return words ? { segments: words.map((s) => s.map((w) => w.text)) } : null;
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * §19.3: what a command's directory may be with a context — every place the shell can be in at that segment: the
 * starting directory and each `cd` target so far (a `cd` that fails, or runs in a pipeline's subshell, leaves the shell
 * where it was). A `cd` target must be an existing folder: one that is not there sends the shell along CDPATH.
 */
type RunEnv = { ctx: ReadOnlyContext; cwds: string[] };

/** A directory a `cd` / `git -C` word names, resolved against `base`; null for `~user` (not followed). */
function wordDir(word: Word, base: string): string | null {
  if (word.tilde) {
    if (word.text === "~") return homedir();
    if (!word.text.startsWith("~/")) return null;
    return join(homedir(), word.text.slice(2));
  }
  return resolve(base, word.text);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** §19.3: `dir` is in the repository — the root or another worktree of it — and not in a nested repository of its own. */
function inRepository(dir: string, ctx: ReadOnlyContext): boolean {
  if (!isInside(dir, ctx.root) && !ctx.sameRepoDirs.some((w) => isInside(dir, w))) return false;
  return !ctx.foreignDir?.(dir);
}

/** `git [global options] verb …` with read-only options and verb; `-C <dir>` only with a context, into the repository. */
function gitIsReadOnly(args: Word[], run: RunEnv | undefined): boolean {
  let i = 0;
  const dirs: Word[] = [];
  while (i < args.length && args[i]!.text.startsWith("-")) {
    const a = args[i]!.text;
    if (a === "-C") {
      const d = args[i + 1];
      if (!run || d === undefined || d.expands) return false;
      dirs.push(d);
      i += 2;
      continue;
    }
    if (!GIT_SAFE_GLOBALS.has(a)) return false;
    i++;
  }
  if (dirs.length > 0) {
    for (const cwd of run!.cwds) {
      let dir: string | null = cwd;
      for (const d of dirs) dir = dir === null ? null : wordDir(d, dir);
      if (dir === null || !inRepository(dir, run!.ctx)) return false;
    }
  }
  const verb = args[i]?.text;
  if (verb === undefined || !GIT_READ_ONLY_VERBS.has(verb)) return false;
  return gitVerbIsReadOnly(verb, args.slice(i + 1).map((w) => w.text));
}

/**
 * §19.3: `xargs [-0 -r -n N -I R -P N -L N] [command …]` — the input becomes arguments of `command`, so it must be one
 * whose every option is harmless (`EXPANSION_SAFE`: a planted file named `--pre=x` in a `find` result stays a file name)
 * and read-only with its own arguments. No command: `echo`.
 */
function xargsIsReadOnly(args: Word[]): boolean {
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k]!.text;
    if (a === "--") {
      k++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    if (a === "-0" || a === "-r") continue;
    const m = /^-([nIPL])(.*)$/s.exec(a);
    if (!m) return false;
    if (m[2] === "" && ++k >= args.length) return false;
  }
  const rest = args.slice(k);
  if (rest.length === 0) return true;
  const name = rest[0]!.text;
  return EXPANSION_SAFE.has(name.slice(name.lastIndexOf("/") + 1)) && commandIsReadOnly(rest, undefined);
}

/** True when `words` (a command after its env assignments) is a read-only command with read-only arguments. */
function commandIsReadOnly(words: Word[], run: RunEnv | undefined): boolean {
  const first = words[0];
  // A lone `[` is the test command, not a glob (an unclosed bracket expression is literal to the shell).
  if (first === undefined || (first.expands && first.text !== "[")) return false;
  const name = first.text;
  const slash = name.lastIndexOf("/");
  const base = slash === -1 ? name : name.slice(slash + 1);
  if (slash !== -1 && !SYSTEM_BIN_DIRS.has(name.slice(0, slash))) return false; // `./ls`, `/repo/bin/ls`
  if (!READ_ONLY_COMMANDS.has(base)) return false;
  const args = words.slice(1);
  if (!EXPANSION_SAFE.has(base) && args.some((w) => w.expands)) return false;
  if (base === "git") return gitIsReadOnly(args, run);
  if (base === "xargs") return xargsIsReadOnly(args);
  const check = ARG_CHECKS[base];
  return check ? check(args.map((w) => w.text)) : true;
}

/** True when `words` (one pipeline segment) is a read-only command, after harmless env assignments. */
function segmentIsReadOnly(words: Word[], run: RunEnv | undefined): boolean {
  let i = 0;
  while (i < words.length && ENV_ASSIGN_RE.test(words[i]!.text)) {
    if (!SAFE_ENV_ASSIGN_RE.test(words[i]!.text)) return false;
    i++;
  }
  return commandIsReadOnly(words.slice(i), run);
}

/**
 * A `cd <dir>` / `cd -P|-L <dir>` / `pushd <dir>` segment: its directory word; null for a `cd` / `pushd` that names no plain
 * directory (bare `cd`, `cd -`, `pushd +1`, a `$` or glob word, more than one); undefined for any other command.
 */
function cdTarget(words: Word[]): Word | null | undefined {
  const first = words[0];
  if (!first || first.quoted || (first.text !== "cd" && first.text !== "pushd")) return undefined;
  let args = words.slice(1);
  if (first.text === "cd") {
    while (args.length > 0 && (args[0]!.text === "-P" || args[0]!.text === "-L")) args = args.slice(1);
    if (args[0]?.text === "--") args = args.slice(1);
  }
  if (args.length !== 1) return null;
  const dir = args[0]!;
  if (dir.expands || (dir.text.startsWith("-") && dir.text !== "--") || dir.text.startsWith("+")) return null;
  return dir;
}

/**
 * Whether `cmd` only reads: every segment of the pipeline / chain is a read-only command and the line has no
 * redirection but into /dev/null or onto another stream, no subshell, substitution or backtick (docs/M16-FRICTION.md
 * §1, docs/PROTOCOL.md §19.3). With `ctx` a `cd` / `pushd` into the repository (`ReadOnlyContext`) is neutral and moves
 * the directory the following segments may run in, and `git -C` may name the repository; without it neither is read-only.
 */
export function isReadOnlyCommand(cmd: string, ctx?: ReadOnlyContext): boolean {
  const segments = scanWords(cmd, true);
  if (!segments || segments.length === 0) return false;
  const run: RunEnv | undefined = ctx ? { ctx, cwds: [resolve(ctx.cwd)] } : undefined;
  for (const words of segments) {
    const cd = cdTarget(words);
    if (cd !== undefined) {
      if (!run || cd === null) return false;
      const dirs: string[] = [];
      for (const cwd of run.cwds) {
        const dir = wordDir(cd, cwd);
        // A folder that is not there sends the shell along CDPATH (zsh, bash: `cd sub` → `$CDPATH/sub`).
        if (dir === null || !inRepository(dir, run.ctx) || !isDirectory(dir)) return false;
        dirs.push(dir);
      }
      run.cwds = [...new Set([...run.cwds, ...dirs])];
      continue;
    }
    if (!segmentIsReadOnly(words, run)) return false;
  }
  return true;
}

/**
 * Claude-style allow pattern (`Bash(npm test:*)`, `Bash(git *)`, `Bash(ls)`) against a Bash command.
 * `prefix:*` matches commands that start with `prefix` at a word boundary; `*` / `?` are globs over the whole
 * command; anything else must match exactly. Whitespace runs are collapsed on both sides. A bare pattern
 * (without the `Bash(…)` wrapper) is accepted too; patterns for other tools never match.
 *
 * The command is tokenized first (`scanWords`, quotes honoured) and the pattern is matched against each simple
 * command on its own: a chain / pipeline (`;`, `&&`, `||`, `|`, newline) matches only when **every** segment
 * matches, so `npm test && rm -rf x` never rides on `npm test:*`. A line with a redirection, `$(…)`, backticks,
 * a subshell / brace group, a background `&` or an unterminated quote never matches.
 */
export function matchesAllowPattern(pattern: string, command: string): boolean {
  const wrapped = /^([A-Za-z_]+)\((.*)\)$/.exec(pattern.trim());
  if (wrapped && wrapped[1] !== "Bash") return false;
  const p = (wrapped ? wrapped[2]! : pattern).trim().replace(/\s+/g, " ");
  if (p.length === 0) return false;
  const segments = simpleCommands(command);
  if (segments === null || segments.length === 0) return false;
  return segments.every((words) => matchesSimple(p, words.join(" ")));
}

/** One simple command's text against a normalized pattern body (see `matchesAllowPattern`). */
function matchesSimple(p: string, c: string): boolean {
  if (p.endsWith(":*")) {
    const prefix = p.slice(0, -2);
    return c === prefix || (c.startsWith(prefix) && (/\s$/.test(prefix) || /^\s/.test(c.slice(prefix.length))));
  }
  if (/[*?]/.test(p)) {
    const re = "^" + p.split("").map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("") + "$";
    return new RegExp(re, "s").test(c);
  }
  return c === p;
}

/**
 * The simple commands of `command` as word lists, or null when the line is not a plain chain / pipeline of simple
 * commands (`scanWords` refuses it) or a command name holds whitespace (a quoted `"npm test"` is one word, never
 * the two words `npm test` it would look like once the words are joined).
 */
function simpleCommands(command: string): string[][] | null {
  const segments = scanWords(command);
  if (!segments) return null;
  const words = segments.map((s) => s.map((w) => w.text));
  return words.every((w) => w.length > 0 && !/\s/.test(w[0]!)) ? words : null;
}

/**
 * Key stored by `permission_response { remember: true }`: `"Bash:<first two words>"` for Bash
 * (`echo hi > x.txt` → `Bash:echo hi`; quotes are honoured when the line tokenizes: `echo "a b"` → `Bash:echo a b`),
 * `"<tool>:<tool>"` for every other tool.
 */
export function rememberKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName !== "Bash") return `${toolName}:${toolName}`;
  const cmd = typeof input.command === "string" ? input.command : "";
  const first = simpleCommands(cmd)?.[0];
  const words = first ?? cmd.trim().split(/\s+/).filter((w) => w.length > 0);
  return `Bash:${words.slice(0, 2).join(" ")}`;
}

/**
 * Whether a `remember: true` key covers this call. Bash: the line must tokenize into simple commands (no
 * redirection / substitution / backtick / subshell / background job) and **every** segment's own key must be
 * remembered — `Bash:npm test` covers `npm test -- x` and `npm test | tail`, never `npm test && rm -rf x`.
 */
export function isRemembered(toolName: string, input: Record<string, unknown>, remembered: ReadonlySet<string> | undefined): boolean {
  if (!remembered || remembered.size === 0) return false;
  if (toolName !== "Bash") return remembered.has(rememberKey(toolName, input));
  const segments = simpleCommands(typeof input.command === "string" ? input.command : "");
  if (segments === null || segments.length === 0) return false;
  return segments.every((words) => remembered.has(`Bash:${words.slice(0, 2).join(" ")}`));
}
