/**
 * §48 Windows — what the installer said. build/installer.nsh appends one line per step to `update-installer.log` in the
 * app's own folder (userData, `%APPDATA%\ReviewGate`; 0.5.35's installer: `%TEMP%\ReviewGate-update.log`)
 * (UTF-16LE, `<installer version> <event> <detail>`):`start <command line>`, `mode …`, `uninstall-old failed <code>`,
 * `uninstall-old retry <n>: <code>`, `failed uninstall-old <code> <file> (in use by <program> <pid>)`,
 * `failed another-installer`, `reopening <exe>` (before it starts; 0.5.35: `reopened …` after), `reopen failed (…)`,
 * `installed <folder>`. The next launch takes the file once: every line goes to
 * the app's log, and an update that did not install says why from the last run's lines. Electron-free.
 */
import { readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { t } from "../renderer/i18n";

/**
 * In userData: a known folder of the user (not an environment variable), so the installer and every later launch name
 * the same file whoever started them.
 */
export const INSTALLER_LOG_NAME = "update-installer.log";
/** Where 0.5.35's installer wrote it, in `$TEMP`: still read for one version. */
export const OLD_INSTALLER_LOG_NAME = "ReviewGate-update.log";
/** More than any run writes; a larger file is read from its end. */
export const MAX_INSTALLER_LOG_BYTES = 64 * 1024;

/** The file's lines (UTF-16LE, a BOM or not), the last 60. */
export function installerLogLines(bytes: Uint8Array): string[] {
  let b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length % 2 === 1) b = b.subarray(1); // read from the end: keep whole UTF-16 units
  const text = b.toString("utf16le").replace(/^﻿/, "");
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, "").trim())
    .filter((l) => l !== "")
    .slice(-60);
}

/** `<version> <event> <detail>` → the event and what follows it. */
const eventOf = (line: string): string => line.replace(/^\S+\s+/, "");

/**
 * Why the last installer run did not install, from its lines (from its `start` on); null when it installed, or when
 * there is nothing to say (no lines).
 */
export function installerLogWhy(lines: readonly string[]): string | null {
  let from = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^start\b/.test(eventOf(lines[i]!))) {
      from = i;
      break;
    }
  }
  const run = (from >= 0 ? lines.slice(from) : lines).map(eventOf);
  if (run.length === 0) return null;
  if (run.some((e) => e === "failed another-installer"))
    return t("Another ReviewGate installer was still open — close it (its window may be behind other windows, or end ReviewGate-Setup in Task Manager), then try again.");
  const busy = run.find((e) => e.startsWith("failed uninstall-old "));
  if (busy !== undefined) {
    const detail = busy.replace(/^failed uninstall-old\s+\S+\s*/, "").trim();
    return detail && detail !== "no file in use now"
      ? t("A file of ReviewGate was in use by another program — {0}. Close that program or restart Windows, then try again.", detail)
      : t("The old version could not be removed — a file of ReviewGate was in use. Restart Windows, then try again.");
  }
  if (run.some((e) => e.startsWith("installed "))) return null;
  return t("The installer stopped before it finished (its last step: {0}).", run[run.length - 1]!.split(" ")[0]!);
}

/**
 * Reads and removes each of `files` (one named twice, in any case, counts once), in their order: the lines, and what
 * went wrong other than a file not being there. Never throws.
 */
export function takeInstallerLog(files: readonly string[]): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || seen.has(file.toLowerCase())) continue;
    seen.add(file.toLowerCase());
    try {
      const size = statSync(file).size;
      const all = readFileSync(file);
      rmSync(file, { force: true });
      lines.push(...installerLogLines(size > MAX_INSTALLER_LOG_BYTES ? all.subarray(all.length - MAX_INSTALLER_LOG_BYTES) : all));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") problems.push(`${file}: ${code ?? String(e)}`);
    }
  }
  return { lines: lines.slice(-60), problems };
}

/**
 * The files a launch takes, the older place first so the newest run's lines come last: 0.5.35's in each temp folder
 * (its installer wrote to `$TEMP`, the environment's TMP / TEMP; Node's `os.tmpdir()` and Electron's temp folder), then
 * userData's. `$TEMP` was not enough: on windows-latest the app the installer started again through Explorer had the
 * session's own temp folder (`…\AppData\Local\Temp\2`) while the installer, started by the app, had `…\Temp`, so the
 * launch never found the file. A temp folder named by a number is a session's: the one above it is looked in too.
 */
export function installerLogFiles(userData: string, tempDirs: readonly string[]): string[] {
  const dirs = tempDirs.filter((d) => d !== "").flatMap((d) => (/^\d+$/.test(basename(d)) ? [d, dirname(d)] : [d]));
  return [...dirs.map((d) => join(d, OLD_INSTALLER_LOG_NAME)), join(userData, INSTALLER_LOG_NAME)];
}
