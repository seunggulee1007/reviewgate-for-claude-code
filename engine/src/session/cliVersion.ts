import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliInfo, CliVersionChange, CliVersionEntry, CliVersionRange } from "../protocol.js";
import { compareVersions } from "../platform/toolchain.js";

/**
 * §36.8 (audit daily-06): the Claude CLI updates itself almost daily (five versions in three days); a behavior change can
 * open a hole in the review (2.1.303 ran every Agent call in the background). The engine knows which versions it was
 * verified against, notices a version it has not seen before, and lists the installed versions so a client can pin one
 * (`settings.claudePath` = `~/.local/share/claude/versions/<ver>`).
 */

/** The CLIs ReviewGate's drivers ran against (inclusive). The integration step moves `max` after a driver run on a new CLI. */
export const VERIFIED_CLI_RANGE: CliVersionRange = { min: "2.1.301", max: "2.1.318" }; // §36.8: every real-CLI driver passed on 2.1.318

/**
 * `<data dir>/verified-cli.json`: versions verified after the release (`make verify-cli` — every real-CLI driver passed on
 * them), so a new CLI needs no new app; read at each session start. `{ version: 1, verified: [{ version, engine, at, drivers }] }`.
 */
export const VERIFIED_CLI_FILE = "verified-cli.json";

/** `<data dir>/cli-versions.json`: the last version a session saw and the one before it (app-wide). */
export const CLI_VERSIONS_FILE = "cli-versions.json";

type CliVersionRecord = { version: 1; last: string | null; previous: string | null; updatedAt: string };

const SEMVER_RE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const CLAUDE_VERSION_LINE_RE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s+\(Claude Code\)/;
const VERSION_ENTRY_RE = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(\.exe)?$/i;

/**
 * The CLI's version: `claude --version` prints `2.1.309 (Claude Code)` — only such a line counts (a stand-in executable's
 * version is not the CLI's); `plain` takes a bare version (`system/init` `claude_code_version`).
 */
export function parseCliVersion(text: string | null | undefined, opts: { plain?: boolean } = {}): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const m = (opts.plain ? SEMVER_RE : CLAUDE_VERSION_LINE_RE).exec(t);
  return m ? m[1]! : null;
}

export function isVerifiedCli(version: string, range: CliVersionRange = VERIFIED_CLI_RANGE, extra: readonly string[] = []): boolean {
  return (compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) <= 0) || extra.includes(version);
}

/** The versions in `<data dir>/verified-cli.json`; none when it is missing or not readable (the built-in range still holds). */
export function verifiedCliVersions(dataDir: string): string[] {
  try {
    const o = JSON.parse(readFileSync(join(dataDir, VERIFIED_CLI_FILE), "utf8")) as { version?: unknown; verified?: unknown };
    if (o?.version !== 1 || !Array.isArray(o.verified)) return [];
    return o.verified
      .map((e) => (e && typeof e === "object" ? (e as { version?: unknown }).version : null))
      .filter((v): v is string => typeof v === "string" && SEMVER_RE.test(v));
  } catch {
    return [];
  }
}

/** The native installer's versions folder: `~/.local/share/claude/versions` (on Windows under `%USERPROFILE%`). */
export function defaultCliVersionsDir(home: string = homedir()): string {
  return join(home, ".local", "share", "claude", "versions");
}

/** The installed versions, newest first — by entry name only (a file named like a version; the contents are never read). */
export function listCliVersions(dir: string, extra: readonly string[] = []): CliVersionEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CliVersionEntry[] = [];
  for (const name of names) {
    const m = VERSION_ENTRY_RE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ version: m[1]!, path, verified: isVerifiedCli(m[1]!, VERIFIED_CLI_RANGE, extra) });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

function readRecord(dataDir: string): CliVersionRecord | null {
  try {
    const o = JSON.parse(readFileSync(join(dataDir, CLI_VERSIONS_FILE), "utf8")) as Partial<CliVersionRecord>;
    if (o?.version !== 1) return null;
    return {
      version: 1,
      last: typeof o.last === "string" && o.last ? o.last : null,
      previous: typeof o.previous === "string" && o.previous ? o.previous : null,
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function writeRecord(dataDir: string, record: CliVersionRecord): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, CLI_VERSIONS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * A session saw `version`: the record's last version is updated; `change` (once, by whichever session first sees the new
 * version) when it differs from the last one — never on the very first sight. `previous`: the version used before this one.
 * Synchronous (a tiny file), best effort: an unwritable data dir only costs the notice.
 */
export function noteCliVersion(dataDir: string, version: string): { change: CliVersionChange | null; previous: string | null } {
  const rec = readRecord(dataDir);
  const now = new Date().toISOString();
  if (rec?.last === version) return { change: null, previous: rec.previous };
  try {
    writeRecord(dataDir, { version: 1, last: version, previous: rec?.last ?? null, updatedAt: now });
  } catch {
    // the notice still goes out; the next session may say it again
  }
  if (!rec?.last) return { change: null, previous: null };
  return { change: { from: rec.last, to: version, verified: isVerifiedCli(version, VERIFIED_CLI_RANGE, verifiedCliVersions(dataDir)) }, previous: rec.last };
}

/** The installed executable of `version` (`<dir>/<ver>`, on Windows maybe `<ver>.exe`); null once it is gone. */
function pinnablePath(versionsDir: string, version: string): string | null {
  const p = join(versionsDir, version);
  if (existsSync(p)) return p;
  return existsSync(`${p}.exe`) ? `${p}.exe` : null;
}

/** `session.cli` for a known version; `extra`: the versions verified after the release (`verifiedCliVersions`). */
export function cliInfo(version: string, previous: string | null, versionsDir: string, extra: readonly string[] = []): CliInfo {
  return {
    version,
    verified: isVerifiedCli(version, VERIFIED_CLI_RANGE, extra),
    verifiedRange: { ...VERIFIED_CLI_RANGE },
    previous: previous ? { version: previous, path: pinnablePath(versionsDir, previous) } : null,
  };
}
