/**
 * MARK: shell-mode — docs/PROTOCOL.md §67.2 / §67.3 on Windows: Claude Code's `!` bash mode in a classic chat. A draft whose
 * first character is `!` is the user's own command: `shell_run` runs it in the project folder between turns (never sent to
 * Claude, never queued), its output streams in (`shell_output`, kept here while it runs) and its row (`kind: "shell"`) joins
 * the chat; the results go to Claude in front of the next message. The words of the running and the finished row live here
 * so the components stay thin.
 */
import type { ShellResult } from "@reviewgate/engine";
import { create } from "zustand";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";

// ---------------------------------------------------------------- the draft

/** The box is in shell mode: its first character is `!` (as Claude Code's bash mode). */
export const isShellDraft = (draft: string): boolean => draft.startsWith("!");

/** The command a `!` draft runs ("" for `!` alone); null when the draft is a message. */
export function shellCommandOfDraft(draft: string): string | null {
  return isShellDraft(draft) ? draft.slice(1).trim() : null;
}

/** The hint under the box in shell mode (the key that runs it). */
export function shellKeyHint(returnSends: boolean): string {
  return returnSends
    ? t("↩ runs the shell command · its output goes to Claude with your next message")
    : t("⌘↩ runs the shell command · its output goes to Claude with your next message");
}

/** The badge's tooltip at the start of the box in shell mode. */
export function shellBadgeTitle(): string {
  return t("Shell mode — the command runs in the project folder, not by Claude. Delete the ! to write to Claude.");
}

/** The caption over the box while results wait for the next message (`state.session.shellPending`); null for none. */
export function shellPendingCaption(count: number | undefined): string | null {
  return count && count > 0 ? t("{0} shell result(s) go to Claude with your next message", count) : null;
}

// ---------------------------------------------------------------- the rows

export type ShellEndTone = "ok" | "error" | "stopped";
/** How a finished command ended, for its row: ✓ 0 · ✗ 종료 코드 n · 중지됨 · 시간 초과 (· it could not start). */
export function shellEnd(r: Pick<ShellResult, "exitCode" | "cancelled" | "timedOut">): { text: string; tone: ShellEndTone } {
  if (r.cancelled) return { text: t("Stopped"), tone: "stopped" };
  if (r.timedOut) return { text: t("Timed out after 10 minutes"), tone: "stopped" };
  if (r.exitCode === null) return { text: t("Could not start"), tone: "error" };
  if (r.exitCode === 0) return { text: "✓ 0", tone: "ok" };
  return { text: `✗ ${t("Exit code {0}", r.exitCode)}`, tone: "error" };
}

/** Lines of output a finished row shows before "전체 보기". */
export const SHELL_FOLD_LINES = 12;

/** `output` folded to its last `lines` lines (`hidden`: how many lines above them are folded away). */
export function foldShellOutput(output: string, lines = SHELL_FOLD_LINES): { text: string; hidden: number } {
  const all = output.replace(/\s+$/, "").split(/\r?\n/);
  if (all.length <= lines) return { text: all.join("\n"), hidden: 0 };
  return { text: all.slice(-lines).join("\n"), hidden: all.length - lines };
}

/** "파일 N개를 바꿨어요 — 다음 리뷰에 나와요" with the names for its tooltip; null when it changed none. */
export function shellFilesLine(r: Pick<ShellResult, "files" | "filesTruncated">): { text: string; title: string } | null {
  const files = r.files ?? [];
  if (files.length === 0) return null;
  const count = r.filesTruncated ? `${files.length}+` : String(files.length);
  return {
    text: t("Changed {0} file(s) — they show in the next review", count),
    title: files.join("\n") + (r.filesTruncated ? "\n…" : ""),
  };
}

/** The row's tooltip on its command: where it ran. */
export function shellRanInTitle(command: string, cwd: string): string {
  return `$ ${command}\n${t("Ran in {0}", cwd)}`;
}

// ---------------------------------------------------------------- the running command's output

type ShellLive = { id: string | null; output: string };

/** The running command's output so far (`shell_output`, the engine's last few thousand characters). */
export const useShellLive = create<ShellLive>(() => ({ id: null, output: "" }));

export function noteShellOutput(id: string, output: string): void {
  useShellLive.setState({ id, output });
}

/** Its row arrived (or the project changed): the live output goes. */
export function clearShellOutput(id?: string): void {
  if (id === undefined || useShellLive.getState().id === id) useShellLive.setState({ id: null, output: "" });
}

// ---------------------------------------------------------------- the engine

/** `shell_run {command}`; null once it started, else the refusal in words. */
export async function runShellCommand(command: string): Promise<string | null> {
  try {
    await engineRequest({ type: "shell_run", command });
    return null;
  } catch (e: unknown) {
    return refusalMessage(refusalOf(e));
  }
}

/** `shell_cancel {}` (Esc, the stop buttons); null once asked, else the refusal in words. */
export async function cancelShellCommand(): Promise<string | null> {
  try {
    await engineRequest({ type: "shell_cancel" });
    return null;
  } catch (e: unknown) {
    return refusalMessage(refusalOf(e));
  }
}
