import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CommandRefused } from "../errors.js";
import type { EngineEvent, SideAnchor, SideMessage, SideThread, SideToolCall } from "../protocol.js";
import { readJSON, writeAtomicJSON } from "../review/persist.js";
import { sessionTitle } from "../review/sessions.js";
import type { SessionLog } from "../session/events.js";
import { earlierBlock, PROMOTE_DRAFT_PROMPT, sideSessionTitle, summarizeInput } from "./context.js";
import { SIDE_READ_ONLY_REASON, SideQuery, type SideQueryEvent, type SideQueryOptions, type SideQueryResult } from "./sideQuery.js";

/**
 * Side threads ("곁질문", docs/PROTOCOL.md §21): per main chat, persisted in
 * `<gitdir>/reviewgate/side/<mainSessionId>.json`, each question run by its own `SideQuery`.
 */

export const SIDE_DIR = join("reviewgate", "side");
export const MAX_SIDE_THREADS = 30;
export const MAX_SIDE_MESSAGES = 200;
export const MAX_SIDE_TEXT = 20_000;
export const MAX_SIDE_QUESTION = 20_000;
export const MAX_SIDE_RUNNING = 3;
const MAX_TOOL_CALLS_PER_MESSAGE = 50;

type SideFile = { version: 1; threads: SideThread[] };

/** Session ids are uuids; anything else is mapped to a safe file name (never a path). */
function fileId(mainSessionId: string): string {
  return mainSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "_";
}

export function sideFilePath(gitDir: string, mainSessionId: string): string {
  return join(gitDir, SIDE_DIR, `${fileId(mainSessionId)}.json`);
}

/** Where a new side session starts from: a fork of the main session (at a chain uuid, or its whole history) or fresh. */
export type ForkSource = ({ mode: "fork_at"; sessionId: string; at: string } | { mode: "fork_full"; sessionId: string } | { mode: "fresh" }) & ForkTurns;

/**
 * §36.10 (wave3 engine-flow): the last main turn the fork contains (null: fresh) and the running main turn the first
 * prompt summarizes (null: none) — `SideThread.fork.atTurn` / `runningTurn`. Absent from a host that does not know them.
 */
export type ForkTurns = { atTurn?: number | null; runningTurn?: number | null };

function forkTurns(source: ForkTurns): ForkTurns {
  return { ...(source.atTurn !== undefined ? { atTurn: source.atTurn } : {}), ...(source.runningTurn !== undefined ? { runningTurn: source.runningTurn } : {}) };
}

/** What a question needs from the engine; launch options are resolved per question (toolchain / settings may change). */
export type SideHost = {
  gitDir(): string | null;
  forkSource(): ForkSource;
  /** Launch options without the per-question fields; throws a CommandRefused when no CLI is available. */
  launch(): Promise<Omit<SideQueryOptions, "prompt" | "emit" | "log" | "forkFrom" | "forkAt" | "resume" | "sessionId">>;
  /**
   * The first question's prompt with the anchor context (§36.10: and the running turn `source.runningTurn` names; §40.3:
   * and `earlier`, the thread's Q&A so far, when its side session is forked again).
   */
  firstPrompt(question: string, anchor: SideAnchor | null, source: ForkSource, earlier?: string): Promise<string>;
  emit(ev: EngineEvent): void;
  onCost(usd: number): void;
  log: SessionLog;
  /** Test seam (default `new SideQuery`). */
  makeQuery?: (o: SideQueryOptions) => SideQueryLike;
  // MARK: wave4b w4b-side — §40.3 the side sessions' own files
  /** Removes a side Claude session this app made (SDK `deleteSession`). Rejections are logged, never surfaced. */
  deleteSession?: (sessionId: string) => Promise<void>;
  /** Names a new side session in the CLI's session list (`claude --resume`; SDK `renameSession`). */
  renameSession?: (sessionId: string, title: string) => Promise<void>;
  /** True for an id of a chat of this project (never deleted as a side session). */
  isChat?: (sessionId: string) => boolean;
};

/** §40.3: a follow-up's side session is gone (the CLI cleaned it up, or the chat moved to another worktree). */
export function isMissingConversation(error: string | null): boolean {
  return !!error && /no conversation found|session .*not found/i.test(error);
}

/**
 * §40.3 (§39.4 chat move): hands a chat's threads to another worktree's git dir — unless it has threads of that chat
 * already. Their side sessions stay where they were made; a follow-up there forks again (`isMissingConversation`).
 */
export async function copySideThreads(fromGitDir: string, toGitDir: string, mainSessionId: string): Promise<boolean> {
  const file = await readJSON<SideFile>(sideFilePath(fromGitDir, mainSessionId));
  if (file?.version !== 1 || !Array.isArray(file.threads) || file.threads.length === 0) return false;
  const target = sideFilePath(toGitDir, mainSessionId);
  if ((await readJSON<SideFile>(target)) !== null) return false;
  await mkdir(join(toGitDir, SIDE_DIR), { recursive: true });
  await writeAtomicJSON(target, file);
  return true;
}

export type SideQueryLike = Pick<SideQuery, "run" | "interrupt" | "dispose">;

/** §36.11 / §36.13 (wave3 engine-flow): a one-shot read-only fork (`SideThreads.startDetached`). */
export type DetachedRun = {
  /** Its key among the running side queries (`commit_draft:<uuid>`, `prereview:<id>`); never a thread id. */
  key: string;
  prompt: string;
  /** On top of `SideHost.launch()` (`env` is merged). */
  options?: Partial<Pick<SideQueryOptions, "env" | "extraTools" | "allowWeb" | "maxTurns" | "system" | "persistSession" | "model" | "tools">>;
  onEvent?: (ev: SideQueryEvent) => void;
};

export type DetachedHandle = {
  /** How it started (before any fork_at → fork_full retry). */
  source: ForkSource;
  /** Settles with the result once the fork ended (never rejects). */
  done: Promise<SideQueryResult>;
  /** Interrupts it and waits for `done`. */
  cancel: () => Promise<void>;
};

function cap(text: string, max = MAX_SIDE_TEXT): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function normalizeThread(t: Partial<SideThread>, mainSessionId: string): SideThread | null {
  if (typeof t.id !== "string" || !Array.isArray(t.messages)) return null;
  const now = new Date().toISOString();
  const wasRunning = t.status === "running";
  return {
    id: t.id,
    mainSessionId,
    anchor: t.anchor && typeof t.anchor === "object" ? t.anchor : null,
    createdAt: typeof t.createdAt === "string" ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : now,
    title: typeof t.title === "string" ? t.title : "",
    messages: t.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string"),
    // A question that was running when the engine went away has no answer: the thread is usable again.
    status: wasRunning ? "error" : t.status === "error" ? "error" : "idle",
    error: wasRunning ? "interrupted (ReviewGate was closed)" : typeof t.error === "string" ? t.error : null,
    sessionId: typeof t.sessionId === "string" ? t.sessionId : null,
    fork: t.fork ?? null,
    costUSD: typeof t.costUSD === "number" && Number.isFinite(t.costUSD) ? t.costUSD : 0,
    ...(Array.isArray(t.promotions) ? { promotions: t.promotions } : {}),
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class SideThreads {
  private readonly host: SideHost;
  private mainSessionId: string | null = null;
  private threads: SideThread[] = [];
  private readonly running = new Map<string, { query: SideQueryLike; done: Promise<void> }>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(host: SideHost) {
    this.host = host;
  }

  get currentMainSessionId(): string | null {
    return this.mainSessionId;
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** Binds the threads of `mainSessionId` (null: none). Running questions must be stopped first (`stopAll`). */
  async load(mainSessionId: string | null): Promise<void> {
    this.mainSessionId = mainSessionId;
    this.threads = [];
    const dir = this.host.gitDir();
    if (!dir || !mainSessionId) return;
    const file = await readJSON<SideFile>(sideFilePath(dir, mainSessionId));
    if (file?.version === 1 && Array.isArray(file.threads)) {
      this.threads = file.threads.map((t) => normalizeThread(t, mainSessionId)).filter((t): t is SideThread => t !== null);
    }
  }

  /** The CLI renamed the current chat (another id than the pre-chosen one): its threads follow. */
  rebind(mainSessionId: string): void {
    if (this.mainSessionId === mainSessionId) return;
    this.mainSessionId = mainSessionId;
    for (const t of this.threads) t.mainSessionId = mainSessionId;
    if (this.threads.length > 0) this.save();
  }

  list(): SideThread[] {
    return [...this.threads].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).map(clone);
  }

  get(threadId: string): SideThread {
    const t = this.threads.find((x) => x.id === threadId);
    if (!t) throw new CommandRefused(`unknown_side_thread:${threadId}`);
    return t;
  }

  snapshot(threadId: string): SideThread {
    return clone(this.get(threadId));
  }

  /** `side_ask`: creates or continues a thread and starts the question; resolves once it runs (the answer streams). */
  async ask(threadId: string | undefined, anchor: SideAnchor | null, rawQuestion: string, opts: { refork?: boolean } = {}): Promise<SideThread> {
    if (!this.mainSessionId) throw new CommandRefused("no_project");
    const question = typeof rawQuestion === "string" ? rawQuestion.trim() : "";
    if (!question) throw new CommandRefused("empty_question");
    if (question.length > MAX_SIDE_QUESTION) throw new CommandRefused("question_too_long");
    let thread = threadId !== undefined ? this.get(threadId) : undefined;
    if (thread && this.running.has(thread.id)) throw new CommandRefused("side_busy");
    if (this.running.size >= MAX_SIDE_RUNNING) throw new CommandRefused("side_limit");
    const launch = await this.host.launch();
    const now = new Date().toISOString();
    if (!thread) {
      thread = {
        id: randomUUID(),
        mainSessionId: this.mainSessionId,
        anchor: anchor && Object.keys(anchor).length > 0 ? clone(anchor) : null,
        createdAt: now,
        updatedAt: now,
        title: sessionTitle(question),
        messages: [],
        status: "idle",
        error: null,
        sessionId: null,
        fork: null,
        costUSD: 0,
      };
      this.threads.push(thread);
      this.prune();
    }
    // A thread whose side session never came up (first question failed) forks again, with the anchor context.
    // §40.3: so does "최신 대화로 다시 묻기" (`refork`): the latest main conversation, with the thread's Q&A so far.
    const refork = opts.refork === true && thread.messages.length > 0;
    const fresh = thread.sessionId === null || refork;
    // §36.10: the fork source first — whether the prompt summarizes a running turn depends on how the fork starts.
    const source = fresh ? this.host.forkSource() : null;
    const earlier = fresh ? earlierBlock(thread.messages) : "";
    const prompt = source ? await this.host.firstPrompt(question, thread.anchor, source, ...(earlier ? [earlier] : [])) : question;
    const replaced = refork ? thread.sessionId : null;
    thread.messages.push({ role: "user", text: cap(question), at: now });
    if (thread.messages.length > MAX_SIDE_MESSAGES) thread.messages.splice(0, thread.messages.length - MAX_SIDE_MESSAGES);
    thread.status = "running";
    thread.error = null;
    thread.updatedAt = now;
    if (source) thread.fork = { mode: source.mode, fromSessionId: source.mode === "fresh" ? null : source.sessionId, at: source.mode === "fork_at" ? source.at : null, ...forkTurns(source) };
    this.changed(thread);
    const t = thread;
    const done = this.runQuestion(t, prompt, launch, source, { question, replaced }).catch((e) => this.host.log("warn", `side question failed: ${String(e)}`));
    // `runQuestion` registered the query synchronously before its first await.
    const entry = this.running.get(t.id);
    if (entry) entry.done = done;
    return clone(t);
  }

  private async runQuestion(
    thread: SideThread,
    prompt: string,
    launch: Awaited<ReturnType<SideHost["launch"]>>,
    source: ForkSource | null,
    more: { question: string; replaced: string | null } = { question: "", replaced: null },
  ): Promise<void> {
    const before = thread.sessionId;
    const assistant: SideMessage = { role: "assistant", text: "", at: new Date().toISOString(), toolCalls: [] };
    const calls = new Map<string, SideToolCall>();
    const onEvent = (ev: SideQueryEvent) => {
      switch (ev.type) {
        case "text_delta":
          assistant.text += ev.text;
          this.host.emit({ type: "side_text_delta", threadId: thread.id, text: ev.text });
          return;
        case "tool_use": {
          const call: SideToolCall = { id: ev.id, name: ev.name, input: clipInput(ev.input) };
          calls.set(ev.id, call);
          if (assistant.toolCalls!.length < MAX_TOOL_CALLS_PER_MESSAGE) assistant.toolCalls!.push(call);
          this.host.emit({ type: "side_tool_use", threadId: thread.id, id: ev.id, name: ev.name, input: ev.input });
          return;
        }
        case "tool_result": {
          const denied = ev.isError && ev.preview.includes(SIDE_READ_ONLY_REASON.slice(0, 40));
          const call = calls.get(ev.toolUseId);
          if (call) {
            call.isError = ev.isError;
            call.preview = ev.preview;
            if (denied) call.denied = true;
          }
          this.host.emit({ type: "side_tool_result", threadId: thread.id, toolUseId: ev.toolUseId, isError: ev.isError, preview: ev.preview, ...(denied ? { denied: true as const } : {}) });
          return;
        }
        case "session":
        case "denied":
          return;
      }
    };
    const start = (src: ForkSource | null, text = prompt): { query: SideQueryLike; presetId: string | null } => {
      const presetId = src ? randomUUID() : null;
      const opts: SideQueryOptions = {
        ...launch,
        prompt: text,
        emit: onEvent,
        log: this.host.log,
        ...(src === null ? { resume: thread.sessionId! } : {}),
        ...(src && src.mode !== "fresh" ? { forkFrom: src.sessionId } : {}),
        ...(src && src.mode === "fork_at" ? { forkAt: src.at } : {}),
        ...(presetId ? { sessionId: presetId } : {}),
      };
      const query = (this.host.makeQuery ?? ((o) => new SideQuery(o)))(opts);
      const prev = this.running.get(thread.id);
      this.running.set(thread.id, { query, done: prev?.done ?? Promise.resolve() });
      return { query, presetId };
    };
    let { query, presetId } = start(source);
    let result: SideQueryResult = await query.run();
    // Forking at the last completed turn failed before anything came back (the uuid is not in the chain): fork the whole history.
    if (result.error && !result.sawOutput && source?.mode === "fork_at" && this.running.get(thread.id)?.query === query) {
      this.host.log("warn", `side fork at ${source.at} failed (${result.error}); forking the whole main session`);
      // §36.10: the prompt (with any running-turn block) is the same; the fork now holds whatever the main session has.
      const full: ForkSource = { mode: "fork_full", sessionId: source.sessionId, ...forkTurns(source) };
      thread.fork = { mode: "fork_full", fromSessionId: source.sessionId, at: null, ...forkTurns(source) };
      ({ query, presetId } = start(full));
      result = await query.run();
    }
    // MARK: wave4b w4b-side — §40.3: the side session of a follow-up is gone: fork the main conversation again with the
    // thread's Q&A so far (the question just asked is the new prompt's question).
    let reforked: ForkSource | null = null;
    if (result.error && !result.sawOutput && source === null && isMissingConversation(result.error) && this.running.get(thread.id)?.query === query && this.threads.includes(thread)) {
      this.host.log("warn", `side session ${thread.sessionId} is gone (${firstLine(result.error)}); forking the main session again`);
      reforked = this.host.forkSource();
      const earlier = earlierBlock(thread.messages.slice(0, -1));
      const text = await this.host.firstPrompt(more.question, thread.anchor, reforked, ...(earlier ? [earlier] : []));
      thread.fork = { mode: reforked.mode, fromSessionId: reforked.mode === "fresh" ? null : reforked.sessionId, at: reforked.mode === "fork_at" ? reforked.at : null, ...forkTurns(reforked) };
      ({ query, presetId } = start(reforked, text));
      result = await query.run();
    }
    this.running.delete(thread.id);
    if (!this.threads.includes(thread)) return; // closed meanwhile
    const at = new Date().toISOString();
    assistant.text = cap(assistant.text.trim() || result.text);
    assistant.costUSD = result.costUSD;
    assistant.durationMs = result.durationMs;
    assistant.stopReason = result.stopReason;
    if (assistant.toolCalls!.length === 0) delete assistant.toolCalls;
    if (assistant.text || assistant.toolCalls || result.stopReason === "interrupted" || !result.error) thread.messages.push(assistant);
    if (result.sessionId && (result.sawOutput || !result.error)) thread.sessionId = result.sessionId;
    else if (presetId && result.sawOutput) thread.sessionId = presetId;
    // MARK: wave4b w4b-side — §40.3: a new fork is named in `claude --resume`; the side session it replaced is deleted.
    if ((source !== null || reforked !== null) && thread.sessionId !== null && thread.sessionId !== before) {
      const id = thread.sessionId;
      if (this.ownSideSession(thread, id)) void this.host.renameSession?.(id, sideSessionTitle(thread.title)).catch((e: unknown) => this.host.log("debug", `side session title: ${String(e)}`));
      if (more.replaced && more.replaced !== id) this.deleteSide(thread, more.replaced);
    }
    thread.costUSD += result.costUSD;
    if (result.costUSD > 0) this.host.onCost(result.costUSD);
    thread.status = result.error ? "error" : "idle";
    thread.error = result.error ? cap(result.error, 2000) : null;
    thread.updatedAt = at;
    this.host.emit({ type: "side_turn_end", threadId: thread.id, costUSD: result.costUSD, durationMs: result.durationMs, stopReason: result.stopReason });
    if (result.error) {
      this.host.emit({ type: "error", message: `Side question failed: ${firstLine(result.error)}`, fatal: false, scope: "session", code: "side_failed", threadId: thread.id });
    }
    this.changed(thread);
  }

  /**
   * `side_promote_draft`: asks the side session for an instruction to the main agent. Not part of the thread's
   * messages (nothing streams); its cost counts to the thread and `hud.sideCostUSD`.
   */
  async draft(threadId: string): Promise<string> {
    const thread = this.get(threadId);
    if (this.running.has(thread.id)) throw new CommandRefused("side_busy");
    if (!thread.sessionId || !thread.messages.some((m) => m.role === "assistant" && m.text)) throw new CommandRefused("side_no_answer");
    const launch = await this.host.launch();
    const query = (this.host.makeQuery ?? ((o) => new SideQuery(o)))({ ...launch, prompt: PROMOTE_DRAFT_PROMPT, resume: thread.sessionId, emit: () => {}, log: this.host.log });
    let release: () => void = () => {};
    this.running.set(thread.id, { query, done: new Promise<void>((r) => (release = r)) });
    thread.status = "running";
    this.changed(thread, false);
    let result: SideQueryResult;
    try {
      result = await query.run();
    } finally {
      this.running.delete(thread.id);
      release();
    }
    thread.costUSD += result.costUSD;
    if (result.costUSD > 0) this.host.onCost(result.costUSD);
    thread.status = "idle";
    this.changed(thread);
    if (result.error || !result.text) throw new CommandRefused(`side_draft_failed:${firstLine(result.error ?? "empty answer")}`, { code: "side_draft_failed" });
    return result.text;
  }

  notePromotion(threadId: string, as: "message" | "note", queued = false): void {
    const t = this.threads.find((x) => x.id === threadId);
    if (!t) return;
    const promotions = (t.promotions ??= []);
    promotions.push({ as, at: new Date().toISOString(), ...(queued ? { queued: true as const } : {}) }); // §40.3 queued
    if (promotions.length > 20) promotions.splice(0, promotions.length - 20);
    t.updatedAt = new Date().toISOString();
    this.changed(t);
  }

  // MARK: wave3 engine-flow — §36.11 / §36.13 one-shot read-only forks

  /**
   * Starts a read-only fork that is no thread (a commit draft, a pre-review): same fork source and launch options as a
   * first question (`forkSource()` / `launch()`, the fork_at → fork_full retry), counted in `MAX_SIDE_RUNNING` and stopped
   * by `stopAll`, its cost to `onCost`. Resolves once it runs; `done` settles with its result (never rejects).
   */
  async startDetached(run: DetachedRun): Promise<DetachedHandle> {
    if (!this.mainSessionId) throw new CommandRefused("no_project");
    if (this.running.has(run.key)) throw new CommandRefused("side_busy");
    if (this.running.size >= MAX_SIDE_RUNNING) throw new CommandRefused("side_limit");
    const launch = await this.host.launch();
    if (this.running.size >= MAX_SIDE_RUNNING) throw new CommandRefused("side_limit");
    const source = this.host.forkSource();
    let release: () => void = () => {};
    const settled = new Promise<void>((r) => (release = r));
    // §40.3 (wave4b w4b-side): a one-shot fork reads an untrusted patch — never the web, not even the user's allowed sites;
    // MARK: r2-skills-side — §21 (M18): nor the user's MCP servers (a read MCP tool could carry what it read out).
    const { webAllowed: _web, mcp: _mcp, ...base } = launch;
    const start = (src: ForkSource): SideQueryLike => {
      const opts: SideQueryOptions = {
        ...base,
        ...run.options,
        env: { ...launch.env, ...(run.options?.env ?? {}) },
        prompt: run.prompt,
        emit: (ev) => run.onEvent?.(ev),
        log: this.host.log,
        ...(src.mode !== "fresh" ? { forkFrom: src.sessionId } : {}),
        ...(src.mode === "fork_at" ? { forkAt: src.at } : {}),
        sessionId: randomUUID(),
      };
      const query = (this.host.makeQuery ?? ((o) => new SideQuery(o)))(opts);
      this.running.set(run.key, { query, done: settled });
      return query;
    };
    let query = start(source);
    const done = (async (): Promise<SideQueryResult> => {
      let result: SideQueryResult;
      try {
        result = await query.run();
        if (result.error && !result.sawOutput && source.mode === "fork_at" && this.running.get(run.key)?.query === query) {
          this.host.log("warn", `${run.key}: fork at ${source.at} failed (${result.error}); forking the whole main session`);
          query = start({ mode: "fork_full", sessionId: source.sessionId });
          result = await query.run();
        }
      } catch (e) {
        result = { sessionId: null, text: "", costUSD: 0, durationMs: 0, stopReason: "error", error: e instanceof Error ? e.message : String(e), sawOutput: false };
      } finally {
        this.running.delete(run.key);
        release();
      }
      if (result.costUSD > 0) this.host.onCost(result.costUSD);
      return result;
    })();
    return {
      source,
      done,
      cancel: async () => {
        await this.running.get(run.key)?.query.interrupt();
        await done;
      },
    };
  }

  async cancel(threadId: string): Promise<void> {
    this.get(threadId);
    const r = this.running.get(threadId);
    if (!r) return;
    await r.query.interrupt();
    await r.done;
  }

  async close(threadId: string): Promise<void> {
    const t = this.get(threadId);
    const r = this.running.get(threadId);
    this.threads = this.threads.filter((x) => x !== t);
    if (r) {
      await r.query.interrupt();
      await r.query.dispose();
    }
    this.running.delete(threadId);
    this.host.emit({ type: "side_thread_closed", threadId });
    this.save();
    if (t.sessionId) this.deleteSide(t, t.sessionId); // MARK: wave4b w4b-side — §40.3
  }

  /** Interrupts every running question and waits for them (≤ ~2.5 s each, in parallel). */
  async stopAll(): Promise<void> {
    const all = [...this.running.values()];
    await Promise.all(all.map(async (r) => {
      await r.query.interrupt();
      await r.done;
      await r.query.dispose();
    }));
    await this.saveChain;
  }

  /** Drops the side file of a deleted main chat. */
  async removeFor(mainSessionId: string): Promise<void> {
    const dir = this.host.gitDir();
    if (!dir) return;
    await this.deleteSessionsOf(dir, `${fileId(mainSessionId)}.json`, mainSessionId); // MARK: wave4b w4b-side — §40.3
    this.saveChain = this.saveChain.then(() => rm(sideFilePath(dir, mainSessionId), { force: true })).catch(() => undefined);
    await this.saveChain;
  }

  /** Deletes side files of chats that no longer exist. */
  async pruneFiles(liveSessionIds: string[]): Promise<void> {
    const dir = this.host.gitDir();
    if (!dir) return;
    const keep = new Set(liveSessionIds.map((id) => `${fileId(id)}.json`));
    const names = await readdir(join(dir, SIDE_DIR)).catch(() => [] as string[]);
    for (const n of names) {
      if (!n.endsWith(".json") || keep.has(n)) continue;
      await this.deleteSessionsOf(dir, n, null); // MARK: wave4b w4b-side — §40.3
      await rm(join(dir, SIDE_DIR, n), { force: true }).catch(() => undefined);
    }
  }

  // MARK: wave4b w4b-side — §40.3 the side sessions' own files, a chat that continues under another id

  /** A side session id this app made for `thread`: never the main chat's, the fork's source, or any chat of the project. */
  private ownSideSession(thread: Pick<SideThread, "mainSessionId" | "fork">, id: string): boolean {
    if (!id || id === thread.mainSessionId || id === this.mainSessionId || id === thread.fork?.fromSessionId) return false;
    return this.host.isChat?.(id) !== true;
  }

  /** Deletes `id` (a side session of `thread`) unless another thread of this chat still uses it. */
  private deleteSide(thread: Pick<SideThread, "mainSessionId" | "fork">, id: string): void {
    const del = this.host.deleteSession;
    if (!del || !this.ownSideSession(thread, id) || this.threads.some((t) => t.sessionId === id)) return;
    void del(id).catch((e: unknown) => this.host.log("debug", `side session ${id} not deleted: ${String(e)}`));
  }

  /** The side sessions a chat's side file (`name` in the side dir) names: deleted before the file goes. */
  private async deleteSessionsOf(dir: string, name: string, mainSessionId: string | null): Promise<void> {
    const del = this.host.deleteSession;
    if (!del) return;
    const file = await readJSON<SideFile>(join(dir, SIDE_DIR, name)).catch(() => null);
    if (file?.version !== 1 || !Array.isArray(file.threads)) return;
    for (const t of file.threads) {
      if (!t || typeof t.sessionId !== "string") continue;
      const main = mainSessionId ?? (typeof t.mainSessionId === "string" ? t.mainSessionId : "");
      if (!this.ownSideSession({ mainSessionId: main, fork: t.fork ?? null }, t.sessionId)) continue;
      await del(t.sessionId).catch((e: unknown) => this.host.log("debug", `side session ${t.sessionId} not deleted: ${String(e)}`));
    }
  }

  /**
   * The chat goes on under `newId` (대화 되돌리기): its threads go with it and the old id keeps none. Running questions
   * must be stopped first (`stopAll`).
   */
  async moveTo(newId: string): Promise<void> {
    const old = this.mainSessionId;
    if (!old || old === newId) return;
    const dir = this.host.gitDir();
    const had = this.threads.length > 0;
    this.rebind(newId);
    await this.saveChain;
    if (dir && had) await rm(sideFilePath(dir, old), { force: true }).catch(() => undefined);
  }

  /** Keeps the newest `MAX_SIDE_THREADS` threads (running ones are never dropped). */
  private prune(): void {
    if (this.threads.length <= MAX_SIDE_THREADS) return;
    const order = [...this.threads].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    const drop = new Set<SideThread>();
    for (const t of order) {
      if (this.threads.length - drop.size <= MAX_SIDE_THREADS) break;
      if (!this.running.has(t.id)) drop.add(t);
    }
    this.threads = this.threads.filter((t) => !drop.has(t));
    for (const t of drop) if (t.sessionId) this.deleteSide(t, t.sessionId); // MARK: wave4b w4b-side — §40.3
  }

  private changed(thread: SideThread, persist = true): void {
    this.host.emit({ type: "side_thread", thread: clone(thread) });
    if (persist) this.save();
  }

  private save(): void {
    const dir = this.host.gitDir();
    const main = this.mainSessionId;
    if (!dir || !main) return;
    const file: SideFile = { version: 1, threads: this.threads.map(clone) };
    this.saveChain = this.saveChain
      .then(async () => {
        await mkdir(join(dir, SIDE_DIR), { recursive: true });
        await writeAtomicJSON(sideFilePath(dir, main), file);
      })
      .catch((e) => this.host.log("warn", `persist side threads: ${String(e)}`));
  }

  flush(): Promise<void> {
    return this.saveChain;
  }
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? s).trim().slice(0, 300);
}

/** Persisted / wire copy of a tool input: long strings cut so a thread file stays small. */
function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(input);
  if (text.length <= 2000) return input;
  return { _preview: summarizeInput(input) ?? text.slice(0, 600) };
}
