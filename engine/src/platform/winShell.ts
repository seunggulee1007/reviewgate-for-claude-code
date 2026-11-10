import { existsSync, readFileSync } from "node:fs";
import { win32 as path } from "node:path";

/**
 * Windows helpers for running `.cmd` / `.bat` files without `shell: true`.
 *
 * Node ≥ 18.20.2 / 20.12.2 refuses to spawn a batch file directly (EINVAL, CVE-2024-27980), so a
 * batch file must go through `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments` — and every
 * piece of `<line>` has to survive cmd.exe's own parsing. The quoting follows cross-spawn
 * (lib/util/escape.js): MSVCRT-quote each argument, then `^`-escape cmd metacharacters; an npm
 * cmd-shim re-expands `%*` once more, so its arguments are `^`-escaped twice.
 */

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escapes the program path for a cmd.exe command line (no quotes; every metacharacter `^`-prefixed). */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/**
 * One argument for a cmd.exe command line: MSVCRT quoting (backslashes before a `"` or the end are
 * doubled, `"` becomes `\"`), wrapped in quotes, then cmd metacharacters `^`-escaped — twice when
 * `doubleEscape` (the batch file passes it on through `%*`, which cmd expands again).
 */
export function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(CMD_META, "^$1");
  if (doubleEscape) a = a.replace(CMD_META, "^$1");
  return a;
}

export type CmdInvocation = { file: string; args: string[]; windowsVerbatimArguments: true };

/**
 * `cmd.exe /d /s /c "<escaped file> <escaped args…>"` — `/d` skips AutoRun, `/s` strips exactly the
 * outer quotes. Pass the result to spawn / execFile with `windowsVerbatimArguments: true`.
 */
export function cmdInvocation(
  file: string,
  args: readonly string[],
  opts: { doubleEscape?: boolean; comspec?: string } = {},
): CmdInvocation {
  const doubleEscape = opts.doubleEscape ?? true;
  const line = [escapeCmdCommand(path.normalize(file)), ...args.map((a) => escapeCmdArgument(a, doubleEscape))].join(" ");
  return { file: opts.comspec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

export function isBatchFile(p: string): boolean {
  return /\.(cmd|bat)$/i.test(p);
}

export type ShimFs = { exists(p: string): boolean; read(p: string): string | null };

export const realShimFs: ShimFs = {
  exists: (p) => existsSync(p),
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
};

/** The program an npm cmd-shim (`"%dp0%\…"` / `"%~dp0\…"`) runs, relative to the shim's folder; `node(.exe)` excluded. */
export function shimTarget(cmdText: string): string | null {
  const targets = [...cmdText.matchAll(/"%~?dp0%?\\([^"]+)"/gi)].map((m) => m[1]!).filter((t) => !/^node(\.exe)?$/i.test(t));
  return targets.length > 0 ? targets[targets.length - 1]! : null;
}

/** How to run what a batch shim would run, without cmd.exe: a native `.exe`, or a `.js` under node. */
export type ShimLaunch = { kind: "exe"; path: string } | { kind: "node"; script: string };

/**
 * Looks through a `.cmd` shim: the `.exe` / `.js` it launches (when it exists), else Claude Code's
 * `node_modules/@anthropic-ai/claude-code/cli.js` next to it. `null` when nothing runnable is known —
 * the caller then needs cmd.exe (`cmdInvocation`) or has to refuse.
 */
export function resolveCmdShim(cmdPath: string, fs: ShimFs = realShimFs): ShimLaunch | null {
  if (!isBatchFile(cmdPath)) return null;
  const dir = path.dirname(cmdPath);
  const text = fs.read(cmdPath);
  const target = text ? shimTarget(text) : null;
  if (target) {
    const abs = path.resolve(dir, target);
    if (/\.exe$/i.test(abs) && fs.exists(abs)) return { kind: "exe", path: abs };
    if (/\.[cm]?js$/i.test(abs) && fs.exists(abs)) return { kind: "node", script: abs };
  }
  const cli = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (fs.exists(cli)) return { kind: "node", script: cli };
  return null;
}

/** Programs `openTerminal` may start (Windows): the auth flows the app offers, nothing else. */
export const TERMINAL_COMMANDS: ReadonlySet<string> = new Set(["gh", "claude"]);

/**
 * Splits a POSIX-style command string (bare words, `'single'` and `"double"` quoted parts, as
 * `pr/auth.ts loginCommand` builds) into argv. `null` for anything else: unbalanced quotes, shell
 * operators, variables, backslash escapes — openTerminal refuses those rather than guess.
 */
export function splitSimpleCommand(command: string): string[] | null {
  const argv: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && /[$`\\]/.test(ch)) return null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) argv.push(cur);
      cur = "";
      inWord = false;
    } else if (/[A-Za-z0-9._:\/=@+,-]/.test(ch)) {
      cur += ch;
      inWord = true;
    } else {
      return null;
    }
  }
  if (quote) return null;
  if (inWord) argv.push(cur);
  return argv.length > 0 ? argv : null;
}

/**
 * `cmd.exe /d /s /k "<program> <args…>"` for `openTerminal` — spawned `detached`, cmd gets its own
 * console window and stays open after the program exits. Only a program in `TERMINAL_COMMANDS` is
 * accepted and `splitSimpleCommand` already limited the arguments to `[A-Za-z0-9._:/=@+,-]`, so one
 * level of cmd escaping is exact whether the program is an `.exe` or a `%*`-forwarding shim (the only
 * metacharacter left, `,`, sits inside the quotes the second parse respects).
 */
export function terminalInvocation(command: string, comspec = "cmd.exe"): CmdInvocation {
  const argv = splitSimpleCommand(command);
  if (!argv) throw new Error(`openTerminal: unsupported command line: ${command}`);
  const [program, ...args] = argv as [string, ...string[]];
  if (!TERMINAL_COMMANDS.has(program.toLowerCase())) throw new Error(`openTerminal: command not allowed: ${program}`);
  const line = [escapeCmdCommand(program), ...args.map((a) => escapeCmdArgument(a, false))].join(" ");
  return { file: comspec, args: ["/d", "/s", "/k", `"${line}"`], windowsVerbatimArguments: true };
}
