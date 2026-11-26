/**
 * §48 Windows — what the installer said. build/installer.nsh appends one line per step to `%TEMP%\ReviewGate-update.log`
 * (UTF-16LE, `<installer version> <event> <detail>`): `start <command line>`, `mode …`, `uninstall-old failed <code>`,
 * `uninstall-old retry <n>: <code>`, `failed uninstall-old <code> <file> (in use by <program> <pid>)`,
 * `failed another-installer`, `reopened …`, `installed <folder>`. The next launch takes the file once: every line goes to
 * the app's log, and an update that did not install says why from the last run's lines. Electron-free.
 */
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { t } from "../renderer/i18n";

export const INSTALLER_LOG_NAME = "ReviewGate-update.log";
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
 * Reads and removes `ReviewGate-update.log` in each of `dirs` (the same folder named twice counts once): the lines, and
 * what went wrong other than there being none. Never throws. The installer writes to its `$TEMP` (the environment's
 * TMP / TEMP); main passes Node's `os.tmpdir()` (TEMP / TMP) and Electron's temp folder — seen on windows-latest,
 * Electron's alone did not find the file the installer had written.
 */
export function takeInstallerLog(dirs: readonly string[]): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    const file = join(dir, INSTALLER_LOG_NAME);
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
