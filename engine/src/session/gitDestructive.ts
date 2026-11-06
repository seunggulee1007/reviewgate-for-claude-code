/**
 * MARK: r1-git — docs/PROTOCOL.md §46 / §39.5: which git commands keep the app's card.
 *
 * Git runs as it does in a terminal: in auto mode the CLI's own rules (the user's, a skill's `allowed-tools`) and its
 * classifier decide, in the default mode the ordinary Bash card (which can be remembered) asks. Only a command that throws
 * away uncommitted work or rewrites the remote — what the review cannot bring back — gets the `git_command` card, in every
 * mode, every time (never remembered, whatever a pattern or a remembered key says).
 *
 * The command line is read with a tolerant shell scanner of its own: `bashClass.scanCommand` refuses any redirection,
 * subshell or substitution (`git reset --hard 2>&1`, `(cd x && git stash drop)`, `"$(cat <<'EOF' …)"`), and a refused line
 * must not slip through here. Only the words of commands count — text inside `echo`, `grep` or a here-document never does;
 * `bash -c` / `sh -c` / `eval` scripts and `$( … )` / backticks are read as the commands they are.
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import type { PermissionReason } from "../protocol.js";
import { nulSplit, runGit } from "../git/exec.js";
import { toRepoRelative } from "../platform/paths.js";
import { SCOPE_MESSAGES } from "./reviewScope.js";

// ------------------------------------------------------------------ the shell scanner

/** Nested scripts (`bash -c`, `eval`, backticks) are read this deep; deeper ones are not looked into. */
const MAX_DEPTH = 4;

type HereDoc = { delim: string; strip: boolean };

/**
 * The simple commands of a shell line as word lists (quotes removed), in order, those of `$( … )`, `` ` … ` `` and
 * `<( … )` included. Separators (`;`, `&&`, `||`, `|`, `&`, newlines, parentheses) end a command; redirections are dropped
 * with their target (`2>&1`, `> /dev/null`, `>> NOTES`), here-document bodies are skipped and comments ignored. Never
 * fails: an unterminated quote runs to the end of the line.
 */
export function shellCommands(line: string): string[][] {
  const out: string[][] = [];
  parseList(line, 0, false, out);
  return out;
}

function parseList(s: string, start: number, nested: boolean, out: string[][]): number {
  const n = s.length;
  let words: string[] = [];
  let word = "";
  let inWord = false;
  /** The next word is a redirection's target or a here-string, not an argument. */
  let dropNext = false;
  /** Subshells `( … )` opened in this list. */
  let parens = 0;
  const heredocs: HereDoc[] = [];
  const endWord = () => {
    if (inWord) {
      if (dropNext) dropNext = false;
      else words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  let i = start;
  while (i < n) {
    const c = s[i]!;
    if (c === "\n") {
      endCommand();
      i++;
      // A here-document's body starts on the line after its operator.
      for (const h of heredocs.splice(0)) i = skipHereDoc(s, i, h);
      continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      const end = close === -1 ? n : close;
      word += s.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const r = readDoubleQuoted(s, i + 1, out);
      word += r.text;
      inWord = true;
      i = r.end;
      continue;
    }
    if (c === "\\") {
      if (s[i + 1] === "\n") {
        i += 2; // a line continuation
        continue;
      }
      if (i + 1 < n) {
        word += s[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "$" && s[i + 1] === "(") {
      i = parseList(s, i + 2, true, out);
      word += "$(…)";
      inWord = true;
      continue;
    }
    if (c === "$" && s[i + 1] === "{") {
      const close = s.indexOf("}", i + 2);
      const end = close === -1 ? n : close + 1;
      word += s.slice(i, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === "`") {
      const r = readBackticks(s, i + 1);
      out.push(...shellCommands(r.body));
      word += "`…`";
      inWord = true;
      i = r.end;
      continue;
    }
    if ((c === "<" || c === ">") && s[i + 1] === "(") {
      endWord();
      i = parseList(s, i + 2, true, out); // process substitution: a command of its own
      continue;
    }
    if (c === "<" || c === ">") {
      // `2>` / `10<`: the digits are the stream, not a word.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      let j = i + 1;
      if (c === "<" && s[j] === "<") {
        if (s[j + 1] === "<") {
          dropNext = true; // `<<< text`: a here-string
          i = j + 2;
          continue;
        }
        j++;
        let strip = false;
        if (s[j] === "-") {
          strip = true;
          j++;
        }
        while (s[j] === " " || s[j] === "\t") j++;
        const d = readWord(s, j);
        if (d.text) heredocs.push({ delim: d.text, strip });
        i = d.end;
        continue;
      }
      if (s[j] === "&") {
        j++;
        const from = j;
        while (j < n && /[0-9-]/.test(s[j]!)) j++;
        if (j > from) {
          i = j; // `2>&1`, `>&-`: onto another stream, no file
          continue;
        }
      } else if (s[j] === ">" || s[j] === "|" || (c === "<" && s[j] === ">")) j++;
      dropNext = true;
      i = j;
      continue;
    }
    if (c === "&") {
      if (s[i + 1] === ">") {
        endWord(); // `&>` / `&>>`
        i += s[i + 2] === ">" ? 3 : 2;
        dropNext = true;
        continue;
      }
      endCommand();
      i += s[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "|") {
      endCommand();
      i += s[i + 1] === "|" || s[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === ";") {
      endCommand();
      i += s[i + 1] === ";" ? 2 : 1;
      continue;
    }
    if (c === "(" && !inWord) {
      endCommand();
      parens++;
      i++;
      continue;
    }
    if (c === ")") {
      endCommand();
      i++;
      if (parens > 0) parens--;
      else if (nested) return i;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand();
  return n;
}

/** A `"…"` string from `i` (after the quote): its text and where it ends; `$( … )` / backticks in it are commands too. */
function readDoubleQuoted(s: string, i: number, out: string[][]): { text: string; end: number } {
  const n = s.length;
  let text = "";
  let j = i;
  while (j < n) {
    const d = s[j]!;
    if (d === "\\" && j + 1 < n) {
      const e = s[j + 1]!;
      if (e === "\n") {
        j += 2;
        continue;
      }
      if (e === "$" || e === "`" || e === '"' || e === "\\") {
        text += e;
        j += 2;
        continue;
      }
    }
    if (d === '"') return { text, end: j + 1 };
    if (d === "$" && s[j + 1] === "(") {
      j = parseList(s, j + 2, true, out);
      text += "$(…)";
      continue;
    }
    if (d === "`") {
      const r = readBackticks(s, j + 1);
      out.push(...shellCommands(r.body));
      text += "`…`";
      j = r.end;
      continue;
    }
    text += d;
    j++;
  }
  return { text, end: n };
}

/** A `` `…` `` substitution from `i` (after the backtick): its script (`\`` unescaped) and where it ends. */
function readBackticks(s: string, i: number): { body: string; end: number } {
  let body = "";
  let j = i;
  while (j < s.length) {
    const d = s[j]!;
    if (d === "\\" && j + 1 < s.length) {
      body += s[j + 1] === "`" ? "`" : d + s[j + 1];
      j += 2;
      continue;
    }
    if (d === "`") return { body, end: j + 1 };
    body += d;
    j++;
  }
  return { body, end: s.length };
}

/** One word from `i` (a here-document's delimiter): quotes removed. */
function readWord(s: string, i: number): { text: string; end: number } {
  let text = "";
  let j = i;
  while (j < s.length) {
    const d = s[j]!;
    if (/[\s;&|<>()]/.test(d)) break;
    if (d === "'" || d === '"') {
      const close = s.indexOf(d, j + 1);
      const end = close === -1 ? s.length : close;
      text += s.slice(j + 1, end);
      j = end + 1;
      continue;
    }
    if (d === "\\" && j + 1 < s.length) {
      text += s[j + 1];
      j += 2;
      continue;
    }
    text += d;
    j++;
  }
  return { text, end: j };
}

/** Index after the here-document's closing line (its body is text, never commands); the end of `s` when it never closes. */
function skipHereDoc(s: string, i: number, h: HereDoc): number {
  let j = i;
  while (j < s.length) {
    const nl = s.indexOf("\n", j);
    const end = nl === -1 ? s.length : nl;
    let line = s.slice(j, end).replace(/\r$/, "");
    if (h.strip) line = line.replace(/^\t+/, "");
    j = nl === -1 ? s.length : nl + 1;
    if (line === h.delim) return j;
  }
  return s.length;
}

// ------------------------------------------------------------------ what runs: wrappers, `cd`, git

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that come before a command without being one (`if git …`, `do git …`, `! git …`, `{ git …; }`). */
const KEYWORDS: ReadonlySet<string> = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"]);
const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** The words of the program that really runs: leading assignments, keywords and wrappers (`sudo`, `env`, `xargs`, …) dropped. */
function programWords(words: readonly string[]): string[] {
  return program(words).words;
}

/** Wrappers that hand the program more arguments than the line spells out: what they read (`xargs`, `parallel`). */
const FEEDERS: ReadonlySet<string> = new Set(["xargs", "parallel"]);

/** `programWords`, and whether a wrapper adds arguments at run time (`git diff --name-only | xargs git checkout --`). */
function program(words: readonly string[]): { words: string[]; moreArgs: boolean } {
  let w = [...words];
  let moreArgs = false;
  for (let guard = 0; guard < 8 && w.length > 0; guard++) {
    while (w.length > 0 && (ASSIGN_RE.test(w[0]!) || KEYWORDS.has(w[0]!))) w = w.slice(1);
    const name = w.length > 0 ? basename(w[0]!) : "";
    const skip = WRAPPERS[name];
    if (!skip) return { words: w, moreArgs };
    if (FEEDERS.has(name)) moreArgs = true;
    w = w.slice(1 + skip(w.slice(1)));
  }
  return { words: w, moreArgs };
}

/** Options (and option values) a wrapper takes before the command it runs. */
function optionsBefore(args: readonly string[], withValue: ReadonlySet<string>): number {
  let k = 0;
  while (k < args.length && args[k]!.startsWith("-") && args[k] !== "-") {
    if (args[k] === "--") return k + 1;
    k += withValue.has(args[k]!) ? 2 : 1;
  }
  return k;
}

const NONE: ReadonlySet<string> = new Set();
const WRAPPERS: Record<string, (args: readonly string[]) => number> = {
  time: (a) => optionsBefore(a, NONE),
  nohup: (a) => optionsBefore(a, NONE),
  builtin: (a) => optionsBefore(a, NONE),
  noglob: (a) => optionsBefore(a, NONE),
  nocorrect: (a) => optionsBefore(a, NONE),
  exec: (a) => optionsBefore(a, new Set(["-a"])),
  // `command -v git` / `-V` only says where git is.
  command: (a) => (a[0] === "-v" || a[0] === "-V" ? a.length : optionsBefore(a, NONE)),
  sudo: (a) => optionsBefore(a, new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U"])),
  env: (a) => {
    let k = optionsBefore(a, new Set(["-u", "-C", "-S"]));
    while (k < a.length && ASSIGN_RE.test(a[k]!)) k++;
    return k;
  },
  nice: (a) => optionsBefore(a, new Set(["-n"])),
  timeout: (a) => {
    const k = optionsBefore(a, new Set(["-s", "-k", "--signal", "--kill-after"]));
    return k < a.length ? k + 1 : k; // the duration
  },
  stdbuf: (a) => optionsBefore(a, new Set(["-i", "-o", "-e"])),
  xargs: (a) => optionsBefore(a, new Set(["-n", "-L", "-P", "-I", "-d", "-E", "-s", "-a"])),
  parallel: (a) => optionsBefore(a, new Set(["-j", "-P", "-n", "-N", "-L", "-I", "-a", "-S", "--jobs", "--arg-file", "--sshlogin"])),
};

/** The script a `bash -c '…'` / `sh -c` / `eval …` runs; null for any other command. */
function scriptOf(words: readonly string[]): string | null {
  const w = programWords(words);
  const name = w.length > 0 ? basename(w[0]!) : "";
  if (name === "eval") return w.slice(1).join(" ");
  if (!SHELLS.has(name)) return null;
  let c = false;
  for (let k = 1; k < w.length; k++) {
    const a = w[k]!;
    if (a === "--") break;
    if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes("c")) c = true;
      if (a === "-o" || a === "+o") k++;
      continue;
    }
    if (c) return a;
    return null; // `bash script.sh`: a file we do not read
  }
  return null;
}

/**
 * One git command line: the folder it runs in (`cd` and `-C` applied), its global options, its verb and what follows.
 * `moreArgs`: it gets more arguments than written when it runs — from `xargs`, `parallel` or `find -exec … {}`.
 */
export type GitInvocation = { dir: string; globals: string[]; verb: string | null; args: string[]; moreArgs?: boolean };

/** A simple command a line runs, as `walkCommands` hands it on. */
export type RunCommand = {
  /** The words of the program that runs (assignments, keywords and wrappers dropped). */
  words: string[];
  /** The folder it runs in: `cwd`, moved by the line's own `cd` / `pushd`. */
  dir: string;
  /** More arguments come at run time: `xargs`, `parallel`, `find -exec … {}`. */
  moreArgs: boolean;
};

/**
 * Every simple command of a shell line, in order — those of `bash -c` / `sh -c` / `eval` scripts, `$( … )` / backticks and
 * `find -exec` / `-execdir` / `-ok` included — with the folder each runs in. `cd` / `pushd` are not handed on, they move it.
 */
export function walkCommands(command: string, cwd: string, visit: (c: RunCommand) => void): void {
  let dir = cwd;
  const walk = (all: readonly (readonly string[])[], depth: number, moreArgs: boolean) => {
    for (const words of all) {
      const inner = scriptOf(words);
      if (inner !== null) {
        if (depth < MAX_DEPTH) walk(shellCommands(inner), depth + 1, moreArgs || program(words).moreArgs);
        continue;
      }
      const p = program(words);
      const w = p.words;
      if (w.length === 0) continue;
      const name = basename(w[0]!);
      if (name === "cd" || name === "pushd") {
        const arg = w.slice(1).find((a) => !a.startsWith("-"));
        if (arg !== undefined) dir = resolveDir(dir, arg);
        continue;
      }
      visit({ words: w, dir, moreArgs: moreArgs || p.moreArgs });
      // `find … -exec <command> {} +|;`: the command runs with the files find found (MARK: §46 — `{}` is filled in).
      if (name === "find" && depth < MAX_DEPTH) for (const exec of findExecs(w)) walk([exec], depth + 1, true);
    }
  };
  walk(shellCommands(command), 0, false);
}

/** The commands `find` runs: the words after each `-exec` / `-execdir` / `-ok` / `-okdir`, up to its `;` or `+`. */
function findExecs(w: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let k = 1; k < w.length; k++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(w[k]!)) continue;
    let end = k + 1;
    while (end < w.length && w[end] !== ";" && w[end] !== "+") end++;
    if (end > k + 1) out.push(w.slice(k + 1, end));
    k = end;
  }
  return out;
}

/** git global options that take a separate value. */
const GIT_GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--list-cmds"]);

function expandHome(p: string): string {
  if (p === "~" || p === "$HOME" || p === "${HOME}") return homedir();
  const m = /^(?:~|\$HOME|\$\{HOME\})[\\/](.*)$/s.exec(p);
  return m ? join(homedir(), m[1]!) : p;
}

function resolveDir(base: string, raw: string): string {
  return resolve(base, expandHome(raw));
}

/**
 * The git commands of a shell line, in order, with the folder each runs in: `cwd` moved by the line's own `cd` / `pushd`
 * (a subshell's too — this only decides where paths point) and by `git -C`. Commands that only mention git (`echo`, `grep`,
 * a here-document) are not among them; `bash -c` / `eval` scripts and substitutions are.
 */
export function gitInvocations(command: string, cwd: string): GitInvocation[] {
  const out: GitInvocation[] = [];
  walkCommands(command, cwd, ({ words: w, dir, moreArgs }) => {
    if (basename(w[0]!) !== "git") return;
    let gdir = dir;
    const globals: string[] = [];
    let k = 1;
    while (k < w.length && w[k]!.startsWith("-")) {
      const opt = w[k]!;
      globals.push(opt);
      if (GIT_GLOBAL_WITH_VALUE.has(opt)) {
        if (opt === "-C" && w[k + 1] !== undefined) gdir = resolveDir(gdir, w[k + 1]!);
        if (w[k + 1] !== undefined) globals.push(w[k + 1]!);
        k += 2;
      } else k++;
    }
    out.push({ dir: gdir, globals, verb: w[k] ?? null, args: w.slice(k + 1), ...(moreArgs ? { moreArgs: true } : {}) });
  });
  return out;
}

// ------------------------------------------------------------------ options of a git verb

type Options = {
  /** Short flags, every letter of every cluster up to a letter that takes a value. */
  short: Set<string>;
  /** Long option names as written (`force-with-lease` of `--force-with-lease=x`), `--no-…` forms included. */
  long: string[];
  /** Words that are not options, before `--`. */
  positionals: string[];
  /** Words after `--` (null: no `--`). */
  afterDashDash: string[] | null;
};

/** Reads a verb's arguments; `shortWithValue` / `longWithValue` name the options that take the next word as their value. */
function readOptions(args: readonly string[], shortWithValue = "", longWithValue: readonly string[] = []): Options {
  const o: Options = { short: new Set(), long: [], positionals: [], afterDashDash: null };
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") {
      o.afterDashDash = args.slice(k + 1);
      break;
    }
    if (a.startsWith("--")) {
      const [name, value] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      o.long.push(name);
      if (value === undefined && longWithValue.some((l) => l.startsWith(name) && name.length > 0)) k++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let c = 1; c < a.length; c++) {
        const ch = a[c]!;
        o.short.add(ch);
        if (shortWithValue.includes(ch)) {
          if (c === a.length - 1) k++; // `-o value`; `-ovalue` keeps it in the word
          break;
        }
      }
      continue;
    }
    o.positionals.push(a);
  }
  return o;
}

/** A long option git would read as `name` (git takes any unambiguous prefix: `--forc`, `--har`); never a `--no-…` form. */
function hasLong(o: Options, ...names: string[]): boolean {
  return o.long.some((l) => l.length >= 2 && !l.startsWith("no-") && names.some((n) => n.startsWith(l)));
}

// ------------------------------------------------------------------ the decision

/** What `destructiveGitReason` asks git about the folder a command runs in (a seam for tests). */
export type GitProbe = {
  /** `name` is a commit there (`git rev-parse --verify --quiet <name>^{commit}`). */
  isRef(dir: string, name: string): Promise<boolean>;
  /**
   * Some file under `pathspecs` (git's pathspec rules, relative to `dir`) has an uncommitted change — staged or not; with
   * `untracked`, an untracked file counts too. Null when git could not tell.
   */
  isDirty(dir: string, pathspecs: readonly string[], untracked: boolean): Promise<boolean | null>;
};

const PROBE_TIMEOUT_MS = 5000;

/** The probe on the real repository (`git status --porcelain`, `git rev-parse`), each call capped at 5 s. */
export const gitProbe: GitProbe = {
  async isRef(dir, name) {
    const out = await runGit(dir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
    return out !== null && out.status === 0 && out.text.trim().length > 0;
  },
  async isDirty(dir, pathspecs, untracked) {
    const out = await runGit(
      dir,
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", `--untracked-files=${untracked ? "all" : "no"}`, "--", ...pathspecs],
      { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS },
    ).catch(() => null);
    if (!out || out.status !== 0) return null;
    return out.stdout.length > 0;
  },
};

export type DestructiveOptions = {
  /** Where the command runs (the shell's directory). */
  cwd: string;
  /** The checkpoint root: `reviewPaths` are relative to it. */
  root: string;
  /** Repo-relative paths still under review (pending, changes requested). */
  reviewPaths: ReadonlySet<string>;
  probe?: GitProbe;
};

/** The reason of the §46 card: git throws away uncommitted work or rewrites the remote. */
export function gitCommandCardReason(): PermissionReason {
  return { code: "git_command", message: SCOPE_MESSAGES.git_command };
}

/**
 * §46: the card reason of a Bash command when one of its git commands throws away uncommitted work or rewrites the remote,
 * else null. Always: `reset --hard|--merge`; `checkout` / `switch` with `-f` / `--force` / `--discard-changes`; `clean`
 * unless `-n` / `--dry-run`; `branch -D` / `-M` / `-C` or any forced branch change; `stash drop|clear`; `push` with
 * `--force` / `-f` / `--force-with-lease` / `--force-if-includes` / `--mirror` / `--delete` / `-d` / `--prune` or a refspec
 * starting with `+` or `:`; `worktree remove --force`. Only when the working tree holds work (a file under review, an
 * uncommitted or unmerged one): `merge --abort`, `rebase` / `cherry-pick` / `revert` / `am` `--abort` or `--skip` — the
 * resolutions made so far go. Only when its files hold work: `checkout [<tree-ish>] -- <paths>`,
 * `checkout .`, `checkout <path>` (an existing path that is no commit), `checkout --ours|--theirs <paths>` and `restore`
 * of the working tree — when a target covers a file still under review or a file with an uncommitted change. A target only
 * the run knows (`$(git diff --name-only)`, `"$f"`, `{a,b}.txt`, what `xargs` / `find -exec` hand on) is the whole tree.
 */
export async function destructiveGitReason(command: string, opts: DestructiveOptions): Promise<PermissionReason | null> {
  if (!/git/.test(command)) return null;
  const probe = opts.probe ?? gitProbe;
  for (const inv of gitInvocations(command, opts.cwd)) {
    if (await destroys(inv, opts, probe)) return gitCommandCardReason();
  }
  return null;
}

async function destroys(inv: GitInvocation, opts: DestructiveOptions, probe: GitProbe): Promise<boolean> {
  const args = inv.args;
  switch (inv.verb) {
    case "reset":
      return hasLong(readOptions(args), "hard", "merge");
    case "clean": {
      const o = readOptions(args, "e", ["exclude"]);
      return !(o.short.has("n") || hasLong(o, "dry-run"));
    }
    case "branch": {
      const o = readOptions(args, "u", ["set-upstream-to", "format", "sort", "points-at", "contains", "no-contains", "merged", "no-merged"]);
      return o.short.has("D") || o.short.has("M") || o.short.has("C") || o.short.has("f") || hasLong(o, "force");
    }
    case "stash": {
      const sub = args.find((a) => !a.startsWith("-"));
      return sub === "drop" || sub === "clear";
    }
    case "push": {
      const o = readOptions(args, "o", ["repo", "receive-pack", "exec", "push-option"]);
      if (o.short.has("f") || o.short.has("d")) return true;
      if (hasLong(o, "force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune")) return true;
      return [...o.positionals, ...(o.afterDashDash ?? [])].some((r) => r.startsWith("+") || r.startsWith(":"));
    }
    case "worktree": {
      if (args.find((a) => !a.startsWith("-")) !== "remove") return false;
      const o = readOptions(args);
      return o.short.has("f") || hasLong(o, "force");
    }
    case "switch": {
      const o = readOptions(args, "cC", ["create", "force-create", "orphan", "conflict"]);
      return o.short.has("f") || hasLong(o, "force", "discard-changes");
    }
    case "checkout":
      return checkoutDestroys(inv, opts, probe);
    case "restore":
      return restoreDestroys(inv, opts, probe);
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "revert":
    case "am":
      // Calling off an operation in progress: `--abort` puts the tree back where it began (`reset --merge`), `--skip` drops
      // the step being resolved — the resolutions made so far go with them.
      return hasLong(readOptions(args), ...(inv.verb === "merge" ? ["abort"] : ["abort", "skip"])) && targetsHoldWork(inv, [WHOLE_TREE], false, opts, probe);
    default:
      return false;
  }
}

/** True when `x` is a pathspec pattern git would expand (`*.java`, `src/?`, `[ab].txt`). */
const isGlob = (x: string): boolean => /[*?[]/.test(x);

/**
 * True when the shell or a runner decides `x` only when the line runs: a substitution or a variable (`$(…)`, `` `…` ``,
 * `$f`, `${f}`), a brace expansion (`{a,b}`, `{1..3}`) or the `{}` that `xargs -I` / `find -exec` fill in.
 */
const atRunTime = (x: string): boolean => /[$`]/.test(x) || x.includes("{}") || /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(x);

/** git's pathspec for the whole working tree, whatever folder the command runs in. */
const WHOLE_TREE = ":/";

/** The pathspecs of a command as far as the line tells: one known only at run time may name any file. */
const pathsOf = (inv: GitInvocation, specs: readonly string[]): string[] => (inv.moreArgs || specs.some(atRunTime) ? [WHOLE_TREE] : [...specs]);

async function checkoutDestroys(inv: GitInvocation, opts: DestructiveOptions, probe: GitProbe): Promise<boolean> {
  const o = readOptions(inv.args, "bB", ["orphan", "conflict", "pathspec-from-file"]);
  if (o.short.has("f") || hasLong(o, "force")) return true;
  if (hasLong(o, "pathspec-from-file")) return targetsHoldWork(inv, ["."], true, opts, probe);
  // A new branch (`-b x [<start>]`, `--orphan`) never touches files.
  if (o.short.has("b") || o.short.has("B") || hasLong(o, "orphan")) return false;
  const pos = o.positionals;
  if (o.afterDashDash !== null) {
    // `git checkout main --`: a branch — unless `xargs` / `find -exec` put the paths after the `--`.
    if (o.afterDashDash.length === 0 && !inv.moreArgs) return false;
    return targetsHoldWork(inv, pathsOf(inv, o.afterDashDash), pos.length > 0, opts, probe);
  }
  // `… | xargs git checkout`: the words it is handed may be paths as well as a branch.
  if (inv.moreArgs) return targetsHoldWork(inv, [WHOLE_TREE], false, opts, probe);
  if (pos.length === 0) return false;
  // `--ours` / `--theirs` / `-p` only take paths.
  if (hasLong(o, "ours", "theirs", "patch") || o.short.has("p")) return targetsHoldWork(inv, pathsOf(inv, pos), false, opts, probe);
  if (pos.length === 1) {
    const x = pos[0]!;
    if (x === "-" || x.startsWith("@{")) return false;
    // `git checkout $(git diff --name-only)`, `git checkout "$f"`: a branch or paths — only the run tells, so it asks when
    // anything could be lost.
    if (atRunTime(x)) return targetsHoldWork(inv, [WHOLE_TREE], false, opts, probe);
    // `git checkout <x>`: a branch / commit when it is one; else a path — what git does with it.
    const pathLike = x === "." || isGlob(x) || existsSync(resolve(inv.dir, expandHome(x)));
    if (!pathLike || (await probe.isRef(inv.dir, x))) return false;
    return targetsHoldWork(inv, [x], false, opts, probe);
  }
  // `git checkout <tree-ish> <paths…>` when the first word is a commit, else every word is a path.
  const fromTree = atRunTime(pos[0]!) || (await probe.isRef(inv.dir, pos[0]!));
  return targetsHoldWork(inv, pathsOf(inv, fromTree ? pos.slice(1) : pos), fromTree, opts, probe);
}

async function restoreDestroys(inv: GitInvocation, opts: DestructiveOptions, probe: GitProbe): Promise<boolean> {
  const o = readOptions(inv.args, "s", ["source", "pathspec-from-file", "conflict"]);
  const staged = o.short.has("S") || hasLong(o, "staged");
  const worktree = o.short.has("W") || hasLong(o, "worktree");
  if (staged && !worktree) return false; // the index only: nothing in the working tree changes
  const fromTree = o.short.has("s") || hasLong(o, "source");
  if (hasLong(o, "pathspec-from-file")) return targetsHoldWork(inv, ["."], fromTree, opts, probe);
  const paths = [...o.positionals, ...(o.afterDashDash ?? [])];
  return (paths.length > 0 || inv.moreArgs === true) && targetsHoldWork(inv, pathsOf(inv, paths), fromTree, opts, probe);
}

/**
 * The pathspecs cover a file still under review or one with an uncommitted change (from a tree-ish an untracked file is
 * overwritten too). A folder git cannot look into, or `--git-dir` / `--work-tree` pointing elsewhere, counts as holding work.
 */
async function targetsHoldWork(inv: GitInvocation, pathspecs: readonly string[], fromTree: boolean, opts: DestructiveOptions, probe: GitProbe): Promise<boolean> {
  if (pathspecs.length === 0) return false;
  if (inv.globals.some((g) => /^--(git-dir|work-tree)(=|$)/.test(g))) return true;
  if (coversReviewFile(inv.dir, pathspecs, opts)) return true;
  const dirty = await probe.isDirty(inv.dir, pathspecs, fromTree);
  return dirty !== false;
}

/** A pathspec (relative to `dir`) names a review path, a folder holding one, or matches one as a glob; `:(magic)` covers all. */
function coversReviewFile(dir: string, pathspecs: readonly string[], opts: DestructiveOptions): boolean {
  if (opts.reviewPaths.size === 0) return false;
  const base = sameOrInside(dir, opts.root);
  if (base === null) return false; // another repository / worktree: none of this review's files
  const review = [...opts.reviewPaths];
  const fold = process.platform === "darwin" || process.platform === "win32";
  const key = (p: string) => (fold ? p.toLowerCase() : p);
  for (const raw of pathspecs) {
    if (raw.startsWith(":")) return true;
    const spec = expandHome(raw);
    const rel = spec.startsWith("/") ? sameOrInside(spec, opts.root) : posix.normalize(posix.join(base, spec.replace(/\\/g, "/")));
    if (rel === null || rel.startsWith("..")) continue;
    const target = rel === "." ? "" : rel.replace(/\/+$/, "");
    if (isGlob(target)) {
      const re = new RegExp("^" + globSource(key(target)) + "(?:/.*)?$", "s");
      if (review.some((p) => re.test(key(p)))) return true;
      continue;
    }
    if (target === "") return true;
    const t = key(target);
    if (review.some((p) => key(p) === t || key(p).startsWith(t + "/"))) return true;
  }
  return false;
}

/** `abs` relative to `root` (POSIX; "." for the root itself), null when it is outside. */
function sameOrInside(abs: string, root: string): string | null {
  const rel = toRepoRelative(abs, root);
  if (rel !== null) return rel;
  return toRepoRelative(join(abs, "_"), root) === "_" ? "." : null;
}

/** git's pathspec glob as a regular expression body (`*` crosses `/`, as in git without `:(glob)`). */
function globSource(glob: string): string {
  let out = "";
  for (let k = 0; k < glob.length; k++) {
    const ch = glob[k]!;
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if (ch === "[") {
      const close = glob.indexOf("]", k + 1);
      if (close === -1) out += "\\[";
      else {
        out += "[" + glob.slice(k + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        k = close;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return out;
}

// ------------------------------------------------------------------ what git commands did (§46, M02)

/** Verbs that can move HEAD or the branch (a commit, a checkout, a pull, …): their HEAD is read before and after. */
const HEAD_MOVING_VERBS: ReadonlySet<string> = new Set(["commit", "checkout", "switch", "reset", "pull", "merge", "rebase", "cherry-pick", "revert", "am", "bisect", "update-ref", "symbolic-ref"]);

/** `git branch -m` / `-M` / `--move`: renames the branch HEAD may be on. */
function renamesBranch(args: readonly string[]): boolean {
  const o = readOptions(args, "u", ["set-upstream-to"]);
  return o.short.has("m") || o.short.has("M") || hasLong(o, "move");
}

/** The line runs a git command that may move HEAD (`gh pr checkout` / `gh pr merge` included). */
export function movesHead(command: string, cwd: string): boolean {
  if (gitInvocations(command, cwd).some((g) => g.verb !== null && (HEAD_MOVING_VERBS.has(g.verb) || (g.verb === "branch" && renamesBranch(g.args))))) return true;
  return shellCommands(command).some((w) => {
    const p = programWords(w);
    return p.length >= 3 && basename(p[0]!) === "gh" && p[1] === "pr" && (p[2] === "checkout" || p[2] === "merge");
  });
}

/** The line runs `git stash` that puts working-tree changes away (`git stash`, `push`, `save`, `-u`, …). */
export function stashesWork(command: string, cwd: string): boolean {
  return gitInvocations(command, cwd).some((g) => {
    if (g.verb !== "stash") return false;
    const sub = g.args.find((a) => !a.startsWith("-"));
    return sub === undefined || sub === "push" || sub === "save" || g.args[0]?.startsWith("-") === true;
  });
}

/**
 * Repo-relative paths of `root`'s repository with an uncommitted change — staged or not — and its untracked files
 * (`git status --porcelain -z`, no renames); null when git could not tell.
 */
export async function dirtyPaths(root: string): Promise<string[] | null> {
  const out = await runGit(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
  if (!out || out.status !== 0) return null;
  return nulSplit(out.stdout).map((e) => e.slice(3)).filter((p) => p.length > 0);
}

/** One HEAD move a reflog entry records: the commit HEAD went to and what moved it (`commit: …`, `checkout: …`). */
export type ReflogEntry = { sha: string; at: number; subject: string };

/** A reflog subject of a commit Claude made with `git commit` (amend and the first commit included; a merge's is not one). */
export function isOwnCommitSubject(subject: string): boolean {
  return /^commit(?: \((?:amend|initial)\))?:/.test(subject);
}

/**
 * The newest HEAD reflog entries (newest first, at most `max`): `git log -g` with the entry time (`HEAD@{<unix>}`).
 * Empty when there is no reflog (`core.logAllRefUpdates` off) or git failed.
 */
export async function headReflog(root: string, max = 200): Promise<ReflogEntry[]> {
  const out = await runGit(root, ["log", "-g", "--date=unix", `--max-count=${max}`, "--format=%H%x09%gd%x09%gs", "HEAD"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
  if (!out || out.status !== 0) return [];
  const entries: ReflogEntry[] = [];
  for (const line of out.text.split("\n")) {
    const m = /^([0-9a-f]{7,64})\t[^\t]*@\{(\d+)\}\t(.*)$/.exec(line);
    if (m) entries.push({ sha: m[1]!, at: Number(m[2]), subject: m[3]! });
  }
  return entries;
}

/**
 * The entries that came after `marker` (the newest entry before the command ran; null: the reflog was empty), newest
 * first — or, when it is gone from the newest `max` (a very long rebase), every entry no older than `since` (unix seconds).
 */
export function entriesSince(entries: readonly ReflogEntry[], marker: ReflogEntry | null, since: number): ReflogEntry[] {
  if (marker) {
    const at = entries.findIndex((e) => e.sha === marker.sha && e.at === marker.at && e.subject === marker.subject);
    if (at >= 0) return entries.slice(0, at);
  } else if (entries.length > 0) return [...entries];
  return entries.filter((e) => e.at >= since);
}
