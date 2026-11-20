/**
 * MARK: terminal-win — PROTOCOL §57.17: what main hands node-pty for a terminal chat's `claude` and the shell panel.
 * Pure (fs / which injected): unit-tested on every OS in terminalLaunch.test.ts.
 *
 * Windows rules:
 * - argv[0] goes through the engine's `resolveClaudeExecutable`: a `.exe` runs as is; npm's `cli.js` runs under a real
 *   `node.exe` (the shim's folder, else PATH) — never Electron-as-node: electron.exe is a GUI-subsystem program that does
 *   not attach to the pseudoconsole. A `.cmd` / `.bat` left over is refused: CreateProcess would re-parse the line
 *   through cmd.exe ("BatBadBut"), and the `--settings` JSON holds `"` and `|`. cmd.exe is never used for claude.
 * - Our own command line (`windowsCommandLine`, every argument quoted), handed to node-pty as a string so node-pty's
 *   own quoting (only arguments with spaces) never runs. `${RG_HOOK_TOKEN}` stays literal: no shell runs anywhere, and
 *   Claude Code interpolates it (`allowedEnvVars`). Refused above 30,000 characters (CreateProcess: 32,767 with NUL).
 * - The whole parent environment, merged case-insensitively (one entry per name, the parent's spelling), minus the
 *   app's own variables; the user's CLAUDE_CONFIG_DIR / CLAUDE_CODE_GIT_BASH_PATH / ANTHROPIC_* stay (on Windows they
 *   are user-level settings). No LANG / LC_*.
 * POSIX is development only (the desktop client on macOS counts as "mac"): a direct exec of argv with the Mac's
 * Stage 1 environment, without the login shell.
 */
import { posix, win32 } from "node:path";
import { resolveClaudeExecutable, type TerminalSpecEvent } from "@reviewgate/engine";
import type { ShellKind } from "../../shared/ipc.js";

export type LaunchPlatform = "win32" | "darwin" | "linux";
export type ShimFs = { exists(p: string): boolean; read(p: string): string | null };
export type Launch = { ok: true; file: string; args: string | string[]; env: Record<string, string>; cwd: string };
export type LaunchRefusal = { ok: false; code: "terminal_needs_native_claude" | "terminal_cmdline_too_long"; error: string };

/** CreateProcess allows 32,767 characters with the program and NUL; this leaves room for both. */
export const MAX_COMMAND_LINE = 30_000;
export const NEEDS_NATIVE_CLAUDE = "Terminal chat needs the native Claude Code (claude.exe) or Node on PATH";
export const COMMAND_LINE_TOO_LONG = "The command line for Claude Code is too long for Windows";

/** Parent variables a PTY child never gets (the app's own, Electron's, a Claude Code session ReviewGate runs inside). */
const DROP_EXACT = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "NODE_OPTIONS", "VITE_DEV_SERVER_URL"]);
const DROP_PREFIXES = ["CLAUDE_AGENT_SDK_", "ELECTRON_", "REVIEWGATE_", "RG_"];

export function droppedFromParent(name: string): boolean {
  const n = name.toUpperCase();
  return DROP_EXACT.has(n) || DROP_PREFIXES.some((p) => n.startsWith(p));
}

/** MSVCRT / CommandLineToArgvW quoting, every argument quoted: backslashes before a `"` and at the end doubled, `"` → `\"`. */
export function windowsQuote(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  return `"${a}"`;
}

export function windowsCommandLine(args: readonly string[]): string {
  return args.map(windowsQuote).join(" ");
}

/** A Windows environment block: set `key` case-insensitively, keeping an existing entry's spelling. */
function setWin(env: Record<string, string>, key: string, value: string): void {
  const existing = Object.keys(env).find((k) => k.toUpperCase() === key.toUpperCase());
  env[existing ?? key] = value;
}

function deleteWin(env: Record<string, string>, key: string): void {
  for (const k of Object.keys(env)) if (k.toUpperCase() === key.toUpperCase()) delete env[k];
}

function getWin(env: Record<string, string | undefined>, key: string): string | undefined {
  const k = Object.keys(env).find((x) => x.toUpperCase() === key.toUpperCase());
  return k === undefined ? undefined : env[k];
}

/** The parent environment for a Windows PTY: one entry per name (the first spelling wins), the app's own dropped. */
export function windowsBaseEnv(parentEnv: Record<string, string | undefined>, appVersion: string): Record<string, string> {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined || k.length === 0 || k.startsWith("=")) continue; // `=C:` drive cwd entries are cmd.exe's own
    const up = k.toUpperCase();
    if (seen.has(up) || droppedFromParent(k)) continue;
    seen.add(up);
    env[k] = v;
  }
  setWin(env, "TERM", "xterm-256color");
  setWin(env, "COLORTERM", "truecolor");
  setWin(env, "TERM_PROGRAM", "ReviewGate");
  setWin(env, "TERM_PROGRAM_VERSION", appVersion);
  return env;
}

/** The Mac's Stage 1 base (TerminalLaunch.swift): only these parent keys, then the terminal's identity. Development only. */
const POSIX_INHERITED = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "PATH"];
export function posixBaseEnv(parentEnv: Record<string, string | undefined>, appVersion: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of POSIX_INHERITED) if (parentEnv[k] !== undefined) env[k] = parentEnv[k]!;
  env.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "ReviewGate";
  env.TERM_PROGRAM_VERSION = appVersion;
  env.LANG = "en_US.UTF-8";
  env.LC_CTYPE = "en_US.UTF-8";
  return env;
}

/** The engine's `terminal_spec.env` rule (`terminalEnv`): only RG_* / CLAUDE_CODE_* keys reach the child. */
export function specEnvAllowed(key: string): boolean {
  return key.startsWith("RG_") || key.startsWith("CLAUDE_CODE_");
}

const isBatch = (p: string) => /\.(cmd|bat)$/i.test(p);

/** §57.16: the hook posts go to 127.0.0.1 — a proxy the user's environment names never takes them. */
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

export type ChatLaunchInput = {
  spec: TerminalSpecEvent;
  platform: LaunchPlatform;
  parentEnv: Record<string, string | undefined>;
  appVersion: string;
  fullRepaint: boolean;
  fs: ShimFs;
  which(name: string): string | null;
};

export function buildChatLaunch(a: ChatLaunchInput): Launch | LaunchRefusal {
  const { spec } = a;
  if (a.platform !== "win32") {
    const env = posixBaseEnv(a.parentEnv, a.appVersion);
    env.CLAUDE_CODE_NATIVE_CURSOR = "1";
    if (a.fullRepaint) env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT = "1";
    for (const [k, v] of Object.entries(spec.env)) if (specEnvAllowed(k)) env[k] = v;
    return { ok: true, file: spec.argv[0]!, args: spec.argv.slice(1), env, cwd: spec.cwd };
  }

  // 1. The executable.
  const resolved = resolveClaudeExecutable(spec.argv[0]!, true, a.fs);
  let file: string;
  let argv: string[];
  if (resolved.executable !== undefined) {
    // npm's cli.js: a real node.exe — the shim's folder first (nvm-windows / a portable node), then PATH.
    const beside = win32.join(win32.dirname(spec.argv[0]!), "node.exe");
    const fromPath = a.which("node");
    const node = a.fs.exists(beside) ? beside : fromPath && !isBatch(fromPath) ? fromPath : null;
    if (!node) return { ok: false, code: "terminal_needs_native_claude", error: NEEDS_NATIVE_CLAUDE };
    file = node;
    argv = [resolved.path, ...spec.argv.slice(1)];
  } else {
    if (isBatch(resolved.path)) return { ok: false, code: "terminal_needs_native_claude", error: NEEDS_NATIVE_CLAUDE };
    file = resolved.path;
    argv = spec.argv.slice(1);
  }

  // 2. The command line (node-pty prefixes the program, quoted when it has a space).
  const args = windowsCommandLine(argv);
  if (file.length + 3 + args.length > MAX_COMMAND_LINE) return { ok: false, code: "terminal_cmdline_too_long", error: COMMAND_LINE_TOO_LONG };

  // 3. The environment.
  const env = windowsBaseEnv(a.parentEnv, a.appVersion);
  setWin(env, "CLAUDE_CODE_NATIVE_CURSOR", "1"); // the IME composition follows the TUI's real caret
  if (a.fullRepaint) setWin(env, "CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT", "1");
  for (const [k, v] of Object.entries(spec.env)) if (specEnvAllowed(k)) setWin(env, k, v);
  // §57.16: one variable on Windows (NO_PROXY and no_proxy are the same name): the user's list, then the loopback.
  const noProxy = getWin(env, "NO_PROXY");
  setWin(env, "NO_PROXY", noProxy ? `${noProxy},${LOOPBACK_NO_PROXY}` : LOOPBACK_NO_PROXY);
  return { ok: true, file, args, env, cwd: spec.cwd };
}

export type ShellLaunchInput = {
  shell: ShellKind;
  cwd: string;
  platform: LaunchPlatform;
  parentEnv: Record<string, string | undefined>;
  which(name: string): string | null;
  appVersion?: string;
};

/** The shell panel: PowerShell (pwsh, else Windows PowerShell) or Command Prompt — no hook token, no claude variables. */
export function buildShellLaunch(a: ShellLaunchInput): Launch {
  const appVersion = a.appVersion ?? "";
  if (a.platform !== "win32") {
    // Development only: the user's shell for either kind.
    const env = posixBaseEnv(a.parentEnv, appVersion);
    return { ok: true, file: a.parentEnv.SHELL || "/bin/sh", args: [], env, cwd: a.cwd };
  }
  const env = windowsBaseEnv(a.parentEnv, appVersion);
  deleteWin(env, "CLAUDE_CODE_NATIVE_CURSOR");
  deleteWin(env, "CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT");
  const systemRoot = getWin(a.parentEnv, "SystemRoot") ?? "C:\\Windows";
  if (a.shell === "powershell") {
    const pwsh = a.which("pwsh");
    const file = pwsh && !isBatch(pwsh) ? pwsh : win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { ok: true, file, args: "-NoLogo", env, cwd: a.cwd };
  }
  const comspec = getWin(a.parentEnv, "ComSpec");
  return { ok: true, file: comspec || win32.join(systemRoot, "System32", "cmd.exe"), args: "", env, cwd: a.cwd };
}

/** A synchronous PATH lookup (the engine's `platform.which` is async): Windows tries PATHEXT, POSIX needs the file. */
export function whichSync(name: string, o: { platform: LaunchPlatform; env: Record<string, string | undefined>; isFile(p: string): boolean }): string | null {
  const win = o.platform === "win32";
  const path = win ? getWin(o.env, "PATH") : o.env.PATH;
  if (!path) return null;
  const exts = win ? ["", ...(getWin(o.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const join = win ? win32.join : posix.join;
  for (const dir of path.split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      if (win && ext === "" && !/\.[a-z0-9]+$/i.test(name)) continue;
      const p = join(dir.replace(/^"(.*)"$/, "$1"), name + ext.toLowerCase());
      if (o.isFile(p)) return p;
    }
  }
  return null;
}
