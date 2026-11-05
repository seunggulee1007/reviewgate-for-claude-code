import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { samePath } from "../platform/paths.js";
import type { ChangedFile } from "../git/checkpoint.js";
import { isEffortLevel, isPeerInboundMode, isPermissionMode, type EffortLevel, type HeadInfo, type PeerInboundMode, type PermissionMode, type SessionCapabilities } from "../protocol.js";
import type { PreReviewRun } from "../protocol.js"; // MARK: wave3 engine-flow
import type { ReviewNote } from "./notes.js";
import { isRound, type HistoryRound } from "./history.js";
import { parsePersistedRanges, type PersistedRanges } from "./ranges.js";
import { cachedCommands } from "../session/commands.js"; // MARK: wave3 engine-session (§36.5)

/**
 * Review-gate persistence (audit 1.3): `<gitdir>/reviewgate-review.json` mirrors the gate after every
 * mutation and `refs/reviewgate/turn-start` / `turn-end` pin the A / B trees so `git gc` cannot prune
 * them. `open_project` restores the pending review from it; the file and refs go away once the review
 * is fully resolved. `<gitdir>/reviewgate-session.json` keeps the Claude session id for `resume`.
 */
export const REVIEW_FILE = "reviewgate-review.json";
export const SESSION_FILE = "reviewgate-session.json";
/**
 * Pre-namespace refs, shared by every worktree of the repository (the M10 audit's medium issue: two
 * workbenches overwrote each other's pins). Still read once by `restore()` and removed afterwards.
 */
export const REF_TURN_START = "refs/reviewgate/turn-start";
export const REF_TURN_END = "refs/reviewgate/turn-end";

/**
 * Per-worktree namespace under `refs/reviewgate/`: `main` for the main worktree, `wt-<name>` for a
 * linked one (`<common>/worktrees/<name>`). Not `refs/worktree/…`: those are per-worktree but
 * `git gc` in ANOTHER worktree does not treat them as roots and prunes the trees (git 2.50, verified),
 * whereas `refs/reviewgate/<ns>/…` lives in the shared ref store, so every gc keeps the trees.
 */
export function refNamespace(gitDir: string, commonDir: string): string {
  if (samePath(gitDir, commonDir)) return "main";
  const name = gitDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").replace(/\.lock$/, "_lock");
  return `wt-${safe || "x"}`;
}

/**
 * The `wt-*` namespaces among `refs` (`refs/reviewgate/<ns>/…`) whose worktree is gone: no
 * `<common>/worktrees/<name>` admin directory maps to them (`worktreeAdminDirs` = those names). `main`
 * and the pre-namespace refs are never stale.
 */
export function staleWorktreeNamespaces(refs: string[], worktreeAdminDirs: string[], commonDir: string): string[] {
  const live = new Set(worktreeAdminDirs.map((n) => refNamespace(join(commonDir, "worktrees", n), commonDir)));
  const seen = new Set<string>();
  for (const ref of refs) {
    const ns = ref.startsWith("refs/reviewgate/") ? ref.slice("refs/reviewgate/".length).split("/")[0] : undefined;
    if (ns && ns.startsWith("wt-") && ref.length > `refs/reviewgate/${ns}`.length && !live.has(ns)) seen.add(ns);
  }
  return [...seen].sort();
}

/** `refs/reviewgate/<ns>/` (see `refNamespace`). */
export function refPrefix(ns: string): string {
  return `refs/reviewgate/${ns}/`;
}

/** The A / B pins of the current review in namespace `ns`. */
export function turnRefs(ns: string): { start: string; end: string } {
  return { start: `${refPrefix(ns)}turn-start`, end: `${refPrefix(ns)}turn-end` };
}

/** The A / B pins of review-history entry `id` (docs/PROTOCOL.md §14). */
export function historyRefs(ns: string, id: string): { start: string; end: string } {
  return { start: `${refPrefix(ns)}history/${id}/start`, end: `${refPrefix(ns)}history/${id}/end` };
}
/** `<gitdir>/reviewgate/capabilities.json`: the last `session_info` capabilities, replayed by `open_project` (docs/M16-FRICTION.md). */
export const CAPABILITIES_FILE = join("reviewgate", "capabilities.json");

export type PersistedReview = {
  version: 1;
  turnStartTree: string | null;
  turnEndTree: string | null;
  changedFiles: ChangedFile[];
  reviewNotes: ReviewNote[];
  acceptedPatchHashes: Record<string, string>;
  acceptedPaths: string[];
  rejectedPaths: string[];
  /** Files `reject_hunks` partly reverted (docs/PROTOCOL.md §17); absent in older files. */
  partiallyRejectedPaths?: string[];
  lastReviewSummary: string | null;
  isRequestingChanges: boolean;
  /** A plain `send` was in flight over this review (docs/PROTOCOL.md §10): accepted files are re-verified on restore. */
  isAnsweringReview: boolean;
  lastUserText: string | null;
  sessionId: string | null;
  /** ISO-8601 */
  savedAt: string;
  /** The review-history round in progress (docs/PROTOCOL.md §14); absent in files written before it. */
  round?: HistoryRound | null;
  /** §31: HEAD when the review was saved (the restore compares it with HEAD then); absent in older files. */
  head?: HeadInfo | null;
  /** HEAD when A was snapshotted (`ReviewGate.followHead`); absent in older files. */
  baseHead?: HeadInfo | null;
  /** §46: the unfinished merge's `MERGE_HEAD` whose incoming side A holds (`ReviewGate.baseMerge`); absent in older files. */
  baseMerge?: string | null;
  /** §32: A / B include the mods paths; absent in files of older engines (the restore adds them to A first). */
  modsCaptured?: boolean;
  // MARK: wave2 engine-review
  /** §34.1: the range trees (turn base, request tree + `lastRequest`, per-file accepted trees, held B); absent in older files. */
  ranges?: PersistedRanges | null;
  // MARK: wave3 engine-flow
  /** §36.13: the review's AI pre-reviews (`gate.prereviews`; read back leniently by `restoreRuns`); absent in older files. */
  prereviews?: PreReviewRun[];
};

export type PersistedSession = { version: 1; sessionId: string; openTabIds?: string[]; permissionMode?: PermissionMode; model?: string | null; effort?: EffortLevel | null; peerInbound?: PeerInboundMode; savedAt: string };

/** The project's model / effort choice (`set_model`, §25) and peer mode (`peer_set`, §29); `undefined` = never chosen (the settings apply). */
export type SessionModelChoice = { model?: string | null; effort?: EffortLevel | null; peerInbound?: PeerInboundMode };

/** `reviewgate-session.json` as the engine reads it back: the current session id, the client's open tabs (M15) and the last permission mode (M20). */
export type SessionFileState = { sessionId: string | null; openTabIds: string[]; permissionMode: PermissionMode | null } & SessionModelChoice;

export function reviewFilePath(gitDir: string): string {
  return join(gitDir, REVIEW_FILE);
}

export function sessionFilePath(gitDir: string): string {
  return join(gitDir, SESSION_FILE);
}

/** temp + rename so a crash mid-write never leaves a torn file. */
export async function writeAtomicJSON(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value) + "\n", "utf8");
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function readJSON<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function saveReview(gitDir: string, review: PersistedReview): Promise<void> {
  return writeAtomicJSON(reviewFilePath(gitDir), review);
}

/** Parsed review file; null when missing, unparsable or of another version. */
export async function loadReview(gitDir: string): Promise<PersistedReview | null> {
  const o = await readJSON<Partial<PersistedReview>>(reviewFilePath(gitDir));
  if (!o || o.version !== 1 || !Array.isArray(o.changedFiles)) return null;
  return {
    version: 1,
    turnStartTree: typeof o.turnStartTree === "string" ? o.turnStartTree : null,
    turnEndTree: typeof o.turnEndTree === "string" ? o.turnEndTree : null,
    changedFiles: o.changedFiles,
    reviewNotes: Array.isArray(o.reviewNotes) ? o.reviewNotes : [],
    acceptedPatchHashes: o.acceptedPatchHashes && typeof o.acceptedPatchHashes === "object" ? o.acceptedPatchHashes : {},
    acceptedPaths: Array.isArray(o.acceptedPaths) ? o.acceptedPaths : [],
    rejectedPaths: Array.isArray(o.rejectedPaths) ? o.rejectedPaths : [],
    partiallyRejectedPaths: Array.isArray(o.partiallyRejectedPaths) ? o.partiallyRejectedPaths : [],
    lastReviewSummary: typeof o.lastReviewSummary === "string" ? o.lastReviewSummary : null,
    isRequestingChanges: o.isRequestingChanges === true,
    isAnsweringReview: o.isAnsweringReview === true,
    lastUserText: typeof o.lastUserText === "string" ? o.lastUserText : null,
    sessionId: typeof o.sessionId === "string" ? o.sessionId : null,
    savedAt: typeof o.savedAt === "string" ? o.savedAt : "",
    round: isRound(o.round) ? o.round : null,
    head: isHeadInfo(o.head) ? { sha: o.head.sha, branch: o.head.branch } : null,
    baseHead: isHeadInfo(o.baseHead) ? { sha: o.baseHead.sha, branch: o.baseHead.branch } : null,
    baseMerge: typeof o.baseMerge === "string" ? o.baseMerge : null,
    modsCaptured: o.modsCaptured === true,
    ranges: parsePersistedRanges(o.ranges),
    ...(Array.isArray(o.prereviews) ? { prereviews: o.prereviews } : {}), // MARK: wave3 engine-flow (validated by the gate's restore)
  };
}

function isHeadInfo(v: unknown): v is HeadInfo {
  const h = v as HeadInfo | null;
  return !!h && typeof h === "object" && (h.sha === null || typeof h.sha === "string") && (h.branch === null || typeof h.branch === "string");
}

export async function clearReview(gitDir: string): Promise<void> {
  await rm(reviewFilePath(gitDir), { force: true }).catch(() => undefined);
}

export function saveSession(gitDir: string, sessionId: string, openTabIds: string[] = [], permissionMode: PermissionMode = "default", choice: SessionModelChoice = {}): Promise<void> {
  const value: PersistedSession = {
    version: 1,
    sessionId,
    openTabIds: [...openTabIds],
    permissionMode,
    ...(choice.model !== undefined ? { model: choice.model } : {}),
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}),
    ...(choice.peerInbound !== undefined ? { peerInbound: choice.peerInbound } : {}),
    savedAt: new Date().toISOString(),
  };
  return writeAtomicJSON(sessionFilePath(gitDir), value);
}

export async function loadSession(gitDir: string): Promise<string | null> {
  return (await loadSessionState(gitDir)).sessionId;
}

/** The session file with its M15 fields; `{sessionId: null, openTabIds: []}` when missing or unparsable. */
export async function loadSessionState(gitDir: string): Promise<SessionFileState> {
  const o = await readJSON<Partial<PersistedSession>>(sessionFilePath(gitDir));
  if (!o || o.version !== 1) return { sessionId: null, openTabIds: [], permissionMode: null };
  return {
    sessionId: typeof o.sessionId === "string" && o.sessionId ? o.sessionId : null,
    openTabIds: Array.isArray(o.openTabIds) ? o.openTabIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [],
    // `plan` is restored as-is: the user may have deliberately parked the project in plan mode (docs/M20-MODES.md).
    permissionMode: isPermissionMode(o.permissionMode) ? o.permissionMode : null,
    ...(o.model === null || (typeof o.model === "string" && o.model) ? { model: o.model } : {}),
    ...(o.effort === null || isEffortLevel(o.effort) ? { effort: o.effort } : {}),
    ...(isPeerInboundMode(o.peerInbound) ? { peerInbound: o.peerInbound } : {}),
  };
}

/**
 * §11: the permission mode the repository's other worktrees ran in last, for a worktree without a mode of its own (a new
 * workbench): the most recently saved `reviewgate-session.json` of the main worktree (`<common>/`) and the linked ones
 * (`<common>/worktrees/<name>/`), this worktree's own and plan mode left out. Null when no other worktree has one.
 */
export async function siblingWorktreeMode(gitDir: string, commonDir: string): Promise<PermissionMode | null> {
  const real = (p: string): Promise<string> => realpath(p).catch(() => p);
  const own = await real(gitDir);
  const dirs = [commonDir];
  try {
    for (const name of await readdir(join(commonDir, "worktrees"))) dirs.push(join(commonDir, "worktrees", name));
  } catch {
    // no linked worktree
  }
  let best: { mode: PermissionMode; at: number } | null = null;
  for (const dir of dirs) {
    if (samePath(await real(dir), own)) continue;
    const o = await readJSON<Partial<PersistedSession>>(sessionFilePath(dir));
    if (!o || o.version !== 1 || !isPermissionMode(o.permissionMode) || o.permissionMode === "plan") continue;
    const at = typeof o.savedAt === "string" ? Date.parse(o.savedAt) : Number.NaN;
    const t = Number.isFinite(at) ? at : 0;
    if (!best || t > best.at) best = { mode: o.permissionMode, at: t };
  }
  return best?.mode ?? null;
}

export async function clearSession(gitDir: string): Promise<void> {
  await rm(sessionFilePath(gitDir), { force: true }).catch(() => undefined);
}

export type PersistedCapabilities = { version: 1; capabilities: SessionCapabilities; savedAt: string };

export function capabilitiesFilePath(gitDir: string): string {
  return join(gitDir, CAPABILITIES_FILE);
}

export async function saveCapabilities(gitDir: string, capabilities: SessionCapabilities): Promise<void> {
  const path = capabilitiesFilePath(gitDir);
  await mkdir(dirname(path), { recursive: true });
  // MARK: wave3 engine-session — §36.5: `state` belongs to the live session, never to the cache.
  const { state: _state, ...kept } = capabilities;
  const value: PersistedCapabilities = { version: 1, capabilities: kept, savedAt: new Date().toISOString() };
  await writeAtomicJSON(path, value);
}

/** The cached capabilities, or null when missing / unparsable / of another version. */
export async function loadCapabilities(gitDir: string): Promise<SessionCapabilities | null> {
  const o = await readJSON<Partial<PersistedCapabilities>>(capabilitiesFilePath(gitDir));
  const c = o?.version === 1 ? o.capabilities : undefined;
  if (!c || !Array.isArray(c.slashCommands) || !Array.isArray(c.skills) || !Array.isArray(c.plugins) || !Array.isArray(c.mcpServers)) return null;
  return {
    slashCommands: [...c.slashCommands],
    skills: [...c.skills],
    plugins: [...c.plugins],
    mcpServers: c.mcpServers.map((m) => ({ ...m })),
    ...(Array.isArray(c.pluginDetails) ? { pluginDetails: c.pluginDetails.map((p) => ({ ...p })) } : {}),
    // MARK: wave3 engine-session — §36.5
    ...optionalCommands(c.commands),
  };
}

/** MARK: wave3 engine-session — §36.5: the cached commands, re-validated (absent in caches written before them). */
function optionalCommands(raw: unknown): Pick<SessionCapabilities, "commands"> {
  const commands = cachedCommands(raw);
  return commands ? { commands } : {};
}
