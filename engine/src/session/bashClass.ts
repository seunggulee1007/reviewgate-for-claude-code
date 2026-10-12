/**
 * Read-only Bash classifier (docs/M16-FRICTION.md §1). A command is read-only when every pipeline /
 * chain segment starts with a command from the read-only set (with per-command argument checks for
 * the few that can write or run code through an option), and the line contains no redirection,
 * subshell, command substitution or backtick. Anything the scanner does not understand is NOT
 * read-only — a false negative only costs one permission prompt, a false positive would run a write
 * (or an arbitrary program) unasked.
 */

/** Commands that never write when their arguments pass `ARG_CHECKS`. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "which", "type", "echo", "printf", "grep", "rg", "find", "fd", "stat",
  "file", "env", "date", "whoami", "tree", "du", "df", "ps", "id", "uname", "sort", "uniq", "cut", "sed", "tr", "jq",
  "node", "npm", "python3", "git",
  // `awk` is deliberately absent: its programs can write (`print > f`), pipe (`| "cmd"`), run commands
  // (`system()`, gawk indirect calls `@f()`), load extensions (`-l`, `@load`) and read programs from files (`-f`).
]);

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
]);

/**
 * git global options that are allowed before the verb. Everything else is refused: `-c k=v` can set
 * `core.fsmonitor` / `core.pager` / `diff.external` / an alias (all run programs), `-C` / `--git-dir` /
 * `--work-tree` point git at a repository whose config may do the same, `--exec-path` swaps git's helpers.
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
  return rest.slice(0, j).every((w) => SAFE_ENV_ASSIGN_RE.test(w)) && commandIsReadOnly(rest.slice(j).map((text) => ({ text, expands: false })));
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
  git: (args) => {
    let i = 0;
    while (i < args.length && args[i]!.startsWith("-")) {
      if (!GIT_SAFE_GLOBALS.has(args[i]!)) return false;
      i++;
    }
    const verb = args[i];
    if (verb === undefined || !GIT_READ_ONLY_VERBS.has(verb)) return false;
    const rest = args.slice(i + 1);
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
      default:
        return true;
    }
  },
};

/** A shell word; `expands` = it had an unquoted glob character or `$` (its runtime value is not its text). */
interface Word {
  text: string;
  expands: boolean;
}

/**
 * Splits `cmd` into `;` / `&&` / `||` / `|` / newline separated segments of shell words (quotes and
 * backslashes honoured as bash does: a word's text is the argument the command gets). Returns null when the
 * line contains anything that can write or run code outside the words themselves: `>`, `<`, `(`, `)`,
 * backticks, `$(`, a background `&`, or an unterminated quote.
 */
function scanWords(cmd: string): Word[][] | null {
  const segments: Word[][] = [];
  let seg: Word[] = [];
  let tok = "";
  let inTok = false;
  let expands = false;
  const endTok = () => {
    if (inTok) seg.push({ text: tok, expands });
    tok = "";
    inTok = false;
    expands = false;
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
      i = close + 1;
      continue;
    }
    if (c === '"') {
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
      i += 2;
      continue;
    }
    if (c === "`" || c === ">" || c === "<" || c === "(" || c === ")") return null;
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

/** True when `words` (a command after its env assignments) is a read-only command with read-only arguments. */
function commandIsReadOnly(words: Word[]): boolean {
  const first = words[0];
  if (first === undefined || first.expands) return false;
  const name = first.text;
  const slash = name.lastIndexOf("/");
  const base = slash === -1 ? name : name.slice(slash + 1);
  if (slash !== -1 && !SYSTEM_BIN_DIRS.has(name.slice(0, slash))) return false; // `./ls`, `/repo/bin/ls`
  if (!READ_ONLY_COMMANDS.has(base)) return false;
  const args = words.slice(1);
  if (!EXPANSION_SAFE.has(base) && args.some((w) => w.expands)) return false;
  const check = ARG_CHECKS[base];
  return check ? check(args.map((w) => w.text)) : true;
}

/** True when `words` (one pipeline segment) is a read-only command, after harmless env assignments. */
function segmentIsReadOnly(words: Word[]): boolean {
  let i = 0;
  while (i < words.length && ENV_ASSIGN_RE.test(words[i]!.text)) {
    if (!SAFE_ENV_ASSIGN_RE.test(words[i]!.text)) return false;
    i++;
  }
  return commandIsReadOnly(words.slice(i));
}

/**
 * Whether `cmd` only reads: every segment of the pipeline / chain is a read-only command and the
 * line has no redirection, subshell, substitution or backtick (docs/M16-FRICTION.md §1).
 */
export function isReadOnlyCommand(cmd: string): boolean {
  const segments = scanWords(cmd);
  if (!segments || segments.length === 0) return false;
  return segments.every(segmentIsReadOnly);
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
