/**
 * MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3 "Review leftovers", the client rules (the same as Core
 * `ReviewLeftovers` on the Mac, tested with the same cases): which past / PR diffs offer "20줄 더 보기", the
 * whitespace-ignoring view's state and what it turns off, the chat search's three lines per chat with "N건 더", and which
 * files get an image preview. Pure (no store) and unit-tested (reviewLeftovers.test.ts).
 */
import { create } from "zustand";
import type { ChangedFileState, FileImageSide, TranscriptSearchHit, TranscriptSearchMatch } from "@reviewgate/engine";
import type { FileAuthor } from "./agentGlance";
import type { TranscriptIndex } from "./agents";
import { t } from "./i18n";

// ---------------------------------------------------------------- "20줄 더 보기" in the history and PR diffs

/** A history file's status (`M` / `R` …): only a modified or renamed text file has unchanged lines around its hunks. */
export function historyOffersContext(status: string, isBinary: boolean): boolean {
  return !isBinary && (status === "M" || status === "R");
}

/** A PR file's GitHub status: a modified / renamed / changed file (an added one is all diff, a removed one has no new side). */
export function prOffersContext(status: string, isBinary: boolean): boolean {
  return !isBinary && (status === "modified" || status === "renamed" || status === "changed");
}

/** Why `file_lines` gave no lines (binary / too large); null when it did. */
export function fileLinesUnavailable(reply: { isBinary: boolean; isTooLarge: boolean }): string | null {
  if (reply.isBinary) return t("Binary file");
  if (reply.isTooLarge) return t("File too large");
  return null;
}

// ---------------------------------------------------------------- the whitespace-ignoring view

type WhitespacePref = { ignore: boolean; toggle(): void; set(on: boolean): void };

/** "공백 무시" — one switch for the window's review diff (not remembered across launches: the view turns parts off). */
export const useIgnoreWhitespace = create<WhitespacePref>((set) => ({
  ignore: false,
  toggle: () => set((s) => ({ ignore: !s.ignore })),
  set: (on) => set({ ignore: on }),
}));

/** What the whitespace-ignoring view turns off, in one line (the hunk revert, the line / part side questions, notes). */
export function whitespaceViewNote(): string {
  return t("Ignoring whitespace: reverting parts and side questions on lines work in the normal view");
}

/** The body of a whitespace-ignoring diff with no hunks: only whitespace changed (or nothing in this range). */
export function whitespaceEmptyText(file: Pick<ChangedFileState, "whitespaceOnly">): string {
  return file.whitespaceOnly === true ? t("Only whitespace changed — ignoring it, nothing is left") : t("No changes once whitespace is ignored");
}

// ---------------------------------------------------------------- the chat search

/** Matches asked per chat (`transcript_search.perChat`). */
export const SEARCH_PER_CHAT = 3;

/** A chat's lines to show (its newest match first, at most three) and how many more matched ("N건 더"). */
export function matchHits(m: TranscriptSearchMatch): { hits: TranscriptSearchHit[]; more: number } {
  const hits: TranscriptSearchHit[] = [{ row: m.row, turn: m.turn, at: m.at, kind: m.kind, line: m.line }, ...(m.more ?? [])].slice(0, SEARCH_PER_CHAT);
  const total = typeof m.total === "number" && m.total >= hits.length ? m.total : hits.length;
  return { hits, more: total - hits.length };
}

// ---------------------------------------------------------------- grouping the list by cause

/**
 * The "원인별" section of a changed file (its header, also its key): the subagent that changed it ("◆ executor", the
 * §39.3 author rule), else the Bash command whose post-Bash snapshot saw it ("Bash · ./gradlew spotlessApply"; "Bash"
 * when the call is not in the rows), else the turn its reason is from ("턴 3"), else the main agent ("메인").
 */
export function fileCause(f: Pick<ChangedFileState, "origin" | "toolUseIds" | "why">, authors: readonly FileAuthor[] | undefined, index: TranscriptIndex | null): string {
  const agent = (authors ?? []).find((a) => a.agentToolUseId !== null);
  if (agent) return `◆ ${agent.label}`;
  if (f.origin === "bash") {
    for (const id of [...(f.toolUseIds ?? [])].reverse()) {
      const use = index?.uses.get(id);
      const command = use && use.name === "Bash" && typeof use.input["command"] === "string" ? (use.input["command"] as string) : null;
      if (command) return `Bash · ${shortCommand(command)}`;
    }
    return "Bash";
  }
  const turn = f.why?.turn;
  if (typeof turn === "number" && turn > 0) return t("Turn {0}", turn);
  return t("Main");
}

/** A command's first line, whitespace folded, 60 characters + "…". */
export function shortCommand(command: string): string {
  const line = (command.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

// ---------------------------------------------------------------- image previews

const IMAGE = /\.(png|jpe?g|gif)$/i;

/** A png / jpg / gif path (`file_image` answers these). */
export function isPreviewImage(path: string): boolean {
  return IMAGE.test(path);
}

/** A side's `<img src>`, or why it is not shown (too large); null side → nothing on that side (added / deleted). */
export function imageSrc(side: FileImageSide | null, mediaType: string): { src: string } | { reason: string } | null {
  if (!side) return null;
  if (side.dataBase64 === undefined || side.tooLarge) return { reason: t("Larger than 2 MB — not previewed") };
  return { src: `data:${mediaType};base64,${side.dataBase64}` };
}
