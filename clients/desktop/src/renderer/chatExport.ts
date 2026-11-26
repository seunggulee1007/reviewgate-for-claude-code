/**
 * docs/PROTOCOL.md §70.3 on Windows: Claude Code's `/export [file]` and `/copy [N]` in a classic chat. The engine makes the
 * text from the chat's rows (`export_chat` → `chat_export`, `copy_response` → `response_text`); `/export file` writes it
 * there (a file that exists is refused), `/export` alone opens the dialog — copy or save through a save dialog — and
 * `/copy [N]` puts Claude's Nth-latest answer on the clipboard. As on the Mac (App ComposerExport.swift).
 */
import type { ChatExportEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";
import { tildePath } from "./peerSessions";

/** What the dialog shows (the engine's reply without its envelope). */
export type ChatExport = Pick<ChatExportEvent, "text" | "name" | "path">;

/** What a command did: a line for the composer (`ok` false: a refusal — the box keeps the command). */
export type ExportOutcome = { ok: boolean; notice: string };

export const exportDescription = (): string => t("Export the conversation as text — to the clipboard or a file");
export const copyDescription = (): string => t("Copy Claude's last answer — /copy 2 copies the one before");
export const exportCopied = (): string => t("Copied the conversation to the clipboard");
export const exportSaved = (path: string): string => t("Saved the conversation to {0}", tildePath(path));
export const copyUsage = (): string => t("Type a number after /copy — /copy 2 copies the answer before the last");
export const copiedResponse = (n: number): string => (n <= 1 ? t("Copied Claude's last answer") : t("Copied Claude's answer {0} back", n));

/** "N lines · M characters" under the dialog's title. */
export function exportSize(text: string): string {
  const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return t("{0} lines · {1} characters", lines, [...text].length);
}

/** `/copy [N]`'s argument: "" → 1 (the latest); a whole number from 1; null — not a number. */
export function copyArgument(arg: string): number | null {
  const s = arg.trim();
  if (s === "") return 1;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 ? n : null;
}

/** `/export` alone: the text for the dialog, or why there is none. */
export async function loadExport(): Promise<{ export: ChatExport } | { notice: string }> {
  try {
    const r = await engineRequest({ type: "export_chat" });
    return { export: { text: r.text, name: r.name, path: r.path } };
  } catch (e: unknown) {
    return { notice: refusalMessage(refusalOf(e)) };
  }
}

/** `/export <file>` (relative to the project folder; the engine never replaces a file), or the save dialog's pick (`replace`: it asked). */
export async function exportToFile(file: string, replace = false): Promise<ExportOutcome> {
  try {
    const r = await engineRequest({ type: "export_chat", path: file, ...(replace ? { replace: true } : {}) });
    return { ok: true, notice: exportSaved(r.path ?? file) };
  } catch (e: unknown) {
    return { ok: false, notice: refusalMessage(refusalOf(e)) };
  }
}

type Copy = (text: string) => Promise<void>;
const defaultCopy: Copy = (text) => window.rg.copyText(text);

/** The dialog's Copy: the whole conversation on the clipboard (a write the user asked for). */
export async function copyExport(exp: ChatExport, copy: Copy = defaultCopy): Promise<ExportOutcome> {
  await copy(exp.text);
  return { ok: true, notice: exportCopied() };
}

type PickSave = (name: string) => Promise<string | null>;
const defaultPickSave: PickSave = (name) => (typeof window.rg.saveExportFile === "function" ? window.rg.saveExportFile(name) : Promise.resolve(null));

/** The dialog's Save: the save dialog (it asks before replacing), then the engine writes there. Null: cancelled. */
export async function saveExport(exp: ChatExport, pick: PickSave = defaultPickSave): Promise<ExportOutcome | null> {
  const path = await pick(exp.name);
  if (path === null) return null;
  return exportToFile(path, true);
}

/** `/copy [N]`: Claude's Nth-latest answer on the clipboard. */
export async function copyResponse(arg: string, copy: Copy = defaultCopy): Promise<ExportOutcome> {
  const n = copyArgument(arg);
  if (n === null) return { ok: false, notice: copyUsage() };
  try {
    const r = await engineRequest({ type: "copy_response", n });
    await copy(r.text);
    return { ok: true, notice: copiedResponse(n) };
  } catch (e: unknown) {
    return { ok: false, notice: refusalMessage(refusalOf(e)) };
  }
}
