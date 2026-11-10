/**
 * MARK: wave4d w4d-config — docs/PROTOCOL.md §42.3, the pure part (unit-tested in claudeConfig.test.ts): MCP servers' origins
 * in words (which file defines a server, why it cannot be removed, the terminal command), the instruction kinds (what a
 * memory file is and when Claude reads it), the CLAUDE.md editor's refusals and its diff. Same rules and English keys as the
 * Mac (Core `ClaudeConfig.swift`); the engine decides — these only word it.
 */
import { diffLines } from "diff";
import type { InstructionKind, McpServerInfo, McpScope } from "@reviewgate/engine";
import { t } from "./i18n";
import { removableScope } from "./mcp";
import { updateReason } from "./sessionTools";

/** `~/…` for a path in the home folder (`home` from the engine's project path or the platform; null = as is). */
export function abbreviate(path: string, home: string | null): string {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, "");
  return path.startsWith(h + "/") || path.startsWith(h + "\\") ? `~${path.slice(h.length)}` : path;
}

// ---------------------------------------------------------------- MCP origins

export const isFromParentFolder = (s: McpServerInfo): boolean => s.origin?.place === "parent" && !!s.origin.file;
export const isOffForRepository = (s: McpServerInfo): boolean => (s.status === "disabled" || s.disabledByUser) && s.disabledIn === "repository";

/** The scope `mcp_remove` takes, or null: the engine's origin says it cannot be removed where it is defined, or its source never can. */
export function removeScope(s: McpServerInfo, opts: { localScope?: boolean } = {}): McpScope | null {
  if (s.origin && !s.origin.removable) return null;
  return removableScope(s, opts);
}

/** The row's "defined in" line; null without an origin file. */
export function originLine(s: McpServerInfo, home: string | null): string | null {
  const file = s.origin?.file;
  if (!file) return null;
  const shown = abbreviate(file, home);
  return s.origin?.place === "parent" ? t("Defined in {0} — a folder above this project; every project under it uses it", shown) : t("Defined in {0}", shown);
}

/** The confirmation of a parent folder's server; null for the others (McpServers.tsx `removeHelp`). */
export function parentRemoveHelp(s: McpServerInfo, home: string | null): string | null {
  if (!isFromParentFolder(s) || removeScope(s) === null) return null;
  return t("Removes “{0}” from {1} — a folder above this project, so every project and workbench under it loses it.", s.name, abbreviate(s.origin!.file!, home));
}

/** Why ReviewGate cannot remove it; null when it can. */
export function notRemovableReason(s: McpServerInfo, home: string | null): string | null {
  const o = s.origin;
  if (!o || o.removable) return null;
  switch (o.reason) {
    case "plugin":
      return t("It comes from a plugin — turn the plugin off in Plugins instead");
    case "claude_ai":
      return t("It comes from your claude.ai connectors — change it on claude.ai");
    case "managed":
      return t("Your organization manages it — it cannot be removed");
    case "not_found":
      return t("ReviewGate could not find which .mcp.json defines it");
    case "read_only":
      return t("ReviewGate cannot change {0}", abbreviate(o.file ?? "", home));
    default:
      return t("ReviewGate does not know where it is defined");
  }
}

/** The terminal command that removes it where ReviewGate cannot; null otherwise. */
export function terminalCommand(s: McpServerInfo): string | null {
  return s.origin && !s.origin.removable && s.origin.command ? s.origin.command : null;
}

// ---------------------------------------------------------------- instructions

export function instructionTitle(kind: InstructionKind | string | undefined): string {
  switch (kind) {
    case "user":
      return t("User");
    case "project":
      return t("Project");
    case "local":
      return t("Local (only me)");
    case "parent":
      return t("Parent folder");
    case "nested":
      return t("Subfolder");
    case "rules":
      return t("Rules");
    case "auto_memory":
      return t("Auto memory");
    case "managed":
      return t("Managed");
    default:
      return t("Other");
  }
}

/** When Claude reads a file of this kind. */
export function whenRead(kind: InstructionKind | string | undefined): string {
  switch (kind) {
    case "user":
      return t("Read at the start of every conversation, in every project");
    case "project":
      return t("Read at the start of every conversation in this project — shared through git");
    case "local":
      return t("Read at the start of every conversation in this project — only you, not in git");
    case "parent":
      return t("Read at the start of every conversation in the projects under that folder");
    case "nested":
      return t("Read when Claude works with files in that folder");
    case "rules":
      return t("Read at the start of a conversation — a rule with paths when Claude works with those files");
    case "auto_memory":
      return t("Claude's own notes for this project — read at the start of every conversation");
    case "managed":
      return t("Set by your organization — read in every conversation");
    default:
      return t("Loaded by Claude Code");
  }
}

export function agentSource(source: string | undefined): string {
  return source === "project" ? t("Project") : source === "user" ? t("User") : source === "plugin" ? t("Plugin") : t("Built in");
}

/** Only Markdown files are handed to the system's default app (main checks again that the file exists). */
export const canOpenMarkdown = (path: string | null | undefined): path is string => !!path && /\.(md|markdown)$/i.test(path);

/** A refusal of `claude_md_read` / `claude_md_write` in the user's words. */
export function claudeMdRefusal(code: string, fallback: string): string {
  switch (code) {
    case "claude_md_changed":
      return t("The file changed since you opened it (in an editor or by Claude) — reload it and make your change again");
    case "session_busy":
      return t("Claude is working — save once the turn has ended");
    case "in_review":
      return t("This file is in the open review — finish its review first");
    case "collect_failed":
      return t("Collecting this turn's changes failed. Retry it first.");
    case "too_large":
      return t("The file is too large to edit here — open it in an editor");
    case "invalid_path":
      return t("Only this project's CLAUDE.md files can be edited here");
    case "unknown_command":
      return updateReason();
    default:
      return fallback;
  }
}

export type DiffRow = { kind: "add" | "del" | "context" | "fold"; text: string; folded?: number };

/** old → new by line, `context` unchanged lines around each change, longer unchanged runs folded into one row. */
export function instructionsDiff(oldText: string, newText: string, context = 3): DiffRow[] {
  const nl = (s: string) => (s.length === 0 || s.endsWith("\n") ? s : `${s}\n`);
  const rows: DiffRow[] = [];
  for (const part of diffLines(nl(oldText), nl(newText))) {
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) rows.push({ kind: part.added ? "add" : part.removed ? "del" : "context", text });
  }
  const changed = rows.flatMap((r, i) => (r.kind === "context" ? [] : [i]));
  if (changed.length === 0) return [];
  const keep = new Set<number>();
  for (const k of changed) for (let n = Math.max(0, k - context); n <= Math.min(rows.length - 1, k + context); n++) keep.add(n);
  const out: DiffRow[] = [];
  let run = 0;
  const flush = () => {
    if (run > 0) out.push({ kind: "fold", text: "", folded: run });
    run = 0;
  };
  rows.forEach((r, i) => {
    if (keep.has(i)) {
      flush();
      out.push(r);
    } else run += 1;
  });
  flush();
  return out;
}

export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  return { added: rows.filter((r) => r.kind === "add").length, removed: rows.filter((r) => r.kind === "del").length };
}
