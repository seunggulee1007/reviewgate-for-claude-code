/**
 * MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: which `statusLine` the user's Claude Code would run.
 *
 * Claude Code reads `statusLine` from its merged settings — user (`<config>/settings.json`) < project
 * (`.claude/settings.json`) < local (`.claude/settings.local.json`) < managed — and runs it only once the workspace is
 * trusted. ReviewGate runs the user's and the managed one; a project's (code that came with the repository) only when
 * the user allowed that very command for that project (`settings.allowedProjectStatusLine` = its sha256, so a pull that
 * changes the command asks again). As the CLI (`Nft` / `Ph`): managed `disableAllHooks: true` runs nothing; managed
 * `allowManagedHooksOnly: true` — or `disableAllHooks: true` anywhere else, ReviewGate's "my hooks off" included — leaves
 * only the managed one. A managed source that cannot be read runs nothing (`managed_policy`). Pure reads, every file
 * through `safeReadOrNull` (a regular file ≤ 1 MB: never a device or a FIFO a repository links in).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StatusLineProject, StatusLineSource } from "../protocol.js";
import { safeReadOrNull, wellFormed } from "../util/safeRead.js";
import type { ManagedPolicy } from "./managed.js";

/** Longest `statusLine.padding` taken (the CLI has no limit; a wider one would leave no room for the line). */
export const STATUS_PADDING_MAX = 20;
/** Longest `refreshInterval` / `timeout` taken (beyond 2^31 − 1 ms a Node timer fires at once). */
export const STATUS_REFRESH_MAX_MS = 24 * 60 * 60 * 1000;
export const STATUS_TIMEOUT_MAX_MS = 10 * 60 * 1000;

export type StatusLineConfig = {
  command: string;
  /** Blank columns on each side (0–20). */
  padding: number;
  /** `statusLine.refreshInterval` in ms (1 s – 1 day), null when not set (then it runs on changes only, as the CLI). */
  refreshIntervalMs: number | null;
  /** `statusLine.timeout` in ms (a hook field the CLI reads for every command), null when not set. */
  timeoutMs: number | null;
  /** `statusLine.shell`: `powershell` runs it through PowerShell (the CLI's hook field); null = the default shell. */
  shell: "bash" | "powershell" | null;
  source: StatusLineSource;
  /** The settings file (or managed source) it comes from. */
  path: string;
};

export type StatusLineResolution = {
  /** What runs; null: nothing is configured, allowed or enabled. */
  config: StatusLineConfig | null;
  /** The project's own `statusLine` (settings.local.json over settings.json), whether it is allowed or not. */
  project: StatusLineProject | null;
  disabled: "disable_all_hooks" | "managed_policy" | null;
  /** The merged `outputStyle` (the stdin's `output_style.name`; "default" when none). */
  outputStyle: string;
};

type Raw = Record<string, unknown>;
type Layer = { source: StatusLineSource; path: string; data: Raw };

/** The sha256 (hex) a project's command is allowed by. */
export function commandSha256(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

function readJson(path: string, read: (p: string) => string | null): Raw | null {
  const text = read(path);
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Raw) : null;
  } catch {
    return null;
  }
}

function statusLineObject(layer: Layer | null | undefined): Raw | null {
  const v = layer?.data.statusLine;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
}

function commandOf(o: Raw | null): string | null {
  if (!o || (o.type !== undefined && o.type !== "command")) return null;
  return typeof o.command === "string" && o.command.trim() !== "" ? o.command : null;
}

/** The merged `statusLine` of `layers` (lowest first: each one's fields over the ones below, as the CLI merges objects). */
function mergedConfig(layers: Layer[]): StatusLineConfig | null {
  let merged: Raw = {};
  let from: Layer | null = null;
  for (const layer of layers) {
    const o = statusLineObject(layer);
    if (!o) continue;
    merged = { ...merged, ...o };
    if (commandOf(o) !== null) from = layer;
  }
  const command = commandOf(merged);
  if (command === null || from === null) return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const padding = Math.min(STATUS_PADDING_MAX, Math.max(0, Math.floor(num(merged.padding) ?? 0)));
  const refresh = num(merged.refreshInterval);
  const timeout = num(merged.timeout);
  const shell = merged.shell === "powershell" || merged.shell === "bash" ? merged.shell : null;
  return {
    command,
    padding,
    refreshIntervalMs: refresh === null ? null : Math.min(STATUS_REFRESH_MAX_MS, Math.max(1, refresh) * 1000),
    timeoutMs: timeout !== null && timeout > 0 ? Math.min(STATUS_TIMEOUT_MAX_MS, timeout * 1000) : null,
    shell,
    source: from.source,
    path: wellFormed(from.path),
  };
}

/**
 * The `statusLine` that runs for `cwd` (null: no project; only the user's and the managed settings are read). `read`
 * stands in for the file system (tests); a file that does not parse is skipped, as the CLI skips invalid settings.
 */
export function resolveStatusLine(opts: {
  configDir: string;
  cwd: string | null;
  /** The managed tier (`readManagedPolicy`). */
  managed: ManagedPolicy;
  /** The sha256 of the project's own statusLine command the user allowed for this project ("" / null: none). */
  allowedProjectSha?: string | null;
  /** `.claude/settings.local.json` loads for this project (§36.6 "로컬 설정 로드"; default true). */
  loadLocal?: boolean;
  /** The flag layer's `disableAllHooks` (ReviewGate's `disableUserHooks`): as the user's own. */
  disableAllHooks?: boolean;
  read?: (path: string) => string | null;
}): StatusLineResolution {
  const read = opts.read ?? ((p: string) => safeReadOrNull(p));
  const layer = (source: StatusLineSource, path: string): Layer | null => {
    const data = readJson(path, read);
    return data ? { source, path, data } : null;
  };
  const user = layer("user", join(opts.configDir, "settings.json"));
  const project = opts.cwd ? layer("project", join(opts.cwd, ".claude", "settings.json")) : null;
  const local = opts.cwd && opts.loadLocal !== false ? layer("local", join(opts.cwd, ".claude", "settings.local.json")) : null;
  const policy = opts.managed.settings;
  const managed: Layer | null = policy ? { source: "managed", path: opts.managed.sources[0]?.path ?? "managed settings", data: policy } : null;

  let outputStyle = "default";
  for (const l of [user, project, local, managed]) if (l && typeof l.data.outputStyle === "string" && l.data.outputStyle.trim() !== "") outputStyle = wellFormed(l.data.outputStyle);

  // The project's own definition (local over project), told whether or not it may run; bound to its command.
  const ownLayers = [project, local].filter((l): l is Layer => l !== null && statusLineObject(l) !== null);
  const own = mergedConfig(ownLayers);
  const sha = own ? commandSha256(own.command) : null;
  const ownAllowed = sha !== null && !!opts.allowedProjectSha && opts.allowedProjectSha === sha;
  const info = (allowed: boolean): StatusLineProject | null =>
    own && sha ? { path: own.path, command: wellFormed(own.command), sha256: sha, allowed } : null;

  if (opts.managed.failed) return { config: null, project: info(false), disabled: "managed_policy", outputStyle };
  if (policy?.disableAllHooks === true) return { config: null, project: info(false), disabled: "disable_all_hooks", outputStyle };
  // The merged `disableAllHooks` (user < project < local < flag < managed: the last one set wins, as the CLI merges).
  let mergedOff: unknown;
  for (const l of [user, project, local]) if (l && l.data.disableAllHooks !== undefined) mergedOff = l.data.disableAllHooks;
  if (opts.disableAllHooks === true) mergedOff = true;
  if (policy && policy.disableAllHooks !== undefined) mergedOff = policy.disableAllHooks;
  const offElsewhere = mergedOff === true;
  if (offElsewhere || policy?.allowManagedHooksOnly === true) {
    // Only the organization's own status line may run (the CLI's `Nft`).
    const config = managed ? wellFormedConfig(mergedConfig([managed])) : null;
    const suppressed = commandOf(statusLineObject(user)) !== null || own !== null;
    return { config, project: info(false), disabled: config ? null : offElsewhere ? "disable_all_hooks" : suppressed ? "managed_policy" : null, outputStyle };
  }
  const runnable = [user, ...(ownAllowed ? [project, local] : []), managed].filter((l): l is Layer => l !== null);
  return { config: wellFormedConfig(mergedConfig(runnable)), project: info(ownAllowed), disabled: null, outputStyle };
}

/** The command as the clients are told it (a lone surrogate half never reaches them; spawning converts it alike). */
function wellFormedConfig(c: StatusLineConfig | null): StatusLineConfig | null {
  return c ? { ...c, command: wellFormed(c.command) } : null;
}
