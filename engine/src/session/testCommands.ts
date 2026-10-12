/**
 * §34.9: which Bash calls are test runs. On top of the §12 runners (`toolOutput.ts`), the JVM / native / script runners
 * of a large monorepo: Maven (`mvn`, `mvnw`, `mvnd`, any `*mvn*.sh` wrapper such as `./mvn25.sh -q -o test`), Gradle
 * (`gradle`, `gradlew`), `make test|check`, `node --test`, `mocha`, `phpunit`, `dotnet test`, `bazel test`, `ctest`,
 * plus the user's `settings.testCommandPatterns` (a glob per simple command).
 *
 * A Maven / Gradle call counts only with a goal / task that runs tests: `explicit` — `test`, `verify`,
 * `integration-test`, `surefire:test`, `failsafe:*`, `<plugin>:test`, or `-Dtest=…` (Maven); a task named `test`,
 * `check`, `…Test(s)`, `…Check` or `--tests` (Gradle) — and `implicit` for `package` / `install` / `deploy` (Maven) and
 * `build` (Gradle), which run tests only unless configured otherwise: those are a test run only when the output shows
 * tests ran (`toolOutput.ts`). `-DskipTests` / `-Dmaven.test.skip` and a Gradle `-x <task>` take the run away.
 * `mvn compile`, `test-compile`, `testClasses`, `assemble` are never test runs.
 */

/** `explicit`: a test run whatever the output; `implicit`: only when the output shows tests ran. */
export type TestCommandKind = "explicit" | "implicit";

/**
 * The simple commands of a Bash line, as typed (quotes kept, whitespace runs collapsed): split on `&&` `||` `;` `|`
 * `&` and newlines outside quotes; redirections (`2>&1`, `&>f`, `>|f`) stay part of their command. Lenient — never
 * refuses a line (a broken quote runs to the end).
 */
export function simpleCommands(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close + 1;
      cur += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') j += command[j] === "\\" ? 2 : 1;
      const end = Math.min(command.length, j + 1);
      cur += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "\\") {
      cur += command.slice(i, i + 2);
      i++;
      continue;
    }
    const prev = command[i - 1];
    const next = command[i + 1];
    if (c === "\n" || c === ";") {
      flush();
      continue;
    }
    if (c === "|") {
      if (prev === ">") {
        cur += c; // `>|` (noclobber override) is a redirection
        continue;
      }
      flush();
      if (next === "|" || next === "&") i++;
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        flush();
        i++;
        continue;
      }
      if (prev === ">" || prev === "<" || next === ">") {
        cur += c; // `2>&1`, `<&3`, `&>file`
        continue;
      }
      flush(); // a background job: the next command starts here
      continue;
    }
    cur += c;
  }
  flush();
  return out;
}

/** The words of one simple command, quotes removed (lenient: a broken quote runs to the end). */
function words(simple: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < simple.length; i++) {
    const c = simple[i]!;
    if (c === " " || c === "\t") {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const close = simple.indexOf("'", i + 1);
      const end = close === -1 ? simple.length : close;
      cur += simple.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < simple.length && simple[j] !== '"'; j++) {
        if (simple[j] === "\\" && j + 1 < simple.length) j++;
        cur += simple[j];
      }
      i = j;
      continue;
    }
    if (c === "\\" && i + 1 < simple.length) {
      cur += simple[++i];
      continue;
    }
    cur += c;
  }
  if (inWord) out.push(cur);
  return out;
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Commands that run the next word as the program (their own options skipped). */
const PREFIXES = new Set(["sudo", "time", "command", "exec", "nohup", "nice", "env", "timeout", "gtimeout", "xvfb-run", "caffeinate", "npx", "bunx", "pnpx"]);
/** Interpreters whose first non-option argument is the script that runs (`bash ./mvn25.sh test`, `php vendor/bin/phpunit`). */
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "php"]);
/** Redirections never are arguments (`2>&1`, `>out.log`, `<in`). */
const REDIRECT_RE = /^(\d*[<>]|&>)/;

const baseName = (w: string) => w.slice(Math.max(w.lastIndexOf("/"), w.lastIndexOf("\\")) + 1).toLowerCase();

/** The program a simple command runs and its arguments, past env assignments, wrappers and interpreters. */
function program(simple: string): { exe: string; args: string[] } | null {
  let ws = words(simple).filter((w) => !REDIRECT_RE.test(w));
  for (let guard = 0; guard < 8 && ws.length > 0; guard++) {
    while (ws.length > 0 && ENV_ASSIGN_RE.test(ws[0]!)) ws = ws.slice(1);
    const head = ws[0];
    if (head === undefined) return null;
    const base = baseName(head);
    if (base === "pnpm" && (ws[1] === "exec" || ws[1] === "dlx")) {
      ws = ws.slice(2);
      continue;
    }
    if (PREFIXES.has(base)) {
      let k = 1;
      // The wrapper's own options (and a duration for timeout / nice -n).
      while (k < ws.length && (ws[k]!.startsWith("-") || ENV_ASSIGN_RE.test(ws[k]!) || ((base === "timeout" || base === "gtimeout") && /^\d/.test(ws[k]!)))) {
        if ((base === "nice" && ws[k] === "-n") || (base === "sudo" && /^-[ugCh]$/.test(ws[k]!))) k++;
        k++;
      }
      ws = ws.slice(k);
      continue;
    }
    if (INTERPRETERS.has(base)) {
      let k = 1;
      while (k < ws.length && ws[k]!.startsWith("-")) k++;
      if (k >= ws.length) return { exe: base, args: [] };
      ws = ws.slice(k);
      continue;
    }
    return { exe: base, args: ws.slice(1) };
  }
  return null;
}

const MAVEN_EXES = new Set(["mvn", "mvnw", "mvnd", "mvn.cmd", "mvnw.cmd"]);
const isMaven = (exe: string) => MAVEN_EXES.has(exe) || /mvn.*\.sh$/.test(exe);
/** Maven options whose value is the next word. */
const MAVEN_VALUE_OPTS = new Set(["-f", "--file", "-s", "--settings", "-gs", "--global-settings", "-t", "--toolchains", "-pl", "--projects", "-rf", "--resume-from", "-T", "--threads", "-P", "--activate-profiles", "-l", "--log-file", "-b", "--builder", "-D", "--define"]);
const MAVEN_EXPLICIT = new Set(["test", "verify", "integration-test"]);
const MAVEN_IMPLICIT = new Set(["package", "install", "deploy"]);

function mavenKind(args: string[]): TestCommandKind | null {
  const goals: string[] = [];
  const defines: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (MAVEN_VALUE_OPTS.has(a)) {
      if (a === "-D" || a === "--define") defines.push(args[i + 1] ?? "");
      i++;
      continue;
    }
    if (a.startsWith("-D")) defines.push(a.slice(2));
    else if (!a.startsWith("-")) goals.push(a.toLowerCase());
  }
  const skipped = defines.some((d) => /^(skipTests|maven\.test\.skip|maven\.test\.skip\.exec)(=(true)?)?$/i.test(d));
  if (skipped) return null;
  const testFilter = defines.some((d) => /^(test|it\.test)=/.test(d));
  const explicit = goals.some((g) => MAVEN_EXPLICIT.has(g) || /^(surefire|failsafe):/.test(g) || /:test$/.test(g) || /^[\w.-]+:[\w.-]+(:[\w.-]+)?:(integration-test|verify)$/.test(g));
  if (explicit) return "explicit";
  if (goals.some((g) => MAVEN_IMPLICIT.has(g))) return testFilter ? "explicit" : "implicit";
  return null;
}

const GRADLE_EXES = new Set(["gradle", "gradlew", "gradle.bat", "gradlew.bat"]);
const GRADLE_VALUE_OPTS = new Set(["-p", "--project-dir", "-b", "--build-file", "-c", "--settings-file", "-g", "--gradle-user-home", "-I", "--init-script", "--console", "--warning-mode", "--priority", "--include-build", "-D", "-P"]);

function gradleKind(args: string[]): TestCommandKind | null {
  const tasks: string[] = [];
  const excluded = new Set<string>();
  let filtered = false;
  // MARK: wave3 check-engine — §37.7: a dry run (`-m` / `--dry-run`) executes no task.
  if (args.includes("-m") || args.includes("--dry-run")) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-x" || a === "--exclude-task") {
      const t = args[++i];
      if (t) excluded.add(lastSegment(t));
      continue;
    }
    if (a === "--tests") {
      filtered = true;
      i++;
      continue;
    }
    if (a.startsWith("--tests=")) {
      filtered = true;
      continue;
    }
    if (GRADLE_VALUE_OPTS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith("-")) tasks.push(a);
  }
  const runs = (t: string) => !excluded.has(t);
  const names = tasks.map(lastSegment);
  if (names.some((t) => /(test|tests|check)$/i.test(t) && runs(t))) return "explicit";
  if (filtered) return "explicit";
  if (names.includes("build") && runs("build") && !excluded.has("test") && !excluded.has("check")) return "implicit";
  return null;
}

/** `:app:testDebugUnitTest` → `testDebugUnitTest`. */
const lastSegment = (task: string) => task.slice(task.lastIndexOf(":") + 1);

/** Non-option arguments of `make` (option values and `VAR=x` assignments skipped). */
function makeTargets(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" || a === "-f" || a === "--file" || a === "--directory" || a === "-I" || a === "-o" || a === "-W") {
      i++;
      continue;
    }
    if (a === "-j" && /^\d+$/.test(args[i + 1] ?? "")) {
      i++;
      continue;
    }
    if (!a.startsWith("-") && !ENV_ASSIGN_RE.test(a)) out.push(a);
  }
  return out;
}

function programKind(exe: string, args: string[]): TestCommandKind | null {
  if (isMaven(exe)) return mavenKind(args);
  if (GRADLE_EXES.has(exe)) return gradleKind(args);
  switch (exe) {
    case "make":
    case "gmake":
      return makeTargets(args).some((t) => t === "test" || t === "check") ? "explicit" : null;
    case "node":
    case "nodejs":
      return args.includes("--test") ? "explicit" : null;
    case "mocha":
    case "_mocha":
    case "phpunit":
    case "ctest":
      return "explicit";
    case "dotnet":
      return args[0] === "test" ? "explicit" : null;
    case "bazel":
    case "bazelisk":
      return args.find((a) => !a.startsWith("-")) === "test" ? "explicit" : null;
    default:
      return null;
  }
}

/** A user pattern (`*` any run, `?` one char, whitespace collapsed) as an anchored regex; null when blank. */
function patternRegex(pattern: string): RegExp | null {
  const p = pattern.replace(/\s+/g, " ").trim();
  if (!p) return null;
  const body = [...p].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${body}$`, "su");
}

/**
 * The built-in runners of §12, anywhere in a simple command (`npx vitest run`, `python -m pytest`, `docker compose exec web
 * pytest`) — §37.7: not in one that only reads, searches, prints or installs (`lookingOnly`).
 */
const LEGACY_TEST_COMMAND_RE = new RegExp(
  [
    String.raw`\bvitest\b`,
    String.raw`\bjest\b`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b`,
    String.raw`\bnpm\s+t\b`,
    String.raw`\bpytest\b`,
    String.raw`\bswift\s+test\b`,
    String.raw`\bgo\s+test\b`,
    String.raw`\bcargo\s+test\b`,
    String.raw`\bxcodebuild\b[^|;&]*\btest\b`,
  ].join("|"),
);

/**
 * Whether a Bash command line runs tests (§34.9): `explicit` (a test runner, a test goal / task, a user pattern),
 * `implicit` (Maven `package` / `install` / `deploy`, Gradle `build`: a test run only when the output shows tests),
 * null otherwise. The strongest of its simple commands wins.
 */
export function testCommandKind(command: string, patterns: readonly string[] = []): TestCommandKind | null {
  const regexes = patterns.map(patternRegex).filter((r): r is RegExp => r !== null);
  let kind: TestCommandKind | null = null;
  for (const simple of simpleCommands(command)) {
    if (regexes.some((r) => r.test(simple))) return "explicit";
    const prog = program(simple);
    // MARK: wave3 check-engine — §37.7: the §12 runners count per simple command, never as what a command that only
    // reads, searches, prints or installs is handed (`grep -rn jest src`, `cat vitest.config.ts`, `npm i -D vitest`).
    if (prog && lookingOnly(prog.exe, prog.args)) continue;
    if (LEGACY_TEST_COMMAND_RE.test(simple)) return "explicit";
    const k = prog ? (programKind(prog.exe, prog.args) ?? packageScriptKind(prog.exe, prog.args)) : null;
    if (k === "explicit") return k;
    if (k === "implicit") kind = k;
  }
  return kind;
}

// MARK: wave3 check-engine — §37.7

/** Programs that only read, search, print, edit in place, fetch or install: a runner's name among their arguments runs nothing. */
const LOOKING_ONLY_EXES: ReadonlySet<string> = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "git", "cat", "bat", "less", "more", "head", "tail", "ls", "tree", "find", "fd",
  "echo", "printf", "sed", "awk", "which", "whereis", "type", "file", "stat", "wc", "sort", "uniq", "cut", "diff", "touch",
  "mkdir", "rm", "cp", "mv", "ln", "chmod", "open", "code", "vim", "vi", "nano", "pip", "pip3", "pipx", "brew", "apt",
  "apt-get", "curl", "wget",
]);
/** Package managers whose command word decides (`npm i -D vitest` installs; `npm test`, `poetry run pytest` run). */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun", "poetry", "uv", "pipenv", "conda"]);
/** Their commands that install, inspect, publish or configure — never run a script or a binary. */
const PM_LOOKING_ONLY: ReadonlySet<string> = new Set([
  "install", "i", "add", "ci", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "info", "view", "show", "ls",
  "list", "why", "outdated", "audit", "link", "unlink", "pack", "publish", "init", "create", "config", "cache", "dedupe",
  "prune", "rebuild", "root", "bin", "help", "search", "doctor", "explain", "pip", "lock", "sync",
]);

/** The command only reads, searches, prints or installs (a `find -exec` and `python -m pip …` handled). */
function lookingOnly(exe: string, args: readonly string[]): boolean {
  if (exe === "find") return !args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
  if (exe === "fd") return !args.some((a) => a === "-x" || a === "--exec" || a === "-X" || a === "--exec-batch");
  if (LOOKING_ONLY_EXES.has(exe)) return true;
  if (PACKAGE_MANAGERS.has(exe)) {
    const cmd = args.find((a) => !a.startsWith("-"));
    return cmd !== undefined && PM_LOOKING_ONLY.has(cmd.toLowerCase());
  }
  if (/^(python[\d.]*|py)$/.test(exe)) return args[0] === "-m" && args[1] === "pip";
  return false;
}

/** `npm test` / `pnpm -r test` / `yarn test:unit` / `npm run test:e2e`: a package manager running a test script. */
function packageScriptKind(exe: string, args: readonly string[]): TestCommandKind | null {
  if (exe !== "npm" && exe !== "pnpm" && exe !== "yarn" && exe !== "bun") return null;
  const words = args.filter((a) => !a.startsWith("-"));
  const cmd = words[0]?.toLowerCase();
  if (cmd === undefined) return null;
  if (cmd === "t" || cmd === "tst" || /^test(?![\w])/.test(cmd)) return "explicit";
  if ((cmd === "run" || cmd === "run-script") && /^test(?![\w])/.test(words[1]?.toLowerCase() ?? "")) return "explicit";
  return null;
}
