import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionMeta, TranscriptItem } from "../protocol.js";
import { readJSON, writeAtomicJSON } from "./persist.js";
import { TRANSCRIPT_FILE, TranscriptStore } from "./transcript.js";

/**
 * Chat sessions (docs/M15-POLISH.md): `<gitdir>/reviewgate/sessions/index.json` lists every session of
 * the worktree (`SessionMeta`), `<gitdir>/reviewgate/sessions/<id>.ndjson` is its transcript. The
 * legacy single `reviewgate-transcript.ndjson` is moved into the first session on first open.
 */
export const SESSIONS_DIR = join("reviewgate", "sessions");
export const SESSIONS_INDEX_FILE = "index.json";
export const NEW_CHAT_TITLE = "New chat";
export const SESSION_TITLE_MAX = 60;

export type SessionsIndexFile = { version: 1; sessions: SessionMeta[] };

export function sessionsDir(gitDir: string): string {
  return join(gitDir, SESSIONS_DIR);
}

export function sessionsIndexPath(gitDir: string): string {
  return join(sessionsDir(gitDir), SESSIONS_INDEX_FILE);
}

export function sessionTranscriptPath(gitDir: string, id: string): string {
  return join(sessionsDir(gitDir), `${id}.ndjson`);
}

/** Title rule: the first non-empty line of the first user message, cut to ≤ 60 chars. */
export function sessionTitle(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (line.length === 0) return NEW_CHAT_TITLE;
  return line.length > SESSION_TITLE_MAX ? line.slice(0, SESSION_TITLE_MAX - 1).trimEnd() + "…" : line;
}

/** Ordering of `state.sessions.list`: newest activity first. */
function newestFirst(a: SessionMeta, b: SessionMeta): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return 0;
}

/** §26 `forkedFrom` as stored, or null when it is not a `{sessionId, turn}` pair (it is then dropped, the chat still loads). */
function normalizeFork(v: unknown): SessionMeta["forkedFrom"] | null {
  if (!v || typeof v !== "object") return null;
  const { sessionId, turn } = v as { sessionId?: unknown; turn?: unknown };
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) return null;
  return { sessionId, turn };
}

function normalizeMeta(o: Partial<SessionMeta>): SessionMeta | null {
  if (typeof o.id !== "string" || o.id.length === 0) return null;
  const now = new Date().toISOString();
  const forkedFrom = normalizeFork(o.forkedFrom);
  return {
    id: o.id,
    title: typeof o.title === "string" && o.title.length > 0 ? o.title : NEW_CHAT_TITLE,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : now,
    turns: typeof o.turns === "number" && Number.isFinite(o.turns) ? o.turns : 0,
    costUSD: typeof o.costUSD === "number" && Number.isFinite(o.costUSD) ? o.costUSD : 0,
    lastUserText: typeof o.lastUserText === "string" ? o.lastUserText : null,
    ...(o.archived === true ? { archived: true } : {}),
    ...(o.resumeFailed === true ? { resumeFailed: true } : {}),
    ...(forkedFrom ? { forkedFrom } : {}),
    ...(o.cliKnown === true ? { cliKnown: true } : {}),
    ...normalizeImported(o.imported), // MARK: wave3 engine-session (§36.9)
    ...normalizeMove("movedTo", o.movedTo), // MARK: wave4b w4b-follow (§39.4)
    ...normalizeMove("movedFrom", o.movedFrom),
    ...(typeof o.planFile === "string" && o.planFile ? { planFile: o.planFile } : {}), // MARK: wave4d w4d-plan (§42.1)
  };
}

/** MARK: wave4b w4b-follow — §39.4 `movedTo` / `movedFrom {path, name, at}` as stored; dropped when malformed (the chat still loads). */
function normalizeMove<K extends "movedTo" | "movedFrom">(key: K, v: unknown): Pick<SessionMeta, K> | Record<string, never> {
  if (!v || typeof v !== "object") return {};
  const { path, name, at } = v as { path?: unknown; name?: unknown; at?: unknown };
  if (typeof path !== "string" || !path || typeof at !== "string" || !at) return {};
  return { [key]: { path, name: typeof name === "string" && name ? name : path, at } } as Pick<SessionMeta, K>;
}

/** MARK: wave3 engine-session — §36.9 `imported {at, cwd}` as stored; dropped when malformed (the chat still loads). */
function normalizeImported(v: unknown): Pick<SessionMeta, "imported"> {
  if (!v || typeof v !== "object") return {};
  const { at, cwd } = v as { at?: unknown; cwd?: unknown };
  if (typeof at !== "string" || !at) return {};
  return { imported: { at, cwd: typeof cwd === "string" && cwd ? cwd : null } };
}

/** Meta derived from a transcript (the legacy migration): title / turns / cost / times from the rows. */
function metaFromRows(id: string, rows: TranscriptItem[], now: string): SessionMeta {
  const meta: SessionMeta = { id, title: NEW_CHAT_TITLE, createdAt: rows[0]?.at ?? now, updatedAt: rows[rows.length - 1]?.at ?? now, turns: 0, costUSD: 0, lastUserText: null };
  for (const r of rows) {
    if (r.kind === "user_message") {
      if (meta.title === NEW_CHAT_TITLE) meta.title = sessionTitle(r.text);
      meta.lastUserText = r.text;
    } else if (r.kind === "turn_end") {
      meta.turns += 1;
      meta.costUSD += r.usage.costUsd;
    }
  }
  return meta;
}

/** In-memory mirror of `index.json`; the engine serializes `save()` behind its persist chain. */
export class SessionIndex {
  private sessions: SessionMeta[] = [];

  private constructor(
    readonly gitDir: string,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Loads the index and migrates the legacy transcript file: `reviewgate-transcript.ndjson` becomes
   * `sessions/<legacySessionId | uuid>.ndjson` with a meta derived from its rows; the old path is read
   * once, then deleted.
   */
  static async open(gitDir: string, legacySessionId: string | null, log: (message: string) => void = () => {}): Promise<SessionIndex> {
    const index = new SessionIndex(gitDir, log);
    const file = await readJSON<Partial<SessionsIndexFile>>(sessionsIndexPath(gitDir));
    if (file && file.version === 1 && Array.isArray(file.sessions)) {
      index.sessions = file.sessions.map((s) => normalizeMeta(s ?? {})).filter((s): s is SessionMeta => s !== null);
    }
    let dirty = false;
    const legacy = join(gitDir, TRANSCRIPT_FILE);
    if (existsSync(legacy)) {
      const id = legacySessionId ?? randomUUID();
      const rows = new TranscriptStore(legacy, undefined, log).tail(Number.MAX_SAFE_INTEGER);
      try {
        mkdirSync(sessionsDir(gitDir), { recursive: true });
        const target = sessionTranscriptPath(gitDir, id);
        if (existsSync(target)) {
          appendFileSync(target, readFileSync(legacy));
          rmSync(legacy, { force: true });
        } else {
          renameSync(legacy, target);
        }
        if (!index.get(id)) index.sessions.push(metaFromRows(id, rows, new Date().toISOString()));
        dirty = true;
        log(`migrated ${TRANSCRIPT_FILE} (${rows.length} row(s)) into session ${id}`);
      } catch (e) {
        log(`transcript migration failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (dirty) await index.save();
    return index;
  }

  /** Newest first. */
  list(): SessionMeta[] {
    return [...this.sessions].sort(newestFirst);
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** A fresh "New chat" (id = new uuid unless given). */
  create(id: string = randomUUID(), now: string = new Date().toISOString()): SessionMeta {
    const meta: SessionMeta = { id, title: NEW_CHAT_TITLE, createdAt: now, updatedAt: now, turns: 0, costUSD: 0, lastUserText: null };
    this.sessions.push(meta);
    return meta;
  }

  /**
   * MARK: wave4b w4b-follow — §39.4: a chat handed over from another worktree — its meta (normalized; replaces one with the
   * same id, e.g. a chat that comes back) and its rows (`rowsPath` moved in as its transcript file; none = no rows).
   */
  adopt(meta: SessionMeta, rowsPath: string | null): SessionMeta | null {
    const m = normalizeMeta(meta);
    if (!m) return null;
    const target = sessionTranscriptPath(this.gitDir, m.id);
    try {
      mkdirSync(sessionsDir(this.gitDir), { recursive: true });
      rmSync(target, { force: true });
      if (rowsPath && existsSync(rowsPath)) {
        try {
          renameSync(rowsPath, target);
        } catch {
          appendFileSync(target, readFileSync(rowsPath));
          rmSync(rowsPath, { force: true });
        }
      }
    } catch (e) {
      this.log(`moved chat ${m.id}: rows not taken (${e instanceof Error ? e.message : String(e)})`);
    }
    this.sessions = [...this.sessions.filter((s) => s.id !== m.id), m];
    return m;
  }

  /** Drops the meta and its transcript file. */
  remove(id: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    rmSync(sessionTranscriptPath(this.gitDir, id), { force: true });
  }

  /**
   * The CLI reported `to` for the session we know as `from` (pre-generated id not honoured, or a
   * test double): the meta and transcript file follow. An existing `to` absorbs `from` (rows appended).
   */
  rename(from: string, to: string): void {
    const meta = this.get(from);
    if (!meta || from === to) return;
    const src = sessionTranscriptPath(this.gitDir, from);
    const dst = sessionTranscriptPath(this.gitDir, to);
    const existing = this.get(to);
    try {
      if (existsSync(src)) {
        mkdirSync(sessionsDir(this.gitDir), { recursive: true });
        if (existsSync(dst)) {
          appendFileSync(dst, readFileSync(src));
          rmSync(src, { force: true });
        } else {
          renameSync(src, dst);
        }
      }
    } catch (e) {
      this.log(`session rename ${from} → ${to} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (existing) {
      existing.turns += meta.turns;
      existing.costUSD += meta.costUSD;
      if (meta.updatedAt > existing.updatedAt) existing.updatedAt = meta.updatedAt;
      if (existing.title === NEW_CHAT_TITLE && meta.title !== NEW_CHAT_TITLE) existing.title = meta.title;
      if (meta.lastUserText !== null) existing.lastUserText = meta.lastUserText;
      this.sessions = this.sessions.filter((s) => s !== meta);
    } else {
      meta.id = to;
    }
  }

  transcript(id: string): TranscriptStore {
    return new TranscriptStore(sessionTranscriptPath(this.gitDir, id), undefined, this.log);
  }

  /** Atomic write of `index.json` (creates the directory). */
  async save(): Promise<void> {
    mkdirSync(sessionsDir(this.gitDir), { recursive: true });
    const value: SessionsIndexFile = { version: 1, sessions: this.list() };
    await writeAtomicJSON(sessionsIndexPath(this.gitDir), value);
  }
}
