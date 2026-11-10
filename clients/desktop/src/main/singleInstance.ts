/**
 * Audit daily-19: one ReviewGate process per user. A second launch (a second click on the taskbar shortcut, `ReviewGate
 * <folder>`) does not start a second set of engines on the same worktrees; it hands over what it was asked to open and
 * quits, and the running process focuses a window or opens that folder. Pure (no `electron`), unit-tested.
 */
import { posix, win32 } from "node:path";

/** What the second instance passes along (`app.requestSingleInstanceLock(data)`). */
export type SecondInstanceData = { project?: string };

export type SecondInstanceAction = { kind: "open"; path: string } | { kind: "focus" };

/**
 * The folder the second launch asked for — its `REVIEWGATE_PROJECT`, else the last command-line argument that is an
 * existing directory (relative ones against its working directory) — or just "focus a window". `firstUserArg`: where the
 * user's arguments start (1 for the packaged app; 2 for `electron <app folder>`, `process.defaultApp`).
 */
export function secondInstanceAction(
  argv: readonly string[],
  workingDirectory: string,
  data: unknown,
  isDirectory: (path: string) => boolean,
  opts: { firstUserArg?: number; platform?: NodeJS.Platform } = {},
): SecondInstanceAction {
  const project = typeof data === "object" && data !== null ? (data as SecondInstanceData).project : undefined;
  if (typeof project === "string" && project.trim().length > 0) return { kind: "open", path: project.trim() };
  const platform = opts.platform ?? process.platform;
  const first = Math.max(1, opts.firstUserArg ?? 1);
  // Chromium / macOS add flags ("--original-process-start-time=…", "-psn_0_…"): only plain arguments are folders.
  for (let i = argv.length - 1; i >= first; i--) {
    const arg = argv[i]!;
    if (arg.length === 0 || arg.startsWith("-")) continue;
    // The platform's own path rules, whatever the host (a POSIX launch never gets a Windows drive, and back).
    const paths = platform === "win32" ? win32 : posix;
    const path = paths.isAbsolute(arg) ? arg : paths.resolve(workingDirectory, arg);
    if (isDirectory(path)) return { kind: "open", path };
  }
  return { kind: "focus" };
}
