/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.6–36.9 on the client, the pure part (unit-tested): whether the engine has the session half of §36,
 * the per-project "Load local settings" and what the session left out ("Not applied in the app"). Later sections add the
 * extensions start (§36.7), the CLI version (§36.8) and the other Claude sessions (§36.9).
 */
import type { CliResumableSession, CliRunningSession, CliSessionStatus, CliVersionRange, ExtensionsWaitingOn, ImportedSession, NotAppliedLocalSettings, ReviewState, SessionExtensions } from "@reviewgate/engine";
import { projectRootHash } from "../shared/hash";
import type { AppSettings } from "../shared/ipc";
import { t } from "./i18n";
import type { PeerSelf } from "@reviewgate/engine"; // MARK: wave4d w4d-peers

type Session = ReviewState["session"];

/**
 * The engine implements §36.5–36.9 (they land together): it sends a field only such an engine has — `cli` /
 * `extensionsWaitingOn` (null included), `capabilities.state` / `commands`, `extensions.notApplied` (null included) or
 * the `local` setting source. An engine before §36 sends none of them; the controls that need it are then off with a reason.
 */
export function knowsSessionTools(s: Session): boolean {
  if (s.cli !== undefined || s.extensionsWaitingOn !== undefined) return true;
  const caps = s.capabilities;
  if (caps && (caps.state !== undefined || (Array.isArray(caps.commands) && caps.commands.length > 0))) return true;
  const ext = s.extensions;
  return !!ext && (ext.notApplied !== undefined || loadsLocalSettings(ext));
}

/** The one-line reason a §36 control is off with an older engine (the Mac's words). */
export const updateReason = (): string => t("This engine does not support it yet — update ReviewGate");

// ---------------------------------------------------------------- §36.6 local settings

/** This project's "Load local settings (settings.local.json)": on unless the project stored false (true without a project). */
export function projectLoadsLocal(settings: Pick<AppSettings, "projectLoadLocalSettings"> | null | undefined, root: string | null | undefined): boolean {
  if (!root) return true;
  return settings?.projectLoadLocalSettings?.[projectRootHash(root)] !== false;
}

/** The running session loaded `.claude/settings.local.json` and the local MCP servers (`settingSources` has `local`). */
export function loadsLocalSettings(ext: SessionExtensions | null | undefined): boolean {
  return Array.isArray(ext?.settingSources) && ext.settingSources.includes("local");
}

/**
 * The project's choice differs from what the running session applied: it takes effect after `restart_session`. Never with
 * an engine without §36.6 (it would never apply it) or during the §16 fallback (which drops local with user; "Retry with
 * extensions" brings both back).
 */
export function localSettingsNeedRestart(applied: SessionExtensions | null | undefined, wanted: boolean, supported: boolean): boolean {
  if (!applied || !supported || applied.fallback) return false;
  return loadsLocalSettings(applied) !== wanted;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

/** `extensions.notApplied`, each part checked; null when it holds nothing (or the session applies local settings). */
export function notAppliedOf(ext: SessionExtensions | null | undefined): NotAppliedLocalSettings | null {
  const raw = ext?.notApplied as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  const hooks = (Array.isArray(raw.hooks) ? raw.hooks : [])
    .filter((h): h is { event: string; command: string } => typeof h === "object" && h !== null && typeof (h as { event?: unknown }).event === "string" && typeof (h as { command?: unknown }).command === "string")
    .map((h) => ({ event: h.event, command: h.command }));
  const count = typeof raw.allowRuleCount === "number" && Number.isFinite(raw.allowRuleCount) && raw.allowRuleCount > 0 ? Math.floor(raw.allowRuleCount) : 0;
  const out: NotAppliedLocalSettings = { hooks, envKeys: strings(raw.envKeys), mcpServers: strings(raw.mcpServers), allowRuleCount: count };
  return out.hooks.length + out.envKeys.length + out.mcpServers.length + out.allowRuleCount === 0 ? null : out;
}

// ---------------------------------------------------------------- §36.7 extensions start

const WAITING_KINDS: ReadonlySet<ExtensionsWaitingOn["kind"]> = new Set(["hook", "mcp", "plugin", "unknown"]);

/** What the starting CLI waits for (`session.extensionsWaitingOn`) — only while the session starts; never a stale value. */
export function extensionsWaitingOf(s: Pick<Session, "starting" | "open" | "ready" | "extensionsWaitingOn">): ExtensionsWaitingOn | null {
  const starting = s.starting || (s.open && s.ready === false);
  const w = s.extensionsWaitingOn as { kind?: unknown; name?: unknown } | null | undefined;
  if (!starting || !w || typeof w !== "object") return null;
  const kind = WAITING_KINDS.has(w.kind as ExtensionsWaitingOn["kind"]) ? (w.kind as ExtensionsWaitingOn["kind"]) : "unknown";
  const name = typeof w.name === "string" && w.name.trim().length > 0 ? w.name : null;
  return { kind, name };
}

function waitingNoun(kind: ExtensionsWaitingOn["kind"]): string {
  switch (kind) {
    case "hook":
      return t("a hook");
    case "mcp":
      return t("an MCP server");
    case "plugin":
      return t("a plugin");
    default:
      return t("extensions");
  }
}

/** "serena 기다리는 중" — or the kind of thing when the signal named none (the HUD chip, the slow-start banner). */
export function waitingText(w: ExtensionsWaitingOn): string {
  return t("Waiting for {0}", w.name ?? waitingNoun(w.kind));
}

/** The tooltip: what Claude Code is doing with it (the Mac's words). */
export function waitingDetail(w: ExtensionsWaitingOn): string {
  if (!w.name) return t("Claude Code is loading extensions");
  switch (w.kind) {
    case "hook":
      return t("Claude Code is running a hook: {0}", w.name);
    case "mcp":
      return t("Claude Code is connecting the MCP server {0}", w.name);
    case "plugin":
      return t("Claude Code is installing the plugin {0}", w.name);
    default:
      return t("Claude Code is loading extensions: {0}", w.name);
  }
}

// ---------------------------------------------------------------- §36.8 CLI version

/** `session.cli` as this client reads it (each part checked); null without one. */
export type CliView = { version: string | null; verified: boolean; verifiedRange: CliVersionRange | null; previous: { version: string; path: string | null } | null };

export function cliInfoOf(s: Pick<Session, "cli">): CliView | null {
  const c = s.cli as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== "object") return null;
  const r = c.verifiedRange as Record<string, unknown> | null | undefined;
  const p = c.previous as Record<string, unknown> | null | undefined;
  return {
    version: typeof c.version === "string" && c.version ? c.version : null,
    verified: c.verified === true,
    verifiedRange: r && typeof r.min === "string" && typeof r.max === "string" ? { min: r.min, max: r.max } : null,
    previous: p && typeof p.version === "string" && p.version ? { version: p.version, path: typeof p.path === "string" && p.path ? p.path : null } : null,
  };
}

const PINNED = /[\\/]\.local[\\/]share[\\/]claude[\\/]versions[\\/](\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*?)?)(?:\.exe)?$/i;

/** The version `settings.claudePath` pins (a file of the native installer's versions folder); null for any other path. */
export function pinnedVersionOf(claudePath: string | null | undefined): string | null {
  return claudePath ? (PINNED.exec(claudePath.trim())?.[1] ?? null) : null;
}

/** The CLI banner: a new unverified version (once per version, closable), or a pin that waits for the next session start. */
export type CliBanner = { kind: "unverified"; version: string; range: CliVersionRange | null; previous: { version: string; path: string | null } | null } | { kind: "pinned"; version: string };

export function cliBannerOf(cli: CliView | null, dismissed: readonly string[], pinned: string | null): CliBanner | null {
  if (!cli?.version) return null;
  if (pinned && pinned !== cli.version && !dismissed.includes(`pin:${pinned}`)) return { kind: "pinned", version: pinned };
  if (cli.verified || dismissed.includes(cli.version)) return null;
  return { kind: "unverified", version: cli.version, range: cli.verifiedRange, previous: cli.previous };
}

const DISMISSED_KEY = "rg.cliBannerDismissed";
type KV = { getItem(key: string): string | null; setItem(key: string, value: string): void };
function defaultStorage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The versions whose banner the user closed (app-wide, so a version is announced once); newest last, ≤ 50. */
export function loadDismissedCliVersions(storage: KV | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const v: unknown = JSON.parse(storage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(-50) : [];
  } catch {
    return [];
  }
}

export function saveDismissedCliVersions(list: string[], storage: KV | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(DISMISSED_KEY, JSON.stringify(list.slice(-50)));
  } catch {
    /* private mode / quota: the banner may come back once */
  }
}

/** The `cli_version_changed` notice in words: its `cli`, else (a restored row) the engine's English sentence. */
export function cliChangeText(ev: { cli?: { from: string | null; to: string; verified: boolean }; message: string }): string {
  let change = ev.cli && typeof ev.cli.to === "string" ? ev.cli : null;
  if (!change) {
    const m = /changed from (\S+) to (\S+?)( \(not verified yet\))?\.?$/.exec(ev.message ?? "");
    if (m) change = { from: m[1]!, to: m[2]!, verified: !m[3] };
  }
  if (!change) return t("Claude Code was updated");
  const text = change.from ? t("Claude Code changed from {0} to {1}", change.from, change.to) : t("Claude Code {0} is in use", change.to);
  return change.verified ? text : `${text} ${t("(not verified yet)")}`;
}

/** Why "Retry with extensions" cannot run now (a start or a retry in flight, a turn / collection / revert), else null. */
export function extensionsRetryBlockedReason(o: { phase: string; starting: boolean; retrying: boolean }): string | null {
  if (o.retrying || o.starting) return t("The session is still starting…");
  if (o.phase === "running" || o.phase === "collecting" || o.phase === "reverting") return t("Wait for Claude to finish the turn");
  return null;
}

// ---------------------------------------------------------------- §36.9 other Claude sessions

export type CliSessionsView = {
  running: CliRunningSession[]; resumable: CliResumableSession[];
  // MARK: wave4d w4d-peers — §42.2: how the user's other sessions see this window; absent from older engines.
  self?: PeerSelf;
};

const STATUSES: ReadonlySet<CliSessionStatus> = new Set(["idle", "busy", "waiting", "unknown"]);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** A `cli_sessions` reply, each row checked (a row without its key fields is left out; an unknown status is `unknown`). */
export function cliSessionsOf(reply: unknown): CliSessionsView {
  const r = (reply ?? {}) as { running?: unknown; resumable?: unknown };
  const running: CliRunningSession[] = [];
  for (const raw of Array.isArray(r.running) ? r.running : []) {
    const x = raw as Record<string, unknown> | null;
    if (!x || typeof x.pid !== "number" || !Number.isFinite(x.pid) || typeof x.cwd !== "string" || !x.cwd) continue;
    running.push({
      pid: x.pid,
      sessionId: strOrNull(x.sessionId),
      name: strOrNull(x.name),
      cwd: x.cwd,
      status: STATUSES.has(x.status as CliSessionStatus) ? (x.status as CliSessionStatus) : "unknown",
      entrypoint: strOrNull(x.entrypoint),
      sameWorktree: x.sameWorktree === true,
    });
  }
  const resumable: CliResumableSession[] = [];
  for (const raw of Array.isArray(r.resumable) ? r.resumable : []) {
    const x = raw as Record<string, unknown> | null;
    if (!x || !strOrNull(x.sessionId)) continue;
    resumable.push({ sessionId: x.sessionId as string, title: typeof x.title === "string" ? x.title : "", updatedAt: typeof x.updatedAt === "string" ? x.updatedAt : "", cwd: strOrNull(x.cwd) });
  }
  const me = peerSelfOf((reply as { self?: unknown } | null | undefined)?.self); // MARK: wave4d w4d-peers
  return { running, resumable, ...(me ? { self: me } : {}) };
}

// MARK: wave4d w4d-peers
/** §42.2 `cli_sessions.self`, checked; null when absent or malformed. */
export function peerSelfOf(raw: unknown): PeerSelf | null {
  const x = raw as Record<string, unknown> | null | undefined;
  if (!x || typeof x !== "object" || typeof x.pid !== "number" || !Number.isFinite(x.pid)) return null;
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  return { pid: x.pid, name: s(x.name), address: s(x.address) };
}

/** "작업 중" / "입력 대기" / "쉬는 중". */
export function runningStatusLabel(status: CliSessionStatus): string {
  switch (status) {
    case "busy":
      return t("Working");
    case "waiting":
      return t("Waiting for input");
    case "idle":
      return t("Idle");
    default:
      return t("unknown");
  }
}

const STATUS_RANK: Record<CliSessionStatus, number> = { waiting: 0, busy: 1, idle: 2, unknown: 3 };

/** Waiting for input first (it needs the user), then working, idle, unknown; this folder first within a status. */
export function sortRunning(list: CliRunningSession[]): CliRunningSession[] {
  return [...list].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || Number(b.sameWorktree) - Number(a.sameWorktree) || a.pid - b.pid);
}

/** `cd <folder> && claude --resume <id>` for the user's terminal (the folder quoted when it needs it). */
export function terminalResumeCommand(folder: string, sessionId: string, platform: string): string {
  const id = /^[A-Za-z0-9-]+$/.test(sessionId) ? sessionId : `"${sessionId.replace(/"/g, "")}"`;
  if (platform === "win32") {
    const dir = /[\s&()^%!"]/.test(folder) ? `"${folder.replace(/"/g, "")}"` : folder;
    return `cd /d ${dir} && claude --resume ${id}`;
  }
  const dir = /^[A-Za-z0-9_./~+@:=-]+$/.test(folder) ? folder : `'${folder.replace(/'/g, "'\\''")}'`;
  return `cd ${dir} && claude --resume ${id}`;
}

/** `SessionMeta.imported` (the chat came from a terminal session; the review gate applies from `at` on). */
export function importedOf(meta: { imported?: unknown } | null | undefined): ImportedSession | null {
  const i = meta?.imported as { at?: unknown; cwd?: unknown } | null | undefined;
  if (!i || typeof i !== "object" || typeof i.at !== "string") return null;
  return { at: i.at, cwd: strOrNull(i.cwd) };
}
