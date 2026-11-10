/**
 * MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: runs the user's status line command the way Claude Code does.
 *
 * The CLI runs `statusLine.command` through a shell (`/bin/sh -c`; Windows: Git Bash, else PowerShell) in the session's
 * folder with the stdin JSON of `input.ts`, 300 ms after the last change it shows (a new answer, the model, the usage
 * windows…), and prints the trimmed stdout under the prompt. Here: the same command, shell and stdin; the client's
 * width as `COLUMNS`; at most one run at a time (a change during a run runs it once more afterwards); a run that takes
 * longer than the limit is stopped with its whole process tree; every 15 s (or `statusLine.refreshInterval`) while the
 * line is on screen, so countdowns move. A failure never reaches the engine: the last good lines stay, the error is
 * told once in the log and as `status_line.error`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Platform } from "../platform/index.js";
import type { StatusLineError, StatusLineEvent } from "../protocol.js";
import { buildStatusLineInput, type StatusLineSnapshot } from "./input.js";
import type { StatusLineConfig, StatusLineResolution } from "./settings.js";

/** The CLI's own debounce after a change. */
export const STATUS_DEBOUNCE_MS = 300;
/** A steady stream of changes still runs at least this often. */
export const STATUS_MAX_WAIT_MS = 2000;
/**
 * MARK: wave7 w7-state — §45.2: a change runs the command at most this often (between run starts); the last change still
 * runs once after the wait. The first show, a new width and a changed switch run after the debounce alone.
 */
export const STATUS_MIN_INTERVAL_MS = 5000;
/** After the shell exited (or was killed), this long for its pipes to close (a grandchild may keep them open). */
export const STATUS_PIPE_GRACE_MS = 2000;
/**
 * Without a configured command, how often the settings are read again (no command runs): a `statusLine` added later
 * shows, as the CLI follows its settings files. A configured one runs on changes only, periodically only with
 * `statusLine.refreshInterval` (the CLI's `Nit`), and once a second after a usage window resets (its `#b`).
 */
export const STATUS_SETTINGS_RECHECK_MS = 15_000;
/** The longest a Node timer waits (2^31 − 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;
/** The CLI runs it again this long after a usage window's reset. */
const RESET_REFRESH_DELAY_MS = 1000;
/** A run is stopped after this long without `statusLine.timeout`. */
export const STATUS_TIMEOUT_MS = 10_000;
export const STATUS_DEFAULT_COLUMNS = 120;
export const STATUS_MIN_COLUMNS = 20;
export const STATUS_MAX_COLUMNS = 1000;
export const STATUS_MAX_LINES = 20;
export const STATUS_MAX_LINE_CHARS = 2000;
/** stdout beyond this is not read. */
export const STATUS_MAX_OUTPUT = 64 * 1024;
const STDERR_MAX = 8 * 1024;

export type StatusLineDeps = {
  /** The `statusLine` that runs now (re-read before every run: an edited settings file applies at once, as in the CLI). */
  resolve: () => StatusLineResolution;
  /** The stdin's facts (the output style comes from the settings `resolve` read); null without a project and chat. */
  snapshot: () => Omit<StatusLineSnapshot, "outputStyle"> | null;
  /** `settings.showStatusLine` is not false. */
  enabled: () => boolean;
  /** The command's environment (the login shell's PATH); `COLUMNS` and `CLAUDE_PROJECT_DIR` are added. */
  env: () => Record<string, string | undefined>;
  platform: Pick<Platform, "killTree" | "isWindows" | "which">;
  /** The open project's folder (null: none) — a run printed for another project never lands. */
  scope?: () => string | null;
  emit: (ev: StatusLineEvent) => void;
  log: (level: "info" | "warn" | "debug", msg: string) => void;
  now?: () => number;
  debounceMs?: number;
  maxWaitMs?: number;
  /** MARK: wave7 w7-state — §45.2: the least time between two change-driven run starts (test seam; default 5 s). */
  minIntervalMs?: number;
  /** The settings re-read without a command (test seam; default 15 s). */
  recheckMs?: number;
  timeoutMs?: number;
};

/** What a run is of: its source, file and command (another one means another line, a revoked one means none). */
export function configKey(cfg: Pick<StatusLineConfig, "source" | "path" | "command"> | null | undefined): string {
  return cfg ? `${cfg.source}\0${cfg.path}\0${cfg.command}` : "";
}

/** `s` cut to `n` UTF-16 units, never between the halves of a surrogate pair (a lone half breaks the Mac's JSON decoding). */
export function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const t = s.slice(0, n);
  const last = t.charCodeAt(t.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? t.slice(0, -1) : t;
}

/** The command's stdout as lines, as the CLI takes it: CRs dropped, trimmed, split; capped in count and length. */
export function statusLinesOf(stdout: string): string[] {
  const text = stdout.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  return text
    .split("\n")
    .slice(0, STATUS_MAX_LINES)
    .map((l) => cutText(l, STATUS_MAX_LINE_CHARS));
}

/**
 * The run's environment: what the engine runs with, the terminal's `TERM` / `COLORTERM` when the app has none (a GUI app
 * starts without them; `tput` fails without `TERM`), and on Windows one `PATH` (Node keeps one of `Path` / `PATH`) with
 * Git Bash's folder in front.
 */
export function statusEnv(base: Record<string, string | undefined>, add: { columns: number; projectDir: string; pathPrefix?: string; isWindows: boolean }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
  if (!env.COLORTERM) env.COLORTERM = "truecolor";
  env.COLUMNS = String(add.columns);
  env.CLAUDE_PROJECT_DIR = add.projectDir;
  if (add.isWindows) {
    const keys = Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
    const path = env.PATH ?? (keys.length > 0 ? env[keys[0]!] : undefined) ?? "";
    for (const k of keys) delete env[k];
    env.PATH = add.pathPrefix ? `${add.pathPrefix};${path}` : path;
  }
  return env;
}

type Shell = { file: string; args: string[]; pathPrefix?: string };

/** Git Bash as the CLI finds it on Windows: `CLAUDE_CODE_GIT_BASH_PATH`, Program Files, then next to `git` on PATH. */
async function gitBash(env: Record<string, string | undefined>, platform: Pick<Platform, "which">): Promise<string | null> {
  const override = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && /^(bash|sh)(\.exe)?$/i.test(basename(override)) && existsSync(override)) return override;
  for (const p of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) if (existsSync(p)) return p;
  const git = await platform.which("git", env).catch(() => null);
  if (git) {
    const p = join(git, "..", "..", "bin", "bash.exe");
    if (existsSync(p)) return p;
  }
  return null;
}

/** The shell the CLI would use: `/bin/sh -c`; Windows Git Bash `-c`, else PowerShell; `statusLine.shell: "powershell"` wins. */
export async function statusShell(cfg: Pick<StatusLineConfig, "command" | "shell">, env: Record<string, string | undefined>, platform: Pick<Platform, "isWindows" | "which">): Promise<Shell | null> {
  const powershell = async (): Promise<Shell | null> => {
    const pwsh = (await platform.which("pwsh", env).catch(() => null)) ?? (platform.isWindows ? "powershell.exe" : null);
    return pwsh ? { file: pwsh, args: ["-NoProfile", "-NonInteractive", "-Command", cfg.command] } : null;
  };
  if (cfg.shell === "powershell") return powershell();
  if (!platform.isWindows) return { file: "/bin/sh", args: ["-c", cfg.command] };
  const bash = await gitBash(env, platform);
  return bash ? { file: bash, args: ["-c", cfg.command], pathPrefix: dirname(bash) } : powershell();
}

const firstLine = (s: string): string => cutText((s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim(), 300);

/** One project window's status line: what it shows, when it runs. */
export class StatusLine {
  private wanted = false;
  private visible = true;
  private columns = STATUS_DEFAULT_COLUMNS;
  private lines: string[] = [];
  /** The project the lines were printed for (a switch clears them before the next run). */
  private linesScope: string | null = null;
  private updatedAt: string | null = null;
  private error: StatusLineError | null = null;
  private resolution: StatusLineResolution | null = null;
  private running = false;
  private again = false;
  private stopRun: (() => void) | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private firstPokeAt: number | null = null;
  private refresh: NodeJS.Timeout | null = null;
  /** The one-shot run a second after the earliest usage window resets (the CLI's), and that time (epoch ms). */
  private resetRefresh: NodeJS.Timeout | null = null;
  private resetAt: number | null = null;
  /** `configKey` of the run in flight and of the run that printed the lines. */
  private runKey = "";
  private linesKey = "";
  private lastSentKey: string | null = null;
  private loggedError: string | null = null;
  // MARK: wave7 w7-state — §45.2
  /** When the last run started (Date.now ms); null: none since the lines were cleared. */
  private lastStartAt: number | null = null;
  /** When the pending soon run starts (Date.now ms): a change after it never puts it off. */
  private soonDue: number | null = null;
  /** A soon run came while one ran: the run after it is soon too. */
  private againSoon = false;
  /** The stderr line last logged (the same text is logged once, not after every run). */
  private loggedStderr: string | null = null;
  /** Bumped by `clear`: a run started before never lands. */
  private generation = 0;
  private disposed = false;

  constructor(private readonly deps: StatusLineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * `status_line`: the client's width (columns) and whether the line is on screen. Replies with what it shows now; a
   * run follows (debounced) when one may run, and its lines come as a `status_line` event.
   */
  request(columns?: unknown, visible?: unknown): StatusLineEvent {
    const before = { columns: this.columns, wanted: this.wanted };
    if (typeof columns === "number" && Number.isFinite(columns)) this.columns = Math.min(STATUS_MAX_COLUMNS, Math.max(STATUS_MIN_COLUMNS, Math.floor(columns)));
    if (typeof visible === "boolean") this.visible = visible;
    this.wanted = true;
    if (this.linesScope !== null && this.deps.scope && this.deps.scope() !== this.linesScope) this.clear(); // another project's lines
    this.resolution = this.deps.resolve();
    if (!this.visible) this.stopRefresh();
    // MARK: wave7 w7-state — §45.2: the first show and a new width run soon; the window shown again waits its turn.
    else this.poke(!before.wanted || before.columns !== this.columns);
    const ev = this.event();
    this.lastSentKey = keyOf(ev);
    return ev;
  }

  /**
   * Something the stdin carries changed: run again 300 ms after the last such change (at most 2 s later) — wave7: and not
   * before `STATUS_MIN_INTERVAL_MS` after the last run started, unless `soon` (the first show, a new width, a switch),
   * whose run no later change puts off.
   */
  poke(soon = false): void {
    if (!this.mayRun()) return;
    const now = Date.now();
    this.firstPokeAt ??= now;
    if (this.debounce) clearTimeout(this.debounce);
    const debounceMs = this.deps.debounceMs ?? STATUS_DEBOUNCE_MS;
    let wait = Math.max(0, Math.min(debounceMs, this.firstPokeAt + (this.deps.maxWaitMs ?? STATUS_MAX_WAIT_MS) - now));
    // MARK: wave7 w7-state — §45.2: no new process sooner than the interval after the last one started (no lines yet: no
    // wait); a pending soon run keeps its time (the run reads the latest stdin anyway).
    if (soon) this.soonDue = now + wait;
    else if (this.lastStartAt !== null) wait = Math.max(wait, this.lastStartAt + (this.deps.minIntervalMs ?? STATUS_MIN_INTERVAL_MS) - now);
    if (this.soonDue !== null) wait = Math.min(wait, Math.max(0, this.soonDue - now));
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.firstPokeAt = null;
      const soonRun = this.soonDue !== null;
      this.soonDue = null;
      this.start(soonRun);
    }, wait);
    this.debounce.unref?.();
  }

  /**
   * A switch changed (`showStatusLine`, the project's allowance, "my hooks off", local settings): tell the clients, run —
   * or stop and clear, also when what runs now is another command than the one running or shown (a revoked project's
   * output never shows).
   */
  settingsChanged(): void {
    if (!this.wanted) return;
    this.resolution = this.deps.resolve();
    const key = configKey(this.resolution.config);
    const stale = (this.running && this.runKey !== key) || (this.lines.length > 0 && this.linesKey !== key);
    if (!this.deps.enabled() || !this.resolution.config || stale) this.clear();
    this.send();
    this.poke(true); // MARK: wave7 w7-state (§45.2): the user changed a switch — no interval to wait
  }

  /**
   * The project opened, switched or closed: the last one's lines go at once and a run of it still going is stopped (its
   * output never lands); the new project's first run follows the next change.
   */
  projectChanged(): void {
    if (this.lines.length > 0 || this.error || this.running || this.linesScope !== null) this.clear();
    if (this.wanted) this.send();
  }

  /** Stops what runs and every timer; nothing is sent afterwards. */
  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private mayRun(): boolean {
    return !this.disposed && this.wanted && this.visible && this.deps.enabled();
  }

  /** The lines go (a run in flight is stopped and never lands). */
  private clear(): void {
    this.generation += 1;
    this.stopRun?.();
    this.stopRun = null;
    this.running = false;
    this.again = false;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.firstPokeAt = null;
    this.stopRefresh();
    this.lines = [];
    this.linesScope = null;
    this.linesKey = "";
    this.runKey = "";
    this.updatedAt = null;
    this.error = null;
    this.loggedError = null;
    this.lastStartAt = null; // MARK: wave7 w7-state (§45.2): what shows next is a first show
    this.soonDue = null;
    this.againSoon = false;
    this.loggedStderr = null;
  }

  private stopRefresh(): void {
    if (this.refresh) clearTimeout(this.refresh);
    this.refresh = null;
    if (this.resetRefresh) clearTimeout(this.resetRefresh);
    this.resetRefresh = null;
    this.resetAt = null;
  }

  /** The CLI's `#b`: one run a second after the earliest usage window of the stdin resets (epoch seconds). */
  private armResetRefresh(rateLimits: unknown): void {
    const resets = Object.values((rateLimits ?? {}) as Record<string, { resets_at?: unknown }>)
      .map((w) => w?.resets_at)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const at = resets.length > 0 ? Math.min(...resets) * 1000 : null;
    if (at === this.resetAt) return;
    if (this.resetRefresh) clearTimeout(this.resetRefresh);
    this.resetRefresh = null;
    this.resetAt = at;
    if (at === null || !this.mayRun()) return;
    this.resetRefresh = setTimeout(() => {
      this.resetRefresh = null;
      this.resetAt = null;
      this.start();
    }, Math.min(MAX_TIMER_MS, Math.max(0, at + RESET_REFRESH_DELAY_MS - Date.now())));
    this.resetRefresh.unref?.();
  }

  private start(soon = false): void {
    if (!this.mayRun()) return;
    if (this.running) {
      this.again = true;
      if (soon) this.againSoon = true; // MARK: wave7 w7-state (§45.2): a new width during a run shows right after it
      return;
    }
    const resolution = (this.resolution = this.deps.resolve());
    const snap = this.deps.snapshot();
    if (!resolution.config || !snap) {
      // Nothing to run (no command any more, no project / session): what the line showed goes.
      if (this.lines.length > 0 || this.error) this.clear();
      this.send();
      // A statusLine added to a settings file later shows within one re-read (the CLI follows its settings files too).
      if (snap) this.scheduleRecheck();
      return;
    }
    if (this.linesScope !== null && this.linesScope !== snap.projectDir) {
      this.clear();
      this.send();
    }
    void this.run(resolution.config, { ...snap, outputStyle: resolution.outputStyle });
  }

  private async run(cfg: StatusLineConfig, snap: StatusLineSnapshot): Promise<void> {
    const generation = this.generation;
    this.running = true;
    this.runKey = configKey(cfg);
    this.lastStartAt = Date.now(); // MARK: wave7 w7-state (§45.2)
    const base = this.deps.env();
    let shell: Shell | null;
    try {
      shell = await statusShell(cfg, base, this.deps.platform);
    } catch {
      shell = null;
    }
    if (generation !== this.generation) return;
    const env = statusEnv(base, { columns: this.columns, projectDir: snap.projectDir, pathPrefix: shell?.pathPrefix, isWindows: this.deps.platform.isWindows });
    const stdinObject = buildStatusLineInput(snap);
    this.armResetRefresh(stdinObject.rate_limits);
    const input = JSON.stringify(stdinObject) + "\n";
    const timeoutMs = cfg.timeoutMs ?? this.deps.timeoutMs ?? STATUS_TIMEOUT_MS;
    if (!shell) {
      this.finish(generation, cfg, snap.projectDir, { kind: "spawn", message: "PowerShell was not found" });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.file, shell.args, { cwd: snap.cwd, env, detached: !this.deps.platform.isWindows, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.finish(generation, cfg, snap.projectDir, { kind: "spawn", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let grace: NodeJS.Timeout | null = null;
    // The shell is gone but a process it left keeps the pipes open (no `close`): that process goes (POSIX: the shell's
    // process group it is in; Windows: what is left of the tree) and the run ends with what it printed — never one more
    // straggler per run.
    const abandonPipes = () => {
      grace ??= setTimeout(() => {
        if (child.pid !== undefined) {
          if (this.deps.platform.isWindows) void this.deps.platform.killTree(child.pid).catch(() => undefined);
          else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              // the group is gone already
            }
          }
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(exitCode);
      }, STATUS_PIPE_GRACE_MS);
      grace.unref?.();
    };
    const kill = () => {
      const hard = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // gone already
        }
      };
      // The tree first (Windows' taskkill /T finds it only while the shell lives), then the shell itself.
      if (child.pid !== undefined) void this.deps.platform.killTree(child.pid).catch(() => undefined).finally(hard);
      else hard();
      abandonPipes();
    };
    this.stopRun = kill;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();
    const done = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (this.stopRun === kill) this.stopRun = null;
      if (spawnError !== undefined) this.finish(generation, cfg, snap.projectDir, { kind: "spawn", message: spawnError });
      else if (timedOut) this.finish(generation, cfg, snap.projectDir, { kind: "timeout", message: `no answer within ${Math.round(timeoutMs / 1000)} s`, stderr });
      else if (code !== 0) this.finish(generation, cfg, snap.projectDir, { kind: "exit", exitCode: code, message: firstLine(stderr) || `exit ${code ?? "?"}`, stderr });
      else this.finish(generation, cfg, snap.projectDir, { kind: "ok", stdout, stderr });
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      if (stdout.length < STATUS_MAX_OUTPUT) stdout += cutText(c, STATUS_MAX_OUTPUT - stdout.length);
    });
    child.stderr?.on("data", (c: string) => {
      if (stderr.length < STDERR_MAX) stderr += cutText(c, STDERR_MAX - stderr.length);
    });
    child.stdout?.on("error", () => undefined); // destroyed by abandonPipes
    child.stderr?.on("error", () => undefined);
    child.stdin?.on("error", () => undefined); // a command that never reads stdin (EPIPE)
    child.on("error", (e) => {
      // The shell never started: no `close` follows for sure.
      if (child.pid === undefined) done(null, e.message);
    });
    child.on("exit", (code) => {
      exitCode = code;
      abandonPipes();
    });
    child.on("close", (code) => done(code ?? exitCode));
    try {
      child.stdin?.end(input);
    } catch {
      // the same EPIPE, thrown
    }
  }

  private finish(
    generation: number,
    cfg: StatusLineConfig,
    scope: string,
    r: { kind: "ok"; stdout: string; stderr: string } | { kind: "spawn"; message: string } | { kind: "timeout" | "exit"; message: string; exitCode?: number | null; stderr: string },
  ): void {
    if (generation !== this.generation) return;
    this.running = false;
    this.runKey = "";
    if ((this.deps.scope && this.deps.scope() !== scope) || configKey(this.resolution?.config) !== configKey(cfg)) {
      // Printed for a project that is no longer open, or by a command that no longer runs (another one, a revoked
      // project's): dropped; what runs now runs on the next change.
      if (this.again) this.runAgain();
      return;
    }
    const at = new Date(this.now()).toISOString();
    if (r.kind === "ok") {
      const lines = statusLinesOf(r.stdout);
      if (!sameLines(lines, this.lines) || this.linesScope !== scope) this.updatedAt = at;
      this.lines = lines;
      this.linesScope = scope;
      this.linesKey = configKey(cfg);
      this.error = null;
      if (this.loggedError !== null) this.deps.log("info", "status line: runs again");
      this.loggedError = null;
      // MARK: wave7 w7-state — §45.2: a command that always writes the same warning is logged once, not after every run.
      const said = r.stderr.trim() ? firstLine(r.stderr) : null;
      if (said !== null && said !== this.loggedStderr) this.deps.log("debug", `status line stderr: ${said}`);
      if (said !== null) this.loggedStderr = said;
    } else {
      this.error = { code: r.kind, message: r.message, at, ...(r.kind === "exit" ? { exitCode: r.exitCode ?? null } : {}) };
      const said = `${r.kind}|${r.message}`;
      if (this.loggedError !== said) {
        this.loggedError = said;
        // Not the command itself: a token written into it would end up in the log.
        this.deps.log("warn", `status line (${cfg.source} settings): ${r.kind === "timeout" ? "stopped" : r.kind === "exit" ? "failed" : "did not start"} — ${r.message}; the last output stays`);
      }
    }
    this.send();
    this.scheduleRefresh(cfg);
    if (this.again) this.runAgain();
  }

  /** What changed during a run runs once more after it — after the debounce alone when that was a soon run (§45.2). */
  private runAgain(): void {
    const soon = this.againSoon;
    this.again = false;
    this.againSoon = false;
    this.poke(soon);
  }

  /** The CLI's `Nit`: periodic runs only with `statusLine.refreshInterval`; otherwise it runs on changes. */
  private scheduleRefresh(cfg: StatusLineConfig): void {
    if (this.refresh) clearTimeout(this.refresh);
    this.refresh = null;
    if (cfg.refreshIntervalMs === null || !this.mayRun()) return;
    this.refresh = setTimeout(() => {
      this.refresh = null;
      this.start();
    }, cfg.refreshIntervalMs);
    this.refresh.unref?.();
  }

  /** Without a command: the settings are read again later (no command runs until one is configured). */
  private scheduleRecheck(): void {
    if (this.refresh) clearTimeout(this.refresh);
    this.refresh = null;
    if (!this.mayRun()) return;
    this.refresh = setTimeout(() => {
      this.refresh = null;
      this.start();
    }, this.deps.recheckMs ?? STATUS_SETTINGS_RECHECK_MS);
    this.refresh.unref?.();
  }

  /** Emits what it shows when that differs from what the clients last got. */
  private send(): void {
    if (this.disposed) return;
    const ev = this.event();
    const key = keyOf(ev);
    if (key === this.lastSentKey) return;
    this.lastSentKey = key;
    this.deps.emit(ev);
  }

  private event(): StatusLineEvent {
    const r = this.resolution ?? this.deps.resolve();
    const enabled = this.deps.enabled();
    const cfg = r.config;
    return {
      type: "status_line",
      lines: enabled ? [...this.lines] : [],
      updatedAt: enabled ? this.updatedAt : null,
      enabled,
      configured: cfg !== null,
      ...(cfg ? { source: cfg.source, path: cfg.path, command: cfg.command, padding: cfg.padding } : {}),
      ...(enabled && this.error ? { error: { ...this.error } } : {}),
      ...(r.project ? { project: { ...r.project } } : {}),
      ...(r.disabled ? { disabled: r.disabled } : {}),
    };
  }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/** What makes two events differ for a client (not when a failure happened again). */
function keyOf(ev: StatusLineEvent): string {
  const { id: _id, error, ...rest } = ev;
  return JSON.stringify({ ...rest, error: error ? { code: error.code, message: error.message, exitCode: error.exitCode } : null });
}
