import { readdirSync } from "node:fs";
import path, { type PlatformPath } from "node:path";
import type { OutputStyleInfo, OutputStyleSetIn } from "../protocol.js";
import { safeReadOrNull, wellFormed } from "../util/safeRead.js";

/**
 * docs/PROTOCOL.md §72.2 `/output-style`: the output styles the session's CLI offers, each with where it comes from and
 * its description, and which settings file picks the current one. The names are the CLI's own (`initializationResult()`
 * `available_output_styles`); the descriptions come from the style files' frontmatter. Pure reads (`safeReadOrNull`).
 */

/** The terminal's built-in styles besides Default (the output-styles page, 2026-11). */
export const BUILTIN_OUTPUT_STYLES = ["default", "Proactive", "Concise", "Explanatory", "Learning"] as const;

/** What a style description is cut to. */
const DESCRIPTION_MAX = 300;
/** At most this many style files are read per folder. */
const FOLDER_MAX = 200;

type StyleFile = { name: string; description: string | null; source: OutputStyleInfo["source"]; path: string; plugin?: string };

/** `name` / `description` of a style file's YAML frontmatter (single-line values; quotes taken off). */
export function styleFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) out[kv[1] as "name" | "description"] = v;
  }
  return out;
}

function readFolder(dir: string, source: StyleFile["source"], plugin: string | undefined, read: (p: string) => string | null, list: (d: string) => string[], pa: PlatformPath): StyleFile[] {
  const out: StyleFile[] = [];
  for (const file of list(dir).slice(0, FOLDER_MAX)) {
    const filePath = pa.join(dir, file);
    const text = read(filePath);
    if (text === null) continue;
    const fm = styleFrontmatter(text);
    const name = wellFormed(fm.name ?? pa.basename(file, ".md"));
    const description = fm.description ? wellFormed(fm.description).slice(0, DESCRIPTION_MAX) : null;
    out.push({ name, description, source, path: wellFormed(filePath), ...(plugin ? { plugin: wellFormed(plugin) } : {}) });
  }
  return out;
}

function listMd(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md") && !f.startsWith(".")).sort();
  } catch {
    return [];
  }
}

/** `.claude/output-styles` from `cwd` up to `root` (closest first: the CLI uses the one closest to the working directory). */
export function projectStyleDirs(cwd: string, root: string, pa: PlatformPath = path): string[] {
  const dirs: string[] = [];
  let at = pa.resolve(cwd);
  const top = pa.resolve(root);
  // Windows paths compare without case (C:\Work and c:\work are one folder).
  const same = (a: string, b: string) => (pa.sep === "\\" ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (let i = 0; i < 64; i++) {
    dirs.push(pa.join(at, ".claude", "output-styles"));
    if (same(at, top)) break;
    const up = pa.dirname(at);
    if (up === at) break;
    at = up;
  }
  return dirs;
}

export type OutputStyleListOptions = {
  /** The CLI's names (`available_output_styles`), in its order; null before the session reported them. */
  available: readonly string[] | null;
  configDir: string;
  cwd: string | null;
  root: string | null;
  plugins: { name: string; path: string | null }[];
  /** The managed folder (`.claude/output-styles` inside it), null: none. */
  managedDir: string | null;
  read?: (p: string) => string | null;
  list?: (d: string) => string[];
  /** Path rules (default: this platform's); tests pass `path.win32`. */
  pathApi?: PlatformPath;
};

/**
 * The styles to pick from: the CLI's list with each style's source and description (a name the files do not explain is a
 * built-in when it is one of the terminal's five, else `other`). Before the session reported its list: the built-ins and
 * every style file found.
 */
export function listOutputStyles(opts: OutputStyleListOptions): OutputStyleInfo[] {
  const pa = opts.pathApi ?? path;
  const read = opts.read ?? ((p: string) => safeReadOrNull(p));
  const list = opts.list ?? listMd;
  const found: StyleFile[] = [];
  if (opts.cwd && opts.root) for (const d of projectStyleDirs(opts.cwd, opts.root, pa)) found.push(...readFolder(d, "project", undefined, read, list, pa));
  found.push(...readFolder(pa.join(opts.configDir, "output-styles"), "user", undefined, read, list, pa));
  for (const p of opts.plugins) if (p.path && p.path !== "builtin") found.push(...readFolder(pa.join(p.path, "output-styles"), "plugin", p.name, read, list, pa));
  if (opts.managedDir) found.push(...readFolder(pa.join(opts.managedDir, ".claude", "output-styles"), "managed", undefined, read, list, pa));
  const file = (name: string) => found.find((f) => f.name === name) ?? found.find((f) => f.name.toLowerCase() === name.toLowerCase())
    ?? found.find((f) => f.plugin !== undefined && `${f.plugin}:${f.name}` === name);
  const builtin = (name: string) => (BUILTIN_OUTPUT_STYLES as readonly string[]).some((b) => b.toLowerCase() === name.toLowerCase());
  const info = (name: string): OutputStyleInfo => {
    if (builtin(name)) return { name, description: null, source: "builtin" };
    const f = file(name);
    if (!f) return { name, description: null, source: "other" };
    return { name, description: f.description, source: f.source, path: f.path, ...(f.plugin ? { plugin: f.plugin } : {}) };
  };
  const names = opts.available ?? [...BUILTIN_OUTPUT_STYLES, ...found.map((f) => f.name)];
  const seen = new Set<string>();
  const out: OutputStyleInfo[] = [];
  for (const raw of names) {
    const name = wellFormed(String(raw));
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(info(name));
  }
  // Default first, then the other built-ins in the terminal's order, then the rest as the CLI listed them.
  const rank = (s: OutputStyleInfo) => (s.source === "builtin" ? BUILTIN_OUTPUT_STYLES.findIndex((b) => b.toLowerCase() === s.name.toLowerCase()) : BUILTIN_OUTPUT_STYLES.length);
  return out.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s);
}

/** The settings file whose `outputStyle` applies (managed > local > project > user, as the CLI's precedence); null: none. */
export function outputStyleSetIn(opts: { configDir: string; cwd: string | null; loadUser: boolean; loadLocal: boolean; managed: Record<string, unknown> | null; managedPath: string | null; read?: (p: string) => string | null; pathApi?: PlatformPath }): OutputStyleSetIn | null {
  const pa = opts.pathApi ?? path;
  const read = opts.read ?? ((p: string) => safeReadOrNull(p));
  const valueIn = (path: string): string | null => {
    const text = read(path);
    if (text === null) return null;
    try {
      const v = (JSON.parse(text) as { outputStyle?: unknown } | null)?.outputStyle;
      return typeof v === "string" && v.trim() ? wellFormed(v) : null;
    } catch {
      return null;
    }
  };
  const m = opts.managed?.outputStyle;
  if (typeof m === "string" && m.trim()) return { source: "managed", path: wellFormed(opts.managedPath ?? "managed settings"), value: wellFormed(m) };
  const layers: { source: OutputStyleSetIn["source"]; path: string; on: boolean }[] = [
    { source: "local", path: opts.cwd ? pa.join(opts.cwd, ".claude", "settings.local.json") : "", on: opts.loadLocal && opts.cwd !== null },
    { source: "project", path: opts.cwd ? pa.join(opts.cwd, ".claude", "settings.json") : "", on: opts.cwd !== null },
    { source: "user", path: pa.join(opts.configDir, "settings.json"), on: opts.loadUser },
  ];
  for (const l of layers) {
    if (!l.on) continue;
    const v = valueIn(l.path);
    if (v !== null) return { source: l.source, path: wellFormed(l.path), value: v };
  }
  return null;
}

/** `/output-style <name>` ignores case (the output-styles page): the CLI's own spelling of `typed`, else null. */
export function canonicalStyle(typed: string, available: readonly string[]): string | null {
  const t = typed.trim();
  if (!t) return null;
  return available.find((n) => n === t) ?? available.find((n) => n.toLowerCase() === t.toLowerCase()) ?? null;
}
