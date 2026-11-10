import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir } from "./extensions.js";

/**
 * What the Claude CLI keeps on disk about a conversation, and how its start fails (docs/PROTOCOL.md §30).
 *
 * The CLI stores a conversation as `<config>/projects/<cwd key>/<session id>.jsonl` (`<config>` = `CLAUDE_CONFIG_DIR`
 * or `~/.claude`) and refuses `--session-id <id>` whenever that file exists ("Session ID … is already in use", even
 * for an empty file). The key rule below is the CLI's own (2.1.30x, read from the binary and verified against a
 * directory it created): the NFC cwd with every non-alphanumeric character replaced by `-`; longer than 200 chars →
 * the first 200 + `-` + the base-36 Java string hash of the cwd. With `CLAUDE_CONFIG_DIR` set, a safe
 * `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the key. The CLI uses its real (symlink-resolved) cwd.
 */

const MAX_KEY = 200;
const PROJECT_DIR_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** The CLI's folder name under `<config>/projects/` for `cwd`. */
export function cliProjectDirName(cwd: string, env: Record<string, string | undefined>): string {
  const override = env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (env.CLAUDE_CONFIG_DIR?.trim() && override && PROJECT_DIR_NAME_RE.test(override) && !RESERVED_NAME_RE.test(override)) return override;
  const nfc = cwd.normalize("NFC");
  const key = nfc.replace(/[^a-zA-Z0-9]/g, "-");
  return key.length <= MAX_KEY ? key : `${key.slice(0, MAX_KEY)}-${Math.abs(javaHash(nfc)).toString(36)}`;
}

/** `<config>/projects/<key>/<sessionId>.jsonl` for `cwd` as given. */
export function cliSessionFile(cwd: string, sessionId: string, env: Record<string, string | undefined>): string {
  return join(claudeConfigDir(env), "projects", cliProjectDirName(cwd, env), `${sessionId}.jsonl`);
}

/**
 * The CLI has a record of `sessionId` for `cwd` (as given or symlink-resolved). A positive signal only: a miss never
 * proves the CLI does not know the conversation (another config dir, a cwd spelled differently) — the CLI's own
 * answer to `--resume` is what decides that.
 */
export function cliSessionExists(cwd: string, sessionId: string, env: Record<string, string | undefined>): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  const cwds = new Set([cwd]);
  try {
    cwds.add(realpathSync(cwd));
  } catch {
    // a cwd that does not resolve is checked as given
  }
  for (const c of cwds) {
    try {
      if (existsSync(cliSessionFile(c, sessionId, env))) return true;
    } catch {
      // unreadable config dir: unknown
    }
  }
  return false;
}

// ------------------------------------------------------------------ start failures

/**
 * Why the CLI refused to start a conversation (stderr / the SDK's error text, CLI 2.1.301–2.1.308):
 * `session_id_in_use` — `--session-id` for a conversation it already has (the engine resumes it instead);
 * `resume_not_found` — `--resume` of a conversation it has no record of (cleaned up after 30 days, deleted, another
 * machine); `resume_failed` — the record exists but could not be loaded.
 */
export type StartFailureCode = "session_id_in_use" | "resume_not_found" | "resume_failed";

const IN_USE_RE = /Session ID \S+ is already in use/i;
const NOT_FOUND_RE = /No conversation found (?:with session ID|to continue)/i;
const RESUME_FAILED_RE = /Failed to resume session|Unable to load transcript/i;

export function codeOfStartFailure(text: string | undefined | null): StartFailureCode | null {
  if (!text) return null;
  if (IN_USE_RE.test(text)) return "session_id_in_use";
  if (NOT_FOUND_RE.test(text)) return "resume_not_found";
  if (RESUME_FAILED_RE.test(text)) return "resume_failed";
  return null;
}

/** English fallbacks; clients localize on the code. */
export const START_FAILURE_MESSAGES: Record<StartFailureCode | "session_start_failed", string> = {
  session_id_in_use: "Claude Code already has this conversation; it was resumed instead of started again.",
  resume_not_found:
    "Claude Code has no record of this conversation any more (cleaned up after 30 days, or deleted), so it cannot be continued. A new chat was started; the previous one stays readable.",
  resume_failed: "Claude Code could not load this conversation, so it cannot be continued. A new chat was started; the previous one stays readable.",
  session_start_failed: "Claude Code exited while starting.",
};

const DETAIL_MAX = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One line of CLI output fit for the wire (`error.detail`): the first non-empty line, the home folder as `~`, API keys,
 * bearer tokens, `…TOKEN=` / `api_key: …` values and long opaque runs masked (ids and paths kept), ≤ 300 chars. Stable for
 * the same failure, so clients can merge repeats.
 */
export function redactDetail(text: string, home: string = homedir()): string {
  let line = (text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "");
  // The home folder itself, not a longer name that starts with it (`/Users/me` must not turn `/Users/meme` into `~me`) —
  // the rule of the Mac's LogRedactor.
  if (home && home !== "/") line = line.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9._-])", "g"), "~");
  line = line
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***")
    .replace(/\b(Bearer)\s+[^\s"',;]+/gi, "$1 ***")
    .replace(/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|credential)[A-Za-z0-9_]*)(\s*[:=]\s*["']?)(?!\*\*\*)[^\s"',;]+/gi, "$1$2***")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (UUID_RE.test(run) || run.includes("/") || /^-|-$/.test(run) ? run : "***"));
  return line.length > DETAIL_MAX ? line.slice(0, DETAIL_MAX - 1) + "…" : line;
}
