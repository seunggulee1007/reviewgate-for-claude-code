/**
 * MARK: add-dir — docs/PROTOCOL.md §67.1 / §67.3 on Windows: Claude Code's `/add-dir` in a classic chat. A directory beyond
 * the project the chat may work in (`add_dir {path}`, `remove_dir {path}`; `state.session.addedDirs`), typed as
 * `/add-dir <path>`, picked with `/add-dir` alone or the chip's "디렉터리 추가…", and listed by the composer's "디렉터리 N"
 * chip with × each. Edits there always ask (`added_directory` on the card), since the review never shows them.
 */
import type { GateState, SessionState } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalCodeText, refusalMessage } from "./errorCodes";
import { t } from "./i18n";
import { tildePath } from "./peerSessions";

const NONE: readonly string[] = [];

/** The current chat's added directories (an engine without §67 has none). */
export const addedDirsOf = (session: Pick<SessionState, "addedDirs">): readonly string[] => session.addedDirs ?? NONE;

/** The chip: "디렉터리 N". */
export const addedDirsChipText = (count: number): string => t("Directories {0}", count);

/** The chip's tooltip. */
export function addedDirsChipTitle(): string {
  return t("Directories added with /add-dir — Claude may work there too. Edits there ask every time, because the review does not show them.");
}

/** A directory as the list shows it: the home folder as `~` (the full path is its tooltip). */
export const shownDir = (path: string): string => tildePath(path);

/**
 * Why the chat's directories cannot change now (the engine would refuse `dir_busy`): the session starting, a turn of
 * Claude's (ours or another session's), its collection or a revert. Null when they can.
 */
export function addedDirsBusyReason(state: { session: Pick<SessionState, "starting" | "externalTurn">; gate: Pick<GateState, "phase"> }): string | null {
  const busy = state.session.starting || !!state.session.externalTurn || state.gate.phase === "running" || state.gate.phase === "collecting" || state.gate.phase === "reverting";
  return busy ? (refusalCodeText("dir_busy", "") ?? "dir_busy") : null;
}

export const addDirDoneNotice = (): string => t("Directory added — from your next message Claude works there too");
export const removeDirDoneNotice = (): string => t("Directory removed — from your next message Claude no longer works there");

/** What `/add-dir` (or the chip) did: a line for the notice; `ok` clears the box. Null: the picker was cancelled. */
export type AddDirOutcome = { ok: boolean; notice: string } | null;

type Picker = () => Promise<string | null>;
const defaultPicker: Picker = () => (typeof window.rg.pickAddDirectory === "function" ? window.rg.pickAddDirectory() : Promise.resolve(""));

/** `add_dir {path}` — with "" the folder picker first (the dialog is the user's own: `/add-dir` alone, "디렉터리 추가…"). */
export async function addDir(path: string, pick: Picker = defaultPicker): Promise<AddDirOutcome> {
  let target = path.trim();
  if (target === "") {
    const picked = await pick();
    if (picked === null) return null;
    target = picked;
  }
  try {
    await engineRequest({ type: "add_dir", path: target });
    return { ok: true, notice: addDirDoneNotice() };
  } catch (e: unknown) {
    return { ok: false, notice: refusalMessage(refusalOf(e)) };
  }
}

/** `remove_dir {path}` — the chip's ×. */
export async function removeDir(path: string): Promise<AddDirOutcome> {
  try {
    await engineRequest({ type: "remove_dir", path });
    return { ok: true, notice: removeDirDoneNotice() };
  } catch (e: unknown) {
    return { ok: false, notice: refusalMessage(refusalOf(e)) };
  }
}
