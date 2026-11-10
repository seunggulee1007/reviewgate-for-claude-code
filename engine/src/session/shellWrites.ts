/**
 * What a Bash command writes, as far as its words tell — docs/PROTOCOL.md §19.4 (plan mode denies only a command that
 * clearly writes) and §33.9 (a Claude Code settings file gets the card only as a write target). Read with the §46 shell
 * scanner (`walkCommands`): a `cd` moves the folder later words are read in, and scripts a shell runs (`bash -c`, a
 * here-document given to `sh`), `$( … )`, `find -exec` and what `xargs` runs count as the commands they are.
 */
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { programName, resolveShellPath } from "../platform/paths.js";
import { writtenPaths } from "./autoMode.js";
import { gitInvocations, parseCommands, walkCommands } from "./gitDestructive.js";

/** A file a command writes, as written, and the folder its command runs in (relative paths are read there). */
export type WrittenFile = { path: string; dir: string };

/** Device files a redirection writes without writing a file (`2>/dev/null`, `>/dev/stderr`). */
const DEVICE_RE = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;

/** `sed -i` / `-I` / `--in-place` and `perl -i`: they edit their operands in place (the script is one of them: it names no file). */
function inPlaceOperands(w: readonly string[]): string[] {
  const name = programName(w[0]!);
  const ops = w.slice(1).filter((a) => !a.startsWith("-"));
  if (name === "sed" || name === "gsed") return w.slice(1).some((a) => /^-[a-zA-Z]*[iI]/.test(a) || a.startsWith("--in-place")) ? ops : [];
  if (name === "perl") return w.slice(1).some((a) => /^-[a-zA-Z0-9]*i/.test(a)) ? ops : [];
  return [];
}

/**
 * The files a shell line writes (their content: created, overwritten, appended to, deleted, moved, linked): a redirection's
 * file (`> x`, `>> x`, `&> x`; not a device), every operand of `rm` / `mv` / `tee` / `truncate` / …, the target of `cp` /
 * `ln` / `install` / `rsync`, `dd of=`, `find -delete`'s start points and the operands of `sed -i` / `perl -i` — also in a
 * script a shell runs. Each with the folder its command runs in.
 */
export function writtenFiles(command: string, cwd: string): WrittenFile[] {
  const out: WrittenFile[] = [];
  const seen = new Set<string>();
  const add = (path: string, dir: string) => {
    if (DEVICE_RE.test(path) || seen.has(`${dir}\0${path}`)) return;
    seen.add(`${dir}\0${path}`);
    out.push({ path, dir });
  };
  const dirs = new Set([cwd]);
  walkCommands(command, cwd, ({ words, cmd, dir }) => {
    dirs.add(dir);
    for (const p of [...(cmd.writes ?? []), ...writtenPaths(words), ...inPlaceOperands(words)]) add(p, dir);
  });
  // A shell's own redirection (`bash -c '…' > x`): `walkCommands` goes into its script instead of handing the shell on.
  for (const c of parseCommands(command)) for (const p of c.writes ?? []) for (const d of dirs) add(p, d);
  return out;
}

/** Commands that create or change files they name without overwriting content: their operands (§19.4 only). */
const TOUCHERS: Partial<Record<string, (ops: string[]) => string[]>> = {
  touch: (ops) => ops,
  mkdir: (ops) => ops,
  chmod: (ops) => ops.slice(1),
  chown: (ops) => ops.slice(1),
  chgrp: (ops) => ops.slice(1),
};

/** Commands whose operands (`writtenPaths`) are files they delete or overwrite. */
const FILE_WRITERS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "mv", "tee", "cp", "ln", "install", "rsync", "ditto"]);

/** Package managers' verbs that install, remove, link or publish packages (a bare `yarn` installs too). */
const PACKAGE_VERBS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["install", "i", "add", "ci", "uninstall", "un", "remove", "rm", "update", "up", "upgrade", "link", "unlink", "publish", "version", "prune", "dedupe"]),
  pnpm: new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link", "unlink", "publish", "prune"]),
  yarn: new Set(["install", "add", "remove", "upgrade", "up", "link", "unlink", "publish", "version"]),
  bun: new Set(["install", "i", "add", "a", "remove", "rm", "update", "link", "unlink", "publish"]),
  pip: new Set(["install", "uninstall", "download"]),
  brew: new Set(["install", "uninstall", "remove", "rm", "reinstall", "upgrade", "update", "tap", "untap", "link", "unlink", "cleanup"]),
  gem: new Set(["install", "uninstall", "update"]),
  cargo: new Set(["install", "uninstall", "add", "remove", "rm"]),
  go: new Set(["install", "get"]),
  poetry: new Set(["add", "remove", "install", "update", "lock"]),
  uv: new Set(["add", "remove", "sync", "lock"]),
};

/** git verbs that change the repository, its working tree or a remote (`GIT_MUTATING_RE`'s and the ones it leaves to §46). */
const GIT_WRITE_VERBS: ReadonlySet<string> = new Set([
  "checkout", "switch", "reset", "restore", "clean", "rebase", "merge", "am", "pull", "cherry-pick", "revert", "bisect",
  "commit", "add", "rm", "mv", "push", "init", "clone", "gc", "prune", "update-ref", "update-index", "filter-branch", "replace",
]);

/** A package manager installing / removing / publishing, as `name verb …` (`pip3`, `python3 -m pip`, `uv pip install` too). */
function installs(w: readonly string[]): boolean {
  let name = programName(w[0]!);
  let rest = w.slice(1);
  if (/^python[\d.]*$/.test(name) && rest[0] === "-m" && rest[1] === "pip") {
    name = "pip";
    rest = rest.slice(2);
  } else if (name === "uv" && rest[0] === "pip") {
    name = "pip";
    rest = rest.slice(1);
  } else if (/^pip[\d.]*$/.test(name)) name = "pip";
  const verbs = PACKAGE_VERBS[name];
  if (!verbs) return false;
  const verb = rest.find((a) => !a.startsWith("-"));
  return verb === undefined ? name === "yarn" : verbs.has(verb);
}

/** A git command that changes something: a write verb, `stash` other than `list` / `show`, `apply` that applies, `worktree add` / `remove` / …. */
function gitWrites(verb: string | null, args: readonly string[]): boolean {
  if (verb === null) return false;
  if (GIT_WRITE_VERBS.has(verb)) return true;
  const sub = args.find((a) => !a.startsWith("-"));
  if (verb === "stash") return sub !== "list" && sub !== "show";
  if (verb === "apply") return !args.some((a) => /^--(?:check|stat|numstat|summary)$/.test(a)) || args.includes("--apply");
  if (verb === "worktree") return sub !== undefined && sub !== "list";
  return false;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * §19.4: the command clearly changes something — it writes a file (`writtenFiles`, or `touch` / `mkdir` / `chmod` / `chown`
 * on one), installs / removes / publishes packages (`npm install`, `pip install`, `brew install`, …), runs a git command
 * that changes the repository or a remote, `gh pr checkout` / `merge`, or `patch`. A file `isScratch` accepts (a temporary
 * folder outside any repository) does not count. Anything else — a build, a test run, a script, `awk`, `curl` — is not
 * clear from its words.
 */
export function clearlyWrites(command: string, cwd: string, isScratch: (abs: string) => boolean = () => false): boolean {
  const counts = (f: WrittenFile) => !isScratch(resolveShellPath(f.dir, expandHome(f.path)));
  if (writtenFiles(command, cwd).some(counts)) return true;
  let hit = false;
  walkCommands(command, cwd, ({ words, dir, moreArgs }) => {
    if (hit) return;
    const name = programName(words[0]!);
    const touch = TOUCHERS[name];
    // What `xargs` / `find -exec` hand on is known only when it runs: any file (`git ls-files | xargs rm`).
    if (moreArgs && (touch || FILE_WRITERS.has(name))) hit = true;
    else if (touch) hit = touch(words.slice(1).filter((a) => !a.startsWith("-"))).some((path) => counts({ path, dir }));
    else if (name === "patch" || installs(words)) hit = true;
    else if (name === "gh") hit = words[1] === "pr" && (words[2] === "checkout" || words[2] === "merge");
  });
  return hit || gitInvocations(command, cwd).some((g) => gitWrites(g.verb, g.args));
}

/** Interpreters whose inline script is read for §33.9, with the options (or subcommand) that take it as the next word. */
function inlineFlag(name: string): RegExp | null {
  if (/^python[\d.]*$/.test(name)) return /^-c$/;
  if (name === "node" || name === "nodejs" || name === "bun") return /^(?:-e|--eval|-p|--print)$/;
  if (name === "deno") return /^eval$/;
  if (name === "ruby" || name === "osascript") return /^-e$/;
  if (name === "perl") return /^-[a-zA-Z0-9]*[eE]$/; // `-e`, `-ne`, `-pe`, `-0777pe`
  if (name === "php") return /^-r$/;
  return null;
}

/** An interpreter's inline script, the words of the command that runs it (the script among them) and the folder it runs in. */
export type InlineScript = { text: string; words: string[]; dir: string };

/**
 * The scripts interpreters run from the line itself — `python3 -c '…'`, `node -e '…'`, `ruby -e`, `perl -ne`, `php -r`,
 * `deno eval`, a here-document given to `python3 -` — with the folder each runs in. A script file (`python3 x.py`) is not
 * read.
 */
export function inlineScripts(command: string, cwd: string): InlineScript[] {
  const out: InlineScript[] = [];
  walkCommands(command, cwd, ({ words, cmd, dir }) => {
    const flag = inlineFlag(programName(words[0]!));
    if (!flag) return;
    const all = cmd.input !== undefined ? [...words, cmd.input] : [...words];
    for (let k = 1; k < words.length - 1; k++) if (flag.test(words[k]!)) out.push({ text: words[++k]!, words: all, dir });
    if (cmd.input !== undefined) out.push({ text: cmd.input, words: all, dir });
  });
  return out;
}

/**
 * §33.9: an inline script that may write a file — a `write…` call (`write_text`, `writeFileSync`, `.write(`), `dump(`,
 * `open(…, 'w' | 'a' | 'x' | '+')`, a rename / remove / copy / move of the os, fs or shutil modules, `truncate`, an append,
 * a copy or a link (`fs.cpSync`, `appendFileSync`, `symlinkSync`, `os.link`) — or one that starts another program (`system(`,
 * `exec(`, `os.exec…`, `execSync`, `spawn…(`, `popen`, `subprocess`, `child_process`), which may write anything. A script that only reads
 * (`json.load(open(p))`, `fs.readFileSync`) is not one.
 */
export const SCRIPT_WRITE_RE =
  /write|\bdump\(|open\s*\([^)]*?['"][rbt]*[wax+][rwxabt+]*['"]|\b(?:os|fs|shutil|Path\([^)]*\))\.\w*(?:rename|remove|unlink|replace|move|copy|rm|touch)\w*|copyFileSync|renameSync|unlinkSync|rmSync|truncate|cpSync|\.cp\s*\(|appendFile|\b(?:sym)?link(?:Sync)?\s*\(|\bsystem\s*\(|(?<![.\w])exec\s*\(|\bos\.exec|execSync|execFile|\bspawn\w*\s*\(|popen|subprocess|child_process/i;

// MARK: release-2 review — §33.9 (M22 follow-up): what a line may write without saying which file

/** Programs that write no file but through a redirection the line spells out (`writtenFiles` reads that). */
const READERS: ReadonlySet<string> = new Set([
  "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "diff", "cmp", "jq", "ls", "stat", "file", "echo", "printf",
  "test", "[", "true", "false", "realpath", "readlink", "basename", "dirname", "md5", "md5sum", "shasum", "sha1sum",
  "sha256sum", "cut", "tr", "nl", "od", "hexdump", "strings",
]);
/** find's actions that write a file they name (`-fprint x`); its `-delete` is `writtenPaths`', its `-exec` a command of its own. */
const FIND_WRITES_RE = /^-(?:fprint0?|fprintf|fls)$/;
/** git verbs that change no file of the working tree they name (a path is a read source or what the index takes). */
const GIT_NAME_ONLY_VERBS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "add", "commit", "blame", "annotate", "ls-files", "ls-tree", "grep", "cat-file",
  "check-ignore", "check-attr", "rev-parse", "rev-list", "shortlog", "whatchanged", "diff-files", "diff-index", "diff-tree",
  "hash-object", "update-index", "describe", "branch", "tag", "remote", "fetch", "push",
]);
/** A word only the run decides: a substitution, a variable, a glob, a brace expansion. */
const RUN_TIME_RE = /[$`*?…]|\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/** A command a line runs whose file writes its words do not tell: the words that may name what it writes, and its folder. */
export type OpaqueCommand = { words: string[]; dir: string };

/**
 * §33.9 (M22 follow-up): the commands of a line that may write files `writtenFiles` cannot name — any program it does not
 * model (`curl -o`, `wget -O`, `yq -i`, `sponge`, `unzip`, `tar`, a script file, `sed` / `perl` without `-i`, …), a git
 * verb that writes the paths it is given (`checkout`, `restore`, `stash`, `apply`, `rm`, `mv`, `clean`, …; any one with
 * `--output`) — with the words that may name what they write. Not one: a reader (`cat`, `grep`, `jq`, `diff`, `echo`, …),
 * a program whose writes `writtenFiles` reads (`cp`, `mv`, `rm`, `tee`, `ln`, `dd`, `sed -i`, `find -delete`, `touch`,
 * `chmod`, …), an interpreter running an inline script (`python3 -c`, `node -e`, a here-document given to `python3 -`:
 * `SCRIPT_WRITE_RE` judges it) and git's other verbs (`diff`, `log`, `add`, `commit`, …). `anyFile`: the line writes files
 * it does not name — a written path only the run decides (`> "$out"`, `cp x "$(…)"`) or a writing command handed more
 * arguments at run time (`… | xargs rm`, `find -exec`).
 */
export function opaqueWriters(command: string, cwd: string): { commands: OpaqueCommand[]; anyFile: boolean } {
  const commands: OpaqueCommand[] = [];
  let anyFile = false;
  walkCommands(command, cwd, ({ words, cmd, dir, moreArgs }) => {
    if ((cmd.writes ?? []).some((p) => RUN_TIME_RE.test(p))) anyFile = true;
    const name = programName(words[0]!);
    if (name === "git") return; // its verbs below
    if (READERS.has(name)) return;
    if (name === "find" && !words.some((a) => FIND_WRITES_RE.test(a))) return;
    const flag = inlineFlag(name);
    if (flag && (cmd.input !== undefined || words.slice(1, -1).some((a) => flag.test(a)))) return;
    const modeled = FILE_WRITERS.has(basename(words[0]!)) || name === "dd" || TOUCHERS[name] !== undefined || inPlaceOperands(words).length > 0;
    if (moreArgs) anyFile = true;
    if (!modeled) {
      commands.push({ words, dir });
      return;
    }
    if ([...writtenPaths(words), ...inPlaceOperands(words)].some((p) => RUN_TIME_RE.test(p))) anyFile = true;
  });
  for (const g of gitInvocations(command, cwd)) {
    const output = g.args.some((a) => a === "--output" || a.startsWith("--output=") || a === "-o");
    const sub = g.args.find((a) => !a.startsWith("-"));
    const reads = g.verb !== null && (GIT_NAME_ONLY_VERBS.has(g.verb) || (g.verb === "stash" && (sub === "list" || sub === "show")) || (g.verb === "rm" && g.args.includes("--cached")));
    if (reads && !output) continue;
    if (g.moreArgs) anyFile = true;
    commands.push({ words: g.args, dir: g.dir });
  }
  return { commands, anyFile };
}
