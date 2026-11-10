/**
 * MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2 (market-12), the same rules as the Mac (Core ExploreFold.swift):
 * consecutive exploration calls (the engine marks a call that only reads or searches `explore: true` — Read, Glob, Grep,
 * LS, read-only Bash, an MCP lookup) fold into one "탐색: 파일 12개 읽음 · 검색 5회" row that opens to the list. Edits, other
 * Bash, permission cards, agent groups, error rows and an exploration call that failed are never folded; Claude's text
 * ends a run. Settings › General "탐색 행 자세히 보기" shows every row instead.
 */
import { t } from "./i18n";
import type { ChatItem } from "./store";

/** `tool_use.explore` on a chat item (absent on older engines: nothing folds). */
export type ExploreMeta = { explore?: true };

/** The mark read from a `tool_use` event or row; anything but `true` reads as absent. */
export const exploreMetaOf = (ev: { explore?: unknown }): ExploreMeta => (ev.explore === true ? { explore: true } : {});

export type ExploreCounts = { files: number; searches: number; commands: number; lookups: number; open: number };
export type ExploreRun = { kind: "run"; id: number; items: ChatItem[]; counts: ExploreCounts };
export type ExploreEntry = { kind: "item"; item: ChatItem } | ExploreRun;

/** Fewer calls than this stay as they are. */
export const MIN_CALLS = 2;

/** The top-level items with every run of at least `MIN_CALLS` exploration calls folded (results go with their call). */
export function foldExplore(items: readonly ChatItem[]): ExploreEntry[] {
  const failed = new Set<string>();
  for (const it of items) if (it.kind === "toolResult" && it.isError) failed.add(it.toolUseId);
  const out: ExploreEntry[] = [];
  let run: ChatItem[] = [];
  let calls = new Set<string>();
  const flush = () => {
    if (calls.size >= MIN_CALLS && run.length > 0) out.push({ kind: "run", id: run[0]!.id, items: run, counts: exploreCounts(run) });
    else for (const item of run) out.push({ kind: "item", item });
    run = [];
    calls = new Set();
  };
  for (const it of items) {
    if (it.kind === "toolUse" && (it as ExploreMeta).explore === true && !it.parentToolUseId && !failed.has(it.toolUseId)) {
      run.push(it);
      calls.add(it.toolUseId);
    } else if (it.kind === "toolResult" && !it.isError && calls.has(it.toolUseId)) {
      run.push(it);
    } else {
      flush();
      out.push({ kind: "item", item: it });
    }
  }
  flush();
  return out;
}

/** What a run did: files read (distinct paths), searches (Grep, Glob, LS), read-only commands, other lookups, open calls. */
export function exploreCounts(items: readonly ChatItem[]): ExploreCounts {
  const c: ExploreCounts = { files: 0, searches: 0, commands: 0, lookups: 0, open: 0 };
  const files = new Set<string>();
  const answered = new Set<string>();
  const calls: string[] = [];
  for (const it of items) {
    if (it.kind === "toolResult") answered.add(it.toolUseId);
    if (it.kind !== "toolUse") continue;
    calls.push(it.toolUseId);
    if (it.name === "Read" || it.name === "NotebookRead") {
      const path = it.file ?? (typeof it.input.file_path === "string" ? it.input.file_path : typeof it.input.notebook_path === "string" ? it.input.notebook_path : it.toolUseId);
      files.add(path);
    } else if (it.name === "Grep" || it.name === "Glob" || it.name === "LS") c.searches += 1;
    else if (it.name === "Bash") c.commands += 1;
    else c.lookups += 1;
  }
  c.files = files.size;
  c.open = calls.filter((id) => !answered.has(id)).length;
  return c;
}

/** "파일 12개 읽음 · 검색 5회 · 명령 2개" — the parts that are not zero. */
export function exploreSummary(c: ExploreCounts): string {
  const parts: string[] = [];
  if (c.files > 0) parts.push(t("{0} files read", c.files));
  if (c.searches > 0) parts.push(t("{0} searches", c.searches));
  if (c.commands > 0) parts.push(t("{0} commands", c.commands));
  if (c.lookups > 0) parts.push(t("{0} lookups", c.lookups));
  return parts.join(" · ");
}
