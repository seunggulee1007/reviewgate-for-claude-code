/**
 * How the window treats an `error` beyond its words (docs/PROTOCOL.md §29, §30, §33.4; audit M4) — pure, unit-tested:
 * which ones are notices (information / warning, never a red failure), which ones stop the message queue, how repeats of
 * the same failure merge into one transcript row ("×N · last time", live and restored alike), and which actions the
 * session banner offers, first one first.
 */
import type { ErrorScope } from "@reviewgate/engine";
import { needsAction } from "./attention";
import { presentationOf } from "./errorCodes";
import { currentLanguage, t } from "./i18n";
import type { ChatItem } from "./store";
import { hidesSubline, isWarningRow } from "./longWork"; // MARK: wave4 w4-longwork
import { isAutoModeRow } from "./autoMode"; // MARK: wave4b w4b-auto

/** What an `error` event says besides its text (engine `ErrorDetails`, §30 / §33.4) — kept on the banner and the row. */
export type ErrorFacts = {
  code?: string;
  /** §30: the CLI's own words (`error.detail`: its first stderr line, same text for the same failure). */
  cliDetail?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** §30: the chat a resume notice is about (`resume_not_found` / `resume_failed`). */
  sessionId?: string;
  /** §33.4: the tool, the folder and the branch of a worktree notice. */
  toolName?: string;
  path?: string;
  branch?: string;
  /** MARK: r1-scope — §33.4: what a command changed in `path` (`worktree_outside_review`, relative to it). */
  files?: string[];
};

export type ErrorTone = "fatal" | "error" | "warning" | "info";

/** fatal → red; a notice → blue (information) or orange (warning); any other failure → the usual orange banner / red row. */
export function errorTone(code: string | undefined, fatal: boolean): ErrorTone {
  if (!fatal && isWarningRow(code)) return "warning"; // MARK: wave4 w4-longwork — §38.2 an orange row without a banner
  const p = presentationOf(code);
  if (p === "info" || p === "row") return "info"; // wave3 desktop-session — §36.8 the CLI version notice
  if (p === "warning") return "warning";
  if (fatal || p === "fatalSession") return "fatal";
  return "error";
}

/**
 * §2.9: a notice never stops the queue (`resume_*`, `worktree_*`, `peer_release_failed`, the §29 fallback's
 * `unprompted_blocked`, the hints) — a failure does: fatal session errors, `lfs_missing`, `send_failed`, `collect_failed`, ….
 */
export function pausesQueue(ev: { fatal: boolean; code?: string }): boolean {
  const p = presentationOf(ev.code);
  if (p === "info" || p === "warning") return false;
  return ev.fatal || needsAction(ev) || p === "banner";
}

/** Reasons a `send` is refused for a moment only — another session's turn (§29), a turn that just started, …. */
const TRANSIENT_GATE = new Set(["external_turn", "running", "starting", "collecting", "awaiting_permission", "reverting"]);

/** A plain send refused this way waits in the queue (front) instead of being dropped with a banner. */
export function requeuesSend(r: { code: string; detail: string }): boolean {
  return r.code === "gate_closed" && TRANSIENT_GATE.has(r.detail);
}

/** The `error` event's facts in the shape the window keeps (only the fields it carries). */
export function factsOf(ev: {
  code?: string;
  detail?: string;
  exitCode?: number | null;
  signal?: string | null;
  sessionId?: string;
  toolName?: string;
  path?: string;
  branch?: string;
  files?: string[];
}): ErrorFacts {
  return {
    ...(ev.code ? { code: ev.code } : {}),
    ...(ev.detail ? { cliDetail: ev.detail } : {}),
    ...(typeof ev.exitCode === "number" ? { exitCode: ev.exitCode } : {}),
    ...(typeof ev.signal === "string" && ev.signal ? { signal: ev.signal } : {}),
    ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
    ...(ev.toolName ? { toolName: ev.toolName } : {}),
    ...(ev.path ? { path: ev.path } : {}),
    ...(ev.branch ? { branch: ev.branch } : {}),
    ...(Array.isArray(ev.files) && ev.files.length > 0 ? { files: ev.files.filter((f): f is string => typeof f === "string") } : {}), // MARK: r1-scope
  };
}

/**
 * A restored `kind: "error"` row's facts, so it reads like the live banner did and two different notices never merge into
 * one ×N row. §35.3: the row keeps the event's details (tool / folder / branch, exit code / signal, the chat) — they come
 * first; a row written before that has only `{message, code, detail}`, and its §33.4 tool / branch / folder are read back
 * from the engine's English text (engine/src/session/reviewScope.ts `scopeNoticeMessage`; wave2 check-clients, the Mac's
 * `SessionNotices.restoredDetail`). Text in another shape keeps the facts the row has.
 */
export function restoredErrorFacts(item: {
  code?: string;
  detail?: string;
  message: string;
  exitCode?: number | null;
  signal?: string | null;
  sessionId?: string;
  toolName?: string;
  path?: string;
  branch?: string;
  files?: string[];
}): ErrorFacts {
  const facts = factsOf(item);
  if (facts.toolName !== undefined) return facts;
  if (item.code === "worktree_blocked") {
    const enter = /^Claude tried to work in a git worktree(?: \("([^"]*)"\))?;/.exec(item.message);
    if (enter) return { ...facts, toolName: "EnterWorktree", ...(enter[1] ? { branch: enter[1] } : {}) };
    const tool = /^Claude tried to work in (\S+) outside this folder;/.exec(item.message);
    if (tool) return { ...facts, toolName: tool[1]! };
  } else if (item.code === "worktree_outside_review") {
    const ran = /^(\S+) worked outside this window's review(?: \((.+?)\))?:/.exec(item.message);
    if (ran) return { ...facts, toolName: ran[1]!, ...(ran[2] ? { path: ran[2] } : {}) };
  }
  return facts;
}

/** §2.6: repeats merge on `code` + the CLI's words, else `code` + the text (§30 "clients merge repeats on code + detail"). */
export function errorKey(message: string, facts: ErrorFacts | undefined): string {
  // r1-scope (§33.4): two rows naming other files never fold into one ×N.
  return `${facts?.code ?? ""}\u0000${facts?.cliDetail ?? message}${facts?.files ? `\u0000${facts.files.join("\n")}` : ""}`;
}

export type ErrorRow = Extract<ChatItem, { kind: "error" }>;

/**
 * Appends `row` — or, when the last row (past trailing turn-end lines) is the same error, counts it there instead:
 * no new row, only "×N" and the last time change. `row` is the row now on screen (the merged one or the new one).
 */
export function appendErrorRow(items: ChatItem[], row: ErrorRow): { items: ChatItem[]; row: ErrorRow } {
  let i = items.length - 1;
  while (i >= 0 && items[i]!.kind === "turnEnd") i--;
  const prev = i >= 0 ? items[i] : undefined;
  if (prev && prev.kind === "error" && errorKey(prev.message, prev.facts) === errorKey(row.message, row.facts)) {
    const merged: ErrorRow = {
      ...prev,
      fatal: row.fatal,
      count: (prev.count ?? 1) + (row.count ?? 1),
      ...(row.lastAt !== undefined ? { lastAt: row.lastAt } : {}),
      facts: { ...prev.facts, ...row.facts },
    };
    const next = [...items];
    next[i] = merged;
    return { items: next, row: merged };
  }
  return { items: [...items, row], row };
}

/** "· exit code 1" / "· signal SIGKILL" after the CLI's words: the second line of a session banner and row. */
export function errorSubline(facts: ErrorFacts | undefined): string {
  if (!facts) return "";
  if (hidesSubline(facts.code)) return ""; // MARK: wave4 w4-longwork — §38.2 the CLI's words are the row itself
  if (isAutoModeRow(facts.code)) return ""; // MARK: wave4b w4b-auto — §39.5 the row names the call and the reason
  if (facts.code === "hook_blocked" && typeof facts.exitCode === "number") return ""; // MARK: wave4b w4b-check4 — §40.1 the row names the hook and the reason
  const how = typeof facts.exitCode === "number" ? t("exit code {0}", facts.exitCode) : facts.signal ? t("signal {0}", facts.signal) : "";
  return [facts.cliDetail ?? "", how].filter((s) => s.length > 0).join(" · ");
}

/** "×3 · 오후 3:12" — the merged count and the last time (nothing for a single occurrence without a time). */
export function repeatLabel(count: number | undefined, lastAt: number | undefined, opts: { timeZone?: string } = {}): string {
  const parts: string[] = [];
  if ((count ?? 1) > 1) parts.push(`×${count}`);
  if ((count ?? 1) > 1 && lastAt !== undefined && Number.isFinite(lastAt)) parts.push(clockTime(lastAt, opts));
  return parts.join(" · ");
}

/** A time of day in the UI language ("오후 3:12"). */
export function clockTime(ms: number, opts: { timeZone?: string } = {}): string {
  const locale = currentLanguage() === "ko" ? "ko" : "en";
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) }).format(new Date(ms));
}

/** What a session banner's buttons do (ErrorBanner / SessionErrorBanner); the first one is the primary button. */
export type SessionAction =
  /** `session_new` */
  | "newChat"
  /** `restart_session` after `session_start_failed` ("다시 시도") */
  | "retry"
  /** `restart_session` after a crash ("다시 연결") */
  | "reconnect"
  | "openLog"
  /** the chat list with `sessionId` highlighted ("이전 대화 보기") */
  | "history"
  /** the new-workbench sheet, branch prefilled (`worktree_blocked`) */
  | "createWorkbench"
  /** the workbench window of `path` (`worktree_outside_review` in a known worktree) */
  | "openWorkbench"
  /** `path` as a project in a new window (`worktree_outside_review` elsewhere) */
  | "openFolder"
  /** the git-lfs install command to the clipboard (`lfs_missing`) */
  | "copyCommand"
  /** MARK: wave4b w4b-follow — §39.4 `chat_move` to `path` (`worktree_outside_review` in a worktree of this repository; asks first while Claude works) */
  | "moveChat";

/** The banner's actions by code (§2.5 / §2.6); `count` is the merged ×N (a crash seen twice puts New chat first). */
export function sessionActions(code: string | undefined, ctx: { count: number; facts?: ErrorFacts; isWorkbench?: (path: string) => boolean }): SessionAction[] {
  const facts = ctx.facts ?? {};
  switch (code) {
    case "session_start_failed":
      return ["newChat", "retry", "openLog"];
    case "session_crashed":
      return ctx.count >= 2 ? ["newChat", "reconnect", "openLog"] : ["reconnect", "newChat", "openLog"];
    case "session_id_in_use":
      return ["newChat", "openLog"];
    case "resume_not_found":
    case "resume_failed":
      return facts.sessionId ? ["history"] : [];
    case "worktree_blocked":
      return ["createWorkbench"];
    case "worktree_outside_review":
      if (!facts.path) return [];
      // wave4b w4b-follow (§39.4): a worktree of this repository — the chat can follow it there first.
      return ctx.isWorkbench?.(facts.path) ? ["moveChat", "openWorkbench"] : ["openFolder"];
    case "lfs_missing":
      return ["copyCommand"];
    default:
      return [];
  }
}

/**
 * §2.5 / test point 16: "워크벤치로 열기" on a blocked worktree opens the new-workbench sheet with the branch Claude wanted
 * (EnterWorktree's `name`) prefilled; the base stays the current branch (the sheet's default).
 */
export function createWorkbenchDialog(facts: ErrorFacts | undefined): { kind: "newWorkbench"; branch?: string } {
  const branch = facts?.branch?.trim();
  return { kind: "newWorkbench", ...(branch ? { branch } : {}) };
}

/** The codes the session banner (SessionErrorBanner) draws instead of the generic error banner. */
export const SESSION_BANNER_CODES: ReadonlySet<string> = new Set([
  "session_start_failed",
  "session_crashed",
  "session_id_in_use",
  "resume_not_found",
  "resume_failed",
  "peer_release_failed",
  "worktree_blocked",
  "worktree_outside_review",
  "lfs_missing",
]);

/** A banner the next working session start makes stale (§30: `state.session.ready` false → true clears it). */
export function clearsOnReady(banner: { code?: string; fatal: boolean; scope: ErrorScope | "client" } | null): boolean {
  if (!banner) return false;
  const p = presentationOf(banner.code);
  return p === "fatalSession" || p === "auth" || (banner.fatal && (banner.scope === "session" || banner.scope === "engine"));
}
