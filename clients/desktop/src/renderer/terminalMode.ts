/**
 * MARK: wave6 w6-terminal
 * docs/PROTOCOL.md §44.1 in Electron (as on the Mac, Core TerminalMode.swift) — pure, unit-tested: the bottom of the chat
 * works like Claude Code in the terminal. Shift+Tab in the composer cycles the permission mode (default → acceptEdits →
 * plan → auto), a one-line mode indicator says which one runs (plan mode Claude entered by itself too), and approving a
 * plan made in an auto chat goes back to auto.
 */
import type { PermissionMode, ReviewState } from "@reviewgate/engine";
import { scheduledModeText } from "./autoMode";
import { t } from "./i18n";

/** Shift+Tab's order, as in the terminal. */
export const MODE_CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

/** The mode after `mode`; auto is skipped while the CLI cannot run it for this chat (`autoModeUnavailable`). */
export function nextPermissionMode(mode: PermissionMode, autoAvailable: boolean): PermissionMode {
  const modes = autoAvailable ? MODE_CYCLE : MODE_CYCLE.filter((m) => m !== "auto");
  return modes[(modes.indexOf(mode) + 1) % modes.length]!;
}

/** Shift+Tab alone (no Ctrl / Alt / ⌘), not while an input method composes. */
export function isModeCycleKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  return e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.isComposing !== true;
}

export type ModeTone = "plain" | "auto" | "acceptEdits" | "plan";

/**
 * The terminal-style line under the composer: "⏵⏵ 자동 모드 (shift+tab 전환)", "⏸ 계획 모드 — 승인하면 자동 모드로 돌아가요
 * (shift+tab 전환)", "기본 모드 (shift+tab 전환)"; a mode picked while Claude works is added ("다음 턴부터: 계획").
 */
export function modeLine(
  mode: PermissionMode,
  opts: { approvesIntoAuto?: boolean; scheduledLabel?: string | null; autoUnavailable?: boolean } = {},
): { text: string; tone: ModeTone } {
  let text: string;
  let tone: ModeTone;
  switch (mode) {
    case "auto":
      // The engine said auto mode cannot run here: the CLI runs the default mode (and asks), so say that.
      text = opts.autoUnavailable ? t("Auto mode is not available here — running in default mode") : `⏵⏵ ${t("Auto mode")}`;
      tone = opts.autoUnavailable ? "plain" : "auto";
      break;
    case "acceptEdits":
      text = `⏵⏵ ${t("Accept edits mode")}`;
      tone = "acceptEdits";
      break;
    case "plan":
      text = `⏸ ${t("Plan mode")}${opts.approvesIntoAuto ? ` — ${t("approving goes back to auto mode")}` : ""}`;
      tone = "plan";
      break;
    default:
      text = t("Default mode");
      tone = "plain";
  }
  if (opts.scheduledLabel) text += ` · ${scheduledModeText(opts.scheduledLabel)}`;
  return { text: `${text} ${t("(shift+tab to switch)")}`, tone };
}

/**
 * "Approve & run" (and the new chat / workbench answers): back to auto when the chat came from auto mode
 * (`state.session.prePlanMode`; an older engine sends none), else the default mode as before — not into an auto mode the
 * engine said cannot run here (`autoUnavailable`: the switch would be refused and the plan would wait).
 */
export function planApproveMode(s: ReviewState, autoUnavailable = false): PermissionMode {
  return s.session.prePlanMode === "auto" && !autoUnavailable ? "auto" : "default";
}

/** After a snapshot: another project or another model may run auto mode again. */
export function autoModeMayRunAgain(previous: ReviewState, snapshot: ReviewState): boolean {
  return previous.project?.root !== snapshot.project?.root || (previous.session.selectedModel ?? null) !== (snapshot.session.selectedModel ?? null);
}
