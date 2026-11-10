/**
 * MARK: polish p-foundation — P3-transcript-07: a tool row's tooltip says in words what the call did and what a click does —
 * "명령 실행: npm test", "파일 읽기: src/Svc.java", "src/Svc.java 편집 — 클릭하면 diff 보기" — instead of its input as raw
 * JSON (that goes to the row's "입력 복사 (JSON)"). The Mac says the same with the same keys (Core `ToolRowTooltip.swift`).
 *
 *   <div className="tool-row" title={toolRowTooltip(item.name, item.input, root, files.length > 0)}>
 */
import { t } from "./i18n";
import { relativeToRoot } from "./paths";
import { toolLabel } from "./toolLabel";

/** A command, pattern, path or URL in the tooltip is cut past this many characters ("…"). */
export const TOOLTIP_VALUE_LIMIT = 600;
/** The JSON of a call these words do not cover: at most this many characters. */
export const TOOLTIP_JSON_LIMIT = 4000;

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * The tooltip of a tool call's row. `root`: the project — paths under it read relative to it. `linked`: a click on the row
 * shows a reviewed file's diff. A call these words do not cover shows its input as JSON (at most `TOOLTIP_JSON_LIMIT`).
 */
export function toolRowTooltip(name: string, input: Record<string, unknown> | null | undefined, root: string | null | undefined, linked: boolean): string {
  const fields = input ?? {};
  const lines = words(name, fields, root, linked) ?? [json(fields)];
  // An edit says it in its own line; any other row a click opens a diff from says it last.
  if (linked && !EDITS.has(name)) lines.push(t("Click to show the diff of the files it changed"));
  return lines.join("\n");
}

function words(name: string, input: Record<string, unknown>, root: string | null | undefined, linked: boolean): string[] | null {
  if (EDITS.has(name)) {
    const file = path(input, root);
    if (file === null) return null;
    return [linked ? t("Edits {0} — click to show its diff", file) : t("Edits {0}", file)];
  }
  switch (name) {
    case "Bash": {
      const command = value(input.command);
      if (command === null) return null;
      const description = value(input.description);
      return [t("Runs: {0}", command), ...(description !== null ? [t("Description: {0}", description)] : [])];
    }
    case "Read": {
      const file = path(input, root);
      return file === null ? null : [t("Reads {0}", file)];
    }
    case "Grep": {
      const pattern = value(input.pattern);
      if (pattern === null) return null;
      const where = scope(input, root);
      return [where !== null ? t("Searches for {0} in {1}", pattern, where) : t("Searches for {0}", pattern)];
    }
    case "Glob": {
      const pattern = value(input.pattern);
      if (pattern === null) return null;
      const where = scope(input, root);
      return [where !== null ? t("Finds files: {0} in {1}", pattern, where) : t("Finds files: {0}", pattern)];
    }
    case "WebFetch": {
      const url = value(input.url);
      return url === null ? null : [t("Reads the web page {0}", url)];
    }
    case "WebSearch": {
      const query = value(input.query);
      return query === null ? null : [t("Searches the web for {0}", query)];
    }
    case "Task":
    case "Agent": {
      const what = value(input.description) ?? value(input.subagent_type);
      return what === null ? null : [t("Starts an agent: {0}", what)];
    }
    case "TodoWrite":
      return [t("Updates the to-do list")];
  }
  const label = toolLabel(name, input);
  if (label.kind === "skill") {
    const skill = [label.name || null, label.arg ?? null].filter((s): s is string => s !== null).join(" ");
    return skill ? [t("Skill: {0}", skill)] : null;
  }
  // "acme · list issues" and its representative argument — the words the row's label uses (§39.3).
  if (label.kind === "mcp") return [`${label.server ?? ""} · ${label.name}`, ...(label.arg ? [label.arg] : [])];
  return null;
}

/** The call's file (`file_path`, a notebook's `notebook_path`), relative to `root` when under it. */
function path(input: Record<string, unknown>, root: string | null | undefined): string | null {
  const raw = value(input.file_path) ?? value(input.notebook_path);
  return raw === null ? null : (relativeToRoot(raw, root) ?? raw);
}

/** Where a search looks: its `path` (relative to `root` when under it), else its `glob` filter. */
function scope(input: Record<string, unknown>, root: string | null | undefined): string | null {
  const raw = value(input.path);
  if (raw !== null) return relativeToRoot(raw, root) ?? raw;
  return value(input.glob);
}

/** A string field, trimmed and at most `TOOLTIP_VALUE_LIMIT` characters; null when absent or blank. */
function value(field: unknown): string | null {
  if (typeof field !== "string") return null;
  const text = field.trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > TOOLTIP_VALUE_LIMIT ? chars.slice(0, TOOLTIP_VALUE_LIMIT).join("") + "…" : text;
}

function json(input: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? "";
  } catch {
    text = String(input);
  }
  return text.length > TOOLTIP_JSON_LIMIT ? text.slice(0, TOOLTIP_JSON_LIMIT) + "…" : text;
}
