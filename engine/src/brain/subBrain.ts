/**
 * MARK: wave5 w5-brain — docs/PROTOCOL.md §43.2: the sub-brain — Claude Code's auto memory of this repository
 * (`<config>/projects/<key>/memory/*.md` + the `MEMORY.md` index), read only. The engine lists what is there, what this
 * session added / changed / removed and who wrote it (Claude, a subagent, or someone the engine did not see), and the
 * links between memories. It never writes the folder, never follows a symlink out of it, and never logs a memory's text.
 */
import { constants as fsc, lstatSync, readFileSync, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CommandRefused } from "../errors.js";
import { compareKey, isInsidePath, realpathLenient } from "../platform/paths.js";
import {
  BRAIN_MEMORY_TYPES,
  type BrainChange,
  type BrainChangeKind,
  type BrainEvent,
  type BrainMemory,
  type BrainMemoryEvent,
  type BrainMemoryType,
  type BrainWriter,
} from "../protocol.js";

/** At most this many memory files are listed (by name); the rest make `truncated`. */
export const BRAIN_MAX_FILES = 2000;
/** A memory is read up to this many bytes (its frontmatter, links and the text `brain_read` returns). */
export const BRAIN_MAX_FILE_BYTES = 64 * 1024;
/** MEMORY.md is read up to this many bytes. */
export const BRAIN_MAX_INDEX_BYTES = 256 * 1024;
/** How often a watched folder is read again. */
export const BRAIN_POLL_MS = 4000;
/** A Write / Edit of a memory names its writer for this long (its result comes back first; the scan follows). */
export const BRAIN_WRITER_TTL_MS = 120_000;
/** The changes kept (newest first); `tally` counts them all. */
export const BRAIN_MAX_CHANGES = 100;
const DESCRIPTION_MAX = 300;
const LINKS_MAX = 50;
const BROKEN_MAX = 200;
/** The CLI keeps a project folder name to 200 characters, then adds a hash (CLI 2.1.310). */
const KEY_MAX = 200;
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit"]);

// ---------------------------------------------------------------- where the memory is

/** Java's `String.hashCode` (the CLI's `sfe`): 32-bit, over UTF-16 code units. */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** The CLI's folder name for a project under `<config>/projects/`: every character but A–Z a–z 0–9 → "-"; over 200, cut + "-" + base-36 hash. */
export function projectKey(path: string): string {
  const key = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (key.length <= KEY_MAX) return key;
  return `${key.slice(0, KEY_MAX)}-${Math.abs(javaHash(path)).toString(36)}`;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** A linked worktree's main checkout, as the CLI checks it: `.git` → gitdir → its `commondir` and `gitdir` back-link. */
function mainCheckoutOf(root: string, dotGit: string): string | null {
  try {
    const text = readFileSync(dotGit, "utf8").trim();
    if (!text.startsWith("gitdir:")) return null;
    const gitdir = resolve(root, text.slice("gitdir:".length).trim());
    const common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
    if (realpathLenient(dirname(gitdir)) !== realpathLenient(join(common, "worktrees"))) return null;
    const back = resolve(gitdir, readFileSync(join(gitdir, "gitdir"), "utf8").trim());
    if (realpathLenient(back) !== realpathLenient(dotGit)) return null;
    return basename(common) === ".git" ? realpathLenient(dirname(common)) : realpathLenient(common);
  } catch {
    return null;
  }
}

/**
 * The checkout whose memory the CLI uses for `start` (CLI 2.1.310): the nearest folder upwards with a `.git`, and for a
 * linked worktree its main checkout — every worktree of a repository shares one memory folder (verified: `claude -p` in a
 * linked worktree names `<config>/projects/<main checkout>/memory/`). Real path; null outside a repository.
 */
export function canonicalRepoRoot(start: string): string | null {
  let cur = realpathLenient(start);
  for (;;) {
    const dotGit = join(cur, ".git");
    const st = lstatOrNull(dotGit);
    if (st && st.isDirectory()) return cur;
    if (st && st.isFile()) return mainCheckoutOf(cur, dotGit) ?? cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export type MemoryDirInfo = { dir: string; source: "cli" | "settings" | "default" };

/** `autoMemoryDirectory` of the user's settings (`~/` expanded; absolute only), else null. Only read. */
function settingsMemoryDir(configDir: string, home: string): string | null {
  let raw: unknown;
  try {
    raw = (JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as { autoMemoryDirectory?: unknown } | null)?.autoMemoryDirectory;
  } catch {
    return null;
  }
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) return null;
  let p = raw.trim();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const rest = p.slice(2);
    if (!rest || rest === "." || rest === ".." || rest.startsWith("../") || rest.startsWith("..\\")) return null;
    p = join(home, rest);
  }
  if (!isAbsolute(p)) return null;
  const clean = resolve(p).replace(/[\\/]+$/, "");
  if (clean.length < 3 || /^[A-Za-z]:$/.test(clean)) return null;
  return clean;
}

/**
 * Where this project's auto memory is: the MEMORY.md the CLI loaded (`extensions.memoryFiles`), else the user's
 * `autoMemoryDirectory`, else the CLI's rule — `<CLAUDE_CODE_REMOTE_MEMORY_DIR or config>/projects/<key of the main
 * checkout>/memory`.
 */
export function autoMemoryDir(opts: {
  projectPath: string;
  configDir: string;
  env: Record<string, string | undefined>;
  cliMemoryFiles?: readonly { path: string; type?: string }[] | null;
  home?: string;
}): MemoryDirInfo | null {
  const projects = join(opts.configDir, "projects");
  const fromCli = (opts.cliMemoryFiles ?? []).find((m) => typeof m.path === "string" && basename(m.path) === "MEMORY.md"
    && (/auto ?mem/i.test(m.type ?? "") || isInsidePath(resolve(m.path), projects)));
  if (fromCli) return { dir: dirname(resolve(fromCli.path)), source: "cli" };
  const configured = settingsMemoryDir(opts.configDir, opts.home ?? homedir());
  if (configured) return { dir: configured, source: "settings" };
  const root = canonicalRepoRoot(opts.projectPath) ?? realpathLenient(opts.projectPath);
  const base = opts.env.CLAUDE_CODE_REMOTE_MEMORY_DIR?.trim() || opts.configDir;
  return { dir: join(base, "projects", projectKey(root), "memory"), source: "default" };
}

// ---------------------------------------------------------------- reading a memory

export type ParsedMemory = { title?: string; description: string; type: BrainMemoryType; links: string[] };

/** One of the four memory kinds (any case), else undefined. */
export function memoryTypeOf(raw: string | undefined): BrainMemoryType | undefined {
  const t = raw?.trim().toLowerCase();
  return t && t !== "other" && (BRAIN_MEMORY_TYPES as readonly string[]).includes(t) ? (t as BrainMemoryType) : undefined;
}

/** `feedback_x` / `project-y` → that kind; anything else `other`. */
export function typeFromName(name: string): BrainMemoryType {
  return memoryTypeOf(name.split(/[_-]/)[0]) ?? "other";
}

function unquote(v: string): string {
  return v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
}

/** A frontmatter value: `key: value` (top level, or indented when `nested`); a `>` / `|` block takes its indented lines. */
function frontValue(block: string, key: string, nested: boolean): string | undefined {
  const lines = block.split(/\r?\n/);
  const re = new RegExp(nested ? `^[ \\t]+${key}:[ \\t]*(.*)$` : `^${key}:[ \\t]*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const v = m[1]!.trim();
    if (/^[>|][-+]?$/.test(v)) {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length && /^[ \t]+\S/.test(lines[j]!); j++) parts.push(lines[j]!.trim());
      const joined = parts.join(" ").trim();
      return joined || undefined;
    }
    const u = unquote(v);
    return u || undefined;
  }
  return undefined;
}

/** A [[link]]'s target: before `|` or `#`, the last path segment, without `.md`. */
function linkTarget(raw: string): string {
  const t = raw.split("|")[0]!.split("#")[0]!.trim();
  return basename(t.replace(/\\/g, "/")).replace(/\.md$/i, "").trim();
}

/** How names are compared: case, `-`, `_` and spaces do not matter. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "_");
}

function linksOf(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const t = linkTarget(m[1]!);
    if (!t || seen.has(nameKey(t))) continue;
    seen.add(nameKey(t));
    out.push(t);
    if (out.length >= LINKS_MAX) break;
  }
  return out;
}

/** Frontmatter (`name`, `description`, `type` at the top or under `metadata:`) and the body's [[links]]. */
export function parseMemory(name: string, text: string): ParsedMemory {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const block = fm?.[1] ?? "";
  const body = fm ? text.slice(fm[0].length) : text;
  const title = frontValue(block, "name", false);
  const description = (frontValue(block, "description", false) ?? "").replace(/\s+/g, " ").slice(0, DESCRIPTION_MAX);
  const type = memoryTypeOf(frontValue(block, "type", false) ?? frontValue(block, "type", true)) ?? typeFromName(name);
  return { ...(title ? { title: title.slice(0, DESCRIPTION_MAX) } : {}), description, type, links: linksOf(body) };
}

/** The memories MEMORY.md links, in order: `[text](name.md)` and `[[name]]` (web links left out). */
export function parseIndex(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+?\.md)>?[^)]*\)|\[\[([^\]\n]+?)\]\]/gi)) {
    let name: string;
    if (m[1] !== undefined) {
      if (m[1].includes("://")) continue;
      let target = m[1];
      try {
        target = decodeURIComponent(target);
      } catch {
        /* keep it as written */
      }
      name = linkTarget(target);
    } else {
      name = linkTarget(m[2]!);
    }
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    out.push(name);
  }
  return out;
}

/** Reads `path` up to `max` bytes without following a symlink (POSIX `O_NOFOLLOW`); null when it is not a regular file. */
async function readCapped(path: string, max: number): Promise<{ text: string; truncated: boolean } | null> {
  const flags = fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0);
  let fh;
  try {
    fh = await open(path, flags);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const size = Math.min(st.size, max);
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const { bytesRead } = await fh.read(buf, got, size - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    // A cut inside a multi-byte character decodes to U+FFFD: drop it.
    const text = new TextDecoder("utf-8").decode(buf.subarray(0, got)).replace(/�+$/, "");
    return { text, truncated: st.size > max };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- the folder over a session

type Entry = { name: string; mtime: number; size: number; parsed: ParsedMemory };
type Writer = { by: Exclude<BrainWriter, "external">; agentType?: string; at: number };

export type SubBrainOptions = {
  now?: () => number;
  /** A scan of a watched folder found a change: the engine sends it (`brain` without an id). */
  onChange: (ev: BrainEvent) => void;
  pollMs?: number;
  maxFiles?: number;
};

/** What a memory write's caller was (from the engine's agent tracker). */
export type BrainCaller = { by: Exclude<BrainWriter, "external">; agentType?: string };

export class SubBrain {
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly maxFiles: number;
  private info: MemoryDirInfo | null = null;
  private files = new Map<string, Entry>();
  private index: { names: string[]; mtime: number; size: number } | null = null;
  private exists = false;
  private truncated = false;
  private error: string | undefined;
  private baselineAt: number | null = null;
  private scannedAt: number | null = null;
  private changes: BrainChange[] = [];
  private tally = { add: 0, change: 0, remove: 0 };
  /** name → what this session did to it last (add / change); a removal drops it. */
  private touched = new Map<string, "add" | "change">();
  /** compareKey(path) → who is writing it; tool_use id → that path. */
  private writers = new Map<string, Writer>();
  private calls = new Map<string, string>();
  private watching = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped by `setDir` / `close`: a scan of an earlier folder drops its result. */
  private generation = 0;

  constructor(private readonly opts: SubBrainOptions) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? BRAIN_POLL_MS;
    this.maxFiles = opts.maxFiles ?? BRAIN_MAX_FILES;
  }

  get dir(): string | null {
    return this.info?.dir ?? null;
  }

  get hasBaseline(): boolean {
    return this.baselineAt !== null;
  }

  /** A new folder starts over (a new baseline at its first scan); the same one only takes the better `source`. */
  setDir(info: MemoryDirInfo | null): void {
    if (info && this.info && samePathKey(info.dir, this.info.dir)) {
      this.info = info;
      return;
    }
    this.generation++;
    this.info = info;
    this.files = new Map();
    this.index = null;
    this.exists = false;
    this.truncated = false;
    this.error = undefined;
    this.baselineAt = null;
    this.scannedAt = null;
    this.changes = [];
    this.tally = { add: 0, change: 0, remove: 0 };
    this.touched = new Map();
    this.writers = new Map();
    this.calls = new Map();
  }

  /** The project closed: no folder, no timer. */
  close(): void {
    this.setWatching(false);
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
    this.setDir(null);
  }

  /** `brain {watch}`: re-read every `pollMs` while a client shows the board. */
  setWatching(on: boolean): void {
    this.watching = on;
    if (on && !this.timer) {
      this.timer = setInterval(() => void this.scan(), this.pollMs);
      this.timer.unref?.();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isWatching(): boolean {
    return this.watching;
  }

  /** A Write / Edit / MultiEdit call: when it targets a memory, remember who makes it (until its result). */
  onToolUse(toolUseId: string, name: string, input: Record<string, unknown>, caller: BrainCaller): void {
    const dir = this.info?.dir;
    if (!dir || !EDIT_TOOLS.has(name)) return;
    const file = typeof input.file_path === "string" ? input.file_path : null;
    if (!file || !/\.md$/i.test(file) || !isInsidePath(resolve(file), resolve(dir))) return;
    const key = compareKey(resolve(file));
    this.writers.set(key, { ...caller, at: this.now() });
    this.calls.set(toolUseId, key);
  }

  /** Its result: a failure (denied, an error) leaves no writer; a success reads the folder right away. */
  onToolResult(toolUseId: string, isError: boolean): void {
    const key = this.calls.get(toolUseId);
    if (key === undefined) return;
    this.calls.delete(toolUseId);
    if (isError) {
      this.writers.delete(key);
      return;
    }
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.scan();
    }, 150);
    this.soon.unref?.();
  }

  /** Reads the folder (one scan at a time); true when something changed. */
  scan(): Promise<boolean> {
    const run = this.chain.then(() => this.scanOnce());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async scanOnce(): Promise<boolean> {
    const info = this.info;
    if (!info) return false;
    const gen = this.generation;
    const now = this.now();
    let exists = true;
    let error: string | undefined;
    let names: string[] = [];
    let allNames = new Set<string>();
    let indexStat: { mtime: number; size: number } | null = null;
    try {
      const ents = await readdir(info.dir, { withFileTypes: true });
      for (const e of ents) {
        if (!e.isFile() || !/\.md$/i.test(e.name)) continue; // a symlink is never a file here
        if (e.name.toLowerCase() === "memory.md") {
          const st = await lstat(join(info.dir, e.name)).catch(() => null);
          if (st?.isFile()) indexStat = { mtime: st.mtimeMs, size: st.size };
          continue;
        }
        allNames.add(e.name.slice(0, -3));
      }
      names = [...allNames].sort();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") exists = false;
      else error = `the memory folder could not be read (${code ?? "error"})`;
      allNames = new Set();
    }
    if (error !== undefined) {
      if (gen !== this.generation) return false;
      const changed = this.error !== error;
      this.error = error;
      this.scannedAt = now;
      if (changed && this.watching) this.opts.onChange(this.snapshot());
      return changed;
    }
    const truncated = names.length > this.maxFiles;
    if (truncated) names = names.slice(0, this.maxFiles);

    const next = new Map<string, Entry>();
    for (const name of names) {
      const path = join(info.dir, `${name}.md`);
      const st = await lstat(path).catch(() => null);
      if (!st?.isFile()) continue;
      const prev = this.files.get(name);
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
        next.set(name, prev);
        continue;
      }
      const read = await readCapped(path, BRAIN_MAX_FILE_BYTES);
      if (!read) continue;
      next.set(name, { name, mtime: st.mtimeMs, size: st.size, parsed: parseMemory(name, read.text) });
    }
    let index = this.index;
    if (!indexStat) index = null;
    else if (!index || index.mtime !== indexStat.mtime || index.size !== indexStat.size) {
      const read = await readCapped(join(info.dir, "MEMORY.md"), BRAIN_MAX_INDEX_BYTES);
      index = read ? { names: parseIndex(read.text), ...indexStat } : null;
    }
    if (gen !== this.generation) return false;

    const first = this.baselineAt === null;
    const added: Entry[] = [];
    const changed: Entry[] = [];
    const removed: Entry[] = [];
    if (!first) {
      for (const [name, e] of next) {
        const prev = this.files.get(name);
        if (!prev) added.push(e);
        else if (prev.mtime !== e.mtime || prev.size !== e.size) changed.push(e);
      }
      for (const [name, e] of this.files) if (!next.has(name) && !allNames.has(name)) removed.push(e);
    }
    const indexChanged = (index?.mtime ?? null) !== (this.index?.mtime ?? null) || (index?.size ?? null) !== (this.index?.size ?? null);
    const somethingChanged = first || added.length + changed.length + removed.length > 0 || indexChanged
      || exists !== this.exists || truncated !== this.truncated || this.error !== undefined;

    // Names cut by the cap stay known (not "removed"); a later scan without the cap would list them again.
    for (const [name, e] of this.files) if (!next.has(name) && allNames.has(name) && truncated) next.set(name, e);
    this.files = next;
    this.index = index;
    this.exists = exists;
    this.truncated = truncated;
    this.error = undefined;
    this.scannedAt = now;
    if (first) this.baselineAt = now;
    this.record(now, info.dir, added, changed, removed);
    this.pruneWriters(now);
    if (somethingChanged && this.watching) this.opts.onChange(this.snapshot());
    return somethingChanged;
  }

  private record(now: number, dir: string, added: Entry[], changed: Entry[], removed: Entry[]): void {
    const made: BrainChange[] = [];
    const push = (kind: BrainChangeKind, e: Entry) => {
      const w = this.takeWriter(join(dir, `${e.name}.md`), kind, now);
      made.push({
        at: now,
        kind,
        name: e.name,
        ...(e.parsed.title ? { title: e.parsed.title } : {}),
        type: e.parsed.type,
        description: e.parsed.description,
        by: w?.by ?? "external",
        ...(w?.by === "agent" && w.agentType ? { agentType: w.agentType } : {}),
      });
      this.tally[kind]++;
      if (kind === "remove") this.touched.delete(e.name);
      else this.touched.set(e.name, kind === "add" || this.touched.get(e.name) === "add" ? "add" : "change");
    };
    for (const e of added) push("add", e);
    for (const e of changed) push("change", e);
    for (const e of removed) push("remove", e);
    if (made.length) this.changes = [...made, ...this.changes].slice(0, BRAIN_MAX_CHANGES);
  }

  /** Who wrote `path` (seen within the TTL); a removal is never a Write / Edit. */
  private takeWriter(path: string, kind: BrainChangeKind, now: number): Writer | undefined {
    if (kind === "remove") return undefined;
    const key = compareKey(resolve(path));
    const w = this.writers.get(key);
    if (!w) return undefined;
    this.writers.delete(key);
    return now - w.at <= BRAIN_WRITER_TTL_MS ? w : undefined;
  }

  private pruneWriters(now: number): void {
    for (const [key, w] of this.writers) if (now - w.at > BRAIN_WRITER_TTL_MS) this.writers.delete(key);
  }

  /** The folder as last read (`brain`). */
  snapshot(): BrainEvent {
    const entries = [...this.files.values()].sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    const byKey = new Map<string, string>();
    for (const e of entries) if (!byKey.has(nameKey(e.name))) byKey.set(nameKey(e.name), e.name);
    const indexKeys = new Set((this.index?.names ?? []).map(nameKey));
    const hasIndex = this.index !== null;
    const counts = Object.fromEntries(BRAIN_MEMORY_TYPES.map((t) => [t, 0])) as Record<BrainMemoryType, number>;
    const brokenLinks: { from: string; to: string }[] = [];
    const memories: BrainMemory[] = entries.map((e) => {
      counts[e.parsed.type]++;
      const links: string[] = [];
      for (const raw of e.parsed.links) {
        const target = byKey.get(nameKey(raw));
        if (target === undefined) {
          if (brokenLinks.length < BROKEN_MAX) brokenLinks.push({ from: e.name, to: raw });
        } else if (target !== e.name && !links.includes(target)) links.push(target);
      }
      const session = this.touched.get(e.name);
      return {
        name: e.name,
        ...(e.parsed.title ? { title: e.parsed.title } : {}),
        type: e.parsed.type,
        description: e.parsed.description,
        mtime: e.mtime,
        size: e.size,
        indexed: hasIndex && indexKeys.has(nameKey(e.name)),
        links,
        ...(session ? { session } : {}),
      };
    });
    const unindexed = hasIndex ? memories.filter((m) => !m.indexed).map((m) => m.name).sort() : [];
    const missing = (this.index?.names ?? []).filter((n) => !byKey.has(nameKey(n)));
    let sessionCount = 0;
    for (const name of this.touched.keys()) if (this.files.has(name)) sessionCount++;
    return {
      type: "brain",
      dir: this.info?.dir ?? null,
      ...(this.info ? { dirSource: this.info.source } : {}),
      exists: this.exists,
      memories,
      counts,
      hasIndex,
      unindexed,
      missing,
      brokenLinks,
      changes: this.changes.map((c) => ({ ...c })),
      tally: { ...this.tally },
      sessionCount,
      baselineAt: this.baselineAt,
      scannedAt: this.scannedAt,
      ...(this.truncated ? { truncated: true as const } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      watching: this.watching,
    };
  }

  /** `brain_read`: one listed memory's text (≤ 64 KiB), never through a symlink, never outside the folder. */
  async read(name: unknown): Promise<BrainMemoryEvent> {
    if (typeof name !== "string" || !name || name.length > 255 || /[\\/\0]/.test(name) || name === "." || name === "..") {
      throw new CommandRefused("invalid_name");
    }
    const dir = this.info?.dir;
    if (!dir) throw new CommandRefused("brain_unavailable");
    if (!this.files.has(name)) throw new CommandRefused(`not_found: ${name}`);
    const path = join(dir, `${name}.md`);
    if (!isInsidePath(resolve(path), resolve(dir))) throw new CommandRefused("invalid_name");
    const read = await readCapped(path, BRAIN_MAX_FILE_BYTES);
    if (!read) throw new CommandRefused(`not_found: ${name}`);
    return { type: "brain_memory", name, path, text: read.text, ...(read.truncated ? { truncated: true as const } : {}) };
  }
}

function samePathKey(a: string, b: string): boolean {
  return compareKey(resolve(a)) === compareKey(resolve(b));
}
