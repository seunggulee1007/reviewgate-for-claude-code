/**
 * MARK: wave4 w4-safety / polish p-lifecycle — what closing a window, quitting (the last window's ✕, Alt+F4, Ctrl+Q) or
 * switching / closing a window's project would stop, lose and leave, and when the app asks first — the Mac's rule and
 * words (Core `QuitGuard.swift` / `CloseGuard.swift`, the same English keys; docs/PROTOCOL.md §55.7). Pure: main shows
 * the close / quit questions (src/main/windows.ts, main.ts), the renderer the project switch's (store.ts).
 */
import type { ReviewState } from "@reviewgate/engine";
import type { AppSettings } from "./ipc";
import { t } from "../renderer/i18n";

export type CloseGuardReason = "working" | "waiting";

/** Why closing this window now would stop Claude; null = idle. Waiting wins (the card goes away with the session). */
export function closeGuardReason(state: Pick<ReviewState, "gate" | "session">): CloseGuardReason | null {
  const s = state.session;
  const waits = s.pendingPermission !== null || (s.pendingPermissions?.length ?? 0) > 0 || s.pendingPlan !== null;
  if (waits) return "waiting";
  return state.gate.phase === "running" ? "working" : null;
}

/** One thing a window has going on when it would close (`QuitReason`). */
export type QuitReason =
  | { kind: "working" }
  | { kind: "waiting" }
  | { kind: "backgroundTasks"; count: number }
  | { kind: "backgroundAgents"; count: number }
  | { kind: "sideQuestions"; count: number }
  | { kind: "creatingWorkbench" }
  | { kind: "images"; count: number }
  | { kind: "prDrafts"; count: number }
  | { kind: "queued"; count: number }
  | { kind: "pendingReview"; count: number }
  | { kind: "unsentNotes"; count: number }
  | { kind: "draft" };

const STOPS = new Set<QuitReason["kind"]>(["working", "waiting", "backgroundTasks", "backgroundAgents", "sideQuestions", "creatingWorkbench"]);
const LOSES = new Set<QuitReason["kind"]>(["images", "prDrafts"]);
export const stops = (r: QuitReason): boolean => STOPS.has(r.kind);
export const loses = (r: QuitReason): boolean => LOSES.has(r.kind);

/**
 * What only the window's page knows (main asks for it over `rg:closeGuardQuery` before it decides): the lines its parts
 * registered (`unsavedWorkLines()`), the message being typed, images attached to it, the queue, side questions answering
 * and a workbench being created.
 */
export type CloseGuardExtras = {
  lines: string[];
  draft: boolean;
  draftImages: number;
  queued: number;
  queuedImages: number;
  sideAnswering: number;
  creatingWorkbench: boolean;
};

export const NO_EXTRAS: CloseGuardExtras = { lines: [], draft: false, draftImages: 0, queued: 0, queuedImages: 0, sideAnswering: 0, creatingWorkbench: false };

type GuardState = Pick<ReviewState, "gate" | "session" | "changedFiles" | "reviewNotes" | "hud" | "pr" | "project" | "workbenches">;

/** What closing this window now would stop, lose or leave behind — in the Mac's order. */
export function quitReasons(state: GuardState, extras: CloseGuardExtras = NO_EXTRAS): QuitReason[] {
  const reasons: QuitReason[] = [];
  const reason = closeGuardReason(state);
  if (reason) reasons.push({ kind: reason });
  const tasks = state.session.backgroundTasks?.length ?? 0;
  if (tasks > 0) reasons.push({ kind: "backgroundTasks", count: tasks });
  // Subagents of a turn that runs stop with that turn (`working`); after it, they are background agents.
  const live = (state.hud?.agents ?? []).filter((a) => a.status === "pending" || a.status === "running" || a.status === "paused").length;
  if (state.gate.phase !== "running" && live > 0) reasons.push({ kind: "backgroundAgents", count: live });
  if (extras.sideAnswering > 0) reasons.push({ kind: "sideQuestions", count: extras.sideAnswering });
  if (extras.creatingWorkbench) reasons.push({ kind: "creatingWorkbench" });
  const images = extras.draftImages + extras.queuedImages;
  if (images > 0) reasons.push({ kind: "images", count: images });
  const prDrafts = state.pr?.draftComments?.length ?? 0;
  if (prDrafts > 0) reasons.push({ kind: "prDrafts", count: prDrafts });
  if (extras.queued > 0) reasons.push({ kind: "queued", count: extras.queued });
  const pending = state.changedFiles.filter((f) => f.state === "pending" || f.state === "changesRequested").length;
  if (pending > 0) reasons.push({ kind: "pendingReview", count: pending });
  const unsent = (state.reviewNotes ?? []).filter((n) => !n.sent).length;
  if (unsent > 0) reasons.push({ kind: "unsentNotes", count: unsent });
  if (extras.draft) reasons.push({ kind: "draft" });
  return reasons;
}

/** The project's name as the questions say it (the main worktree's folder, as the window title); "" without a project. */
export function projectDisplayName(state: Pick<ReviewState, "project" | "workbenches">): string {
  if (!state.project) return "";
  const repo = state.workbenches?.list?.find((w) => w.isMain)?.path ?? state.project.root ?? state.project.path;
  return repo?.split(/[\\/]/).filter(Boolean).pop() ?? state.project.name ?? "";
}

/** One window as the questions see it (`WindowQuitState`). */
export type WindowQuitState = { name: string; reasons: QuitReason[]; unsavedLines: string[] };

export function windowQuitState(state: GuardState, extras: CloseGuardExtras = NO_EXTRAS): WindowQuitState {
  return { name: projectDisplayName(state), reasons: quitReasons(state, extras), unsavedLines: extras.lines };
}

const windowStops = (w: WindowQuitState) => w.reasons.some(stops);
const windowLoses = (w: WindowQuitState) => w.unsavedLines.length > 0 || w.reasons.some(loses);
const needsCare = (w: WindowQuitState) => windowStops(w) || windowLoses(w);

/** The question's words and buttons (`QuitPrompt`). */
export type QuitPrompt = {
  title: string;
  message: string;
  confirm: string;
  cancel: string;
  dontAskAgain: string;
  /** "Don't ask again": on a quit only when nothing stops or is lost (it turns off `confirmQuit`); otherwise it turns off `confirmCloseWhileWorking`. */
  offersSuppression: boolean;
  /** Something would be lost: Cancel is the default button. */
  cancelIsDefault: boolean;
};

type Switches = Pick<AppSettings, "confirmQuit" | "confirmCloseWhileWorking">;
const asksQuit = (s: Switches) => s.confirmQuit !== false;
const asksWhileWorking = (s: Switches) => s.confirmCloseWhileWorking !== false;

const named = (line: string, window: string | null | undefined): string => (window ? `${window}: ${line}` : line);

/** One line of a question; `window` names the project (null: the window being closed). */
export function quitLine(r: QuitReason, window: string | null): string {
  if (window) {
    switch (r.kind) {
      case "working":
        return t("{0}: Claude is working — quitting stops this turn", window);
      case "waiting":
        return t("{0}: Claude is waiting for your answer — quitting stops this turn", window);
      case "pendingReview":
        return t("{0}: {1} files wait for review — they come back when you reopen it", window, r.count);
      case "queued":
        return t("{0}: {1} queued messages come back paused when you reopen it", window, r.count);
      default:
        break;
    }
  }
  let text: string;
  switch (r.kind) {
    case "working":
      text = t("Closing stops this turn.");
      break;
    case "waiting":
      text = t("Claude is waiting for your answer. Closing stops this turn.");
      break;
    case "backgroundTasks":
      text = t("{0} background commands stop", r.count);
      break;
    case "backgroundAgents":
      text = t("{0} background agents stop", r.count);
      break;
    case "sideQuestions":
      text = t("{0} side questions stop", r.count);
      break;
    case "creatingWorkbench":
      text = t("A workbench is still being created");
      break;
    case "images":
      text = t("{0} attached images are not kept", r.count);
      break;
    case "prDrafts":
      text = t("{0} PR review comments not submitted yet are lost", r.count);
      break;
    case "pendingReview":
      text = t("{0} files wait for review — they come back when you reopen it", r.count);
      break;
    case "queued":
      text = t("{0} queued messages come back paused when you reopen it", r.count);
      break;
    case "unsentNotes":
    case "draft":
      text = t("Unsent notes and the message you were typing are kept");
      break;
  }
  return named(text, window);
}

/** What stays of one window, said once: pending files (with the unsent notes when there are both) and the queue. */
function stayLines(w: WindowQuitState): string[] {
  let pending = 0;
  let notes = 0;
  let queued = 0;
  for (const r of w.reasons) {
    if (r.kind === "pendingReview") pending = r.count;
    else if (r.kind === "unsentNotes") notes = r.count;
    else if (r.kind === "queued") queued = r.count;
  }
  const lines: string[] = [];
  if (pending > 0 && notes > 0) lines.push(named(t("{0} unsent notes and {1} pending files stay — they are here when you reopen", notes, pending), w.name));
  else if (pending > 0) lines.push(quitLine({ kind: "pendingReview", count: pending }, w.name || null));
  if (queued > 0) lines.push(quitLine({ kind: "queued", count: queued }, w.name || null));
  return lines;
}

const buttons = (confirm: string) => ({ confirm, cancel: t("Cancel"), dontAskAgain: t("Don't ask again") });

/**
 * Quit and the last window's close (`QuitPrompt.make`). null: quit without asking. "Ask before quitting" decides while
 * nothing would stop or be lost; "Ask before closing while Claude works" alone decides otherwise. `reopenCount`: the
 * projects the next launch reopens (null when "Reopen last projects" is off).
 */
export function quitPrompt(windows: WindowQuitState[], kind: "quit" | "lastWindow", settings: Switches, reopenCount: number | null): QuitPrompt | null {
  const care = windows.some(needsCare);
  if (!(care ? asksWhileWorking(settings) : asksQuit(settings))) return null;
  const paragraphs: string[] = [];
  if (kind === "lastWindow") paragraphs.push(t("Closing the last window quits ReviewGate."));
  const stopLines = windows.flatMap((w) => w.reasons.filter(stops).map((r) => quitLine(r, w.name || null)));
  const lost = windows.flatMap((w) => [...w.unsavedLines.map((l) => named(l, w.name)), ...w.reasons.filter(loses).map((r) => quitLine(r, w.name || null))]);
  const stays = windows.flatMap(stayLines);
  if (windows.some((w) => w.reasons.some((r) => r.kind === "draft" || r.kind === "unsentNotes"))) stays.push(t("Unsent notes and the message you were typing are kept"));
  const projects = windows.filter((w) => w.name !== "").length;
  if (stopLines.length === 0 && projects > 0) stays.unshift(t("The Claude sessions of {0} open projects end.", projects));
  if (reopenCount !== null && reopenCount > 0) stays.push(t("{0} projects reopen next time", reopenCount));
  for (const block of [stopLines, lost, stays]) if (block.length > 0) paragraphs.push(block.join("\n"));
  return { title: t("Quit ReviewGate?"), message: paragraphs.join("\n\n"), ...buttons(t("Quit")), offersSuppression: !care, cancelIsDefault: windows.some(windowLoses) };
}

/** One window's question (the title by the reason — waiting wins —, `lead` for a turn that would stop, the rest, what stays). */
function guardPrompt(w: WindowQuitState, lead: (r: CloseGuardReason) => string, confirm: string): QuitPrompt {
  let title: string;
  const paragraphs: string[] = [];
  if (w.reasons.some((r) => r.kind === "waiting")) {
    title = t("Claude is waiting for your answer");
    paragraphs.push(lead("waiting"));
  } else if (w.reasons.some((r) => r.kind === "working")) {
    title = t("Claude is working right now");
    paragraphs.push(lead("working"));
  } else {
    title = t("Close this window?");
  }
  const lines = [...w.reasons.filter((r) => (stops(r) || loses(r)) && r.kind !== "working" && r.kind !== "waiting").map((r) => quitLine(r, null)), ...w.unsavedLines];
  if (lines.length > 0) paragraphs.push(lines.join("\n"));
  paragraphs.push(t("Pending reviews, notes and drafts come back when you reopen."));
  return { title, message: paragraphs.join("\n\n"), ...buttons(confirm), offersSuppression: true, cancelIsDefault: windowLoses(w) };
}

const closeLead = (r: CloseGuardReason) => (r === "waiting" ? t("Claude is waiting for your answer. Closing stops this turn.") : t("Closing stops this turn."));

/** Closing one window that is not the last: asks only while something would stop or be lost (`QuitPrompt.close`). */
export function closePrompt(w: WindowQuitState, settings: Switches): QuitPrompt | null {
  if (!asksWhileWorking(settings) || !needsCare(w)) return null;
  return guardPrompt(w, closeLead, t("Close"));
}

/** P1-chrome-03: switching or closing the window's project stops its session — asked like a window's close. */
export function projectChangePrompt(w: WindowQuitState, change: "switch" | "close", settings: Switches): QuitPrompt | null {
  if (!asksWhileWorking(settings) || !needsCare(w)) return null;
  return change === "switch"
    ? guardPrompt(w, () => t("Switching projects stops this turn."), t("Switch"))
    : guardPrompt(w, () => t("Closing the project stops this turn."), t("Close Project"));
}

/** Bounds what a page reports (`rg:closeGuardExtras`): main shows these lines in a native dialog. */
export function validExtras(raw: unknown): CloseGuardExtras {
  const o = (raw ?? {}) as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 9999) : 0);
  const lines = Array.isArray(o["lines"]) ? o["lines"].filter((l): l is string => typeof l === "string" && l.trim() !== "").slice(0, 20).map((l) => l.slice(0, 300)) : [];
  return {
    lines,
    draft: o["draft"] === true,
    draftImages: count(o["draftImages"]),
    queued: count(o["queued"]),
    queuedImages: count(o["queuedImages"]),
    sideAnswering: count(o["sideAnswering"]),
    creatingWorkbench: o["creatingWorkbench"] === true,
  };
}
