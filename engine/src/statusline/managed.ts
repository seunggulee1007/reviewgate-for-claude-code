/**
 * MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the managed ("policy") settings tier as Claude Code 2.1.310 reads
 * it, for the two things the status line obeys — `statusLine`, `disableAllHooks` / `allowManagedHooksOnly` (the CLI's
 * `Nft` / `Ph`). The CLI used to be the only runner of a user's commands; now the engine runs the status line itself, so
 * an organization's switch must reach it from every source the CLI reads:
 *
 * - server-managed: `<config>/remote-settings.json` (keys starting with `$` other than `$schema` dropped);
 * - MDM: macOS `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`, then the device-level one (the first
 *   with content; read through `/usr/bin/plutil -convert json`), Windows `HKLM\SOFTWARE\Policies\ClaudeCode` value
 *   `Settings` (JSON, REG_SZ / REG_EXPAND_SZ);
 * - file: `managed-settings.json` of the managed folder, then `managed-settings.d/*.json` (sorted; regular files or links,
 *   no dotfiles) deep-merged over it in that order;
 * - Windows `HKCU\SOFTWARE\Policies\ClaudeCode` only when none of the above is present (the user can write it).
 *
 * `managedSourcesBehavior` (from the highest source that sets it): `first-wins` (default) — the highest present source is
 * the managed tier alone; `merge` — every present source deep-merges, the highest's value on top, a restrictive switch
 * (`disable*`, `allowManaged*Only`) true when any source sets it. A source that exists but cannot be read or parsed
 * fails closed: `failed` is set and the caller runs nothing. Every source is cached by mtime / size (the registry for a
 * minute), so a run costs a few `stat`s.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { safeReadText, type SafeRead } from "../util/safeRead.js";

export type ManagedKind = "remote" | "plist" | "hklm" | "file" | "hkcu";
type Raw = Record<string, unknown>;

export type ManagedPolicy = {
  /** The managed tier's settings; null when no source is present. */
  settings: Raw | null;
  /** The present sources making it up, highest first (the first is where its `statusLine` is told to come from). */
  sources: { kind: ManagedKind; path: string }[];
  /** A source that exists but could not be read or parsed: nothing may run until it is fixed. */
  failed: { kind: ManagedKind; path: string; reason: string } | null;
};

export const NO_MANAGED_POLICY: ManagedPolicy = { settings: null, sources: [], failed: null };

/** The managed folder of `managed-settings.json` and `managed-settings.d/` per platform. */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

export const PLIST_DOMAIN = "com.anthropic.claudecode";
export const HKLM_KEY = "HKLM\\SOFTWARE\\Policies\\ClaudeCode";
export const HKCU_KEY = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";
const REMOTE_MAX = 8 * 1024 * 1024;
const MANAGED_MAX = 2 * 1024 * 1024;
const REGISTRY_TTL_MS = 60_000;

export type ManagedReadOptions = {
  platform: NodeJS.Platform;
  /** `<config>`: where `remote-settings.json` lives. */
  configDir: string;
  /** The managed folder (default the platform's); null: none (tests). */
  managedDir?: string | null;
  /** The account name of the per-user managed preferences (default the process's). */
  username?: string;
  /** Test seams. */
  readText?: (path: string, max: number) => SafeRead;
  plistToJson?: (path: string) => string;
  regQuery?: (key: string) => string | null;
  listDir?: (dir: string) => { name: string; isFile: boolean; isLink: boolean }[];
  now?: () => number;
};

const isObject = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

/** Objects merged key by key, the right one's value on top (arrays and scalars replaced). */
function deepMerge(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Raw, v) : v;
  return out;
}

const RESTRICTIVE = /^(disable[A-Z]\w*|allowManaged\w*Only)$/;

type Parsed = { ok: true; data: Raw } | { ok: false; reason: string } | null; // null: absent

function parseJson(text: string): Parsed {
  if (text.trim() === "") return { ok: true, data: {} };
  try {
    const o = JSON.parse(text) as unknown;
    return isObject(o) ? { ok: true, data: o } : { ok: false, reason: "not a JSON object" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.split("\n")[0]! : "not JSON" };
  }
}

const fileCache = new Map<string, { mtimeMs: number; size: number; parsed: Parsed }>();
const regCache = new Map<string, { at: number; value: string | null }>();

/** Clears the caches (tests). */
export function resetManagedCache(): void {
  fileCache.clear();
  regCache.clear();
}

function statKey(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** A JSON settings file: absent, parsed, or failed (exists but is no readable JSON object). */
function readJsonSource(path: string, max: number, opts: ManagedReadOptions, cached = true): Parsed {
  const key = cached && !opts.readText ? statKey(path) : null;
  if (key) {
    const hit = fileCache.get(path);
    if (hit && hit.mtimeMs === key.mtimeMs && hit.size === key.size) return hit.parsed;
  }
  const r = (opts.readText ?? safeReadText)(path, max);
  let parsed: Parsed;
  if ("text" in r) parsed = parseJson(r.text);
  else if (r.error === "absent") parsed = null;
  else parsed = { ok: false, reason: r.error === "unreadable" ? `unreadable (${r.detail ?? "?"})` : r.error === "too_large" ? "too large" : "not a regular file" };
  if (key) fileCache.set(path, { ...key, parsed });
  return parsed;
}

function defaultPlistToJson(path: string): string {
  return execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], { encoding: "utf8", timeout: 5000, maxBuffer: MANAGED_MAX, stdio: ["ignore", "pipe", "ignore"] });
}

function plistSource(path: string, opts: ManagedReadOptions): Parsed {
  let key: { mtimeMs: number; size: number } | null = null;
  if (!opts.plistToJson) {
    try {
      const st = statSync(path);
      if (!st.isFile()) return { ok: false, reason: "not a regular file" };
      key = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? null : { ok: false, reason: `unreadable (${code ?? "?"})` };
    }
  }
  if (key) {
    const hit = fileCache.get(path);
    if (hit && hit.mtimeMs === key.mtimeMs && hit.size === key.size) return hit.parsed;
  }
  let parsed: Parsed;
  try {
    parsed = parseJson((opts.plistToJson ?? defaultPlistToJson)(path));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    parsed = code === "ENOENT" && opts.plistToJson ? null : { ok: false, reason: "plutil could not read it" };
  }
  if (key) fileCache.set(path, { ...key, parsed });
  return parsed;
}

function defaultRegQuery(key: string): string | null {
  try {
    return execFileSync("reg.exe", ["query", key, "/v", "Settings"], { encoding: "utf8", timeout: 5000, maxBuffer: MANAGED_MAX, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null; // the key or the value is not there
  }
}

/** The `Settings` value of a `reg query` answer (the CLI's pattern), else null. */
export function registrySettingsValue(stdout: string): string | null {
  const m = /^[ \t]+Settings[ \t]+REG_(?:EXPAND_)?SZ[ \t]+([\s\S]*)/im.exec(stdout);
  const v = m?.[1]?.trimEnd();
  return v ? v : null;
}

function registrySource(key: string, opts: ManagedReadOptions): Parsed {
  const now = (opts.now ?? Date.now)();
  const hit = opts.regQuery ? undefined : regCache.get(key);
  let stdout: string | null;
  if (hit && now - hit.at < REGISTRY_TTL_MS) stdout = hit.value;
  else {
    stdout = (opts.regQuery ?? defaultRegQuery)(key);
    if (!opts.regQuery) regCache.set(key, { at: now, value: stdout });
  }
  if (stdout === null) return null;
  const value = registrySettingsValue(stdout);
  return value === null ? null : parseJson(value);
}

function listDropIns(dir: string, opts: ManagedReadOptions): { names: string[]; error: string | null } {
  try {
    const entries = opts.listDir
      ? opts.listDir(dir)
      : readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isFile: d.isFile(), isLink: d.isSymbolicLink() }));
    return { names: entries.filter((e) => (e.isFile || e.isLink) && e.name.endsWith(".json") && !e.name.startsWith(".")).map((e) => e.name).sort(), error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { names: [], error: code === "ENOENT" || code === "ENOTDIR" ? null : `unreadable (${code ?? "?"})` };
  }
}

/** The managed tier as the CLI composes it (see the file's head). */
export function readManagedPolicy(opts: ManagedReadOptions): ManagedPolicy {
  type Source = { kind: ManagedKind; path: string; data: Raw };
  let failed: ManagedPolicy["failed"] = null;
  const fail = (kind: ManagedKind, path: string, reason: string) => {
    failed ??= { kind, path, reason };
  };
  const take = (kind: ManagedKind, path: string, parsed: Parsed): Source | null => {
    if (parsed === null) return null;
    if (!parsed.ok) {
      fail(kind, path, parsed.reason);
      return null;
    }
    return { kind, path, data: parsed.data };
  };

  // server-managed
  const remotePath = join(opts.configDir, "remote-settings.json");
  let remote = take("remote", remotePath, readJsonSource(remotePath, REMOTE_MAX, opts));
  if (remote) remote = { ...remote, data: Object.fromEntries(Object.entries(remote.data).filter(([k]) => !k.startsWith("$") || k === "$schema")) };

  // MDM
  let mdm: Source | null = null;
  if (opts.platform === "darwin") {
    let user = opts.username;
    if (user === undefined) {
      try {
        user = userInfo().username;
      } catch {
        user = "";
      }
    }
    const paths = [...(user ? [`/Library/Managed Preferences/${user}/${PLIST_DOMAIN}.plist`] : []), `/Library/Managed Preferences/${PLIST_DOMAIN}.plist`];
    for (const p of paths) {
      const s = take("plist", p, plistSource(p, opts));
      if (s && Object.keys(s.data).length > 0) {
        mdm = s;
        break;
      }
    }
  } else if (opts.platform === "win32") {
    mdm = take("hklm", `${HKLM_KEY}\\Settings`, registrySource(HKLM_KEY, opts));
  }

  // file: the base file, then the drop-ins over it
  let file: Source | null = null;
  const dir = opts.managedDir === undefined ? managedSettingsDir(opts.platform) : opts.managedDir;
  if (dir !== null) {
    const base = join(dir, "managed-settings.json");
    let merged: Raw | null = take("file", base, readJsonSource(base, MANAGED_MAX, opts))?.data ?? null;
    const dropDir = join(dir, "managed-settings.d");
    const { names, error } = listDropIns(dropDir, opts);
    if (error) fail("file", dropDir, error);
    for (const name of names) {
      const s = take("file", join(dropDir, name), readJsonSource(join(dropDir, name), MANAGED_MAX, opts));
      if (s) merged = deepMerge(merged ?? {}, s.data);
    }
    if (merged !== null) file = { kind: "file", path: base, data: merged };
  }

  const present = [remote, mdm, file].filter((s): s is Source => s !== null && Object.keys(s.data).length > 0);
  if (present.length === 0 && opts.platform === "win32") {
    const hkcu = take("hkcu", `${HKCU_KEY}\\Settings`, registrySource(HKCU_KEY, opts));
    if (hkcu && Object.keys(hkcu.data).length > 0) present.push(hkcu);
  }
  if (present.length === 0) return { settings: null, sources: [], failed };

  const behavior = present.find((s) => s.data.managedSourcesBehavior !== undefined)?.data.managedSourcesBehavior;
  let settings: Raw;
  if (behavior === "merge" && present.length > 1) {
    settings = {};
    for (const s of [...present].reverse()) settings = deepMerge(settings, s.data);
    for (const s of present) for (const [k, v] of Object.entries(s.data)) if (RESTRICTIVE.test(k) && v === true) settings[k] = true;
  } else {
    settings = present[0]!.data;
  }
  return { settings, sources: present.map((s) => ({ kind: s.kind, path: s.path })), failed };
}
