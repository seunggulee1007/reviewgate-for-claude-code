import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { CommandRefused } from "../errors.js";
import type { InstructionKind, MemoryFile, ProjectInstructionFile, SubagentInfo } from "../protocol.js";
import { hasGitComponent, isInsidePath, realpathLenient, relativeInside, samePath } from "../platform/paths.js";

/**
 * MARK: wave4d w4d-config — §42.3: Claude's instruction files and subagents in the app.
 *
 * - `instructionKind`: what a memory file the CLI reported is — and so when Claude reads it (one rule; clients only word it).
 * - The project's own CLAUDE.md / CLAUDE.local.md (and a CLAUDE.md in a folder below the root) can be read and saved by
 *   the app (`claude_md_read` / `claude_md_write`): the user's own edit, compared against the content they started from.
 *   Files in the user's home (~/.claude/CLAUDE.md, auto memory) are only opened in an editor by the clients.
 * - `subagentList`: `initializationResult().agents` with the definition file when it is found.
 */

/** A file larger than this is neither read nor written here (an editor is the better place). */
export const CLAUDE_MD_MAX_BYTES = 256 * 1024;
const DESCRIPTION_MAX = 300;
const AGENTS_MAX = 200;

const INSTRUCTION_NAMES = new Set(["CLAUDE.md", "CLAUDE.local.md"]);

const sep = /[\\/]/;
const parts = (p: string) => p.split(sep).filter(Boolean);

/** What `path` is: see `InstructionKind`. `type` is the CLI's label ("Project", "User", …), used where the path does not say. */
export function instructionKind(path: string, type: string, ctx: { root: string; configDir: string }): InstructionKind {
  const p = resolve(path);
  const root = resolve(ctx.root);
  const config = resolve(ctx.configDir);
  const name = basename(p);
  const label = type.toLowerCase();
  if (/managed|policy|enterprise/.test(label)) return "managed";
  if (samePath(p, join(config, "CLAUDE.md"))) return "user";
  if (isInsidePath(p, join(config, "projects")) || /auto ?mem/.test(label)) return "auto_memory";
  const realRoot = realpathLenient(root);
  const inRoot = relativeInside(p, root) ?? relativeInside(p, realRoot);
  const segs = inRoot !== null ? inRoot.split("/") : parts(p);
  const ruleAt = segs.findIndex((s, i) => s === ".claude" && segs[i + 1] === "rules");
  if (ruleAt >= 0 || isInsidePath(p, join(config, "rules"))) return "rules";
  if (INSTRUCTION_NAMES.has(name)) {
    if (inRoot === "CLAUDE.md" || inRoot === ".claude/CLAUDE.md") return "project";
    if (inRoot === "CLAUDE.local.md") return "local";
    if (inRoot !== null) return "nested";
    const folder = basename(dirname(p)) === ".claude" ? dirname(dirname(p)) : dirname(p);
    if (isInsidePath(root, folder) || isInsidePath(realRoot, folder)) return "parent";
  }
  return label === "user" ? "user" : "other";
}

/** A memory file with its `kind` and, when the app can save it, `editable`. */
export function describeMemoryFile(m: MemoryFile, ctx: { root: string; configDir: string }): MemoryFile {
  const kind = instructionKind(m.path, m.type, ctx);
  const editable = (kind === "project" || kind === "local" || kind === "nested") && instructionTarget(ctx.root, m.path) !== null;
  return { ...m, kind, ...(editable ? { editable: true as const } : {}) };
}

/** The project's CLAUDE.md (`.claude/CLAUDE.md` when only that one exists) and CLAUDE.local.md, existing or not. */
export function projectInstructionFiles(root: string): ProjectInstructionFile[] {
  const main = !existsSync(join(root, "CLAUDE.md")) && existsSync(join(root, ".claude", "CLAUDE.md")) ? ".claude/CLAUDE.md" : "CLAUDE.md";
  return [
    { path: join(root, ...main.split("/")), relPath: main, kind: "project", exists: isFile(join(root, ...main.split("/"))) },
    { path: join(root, "CLAUDE.local.md"), relPath: "CLAUDE.local.md", kind: "local", exists: isFile(join(root, "CLAUDE.local.md")) },
  ];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export type InstructionTarget = { abs: string; relPath: string; kind: "project" | "local" | "nested" };

/**
 * A client path (project-relative, or absolute inside the project) as an instruction file the app may read / save, or
 * null: its name must be CLAUDE.md / CLAUDE.local.md, it stays inside the project (no `..`, no `.git`), and — when it
 * exists — what it really is (a symlink resolved) is inside the project too.
 */
export function instructionTarget(root: string, raw: unknown): InstructionTarget | null {
  if (typeof raw !== "string" || !raw.trim() || /[\0-\x1f]/.test(raw)) return null;
  const base = resolve(root);
  let rel: string | null;
  if (isAbsolute(raw)) {
    // The CLI reports real paths (/private/var/… for /var/…): compare the folder's real path, keep the file's own name.
    rel = relativeInside(resolve(raw), base) ?? relativeInside(join(realpathLenient(dirname(resolve(raw))), basename(raw)), realpathLenient(base));
  } else {
    const n = posix.normalize(raw.trim().replace(/\\/g, "/"));
    rel = n.startsWith("../") || n === ".." || n.startsWith("/") || /^[A-Za-z]:/.test(n) ? null : n.replace(/^\.\//, "");
  }
  if (!rel || rel === "." || hasGitComponent(rel)) return null;
  const segs = rel.split("/");
  const name = segs[segs.length - 1]!;
  if (!INSTRUCTION_NAMES.has(name)) return null;
  const abs = join(base, ...segs);
  // A symlink (CLAUDE.md → AGENTS.md is common) may point anywhere: what it names must be in the project as well.
  const real = realpathLenient(abs);
  if (!isInsidePath(real, realpathLenient(base)) || hasGitComponent(real)) return null;
  const kind = rel === "CLAUDE.md" || rel === ".claude/CLAUDE.md" ? "project" : rel === "CLAUDE.local.md" ? "local" : "nested";
  return { abs, relPath: rel, kind };
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export type InstructionContent = { text: string; sha: string | null; exists: boolean };

export async function readInstruction(abs: string): Promise<InstructionContent> {
  let st: { isFile(): boolean; size: number };
  try {
    st = await stat(abs);
  } catch {
    return { text: "", sha: null, exists: false };
  }
  if (!st.isFile()) throw new CommandRefused("invalid_path", { code: "invalid_path" });
  if (st.size > CLAUDE_MD_MAX_BYTES) throw new CommandRefused("too_large", { code: "too_large" });
  const buf = await readFile(abs);
  return { text: buf.toString("utf8"), sha: sha(buf), exists: true };
}

/**
 * Saves `text` when the file is still what the user started from (`baseSha`, null = it did not exist): written next to
 * the real file (a symlink stays one) and renamed over it, keeping its mode. A missing folder is not created.
 */
export async function writeInstruction(abs: string, text: unknown, baseSha: unknown): Promise<InstructionContent> {
  if (typeof text !== "string" || text.includes("\0")) throw new CommandRefused("invalid_text", { code: "invalid_text" });
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > CLAUDE_MD_MAX_BYTES) throw new CommandRefused("too_large", { code: "too_large" });
  const current = await readInstruction(abs);
  const base = typeof baseSha === "string" && baseSha ? baseSha : null;
  if (current.sha !== base) throw new CommandRefused("claude_md_changed", { code: "claude_md_changed" });
  const target = current.exists ? await realpath(abs) : abs;
  if (!existsSync(dirname(target))) throw new CommandRefused("invalid_path", { code: "invalid_path" });
  const mode = current.exists ? (await stat(target)).mode & 0o7777 : null;
  const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, bytes);
    if (mode !== null) await chmod(tmp, mode).catch(() => undefined);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new CommandRefused(`claude_md_failed:${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, { code: "claude_md_failed" });
  }
  return { text, sha: sha(bytes), exists: true };
}

// ---------------------------------------------------------------- subagents

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const AGENT_FILE_NAME = /^[A-Za-z0-9_.-]{1,120}$/;

/** Where an agent is defined: `<plugin>/agents/<name>.md` for `plugin:name`, else the project's or the user's `agents/<name>.md`. */
function agentFile(name: string, ctx: { root: string; configDir: string; plugins: { name: string; path: string | null }[] }): Pick<SubagentInfo, "source" | "path"> | null {
  const colon = name.indexOf(":");
  if (colon > 0) {
    const plugin = ctx.plugins.find((p) => p.name === name.slice(0, colon) && p.path && p.path !== "builtin");
    if (!plugin) return null;
    const file = name.slice(colon + 1);
    const path = AGENT_FILE_NAME.test(file) ? join(plugin.path!, "agents", `${file}.md`) : null;
    return path && isFile(path) ? { source: "plugin", path } : { source: "plugin" };
  }
  if (!AGENT_FILE_NAME.test(name)) return null;
  const project = join(ctx.root, ".claude", "agents", `${name}.md`);
  if (isFile(project)) return { source: "project", path: project };
  const user = join(ctx.configDir, "agents", `${name}.md`);
  if (isFile(user)) return { source: "user", path: user };
  return null;
}

/** `initializationResult().agents` (raw `AgentInfo[]`) for the wire; null when it is not a list. */
export function subagentList(raw: unknown, ctx: { root: string; configDir: string; plugins: { name: string; path: string | null }[] }): SubagentInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SubagentInfo[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (out.length >= AGENTS_MAX) break;
    const o = a as { name?: unknown; description?: unknown; model?: unknown } | null;
    if (!o || typeof o.name !== "string" || !o.name.trim() || /[\0-\x1f]/.test(o.name) || seen.has(o.name)) continue;
    seen.add(o.name);
    const name = o.name.slice(0, 200);
    const description = typeof o.description === "string" ? cut(o.description.replace(/\s+/g, " ").trim(), DESCRIPTION_MAX) : "";
    const model = typeof o.model === "string" && o.model.trim() ? o.model.trim().slice(0, 80) : undefined;
    const where = agentFile(name, ctx);
    out.push({ name, description, ...(model ? { model } : {}), ...(where?.source ? { source: where.source } : {}), ...(where?.path ? { path: where.path } : {}) });
  }
  return out;
}
