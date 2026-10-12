/**
 * wave3 check-clients — what must not leave the machine in the daily log file or a "Copy Diagnostics" paste, masked with
 * the Mac's LogRedactor rules (Core/Sources/ReviewGateCore/Session/EngineLog.swift; the engine's `redactDetail`, §30):
 * the home folder as `~` (the folder itself, never a longer name that starts with it), `sk-ant-…` keys, `Bearer …`,
 * `…TOKEN=` / `password:` / `api_key=` values and runs of 32+ opaque characters — UUIDs, paths and git object ids stay
 * readable. Every line of the text (a stack trace, the diagnostics JSON); nothing is cut.
 *
 * Windows: the home folder is matched with either separator and in any case, and as JSON writes it (`C:\\Users\\me`),
 * so the diagnostics' state is masked too.
 */
import { homedir } from "node:os";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]+$/i;

/** The spellings of `home` a log line can hold (one on macOS / Linux). */
function homeSpellings(home: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [home];
  const slash = home.replace(/\\/g, "/");
  const back = slash.replace(/\//g, "\\");
  return [...new Set([back.replace(/\\/g, "\\\\"), back, slash])];
}

/** A run of 32+ token characters that stays: a path, a flag-like run, a UUID, a git object id (sha-1 / sha-256). */
function keepsRun(run: string): boolean {
  if (run.includes("/") || run.startsWith("-") || run.endsWith("-")) return true;
  if (UUID_RE.test(run)) return true;
  return HEX_RE.test(run) && (run.length === 40 || run.length === 64);
}

/** The home folder's patterns, built once per (home, platform): every log line goes through them. */
let homeCache: { key: string; patterns: RegExp[] } | null = null;
function homePatterns(home: string, platform: NodeJS.Platform): RegExp[] {
  const key = `${platform}\u0000${home}`;
  if (homeCache?.key !== key) {
    const flags = platform === "win32" ? "gi" : "g";
    homeCache = { key, patterns: homeSpellings(home, platform).map((s) => new RegExp(escapeRe(s) + "(?![A-Za-z0-9._-])", flags)) };
  }
  return homeCache.patterns;
}

export function redactLog(text: string, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  let out = text;
  if (home && home !== "/" && home !== "\\") {
    for (const pattern of homePatterns(home, platform)) out = out.replace(pattern, "~");
  }
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***")
    .replace(/\b(Bearer)\s+[^\s"',;]+/gi, "$1 ***")
    .replace(/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|credential)[A-Za-z0-9_]*)(\s*[:=]\s*["']?)(?!\*\*\*)[^\s"',;]+/gi, "$1$2***")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (keepsRun(run) ? run : "***"));
}
