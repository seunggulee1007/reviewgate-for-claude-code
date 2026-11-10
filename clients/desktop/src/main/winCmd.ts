/**
 * Running a Windows `.cmd` / `.bat` (e.g. VS Code's `code.cmd`) safely. Node ≥ 18.20.2 / 20.12.2
 * refuses to spawn batch files without a shell (EINVAL, CVE-2024-27980), and `cmd.exe` re-parses
 * the command line: `&`, `|`, `^`, `%VAR%`, `(`, `)` … in a path would run commands. This builds the
 * `cmd.exe /d /s /c "…"` line the way cross-spawn does — every argument quoted (CommandLineToArgvW
 * rules) and every cmd metacharacter of it `^`-escaped, twice for a batch file because the shim's `%*`
 * hands the arguments to a second parse. Pure, unit-tested in winCmd.test.ts.
 */

const META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a cmd.exe line; `batch` = the target is a .cmd/.bat (double escaping). */
export function escapeCmdArg(arg: string, batch: boolean): string {
  // Backslashes before a quote / the closing quote are doubled; the quote itself is escaped.
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(META, "^$1");
  if (batch) a = a.replace(META, "^$1");
  return a;
}

/**
 * The program path for a cmd.exe line: plainly quoted (spaces, `&`, `(x86)` are literal inside the
 * quotes). It is a path we located ourselves (where.exe / install folders), never renderer input.
 */
export function quoteCmdCommand(exe: string): string {
  return `"${exe}"`;
}

export const isBatchFile = (exe: string): boolean => /\.(cmd|bat)$/i.test(exe);

/**
 * `spawn(file, args, { windowsVerbatimArguments: true })` for `exe args…` through cmd.exe:
 * `cmd.exe /d /s /c ""<exe>" <escaped args>"` (/d: no AutoRun, /s: strip the outer quotes).
 */
export function cmdInvocation(exe: string, args: string[], comspec = "cmd.exe"): { file: string; args: string[] } {
  const batch = isBatchFile(exe);
  const line = [quoteCmdCommand(exe), ...args.map((a) => escapeCmdArg(a, batch))].join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`] };
}
