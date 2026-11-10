import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { exec } from "../util/exec.js";
import type { GHAccount } from "./models.js";

/**
 * `gh auth status` per host (port of Core `PR/GHAuth.swift`). Hosts come from `hosts.yml` (no network),
 * then every host is probed concurrently with its own timeout so an unreachable GHE (VPN off) never
 * blocks github.com.
 */

/** Per-host wall-clock cap for `gh auth status`; `gh` itself waits much longer on a dead host. */
export const PER_HOST_TIMEOUT_MS = 8_000;
export const TIMED_OUT_DETAIL = "timed out (VPN?)";

type Env = Record<string, string | undefined>;

/** `GH_CONFIG_DIR` → win32 `%APPDATA%\GitHub CLI` → `$HOME/.config/gh` (joined with that OS's separator). */
export function ghConfigDir(platform: NodeJS.Platform, env: Env): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (platform === "win32") {
    const appData = env.APPDATA ?? win32.join(env.USERPROFILE ?? homedir(), "AppData", "Roaming");
    return win32.join(appData, "GitHub CLI");
  }
  return posix.join(env.HOME || homedir(), ".config", "gh");
}

export async function status(ghPath: string, env: Env, platform: NodeJS.Platform = process.platform): Promise<GHAccount[]> {
  const hostsFile = join(ghConfigDir(platform, env), "hosts.yml");
  let text = "";
  try {
    text = await readFile(hostsFile, "utf8");
  } catch {
    // no hosts.yml → no hosts
  }
  const known = parseHostsYAML(text);
  if (known.length === 0) return [];
  // Concurrent probes, hosts.yml order (first host first), so the list is stable across refreshes.
  return Promise.all(known.map((h) => probe(h.host, h.login, ghPath, env)));
}

/** `host[:port]` only — letters, digits, `.`, `-`, and an optional numeric port. */
export function isValidHost(host: string): boolean {
  return /^[A-Za-z0-9.-]+(:[0-9]+)?$/.test(host);
}

/**
 * null if `host` doesn't look like a bare hostname (guards against shell injection via the value
 * this builds into `platform.openTerminal`'s command string).
 */
export function loginCommand(host: string): string | null {
  if (!isValidHost(host)) return null;
  return `gh auth login --hostname '${host}' --web --git-protocol https`;
}

// MARK: - hosts.yml

export type KnownHost = { host: string; login: string | null };

/**
 * Minimal reader for `hosts.yml`: top-level keys ending in `:` are hosts; an indented `user:` line
 * names the active login of the host above it. A duplicated host block keeps the first occurrence.
 */
export function parseHostsYAML(text: string): KnownHost[] {
  const result: KnownHost[] = [];
  let current: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const indented = /^\s/.test(line);
    if (!indented && trimmed.endsWith(":")) {
      const host = trimmed.slice(0, -1);
      if (result.some((h) => h.host === host)) {
        // Duplicate host block: keep the first occurrence, ignore this one's fields.
        current = null;
      } else {
        result.push({ host, login: null });
        current = result.length - 1;
      }
    } else if (indented && trimmed.startsWith("user:") && current !== null) {
      const login = trimmed.slice("user:".length).trim();
      if (login.length > 0) result[current].login = login;
    }
  }
  return result;
}

// MARK: - gh auth status --json hosts

async function probe(host: string, knownLogin: string | null, ghPath: string, env: Env): Promise<GHAccount> {
  let out;
  try {
    out = await exec(ghPath, ["auth", "status", "--hostname", host, "--json", "hosts"], { env, timeoutMs: PER_HOST_TIMEOUT_MS });
  } catch (e) {
    return { host, login: knownLogin, ok: false, detail: String((e as Error).message ?? e) };
  }
  const parsed = parseStatusJSON(out.stdout, host);
  if (parsed) {
    return { host, login: parsed.login ?? knownLogin, ok: parsed.ok, detail: parsed.detail };
  }
  // Killed by our timeout or no JSON at all.
  const stderr = out.stderr.trim();
  const killed = out.timedOut || out.signal === "SIGTERM" || out.signal === "SIGKILL";
  const detail = killed ? TIMED_OUT_DETAIL : stderr.length > 0 ? stderr : `gh auth status exited ${out.status}`;
  return { host, login: knownLogin, ok: false, detail };
}

export type HostStatus = { ok: boolean; login: string | null; detail: string };

/** `{"hosts":{"H":[{state, login, error, …}]}}` (docs/gh-auth-status.json). The active entry wins. */
export function parseStatusJSON(data: Buffer | string, host: string): HostStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const hosts = (parsed as { hosts?: unknown }).hosts;
  if (typeof hosts !== "object" || hosts === null) return null;
  const entries = (hosts as Record<string, unknown>)[host];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const records = entries.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
  if (records.length === 0) return null;
  const entry = records.find((e) => e.active === true) ?? records[0];
  if (typeof entry.state !== "string") return null;
  const state = entry.state;
  const entryLogin = typeof entry.login === "string" ? entry.login : null;
  switch (state) {
    case "success": {
      let detail = `Logged in as ${entryLogin ?? "?"}`;
      if (typeof entry.tokenSource === "string") detail += ` (${entry.tokenSource})`;
      if (typeof entry.scopes === "string" && entry.scopes.length > 0) detail += `; scopes: ${entry.scopes}`;
      return { ok: true, login: entryLogin, detail };
    }
    case "timeout":
      return { ok: false, login: entryLogin, detail: TIMED_OUT_DETAIL };
    default: {
      const err = typeof entry.error === "string" ? entry.error.trim() : "";
      return { ok: false, login: entryLogin, detail: err.length > 0 ? err : state };
    }
  }
}
