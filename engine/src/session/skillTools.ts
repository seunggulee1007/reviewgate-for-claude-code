import { lstat, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isBroadBashPattern } from "./bashClass.js";

/**
 * MARK: r2-skills-side — docs/PROTOCOL.md §33.5 (M20): what a running skill or slash command pre-allowed. A SKILL.md /
 * command .md may say `allowed-tools: Bash(git add:*), Bash(git status:*), Read` in its frontmatter; the terminal then runs
 * those calls without asking while the skill runs. ReviewGate's hooks answer `ask` before the CLI's own rules, so in default
 * mode every such call got a card. The engine reads the list itself and keeps it as the turn's allow patterns
 * (`HookContext.turnAllowPatterns`): Bash through `matchesAllowPattern`, other tools through `matchesToolPattern` — never an
 * edit, SendMessage or a reason card (those are decided before any pattern).
 */

/** Where a skill / command may live (`skillFiles`). `plugins`: the session's plugins with their install path. */
export type SkillDirs = {
  /** The project folder(s) whose `.claude/skills` / `.claude/commands` count (the session's cwd and the checkpoint root). */
  projectDirs: readonly string[];
  /** `CLAUDE_CONFIG_DIR` or `~/.claude`; null while user settings are off (no user skills then). */
  configDir: string | null;
  plugins: readonly { name: string; path: string | null }[];
  /**
   * Release-2 review: a file changed at or after this time (wall clock, ms: the turn's start) gives no patterns — Claude may
   * have written it this turn. As changed counts its content (mtime) or its inode (ctime, which no command can set back).
   */
  unchangedSince?: number;
  /** Release-2 review: a file still under review (Claude changed it in an earlier turn, not accepted yet) gives none. */
  underReview?: (file: string) => boolean;
};

/** At most this many patterns are kept from one skill (a frontmatter is a few lines). */
const MAX_PATTERNS = 100;

/** The name a Skill tool call runs (`skill`, older CLIs `command`), or null. */
export function skillCallName(input: Record<string, unknown>): string | null {
  const raw = typeof input.skill === "string" ? input.skill : typeof input.command === "string" ? input.command : "";
  const name = raw.trim().replace(/^\//, "");
  return validName(name) ? name : null;
}

/** The command a message runs (`/acme-verify --fast` → `acme-verify`), or null. */
export function slashCommandName(text: string): string | null {
  const m = /^\/([^\s/]+)(?:\s|$)/.exec(text.trim());
  return m && validName(m[1]!) ? m[1]! : null;
}

/** A name never leaves its folder: no path separators, no `..`, nothing but the CLI's command characters. */
function validName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && /^[A-Za-z0-9_.:@-]+$/.test(name) && !name.split(":").some((p) => p === "" || p === "." || p === "..");
}

/**
 * The files `name` may be, in the order they are tried: the project's `.claude/skills/<name>/SKILL.md` and
 * `.claude/commands/<name>.md` (`a:b` → `commands/a/b.md`), the same under the user's config dir, then for `plugin:rest` the
 * plugin's `skills/<rest>/SKILL.md` and `commands/<rest>.md`.
 */
export function skillFiles(name: string, dirs: SkillDirs): string[] {
  if (!validName(name)) return [];
  const parts = name.split(":");
  const out: string[] = [];
  const add = (base: string, segs: readonly string[]) => {
    out.push(join(base, "skills", ...segs, "SKILL.md"));
    out.push(join(base, "commands", ...segs.slice(0, -1), `${segs[segs.length - 1]}.md`));
  };
  for (const d of [...new Set(dirs.projectDirs.map((p) => resolve(p)))]) add(join(d, ".claude"), parts);
  if (dirs.configDir) add(dirs.configDir, parts);
  if (parts.length > 1) {
    for (const p of dirs.plugins) if (p.path && p.name === parts[0]) add(p.path, parts.slice(1));
  }
  return [...new Set(out)];
}

/**
 * A frontmatter key's value (`---` … `---` at the top of the file): a string as written (`key: a, b`), or the items of a
 * YAML list under it (`key:` then `  - a` lines). Undefined when the file has no frontmatter or no such key.
 */
export function frontmatterValue(text: string, keys: readonly string[]): string | string[] | undefined {
  const body = text.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (!m) return undefined;
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv || !keys.includes(kv[1]!)) continue;
    const rest = kv[2]!.trim();
    const block = rest === "|" || rest === ">";
    if (rest && !block) return rest;
    // A YAML list (`  - a`) or a block scalar (`key: >` then indented lines, read as one line).
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "") continue;
      const item = block ? null : /^[ \t]*-[ \t]+(.*)$/.exec(line);
      if (item) items.push(item[1]!.trim());
      else if (block && /^[ \t]+\S/.test(line)) items.push(line.trim());
      else break;
    }
    return block ? items.join(" ") : items;
  }
  return undefined;
}

/** Splits at `sep` outside parentheses and quotes. */
function splitOutside(text: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && sep.test(ch)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1).trim() : t;
}

/**
 * `allowed-tools` as patterns: a comma list (`Bash(git add:*), Read`), a space list (`Bash(git add:*) Read`), a flow list
 * (`[Read, "Bash(git status:*)"]`) or a YAML list; quotes dropped, at most `MAX_PATTERNS`.
 */
export function parseAllowedTools(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  let items: string[];
  if (Array.isArray(value)) items = value.map(unquote);
  else {
    let text = (value as string).trim();
    if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
    const byComma = splitOutside(text, /,/);
    items = (byComma.length > 1 ? byComma : splitOutside(text, /\s/)).map(unquote);
  }
  return [...new Set(items.filter((i) => i.length > 0 && i.length <= 500))].slice(0, MAX_PATTERNS);
}

/** The latest change time (content or inode) of `file` and of a symlink in its place; null when it cannot be read. */
async function changedAt(file: string): Promise<number | null> {
  try {
    const [l, t] = await Promise.all([lstat(file), stat(file)]);
    return Math.max(l.mtimeMs, l.ctimeMs, t.mtimeMs, t.ctimeMs);
  } catch {
    return null;
  }
}

/**
 * The `allowed-tools` of the first file `skillFiles` finds for `name` ([] when none has them). Release-2 review: [] as
 * well for a file changed since `unchangedSince` or still `underReview` — a skill Claude just wrote (`allowed-tools:
 * Bash(*)`) pre-allowed every later command of the turn — and never a pattern that covers any command
 * (`isBroadBashPattern`: `Bash(*)`, `Bash(sh:*)`, a bare `Bash`).
 */
export async function skillAllowedTools(name: string, dirs: SkillDirs): Promise<string[]> {
  for (const file of skillFiles(name, dirs)) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (dirs.underReview?.(file)) return [];
    if (dirs.unchangedSince !== undefined) {
      const at = await changedAt(file);
      if (at === null || at >= dirs.unchangedSince) return [];
    }
    return parseAllowedTools(frontmatterValue(text.slice(0, 64 * 1024), ["allowed-tools", "allowed_tools"])).filter((p) => !isBroadBashPattern(p));
  }
  return [];
}
