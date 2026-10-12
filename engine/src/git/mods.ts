import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/**
 * "Mods" paths (docs/PROTOCOL.md §32): the files that change how Claude Code itself behaves in this project — hooks,
 * skills, agents, commands, rules, settings (`.claude/**`), MCP servers (`.mcp.json`) and instructions (`CLAUDE.md`,
 * `CLAUDE.local.md`). Repositories often gitignore `.claude/` (acme does), so `git add -A` never puts them in a
 * snapshot and a turn that rewrote a hook left no diff. Every snapshot therefore force-adds them, whatever .gitignore
 * or the app's ignore patterns say — by path rules only, so A and B always agree on which paths are in the tree.
 *
 * Content that is not captured (larger than `MODS_MAX_BYTES`, binary, or more than `MODS_MAX_FILES` candidates) is
 * still present in the tree, as a small stub text (size + mtime): its change shows, a phantom add / delete cannot
 * happen, and a stub is never written back to disk (`isModsStub`).
 */
export const MODS_DIR = ".claude";
export const MODS_ROOT_FILES: readonly string[] = [".mcp.json", "CLAUDE.md", "CLAUDE.local.md"];
/** Never captured (it may hold secrets — API keys in `env`): changes are reported by hash only (§32 `localSettingsChanged`). */
export const LOCAL_SETTINGS = ".claude/settings.local.json";
export const MODS_MAX_BYTES = 256 * 1024;
export const MODS_MAX_FILES = 1000;
export const MODS_STUB_PREFIX = "[ReviewGate] mods file not captured";

/** Directories never descended into: Claude Code's own worktrees and dependency / repository folders. */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tif", ".tiff", ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".jar", ".war", ".class", ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".db", ".sqlite", ".sqlite3", ".pyc",
]);

/** A path the snapshot force-adds (repo-relative, POSIX). */
export function isModsPath(rel: string): boolean {
  if (MODS_ROOT_FILES.includes(rel)) return true;
  if (!rel.startsWith(`${MODS_DIR}/`) || rel === LOCAL_SETTINGS) return false;
  if (rel.startsWith(`${MODS_DIR}/worktrees/`)) return false;
  return !rel.split("/").some((c) => SKIP_DIRS.has(c));
}

/** A changed file listed in the review's "mods" group: the captured paths, plus nested `CLAUDE.md` / `CLAUDE.local.md`. */
export function isModsGroup(rel: string): boolean {
  if (isModsPath(rel) || rel === LOCAL_SETTINGS) return true;
  const name = basename(rel);
  return name === "CLAUDE.md" || name === "CLAUDE.local.md";
}

export type ModsCandidate = { rel: string; abs: string; kind: "file" | "symlink"; size: number; mtimeMs: number; executable: boolean };

/**
 * Every mods path on disk: the root files and the regular files / symlinks under `.claude/` (symlinked directories are
 * not followed; `worktrees/`, `node_modules/`, `.git/` and any directory holding a `.git` — another repository — are
 * skipped). Sorted.
 */
export async function modsCandidates(root: string): Promise<ModsCandidate[]> {
  const out: ModsCandidate[] = [];
  const add = async (rel: string): Promise<void> => {
    const abs = join(root, rel);
    const st = await lstat(abs).catch(() => null);
    if (!st || !(st.isFile() || st.isSymbolicLink())) return;
    out.push({ rel, abs, kind: st.isSymbolicLink() ? "symlink" : "file", size: st.size, mtimeMs: st.mtimeMs, executable: (st.mode & 0o111) !== 0 });
  };
  for (const f of MODS_ROOT_FILES) await add(f);
  const walk = async (relDir: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    const entries = await readdir(join(root, relDir), { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.name === ".git")) return;
    for (const e of entries) {
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || rel === `${MODS_DIR}/worktrees`) continue;
        await walk(rel, depth + 1);
      } else if (isModsPath(rel)) await add(rel);
    }
  };
  if (await lstat(join(root, MODS_DIR)).then((s) => s.isDirectory(), () => false)) await walk(MODS_DIR, 0);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Why a regular file's content is not captured, or null when it is. */
export async function uncapturedReason(c: ModsCandidate, tooMany: boolean): Promise<string | null> {
  if (c.kind !== "file") return null;
  if (tooMany) return "too many files";
  if (c.size > MODS_MAX_BYTES) return "too large";
  if (BINARY_EXTENSIONS.has(extname(c.rel).toLowerCase())) return "binary";
  return (await looksBinary(c.abs)) ? "binary" : null;
}

/** NUL in the first 8000 bytes (git's own heuristic). */
async function looksBinary(abs: string): Promise<boolean> {
  const fh = await open(abs, "r").catch(() => null);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** The stub text that stands for an uncaptured file: changes whenever its size or mtime does. */
export function stubText(reason: string, size: number, mtimeMs: number): string {
  return `${MODS_STUB_PREFIX} (${reason}): ${size} bytes, modified ${new Date(Math.floor(mtimeMs)).toISOString()}\n`;
}

export function isStubContent(content: Buffer | string): boolean {
  const s = typeof content === "string" ? content : content.subarray(0, MODS_STUB_PREFIX.length).toString("utf8");
  return s.startsWith(MODS_STUB_PREFIX);
}

/** Why a change to a mods file matters (§32): what it makes run, or what it lets through. */
export type ModsRisk = "hook" | "script" | "mcp" | "permissions" | "env";

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([".sh", ".bash", ".zsh", ".fish", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd"]);

/**
 * The risks of a change to `rel` (null content = absent on that side): hook definitions (`hooks.json`, anything under
 * `.claude/hooks/`, a settings file whose `hooks` changed), scripts (executable bit or a script extension under
 * `.claude/`), MCP servers (`.mcp.json`, settings `mcpServers` / `enabledMcpjsonServers` / `enableAllProjectMcpServers`),
 * permissions (settings `permissions`) and the environment the CLI runs commands with (settings `env`).
 */
export function modsRisks(rel: string, executable: boolean, before: Buffer | null, after: Buffer | null): ModsRisk[] {
  const risks = new Set<ModsRisk>();
  const name = basename(rel);
  if (name === "hooks.json" || rel.startsWith(`${MODS_DIR}/hooks/`)) risks.add("hook");
  if (rel.startsWith(`${MODS_DIR}/`) && (executable || SCRIPT_EXTENSIONS.has(extname(rel).toLowerCase()))) risks.add("script");
  if (rel === ".mcp.json") risks.add("mcp");
  if (/^settings(\.[^/]+)?\.json$/.test(name) && rel.startsWith(`${MODS_DIR}/`)) {
    const [a, b] = [jsonObject(before), jsonObject(after)];
    const changed = (...keys: string[]) => keys.some((k) => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null));
    if (a === undefined || b === undefined) risks.add("hook"); // unparsable: assume the worst
    else {
      if (changed("hooks", "statusLine")) risks.add("hook");
      if (changed("mcpServers", "enabledMcpjsonServers", "enableAllProjectMcpServers")) risks.add("mcp");
      if (changed("permissions")) risks.add("permissions");
      if (changed("env", "apiKeyHelper")) risks.add("env");
    }
  }
  return [...risks].sort();
}

/** Parsed JSON object; null for an absent side, undefined when it is not a JSON object (or a stub). */
function jsonObject(content: Buffer | null): Record<string, unknown> | null | undefined {
  if (content === null) return null;
  if (isStubContent(content)) return undefined;
  try {
    const o = JSON.parse(content.toString("utf8")) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** §32 `localSettingsChanged`: hashes only — the file's content never leaves it. */
export type LocalSettingsDigest = { exists: boolean; hash: string | null; keys: Record<"hooks" | "permissions" | "env" | "mcp", string | null> };

export async function localSettingsDigest(root: string): Promise<LocalSettingsDigest> {
  const text = await readFile(join(root, LOCAL_SETTINGS)).catch(() => null);
  if (text === null) return { exists: false, hash: null, keys: { hooks: null, permissions: null, env: null, mcp: null } };
  const o = jsonObject(text);
  // Unparsable: every part counts as changed (assume the worst); a part the file does not have is null.
  const h = (...keys: string[]): string | null =>
    !o ? `unparsable:${sha256(text)}` : keys.every((k) => o[k] === undefined) ? null : sha256(JSON.stringify(keys.map((k) => o[k] ?? null)));
  return {
    exists: true,
    hash: sha256(text),
    keys: { hooks: h("hooks", "statusLine"), permissions: h("permissions"), env: h("env", "apiKeyHelper"), mcp: h("mcpServers", "enabledMcpjsonServers", "enableAllProjectMcpServers") },
  };
}

/** The §32 `localSettingsChanged` between two digests; null when the file is byte-identical (or absent both times). */
export function localSettingsChange(before: LocalSettingsDigest, after: LocalSettingsDigest): { hooks: boolean; permissions: boolean; env: boolean; mcp: boolean } | null {
  if (before.hash === after.hash) return null;
  return {
    hooks: before.keys.hooks !== after.keys.hooks,
    permissions: before.keys.permissions !== after.keys.permissions,
    env: before.keys.env !== after.keys.env,
    mcp: before.keys.mcp !== after.keys.mcp,
  };
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
