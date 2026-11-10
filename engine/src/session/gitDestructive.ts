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
 * must not slip through here. Only the words of commands count — text inside `echo`, `grep` or a here-document given to
 * `cat` never does; `bash -c` / `sh -c` / `eval` scripts, a script a shell reads on stdin (`bash <<'EOF'`, `echo '…' | sh`),
 * `$( … )` / backticks, `find -exec` and what git runs itself (`submodule foreach`, `rebase --exec`, `bisect run`) are read
 * as the commands they are. A program is known by its name (`programName`): `git.exe`, `GIT`, `"C:\…\git.exe"` are git,
 * `bash.exe` is a shell, `env.exe` a wrapper.
 */
import { homedir, userInfo } from "node:os";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, posix } from "node:path";
import type { PermissionReason } from "../protocol.js";
import { nulSplit, runGit } from "../git/exec.js";
import { filtersOffArgs } from "../git/filtersOff.js";
import { checkedOutSubmodules } from "../git/submodules.js";
import { programName, resolveShellPath, toRepoRelative } from "../platform/paths.js";
import { nestedRepoRoot, SCOPE_MESSAGES } from "./reviewScope.js";

// ------------------------------------------------------------------ the shell scanner

/** Nested scripts (`bash -c`, `eval`, backticks) are read this deep; deeper ones are not looked into. */
const MAX_DEPTH = 4;

/** One simple command of a shell line. */
export type ShellCommand = {
  /** Its words, quotes removed (a `$( … )` / backticks as `$(…)` / `` `…` ``: their commands are the line's too). */
  words: string[];
  /** What it reads on stdin from the line itself: a here-document's body or a here-string (the last one given). */
  input?: string;
  /** Its stdin comes from what the line does not spell out: a pipe (`… | sh`) or a file (`sh < x`). */
  stdinElsewhere?: boolean;
  /** The files its redirections write (`> x`, `>> x`, `2> x`, `&> x`), as written. */
  writes?: string[];
};

type HereDoc = { delim: string; strip: boolean; cmd: ShellCommand };

/**
 * The simple commands of a shell line as word lists (quotes removed), in order, those of `$( … )`, `` ` … ` `` and
 * `<( … )` included. Separators (`;`, `&&`, `||`, `|`, `&`, newlines, parentheses) end a command; redirections are dropped
 * with their target (`2>&1`, `> /dev/null`, `>> NOTES`), here-document bodies are skipped and comments ignored. Never
 * fails: an unterminated quote runs to the end of the line.
 */
export function shellCommands(line: string): string[][] {
  return parseCommands(line).map((c) => c.words);
}

/** `shellCommands` with each command's stdin: a here-document's body or a here-string, or a pipe / file it reads. */
export function parseCommands(line: string): ShellCommand[] {
  const out: ShellCommand[] = [];
  parseList(line, 0, false, out);
  return out;
}

function parseList(s: string, start: number, nested: boolean, out: ShellCommand[]): number {
  const n = s.length;
  let cmd: ShellCommand = { words: [] };
  let word = "";
  let inWord = false;
  /** The next word is a redirection's target, not an argument (`writeNext`: one it writes). */
  let dropNext = false;
  let writeNext = false;
  /** The next word is a here-string: the command's input. */
  let inputNext = false;
  /** Subshells `( … )` opened in this list. */
  let parens = 0;
  const heredocs: HereDoc[] = [];
  const endWord = () => {
    if (inWord) {
      if (dropNext) dropNext = false;
      else if (writeNext) {
        writeNext = false;
        (cmd.writes ??= []).push(word);
      } else if (inputNext) {
        inputNext = false;
        cmd.input = word;
      } else cmd.words.push(word);
    }
    word = "";
    inWord = false;
  };
  /** Ends the command; `piped`: the next one reads what this one writes. */
  const endCommand = (piped = false) => {
    endWord();
    if (cmd.words.length > 0) out.push(cmd);
    cmd = piped ? { words: [], stdinElsewhere: true } : { words: [] };
  };
  let i = start;
  while (i < n) {
    const c = s[i]!;
    if (c === "\n") {
      endCommand();
      i++;
      // A here-document's body starts on the line after its operator: the input of the command it was given to.
      for (const h of heredocs.splice(0)) {
        const r = readHereDoc(s, i, h);
        h.cmd.input = r.body;
        i = r.end;
      }
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
      out.push(...parseCommands(r.body));
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
      let fd: string | null = null;
      if (inWord && /^\d+$/.test(word)) {
        fd = word;
        word = "";
        inWord = false;
      } else endWord();
      /** This redirection feeds the command's stdin. */
      const stdin = c === "<" && (fd === null || fd === "0");
      let j = i + 1;
      if (c === "<" && s[j] === "<") {
        if (s[j + 1] === "<") {
          if (stdin) inputNext = true; // `<<< text`: a here-string
          else dropNext = true;
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
        if (d.text) heredocs.push({ delim: d.text, strip, cmd });
        i = d.end;
        continue;
      }
      if (stdin) cmd.stdinElsewhere = true; // `< file`, `<&3`
      if (s[j] === "&") {
        j++;
        const from = j;
        while (j < n && /[0-9-]/.test(s[j]!)) j++;
        if (j > from) {
          i = j; // `2>&1`, `>&-`: onto another stream, no file
          continue;
        }
      } else if (s[j] === ">" || s[j] === "|" || (c === "<" && s[j] === ">")) j++;
      if (c === ">") writeNext = true;
      else dropNext = true;
      i = j;
      continue;
    }
    if (c === "&") {
      if (s[i + 1] === ">") {
        endWord(); // `&>` / `&>>`
        i += s[i + 2] === ">" ? 3 : 2;
        writeNext = true;
        continue;
      }
      endCommand();
      i += s[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "|") {
      const or = s[i + 1] === "|";
      endCommand(!or);
      i += or || s[i + 1] === "&" ? 2 : 1;
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
function readDoubleQuoted(s: string, i: number, out: ShellCommand[]): { text: string; end: number } {
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
      out.push(...parseCommands(r.body));
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

/**
 * A here-document from `i`: its body (text, never commands of this line — a shell it is given to reads it as its script)
 * and the index after its closing line; the end of `s` when it never closes.
 */
function readHereDoc(s: string, i: number, h: HereDoc): { body: string; end: number } {
  const lines: string[] = [];
  let j = i;
  while (j < s.length) {
    const nl = s.indexOf("\n", j);
    const end = nl === -1 ? s.length : nl;
    let line = s.slice(j, end).replace(/\r$/, "");
    if (h.strip) line = line.replace(/^\t+/, "");
    j = nl === -1 ? s.length : nl + 1;
    if (line === h.delim) return { body: lines.join("\n"), end: j };
    lines.push(line);
  }
  return { body: lines.join("\n"), end: s.length };
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
    const name = w.length > 0 ? programName(w[0]!) : "";
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

/** A shell that reads its script from stdin: `bash`, `sh -s`, `bash <<'EOF'`, `… | sh`. */
const FROM_STDIN = Symbol("stdin");

/**
 * What a shell runs: the script of `bash -c '…'` / `sh -c` / `eval …`, `FROM_STDIN` for a shell that reads it from stdin (no
 * `-c` and no script file, or `-s`); null for any other command (`bash script.sh`: a file we do not read).
 */
function shellScript(w: readonly string[]): string | typeof FROM_STDIN | null {
  const name = w.length > 0 ? programName(w[0]!) : "";
  if (name === "eval") return w.slice(1).join(" ");
  if (!SHELLS.has(name)) return null;
  let c = false;
  let s = false;
  for (let k = 1; k < w.length; k++) {
    const a = w[k]!;
    if (a === "--") return c ? (w[k + 1] ?? null) : s || k + 1 >= w.length ? FROM_STDIN : null;
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a.startsWith("-") && a.includes("c")) c = true;
      if (a.startsWith("-") && a.includes("s")) s = true;
      if (/[oO]$/.test(a)) k++; // `-o pipefail`, `-euo pipefail`
      continue;
    }
    if (a.startsWith("--")) continue; // `--login`, `--norc`
    if (c) return a;
    return s ? FROM_STDIN : null; // `bash -s arg`: still stdin; `bash script.sh`: a file
  }
  return c ? null : FROM_STDIN;
}

/**
 * The scripts a shell command runs: its `-c` / `eval` script; or what it reads on stdin — the line's here-document or
 * here-string for it. A script the line does not spell out (`… | sh`, `sh < file`, `bash -c "$(cat <<'EOF' …)"`) is looked
 * for in every text of the line that could be one (`lineTexts`).
 */
function scriptsOf(script: string | typeof FROM_STDIN, cmd: ShellCommand, line: readonly ShellCommand[]): string[] {
  if (script === FROM_STDIN) {
    if (cmd.input !== undefined) return [cmd.input];
    return cmd.stdinElsewhere ? lineTexts(line) : [];
  }
  return /^(?:\$\(…\)|`…`)$/.test(script.trim()) ? lineTexts(line) : [script];
}

/**
 * Every text of a line that could be a script handed to a shell: a word with a space or a line break in it (`echo 'git
 * reset --hard' | sh`), a here-document's body, a here-string — `\n` read as a line break (`printf 'git … \n' | sh`).
 */
function lineTexts(line: readonly ShellCommand[]): string[] {
  const out: string[] = [];
  for (const c of line) {
    for (const w of c.words) if (/\s/.test(w)) out.push(w);
    if (c.input !== undefined) out.push(c.input);
  }
  return out.map((t) => t.replace(/\\n/g, "\n"));
}

/**
 * One git command line: the folder it runs in (`cd` and `-C` applied), its global options, its verb and what follows.
 * `moreArgs`: it gets more arguments than written when it runs — from `xargs`, `parallel` or `find -exec … {}`.
 * `dirUnknown`: it runs in folders the line does not name (`git submodule foreach`, `git rebase --exec`, `find -execdir`).
 */
export type GitInvocation = { dir: string; globals: string[]; verb: string | null; args: string[]; moreArgs?: boolean; dirUnknown?: boolean };

/** A simple command a line runs, as `walkCommands` hands it on. */
export type RunCommand = {
  /** The words of the program that runs (assignments, keywords and wrappers dropped). */
  words: string[];
  /** The command as the line has it (its here-document or here-string, a pipe into it). */
  cmd: ShellCommand;
  /** The folder it runs in: `cwd`, moved by the line's own `cd` / `pushd`. */
  dir: string;
  /** More arguments come at run time: `xargs`, `parallel`, `find -exec … {}`. */
  moreArgs: boolean;
  /** It runs in folders the line does not name: in each submodule (`git submodule foreach`), at each rebase step, … */
  dirUnknown: boolean;
};

/**
 * Every simple command of a shell line, in order, with the folder each runs in — also those of `bash -c` / `sh -c` / `eval`
 * scripts, of a script a shell reads from the line (`bash <<'EOF'`, `<<< '…'`, `echo '…' | sh`), of `$( … )` / backticks,
 * of `find -exec` / `-execdir` / `-ok`, and those git runs itself (`git submodule foreach <cmd>`, `git rebase -x <cmd>`,
 * `git bisect run <cmd>`). `cd` / `pushd` are not handed on: they move the folder.
 */
export function walkCommands(command: string, cwd: string, visit: (c: RunCommand) => void): void {
  let dir = cwd;
  const walk = (cmds: readonly ShellCommand[], depth: number, moreArgs: boolean, dirUnknown: boolean) => {
    for (const cmd of cmds) {
      const p = program(cmd.words);
      const w = p.words;
      if (w.length === 0) continue;
      const more = moreArgs || p.moreArgs;
      const script = shellScript(w);
      if (script !== null) {
        if (depth < MAX_DEPTH) for (const text of scriptsOf(script, cmd, cmds)) walk(parseCommands(text), depth + 1, more, dirUnknown);
        continue;
      }
      // `cd` / `pushd` are the shell's own, by their name as written; a program is known by `programName` (`find.exe`, `git.exe`).
      const builtin = basename(w[0]!);
      if (builtin === "cd" || builtin === "pushd") {
        const arg = w.slice(1).find((a) => !a.startsWith("-"));
        if (arg !== undefined) dir = resolveDir(dir, arg);
        continue;
      }
      visit({ words: w, cmd, dir, moreArgs: more, dirUnknown });
      if (depth >= MAX_DEPTH) continue;
      const name = programName(w[0]!);
      // `find … -exec <command> {} +|;`: the command runs with the files find found (`-execdir`: in each one's folder).
      if (name === "find") for (const e of findExecs(w)) walk([{ words: e.words }], depth + 1, true, dirUnknown || e.inItsFolder);
      if (name === "git") {
        const runs = gitRuns(parseGit(w, dir));
        const at = dir;
        if (runs.length > 0) walk(runs, depth + 1, false, true);
        dir = at;
      }
    }
  };
  walk(parseCommands(command), 0, false, false);
}

/** The commands `find` runs: the words after each `-exec` / `-execdir` / `-ok` / `-okdir`, up to its `;` or `+`. */
function findExecs(w: readonly string[]): { words: string[]; inItsFolder: boolean }[] {
  const out: { words: string[]; inItsFolder: boolean }[] = [];
  for (let k = 1; k < w.length; k++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(w[k]!)) continue;
    let end = k + 1;
    while (end < w.length && w[end] !== ";" && w[end] !== "+") end++;
    if (end > k + 1) out.push({ words: w.slice(k + 1, end), inItsFolder: w[k]!.endsWith("dir") });
    k = end;
  }
  return out;
}

/**
 * The commands git runs itself (§46): `submodule foreach <command>` in every submodule — nested repositories the review
 * does not see —, `rebase -x|--exec <command>` after each step, `bisect run <command>` at each step. One word is a shell
 * script (`foreach 'git reset --hard'`); several are the command's own words (`bisect run sh -c '…'`), as git runs them.
 */
function gitRuns(g: { verb: string | null; args: string[] }): ShellCommand[] {
  const a = g.args;
  const runs = (words: string[]): ShellCommand[] => (words.length === 1 ? parseCommands(words[0]!) : [{ words }]);
  if (g.verb === "submodule") {
    let k = 0;
    while (a[k]?.startsWith("-")) k++; // `git submodule --quiet foreach`
    if (a[k] !== "foreach") return [];
    k++;
    while (a[k]?.startsWith("-")) k++; // `--recursive`, `--`
    return k < a.length ? runs(a.slice(k)) : [];
  }
  if (g.verb === "rebase") {
    const out: ShellCommand[] = [];
    for (let k = 0; k < a.length; k++) {
      if ((a[k] === "-x" || a[k] === "--exec") && a[k + 1] !== undefined) out.push(...parseCommands(a[++k]!));
      else if (a[k]!.startsWith("--exec=")) out.push(...parseCommands(a[k]!.slice("--exec=".length)));
    }
    return out;
  }
  if (g.verb === "bisect" && a[0] === "run" && a.length > 1) return runs(a.slice(1));
  return [];
}

/** A git command's words: the folder it runs in (`-C` applied to `dir`), its global options, its verb and what follows. */
function parseGit(w: readonly string[], dir: string): { dir: string; globals: string[]; verb: string | null; args: string[] } {
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
  return { dir: gdir, globals, verb: w[k] ?? null, args: w.slice(k + 1) };
}

/** git global options that take a separate value. */
const GIT_GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--list-cmds"]);

/**
 * The folder a `cd` / `pushd` / `git -C` word names, against `base`, as the shell reads it: `~` / `$HOME` put in (`shellWord`;
 * one only the run knows stays as written — no such folder, so the probe fails there and its targets count as holding work)
 * and, on Windows, MSYS `/c/…` as `C:\…` (§20).
 */
function resolveDir(base: string, raw: string): string {
  return resolveShellPath(base, shellWord(raw) ?? raw);
}

/**
 * The git commands of a shell line, in order, with the folder each runs in: `cwd` moved by the line's own `cd` / `pushd`
 * (a subshell's too — this only decides where paths point) and by `git -C`. Commands that only mention git (`echo`, `grep`,
 * a here-document given to `cat`) are not among them; scripts a shell runs and substitutions are (`walkCommands`).
 */
export function gitInvocations(command: string, cwd: string): GitInvocation[] {
  const out: GitInvocation[] = [];
  walkCommands(command, cwd, ({ words: w, dir, moreArgs, dirUnknown }) => {
    if (programName(w[0]!) !== "git") return;
    out.push({ ...parseGit(w, dir), ...(moreArgs ? { moreArgs: true } : {}), ...(dirUnknown ? { dirUnknown: true } : {}) });
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
   * `untracked`, an untracked file counts too. Null when git could not tell. `foreign`: `dir` is not in this window's
   * repository (a nested clone or submodule, another worktree, a folder outside the project) — its filter drivers stay off.
   * `submodules` (release-2 review): the command may recurse into submodules — a checked-out submodule under `pathspecs`
   * with an uncommitted change of its own counts too.
   */
  isDirty(dir: string, pathspecs: readonly string[], untracked: boolean, foreign?: boolean, submodules?: boolean): Promise<boolean | null>;
  /** Release-2 review: `submodule.recurse` is true where `dir` is (the user's or the repository's configuration). */
  recursesSubmodules?(dir: string): Promise<boolean>;
};

const PROBE_TIMEOUT_MS = 5000;

/**
 * The probe on the real repository (`git status --porcelain`, `git rev-parse`), each call capped at 5 s. It runs before any
 * card: in a folder of another repository the status runs with that repository's filter drivers off (`filtersOffArgs`;
 * fsmonitor and hooks are off for every call). A submodule counts by its commit only (`--ignore-submodules=dirty`: git
 * would run a status inside it, with its own configuration) — release-2 review: unless the command may recurse into it
 * (`submodules`), when each checked-out submodule under the pathspecs is probed on its own, as another repository (its
 * filter drivers off), down to `MAX_SUBMODULE_DEPTH`.
 */
export const gitProbe: GitProbe = {
  async isRef(dir, name) {
    const out = await runGit(dir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
    return out !== null && out.status === 0 && out.text.trim().length > 0;
  },
  isDirty: (dir, pathspecs, untracked, foreign, submodules) => dirtyIn(dir, pathspecs, untracked, foreign === true, submodules === true, 0),
  async recursesSubmodules(dir) {
    const out = await runGit(dir, ["config", "--type=bool", "--get", "submodule.recurse"], { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
    return out !== null && out.status === 0 && out.text.trim() === "true";
  },
};

/** How deep `gitProbe.isDirty` follows submodules inside submodules. */
const MAX_SUBMODULE_DEPTH = 3;

async function dirtyIn(dir: string, pathspecs: readonly string[], untracked: boolean, foreign: boolean, submodules: boolean, depth: number): Promise<boolean | null> {
  const off = foreign ? await filtersOffArgs(dir, PROBE_TIMEOUT_MS).catch(() => null) : [];
  if (off === null) return null;
  const out = await runGit(
    dir,
    [...off, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", `--untracked-files=${untracked ? "all" : "no"}`, "--ignore-submodules=dirty", "--", ...pathspecs],
    { allowFailure: true, timeoutMs: PROBE_TIMEOUT_MS },
  ).catch(() => null);
  if (!out || out.status !== 0) return null;
  if (out.stdout.length > 0) return true;
  if (!submodules) return false;
  // A submodule that is checked out holds work of its own (one that is not has nothing to lose).
  const subs = await checkedOutSubmodules(dir, pathspecs, PROBE_TIMEOUT_MS);
  if (subs === null) return null;
  for (const sub of subs) {
    if (depth >= MAX_SUBMODULE_DEPTH) return true;
    const dirty = await dirtyIn(join(dir, sub), ["."], untracked, true, true, depth + 1);
    if (dirty !== false) return dirty;
  }
  return false;
}

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
 * of the working tree — when a target covers a file still under review or a file with an uncommitted change. A target is
 * read as the shell hands it to git (`~/…`, `$HOME/…` put in); one only the run knows (`$(git diff --name-only)`, `"$f"`,
 * `~bob/…`, `{a,b}.txt`, what `xargs` / `find -exec` hand on) is the whole tree.
 */
export async function destructiveGitReason(command: string, opts: DestructiveOptions): Promise<PermissionReason | null> {
  if (!/git/i.test(command)) return null;
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

/** `$HOME` / `${HOME}` in a word (`$HOMEDIR` is another variable). */
const HOME_VAR_RE = /\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g;

/**
 * The folder `~<name>` stands for (`~`: `name` is empty): the home folder for `~` and for your own user name; null for
 * another user's (the shell asks the system for it) and for `~+` / `~-` (the shell's folders) — what only the run knows.
 */
function tildeFolder(name: string): string | null {
  if (name === "") return homedir();
  let me: string;
  try {
    me = userInfo().username;
  } catch {
    return null; // no user entry: the shell finds no `~name` either
  }
  return (process.platform === "win32" ? name.toLowerCase() === me.toLowerCase() : name === me) ? homedir() : null;
}

/**
 * A word as the shell hands it to git (§46, §20): `~`, `~/…`, `~<your user name>/…`, `$HOME` and `${HOME}` with the home
 * folder put in; null when only the run knows it — another user's `~bob/…`, `~+` / `~-`, any other variable or a
 * substitution (`$f`, `${f}`, `$(…)`, `` `…` ``), a brace expansion (`{a,b}`, `{1..3}`) or the `{}` that `xargs -I` /
 * `find -exec` fill in.
 */
function shellWord(x: string): string | null {
  const tilde = /^~([^/\\]*)/.exec(x);
  const folder = tilde ? tildeFolder(tilde[1]!) : "";
  if (folder === null) return null;
  const rest = tilde ? x.slice(tilde[0].length) : x;
  if (atRunTime(rest.replace(HOME_VAR_RE, "_"))) return null;
  return folder + rest.replace(HOME_VAR_RE, () => homedir());
}

/** git's pathspec for the whole working tree, whatever folder the command runs in. */
const WHOLE_TREE = ":/";

/** The pathspecs of a command as the shell hands them to git (`shellWord`): one only the run knows may name any file. */
function pathsOf(inv: GitInvocation, specs: readonly string[]): string[] {
  const words = specs.map(shellWord);
  return inv.moreArgs || words.includes(null) ? [WHOLE_TREE] : (words as string[]);
}

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
    if (pos[0] === "-" || pos[0]!.startsWith("@{")) return false;
    const x = shellWord(pos[0]!);
    // `git checkout $(git diff --name-only)`, `git checkout "$f"`, `git checkout ~bob/x`: a branch or paths — only the run
    // tells, so it asks when anything could be lost.
    if (x === null) return targetsHoldWork(inv, [WHOLE_TREE], false, opts, probe);
    // `git checkout <x>`: a branch / commit when it is one; else a path — what git does with it.
    const pathLike = x === "." || isGlob(x) || existsSync(resolveShellPath(inv.dir, x));
    if (!pathLike || (await probe.isRef(inv.dir, x))) return false;
    return targetsHoldWork(inv, [x], false, opts, probe);
  }
  // `git checkout <tree-ish> <paths…>` when the first word is a commit, else every word is a path. A first word only the run
  // knows (`"$rev"`, `~bob/x`) may be either: the whole tree as paths, and what follows it from a tree-ish.
  const first = shellWord(pos[0]!);
  if (first === null) {
    return (await targetsHoldWork(inv, [WHOLE_TREE], false, opts, probe)) || targetsHoldWork(inv, pathsOf(inv, pos.slice(1)), true, opts, probe);
  }
  const fromTree = await probe.isRef(inv.dir, first);
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
  // In every submodule (`git submodule foreach`), at each rebase step: no folder to look at — nested repositories the review
  // does not see, so the card is all there is.
  if (inv.dirUnknown) return true;
  if (inv.globals.some((g) => /^--(git-dir|work-tree)(=|$)/.test(g))) return true;
  if (coversReviewFile(inv.dir, pathspecs, opts)) return true;
  // Not this window's repository (another one's configuration is not the user's to run before the card): filters off.
  const foreign = sameOrInside(inv.dir, opts.root) === null || nestedRepoRoot(join(inv.dir, "_"), opts.root) !== null;
  const specs = pathspecs.map((p) => (isAbsolute(p) ? resolveShellPath(inv.dir, p) : p));
  const recurse = await recursesSubmodules(inv, probe);
  const dirty = recurse ? await probe.isDirty(inv.dir, specs, fromTree, foreign, true) : await probe.isDirty(inv.dir, specs, fromTree, foreign);
  return dirty !== false;
}

/** A `submodule.recurse` value git reads as false. */
const FALSE_RE = /^(?:false|no|off|0)$/i;

/**
 * Release-2 review: the command may change the files of the submodules under its paths — `--recurse-submodules` (the last
 * of it and `--no-recurse-submodules` wins), `-c submodule.recurse[=<bool>]` / `--config-env=submodule.recurse=…` on the
 * line, else `submodule.recurse` set true where it runs (a common global setting: a plain `git checkout -- .` recurses then).
 */
async function recursesSubmodules(inv: GitInvocation, probe: GitProbe): Promise<boolean> {
  for (let k = inv.args.length - 1; k >= 0; k--) {
    const a = inv.args[k]!;
    if (a === "--no-recurse-submodules") return false;
    if (a === "--recurse-submodules") return true;
    if (a.startsWith("--recurse-submodules=")) return !FALSE_RE.test(a.slice("--recurse-submodules=".length));
  }
  let fromLine: boolean | null = null;
  for (let k = 0; k < inv.globals.length; k++) {
    const g = inv.globals[k]!;
    const value = g === "-c" ? inv.globals[k + 1] : g.startsWith("--config-env=") ? g.slice("--config-env=".length) : g === "--config-env" ? inv.globals[k + 1] : undefined;
    if (value === undefined || !/^submodule\.recurse(?:=|$)/i.test(value)) continue;
    const eq = value.indexOf("=");
    fromLine = g === "-c" ? eq === -1 || !FALSE_RE.test(value.slice(eq + 1)) : true;
  }
  if (fromLine !== null) return fromLine;
  return (await probe.recursesSubmodules?.(inv.dir).catch(() => false)) ?? false;
}

/**
 * A pathspec (relative to `dir`, as the shell hands it to git: `pathsOf`) names a review path, a folder holding one, or
 * matches one as a glob; `:(magic)` covers all. An absolute one is read as the shell spells it (§20: on Windows `C:\…`,
 * `C:/…` and MSYS `/c/…`) — so is the one the probe hands git: Git Bash gives git `/c/…` as `C:/…`.
 */
function coversReviewFile(dir: string, pathspecs: readonly string[], opts: DestructiveOptions): boolean {
  if (opts.reviewPaths.size === 0) return false;
  const base = sameOrInside(dir, opts.root);
  if (base === null) return false; // another repository / worktree: none of this review's files
  const review = [...opts.reviewPaths];
  const fold = process.platform === "darwin" || process.platform === "win32";
  const key = (p: string) => (fold ? p.toLowerCase() : p);
  for (const spec of pathspecs) {
    if (spec.startsWith(":")) return true;
    const rel = isAbsolute(spec) ? sameOrInside(resolveShellPath(dir, spec), opts.root) : posix.normalize(posix.join(base, spec.replace(/\\/g, "/")));
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
    return p.length >= 3 && programName(p[0]!) === "gh" && p[1] === "pr" && (p[2] === "checkout" || p[2] === "merge");
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
