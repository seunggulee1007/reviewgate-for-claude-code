/**
 * Daily log file under userData/logs (engine-YYYY-MM-DD.log); warn/error also go to stderr. Never throws.
 * wave3 check-clients: every line is masked first (logRedact.ts — the Mac's LogRedactor rules: home folder, keys, tokens).
 */
import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogLevel } from "@reviewgate/engine";
import { redactLog } from "./logRedact.js";

/** Resolved per call: main sets `userData` after this module is imported. */
export const logDir = (): string => join(app.getPath("userData"), "logs");

export function logLine(prefix: string, level: LogLevel | "main", msg: string): void {
  const line = `${new Date().toISOString()} [${prefix}:${level}] ${redactLog(msg)}\n`;
  if (level === "error" || level === "warn" || process.env.REVIEWGATE_VERBOSE) process.stderr.write(line);
  try {
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `engine-${new Date().toISOString().slice(0, 10)}.log`), line);
  } catch {
    /* logging must never break the app */
  }
}
