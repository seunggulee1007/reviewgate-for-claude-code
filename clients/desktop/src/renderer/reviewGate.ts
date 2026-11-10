/**
 * Review provenance, mods files and the gate notices of docs/PROTOCOL.md §31–32 as pure helpers (unit-tested in
 * reviewGate.test.ts): who changed a file (`origin`), the Changes list groups (settings & hooks · Claude · outside the
 * app), what "Reject all" reverts, the stale-review sheet, the banner texts and which banners the user already dismissed.
 * Unknown wire values never throw: an unknown origin is neutral, an unknown mods risk or nested kind gets a generic label.
 */
import type { ChangedFileState, ConcurrentClaude, GateState, HeadInfo, HeadMove, LocalSettingsChange, NestedChange, SkippedPath, StaleReview } from "@reviewgate/engine";
import { relativeTime, t } from "./i18n";
import type { RejectCommand } from "./rejectFlow";

// ---------------------------------------------------------------- origin (§31.1)

/** `other`: an origin this client does not know (a newer engine) or none at all (an engine before §31). */
export type Origin = "tool" | "bash" | "skill" | "external" | "other";

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * The engine's `origin`. Without one (an engine before §31) a file only Bash touched still reads as Bash, but nothing is
 * called "outside the app": that engine's `reject_all` reverts every file, so the list must not promise otherwise.
 */
export function originOf(f: { origin?: string | null; tools?: readonly string[] }): Origin {
  switch (f.origin) {
    case "tool":
    case "bash":
    case "skill": // MARK: r2-skills-side (§31.1, M35): a skill's own work — reverted by "Reject all" with Claude's
    case "external":
      return f.origin;
  }
  if (f.origin == null && f.tools?.includes("Bash") && !f.tools.some((x) => EDIT_TOOLS.has(x) || x.startsWith("mcp__"))) return "bash";
  return "other";
}

/**
 * MARK: r2-skills-side — §31.1 (M35): the slash command a cause id names (`skill:acme-verify` → `acme-verify`: what its
 * !`command` lines changed while Claude Code loaded it — no tool call, so no transcript row), else null. A `Skill` call's
 * cause is its own tool_use id.
 */
export function commandOfCause(id: string): string | null {
  return id.startsWith("skill:") && id.length > "skill:".length ? id.slice("skill:".length) : null;
}

/** Changed by nothing of Claude's: the IDE, another Claude session, a `git pull`, work done while the app was closed. */
export const isExternalChange = (f: { origin?: string | null; tools?: readonly string[] }): boolean => originOf(f) === "external";

/** Pending files changed outside the app — what "Reject all" leaves (`gate.externalPendingCount`; else counted from the list). */
export function externalPendingOf(s: { gate: Pick<GateState, "externalPendingCount">; changedFiles: readonly ChangedFileState[] }): number {
  const n = s.gate.externalPendingCount;
  if (typeof n === "number" && n >= 0) return n;
  return s.changedFiles.filter((f) => f.state === "pending" && isExternalChange(f)).length;
}

/** How many of `files` (live or `turn_summary` files) were changed outside the app. */
export const externalCountOf = (files: readonly { origin?: string | null }[]): number => files.filter((f) => isExternalChange(f)).length;

// ---------------------------------------------------------------- Changes list groups (§31.2, §32.1)

export type ChangeGroupKind = "mods" | "claude" | "external";
export type ChangeGroup = { kind: ChangeGroupKind; files: ChangedFileState[]; pending: number };

/** `.claude/**`, `.mcp.json`, `CLAUDE*.md`, `settings.local.json`: files that change how Claude Code itself behaves. */
export const isModsFile = (f: { group?: string | null }): boolean => f.group === "mods";

/** Settings & hooks first (whoever changed them), then Claude's changes, then the outside ones; empty groups are left out. */
export function groupChanges(files: readonly ChangedFileState[]): ChangeGroup[] {
  const by: Record<ChangeGroupKind, ChangedFileState[]> = { mods: [], claude: [], external: [] };
  for (const f of files) by[isModsFile(f) ? "mods" : isExternalChange(f) ? "external" : "claude"].push(f);
  return (["mods", "claude", "external"] as const)
    .filter((kind) => by[kind].length > 0)
    .map((kind) => ({ kind, files: by[kind], pending: by[kind].filter((f) => f.state === "pending").length }));
}

/** Group headers only when they tell something: a list of Claude's changes alone stays as it always was. */
export const showsGroupHeaders = (groups: readonly ChangeGroup[]): boolean => !(groups.length === 1 && groups[0]!.kind === "claude");

export function groupLabel(kind: ChangeGroupKind): string {
  switch (kind) {
    case "mods":
      return t("Settings & hooks (changes how Claude works)");
    case "claude":
      return t("Claude's changes");
    case "external":
      return t("Outside changes");
  }
}

export function groupHelp(kind: ChangeGroupKind): string {
  switch (kind) {
    case "mods":
      return t("Claude Code settings, hooks, MCP servers and CLAUDE.md — reviewed even when .gitignore hides them");
    case "claude":
      return t("Files Claude's edit tools or commands changed");
    case "external":
      return t("Not changed by a Claude tool — it may be the IDE, another session or a git pull. Reject all leaves these as they are.");
  }
}

// ---------------------------------------------------------------- mods files (§32.1)

const MODS_RISK_ORDER = ["hook", "script", "mcp", "permissions", "env"];

/** `risk` deduplicated, known risks in a fixed order, unknown ones kept (shown with a generic label). */
export function modsRisksOf(f: { risk?: readonly string[] | null }): string[] {
  const set = new Set(Array.isArray(f.risk) ? f.risk.filter((r): r is string => typeof r === "string" && r.length > 0) : []);
  return [...MODS_RISK_ORDER.filter((r) => set.has(r)), ...[...set].filter((r) => !MODS_RISK_ORDER.includes(r))];
}

export function modsRiskLabel(risk: string): string {
  switch (risk) {
    case "hook":
      return t("Hook — runs automatically from the next prompt");
    case "script":
      return t("Executable script");
    case "mcp":
      return t("MCP server");
    case "permissions":
      return t("Permission rules");
    case "env":
      return t("Environment variables");
    default:
      return t("Other risk ({0})", risk);
  }
}

export function modsRiskHelp(risk: string): string {
  switch (risk) {
    case "hook":
      return t("A hook definition changed — it runs by itself in every session of this project from the next prompt");
    case "script":
      return t("A script under .claude/ — hooks and commands may run it");
    case "mcp":
      return t("MCP server settings — which servers Claude Code starts and trusts");
    case "permissions":
      return t("Permission rules — what Claude may do without asking");
    case "env":
      return t("Environment variables / apiKeyHelper — what every command runs with");
    default:
      return t("A change the engine flagged as risky");
  }
}

/** Why an `uncaptured` file cannot be reverted: unreadable for git (left out of the snapshot), else too large / binary. */
export function uncapturedText(f: Pick<ChangedFileState, "path">, gate: Pick<GateState, "snapshotSkipped">): string {
  if ((gate.snapshotSkipped ?? []).some((s) => s.path === f.path)) return t("Unreadable — left out of the snapshot, cannot be reverted");
  return t("Content not captured (large file / binary) — cannot be reverted");
}

// ---------------------------------------------------------------- Reject all (M3, §31.2)

export type RejectAllPlan = {
  /** What to send — `reject_all` (`includeExternal` when asked), or `reject {paths}` when uncaptured files must stay out; null: nothing to revert. */
  cmd: RejectCommand | null;
  /** The pending files that will be reverted. */
  revert: ChangedFileState[];
  /** Pending outside changes left as they are (without `includeExternal`). */
  keptExternal: ChangedFileState[];
  /** Pending files whose content was not captured (§32): never revertible, so they stay. */
  uncaptured: ChangedFileState[];
  /** Outside changes that will be reverted — the second confirm lists them. */
  external: ChangedFileState[];
};

/**
 * Mirrors the engine's `rejectAllPaths` (pending files, outside ones only with `includeExternal`). The engine refuses
 * the whole batch with `not_captured` when an uncaptured file is in it, so then the rest goes out as `reject {paths}`.
 */
export function planRejectAll(files: readonly ChangedFileState[], includeExternal: boolean): RejectAllPlan {
  const pending = files.filter((f) => f.state === "pending");
  const targets = pending.filter((f) => includeExternal || !isExternalChange(f));
  const uncaptured = targets.filter((f) => f.uncaptured === true);
  const revert = targets.filter((f) => f.uncaptured !== true);
  const cmd: RejectCommand | null =
    revert.length === 0 ? null : uncaptured.length > 0 ? { type: "reject", paths: revert.map((f) => f.path) } : { type: "reject_all", ...(includeExternal ? { includeExternal: true as const } : {}) };
  return {
    cmd,
    revert,
    keptExternal: includeExternal ? [] : pending.filter((f) => isExternalChange(f)),
    uncaptured,
    external: includeExternal ? revert.filter((f) => isExternalChange(f)) : [],
  };
}

// ---------------------------------------------------------------- commit sheet (§32.1 ignored)

/** The commit checklist without gitignored files (the engine leaves them out of `acceptedPaths` too); `ignored`: the accepted ones left out. */
export function commitPaths(acceptedPaths: readonly string[], files: readonly ChangedFileState[]): { paths: string[]; ignored: string[] } {
  const ignored = files.filter((f) => f.ignored === true && f.state === "accepted").map((f) => f.path);
  const skip = new Set(files.filter((f) => f.ignored === true).map((f) => f.path));
  return { paths: acceptedPaths.filter((p) => !skip.has(p)), ignored };
}

// ---------------------------------------------------------------- stale review / finish_review (§31.5)

/** `main@1a2b3c4`; a detached HEAD, an unborn branch and an unknown HEAD in words. */
export function headLabel(h: HeadInfo | null | undefined): string {
  if (!h) return t("unknown");
  const branch = h.branch ?? t("detached");
  return h.sha ? `${branch}@${h.sha.slice(0, 7)}` : t("{0} (no commit)", branch);
}

/** The stale sheet's lines: when it was saved, then why it is stale (unknown reasons skipped) and what came in meanwhile. */
export function staleLines(stale: StaleReview, rel: (iso: string) => string = relativeTime): string[] {
  const reasons: readonly string[] = Array.isArray(stale.reasons) ? stale.reasons : [];
  const lines = [t("Saved {0}", rel(stale.savedAt))];
  if (reasons.includes("head_moved")) lines.push(t("HEAD has moved since: {0} → {1}", headLabel(stale.savedHead), headLabel(stale.head)));
  if (reasons.includes("old")) lines.push(t("More than 12 hours have passed"));
  if (stale.externalFiles > 0) lines.push(t("{0} change(s) made outside the app are mixed in", stale.externalFiles));
  return lines;
}

/** Identifies one stale review (project + save time): its sheet opens once, not on every snapshot. */
export function staleSheetKey(s: { project: { root: string } | null; gate: Pick<GateState, "stale"> }): string | null {
  const stale = s.gate.stale ?? null;
  return stale ? `${s.project?.root ?? ""}\u0000${stale.savedAt}` : null;
}

/** "리뷰 끝내기" is off while a turn / collection / revert runs (or a failed collection waits for Retry) and with nothing to finish. */
export function finishReviewBlocked(s: { gate: Pick<GateState, "phase">; changedFiles: readonly unknown[]; reviewNotes: readonly unknown[] }): "busy" | "empty" | null {
  if (["running", "collecting", "reverting", "collect_failed"].includes(s.gate.phase)) return "busy";
  if (s.changedFiles.length === 0 && s.reviewNotes.length === 0) return "empty";
  return null;
}

/** The "review restored" banner stays (no auto-hide) while the review is stale or outside changes came in with it. */
export function restoredNotice(s: { gate: Pick<GateState, "stale" | "externalPendingCount">; changedFiles: readonly ChangedFileState[] }): { external: number; stale: boolean; sticky: boolean } {
  const external = externalPendingOf(s);
  const stale = (s.gate.stale ?? null) !== null;
  return { external, stale, sticky: stale || external > 0 };
}

// ---------------------------------------------------------------- banners (§31.3, §31.4, §32)

export function headMovedText(m: HeadMove): string {
  return t("The branch / commit changed during this turn ({0} → {1}). That difference is shown as outside changes.", headLabel(m.from), headLabel(m.to));
}

/** One live CLI process: its pid with the start time, so a reused pid counts as a new session. */
export const concurrentKey = (c: Pick<ConcurrentClaude, "pid" | "startedAt">): string => `${c.pid}@${c.startedAt ?? ""}`;

/** `acme-b4 (터미널)` / `pid 4242 (앱/SDK)`. */
export function concurrentWho(c: ConcurrentClaude): string {
  const name = c.name?.trim() || t("pid {0}", c.pid);
  return c.entrypoint === "cli" ? t("{0} (terminal)", name) : t("{0} (app / SDK)", name);
}

export function concurrentText(sessions: readonly ConcurrentClaude[]): string {
  const shown = sessions.slice(0, 3).map(concurrentWho).join(", ");
  const who = sessions.length > 3 ? `${shown} ${t("and {0} more", sessions.length - 3)}` : shown;
  return t("Another Claude session is running in this worktree: {0} — its edits mix in as outside changes. Split the work into a workbench.", who);
}

export function localSettingsText(c: LocalSettingsChange): string {
  const parts = [c.hooks && t("hooks"), c.permissions && t("permissions"), c.env && t("environment variables"), c.mcp && "MCP"].filter((p): p is string => typeof p === "string");
  return parts.length > 0
    ? t("{0} changed ({1}) — it may hold secrets, so its content is not kept and it cannot be reverted.", c.path, parts.join(" · "))
    : t("{0} changed — it may hold secrets, so its content is not kept and it cannot be reverted.", c.path);
}

/** §33.5: changed allow rules can reach the next session's lookup / read tools. */
export function localSettingsHint(c: LocalSettingsChange): string | null {
  return c.permissions ? t("Changed allow rules may apply to lookup / read tools from the next session (check them in Settings > Permissions > Terminal (Claude Code) allow rules).") : null;
}

export function nestedKindLabel(kind: string): string {
  switch (kind) {
    case "worktree":
      return t("worktree");
    case "submodule":
      return t("submodule");
    default:
      return t("nested repository");
  }
}

export function nestedText(n: NestedChange): string {
  const kind = nestedKindLabel(n.kind) + (n.branch ? ` · ${n.branch}` : "");
  const touched = Array.isArray(n.touchedFiles) ? n.touchedFiles.length : 0;
  const count = touched > 0 ? touched : n.dirtyFiles;
  const what = typeof count === "number" && count > 0 ? `${kind}, ${t("{0} file(s)", count)}` : kind;
  return t("Outside the review — {0} ({1}): not reviewed in this window", n.path, what);
}

export function nestedDetails(n: NestedChange): string[] {
  const out: string[] = [];
  if (n.head) out.push(`HEAD ${n.head.from.slice(0, 7)} → ${n.head.to.slice(0, 7)}`);
  if (n.dirtyFiles === null) out.push(t("Status check timed out"));
  return out;
}

export function skippedText(skipped: readonly SkippedPath[], max = 3): string {
  const paths = skipped.map((s) => s.path);
  const shown = paths.slice(0, max).join(", ");
  return t("{0} unreadable file(s) were left out of this review: {1}", paths.length, paths.length > max ? `${shown} ${t("and {0} more", paths.length - max)}` : shown);
}

/** Appends `paths` to the ignore-pattern lines (one per line), skipping ones already there (with or without a leading `/`). */
export function addIgnorePatternLines(current: string, paths: readonly string[]): { text: string; added: string[] } {
  const lines = current.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const have = new Set(lines.map((l) => l.replace(/^\//, "")));
  const added: string[] = [];
  for (const p of paths) {
    if (p.length === 0 || /[\r\n]/.test(p) || have.has(p.replace(/^\//, ""))) continue;
    have.add(p.replace(/^\//, ""));
    added.push(p);
  }
  return { text: [...lines, ...added].join("\n"), added };
}

/** A repo-relative (POSIX) path on the native root — `sep` is the OS separator (`window.rg.sep`). */
export function joinRoot(root: string, rel: string, sep: string): string {
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}

// ---------------------------------------------------------------- dismissed notices

export type GateNoticeKind = "headMoved" | "localSettings" | "nested" | "skipped";
const NOTICE_KINDS: readonly GateNoticeKind[] = ["headMoved", "localSettings", "nested", "skipped"];

/**
 * What the user closed: `dismissed` holds the notice's value at that moment (forgotten once the engine clears it or the
 * next turn starts — the next occurrence shows again); `concurrent` the sessions (`concurrentKey`) already shown, kept for
 * the window's lifetime because `concurrent_claude` is re-sent on every send.
 */
export type GateNoticeMemory = { dismissed: Partial<Record<GateNoticeKind, string>>; concurrent: string[] };
export const EMPTY_GATE_NOTICES: GateNoticeMemory = { dismissed: {}, concurrent: [] };

type NoticeGate = Partial<Pick<GateState, "headMoved" | "localSettingsChanged" | "nestedChanges" | "snapshotSkipped" | "concurrentClaude" | "phase">>;

/** The notice's current value as a key, null when there is nothing to show. */
export function gateNoticeKey(kind: GateNoticeKind, gate: NoticeGate): string | null {
  switch (kind) {
    case "headMoved":
      // MARK: r1-git — §31.3: a move Claude's own git commands made is a chat row, never this banner.
      return gate.headMoved && gate.headMoved.explainedBy !== "claude_git" ? JSON.stringify(gate.headMoved) : null;
    case "localSettings":
      return gate.localSettingsChanged ? JSON.stringify(gate.localSettingsChanged) : null;
    case "nested":
      return gate.nestedChanges && gate.nestedChanges.length > 0 ? JSON.stringify(gate.nestedChanges) : null;
    case "skipped":
      return gate.snapshotSkipped && gate.snapshotSkipped.length > 0 ? JSON.stringify(gate.snapshotSkipped) : null;
  }
}

export function isGateNoticeShown(kind: GateNoticeKind, gate: NoticeGate, mem: GateNoticeMemory): boolean {
  const key = gateNoticeKey(kind, gate);
  return key !== null && mem.dismissed[kind] !== key;
}

export function dismissGateNotice(mem: GateNoticeMemory, kind: GateNoticeKind, gate: NoticeGate): GateNoticeMemory {
  const key = gateNoticeKey(kind, gate);
  return key === null || mem.dismissed[kind] === key ? mem : { ...mem, dismissed: { ...mem.dismissed, [kind]: key } };
}

/** Some session in `concurrentClaude` was not shown and closed before (the same pids re-sent on every send stay hidden). */
export function isConcurrentShown(gate: NoticeGate, mem: GateNoticeMemory): boolean {
  return (gate.concurrentClaude ?? []).some((c) => !mem.concurrent.includes(concurrentKey(c)));
}

export function dismissConcurrent(mem: GateNoticeMemory, gate: NoticeGate): GateNoticeMemory {
  const keys = (gate.concurrentClaude ?? []).map(concurrentKey).filter((k) => !mem.concurrent.includes(k));
  return keys.length === 0 ? mem : { ...mem, concurrent: [...mem.concurrent, ...keys] };
}

/** Called for every new gate: a started turn (or the notice gone) forgets its dismissal. Unchanged memory keeps its identity. */
export function carryGateNotices(mem: GateNoticeMemory, prev: NoticeGate, next: NoticeGate): GateNoticeMemory {
  const turnStarted = next.phase === "running" && prev.phase !== "running";
  let dismissed: Partial<Record<GateNoticeKind, string>> | null = null;
  for (const kind of NOTICE_KINDS) {
    if (mem.dismissed[kind] === undefined) continue;
    // wave2 check-clients: the same unreadable files are skipped at every turn's snapshot (the engine empties the list when
    // a turn starts and fills it again) — closed once stays closed, as on the Mac; another set has another key.
    if (kind === "skipped") continue;
    if (!turnStarted && gateNoticeKey(kind, next) !== null) continue;
    dismissed ??= { ...mem.dismissed };
    delete dismissed[kind];
  }
  return dismissed ? { ...mem, dismissed } : mem;
}

// ---------------------------------------------------------------- notifications

/**
 * The background notification of a finished turn: Claude's files to review, outside changes counted apart — the
 * badge rule `pending − external` (the desktop badge counts unseen notifications, so it is applied to what they say).
 * wave4b w4-notify: the Mac's "리뷰할 파일 3개" / "리뷰할 파일 없음"; the headline ("작업이 끝났어요", a stop reason) is the caller's.
 */
export function turnDoneBody(ev: { files: number; external?: number }): string {
  const external = Math.max(0, Math.min(ev.files, ev.external ?? 0));
  const mine = ev.files - external;
  const body = mine > 0 ? t("{0} file(s) to review", mine) : t("No files to review");
  return external > 0 ? `${body} · ${t("{0} outside change(s) included", external)}` : body;
}
