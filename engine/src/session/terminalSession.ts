/**
 * docs/PROTOCOL.md §57.4: a terminal chat's session — the real `claude` TUI runs in the app's PTY; this object only
 * receives its http hooks (HookServer) and turns them into the session events the engine already takes from a
 * ClaudeSession: `terminal_prompt` (a review turn starts: snapshot A, answered with `answerPrompt`), `auto_turn_start`
 * (a write tool with no turn open), `tool_use` / `tool_result` / `tool_files` / `bash_snapshot` (attribution), and
 * `turn_end` (snapshot B: the review). It never starts or stops the CLI.
 */
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTask, PermissionMode, TerminalSessionState, TerminalWaiting } from "../protocol.js";
import { openCheckpoint } from "../git/checkpoint.js";
import { normalizeForCompare } from "../platform/paths.js";
import { isReadOnlyCommand } from "./bashClass.js";
import { BudgetState } from "./budget.js";
import type { ClaudeSessionLike } from "./claude.js";
import type { SessionEvent, SessionLog, ToolFileEntry } from "./events.js";
import { retiredAnswer, RETIRED_REASON, type HookOutput, type TerminalHookHandler } from "./hookServer.js";
import {
  bashBaseline,
  changedBetween,
  containmentRoot,
  finishWindow,
  GIT_MUTATING_RE,
  isOutsideRoot,
  isPlanFile,
  openWindow,
  readOnlyContextOf,
  toolFile,
  UNPROMPTED_REASON,
  type HookContext,
} from "./hooks.js";
import { changedWithin, WINDOW_MARGIN_MS } from "./provenance.js";
import { editScopeReason } from "./reviewScope.js";

/** The engine's answer to a `terminal_prompt`. */
export type PromptAnswer = { ok: true; additionalContext: string | null; checkpointTree: string } | { ok: false; reason: string };

export type TerminalSessionOptions = {
  /** The chat's id (`SessionMeta.id`): every `turn_end` carries it, so the engine never renames the chat after `/clear`. */
  chatId: string;
  /** The CLI conversation the terminal runs (`cliSessionId ?? id`); a hook with another one emits `terminal_session_id`. */
  cliSessionId: string;
  /** Where claude runs (the project folder). */
  cwd: string;
  /** Settings.ignorePatterns — paths the post-Bash diff skips. */
  ignorePatterns: string[];
  /** How long a prompt waits for the engine's answer (the engine's own bound is a little shorter). */
  promptWaitMs: number;
  /** How long a write tool with no turn open waits for `autoTurnReady`. */
  adoptWaitMs?: number;
  /** Override of the plans folder (plan files are no outside edits). */
  plansDir?: string;
  scratchDirs?: readonly string[];
  emit: (ev: SessionEvent) => void;
  log: SessionLog;
  /** Test seams. */
  now?: () => number;
  windowMarginMs?: number;
};

/** A prompt the engine did not answer in time is blocked with this (the user sends it again). */
export const PROMPT_TIMEOUT_REASON = "ReviewGate could not start the review of this prompt in time (it is still busy). Send it again.";

const PREVIEW_CHARS = 400;
const EDIT_TOOLS_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const PERMISSION_MODES: ReadonlySet<string> = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);

type Touched = { path: string; tools: Set<string>; count: number; toolUseIds: string[] };
type OpenTurn = { promptId: string | null; hookPromptId: string | null; openedAt: number };
type Waiter<T> = { resolve: (v: T) => void; timer: NodeJS.Timeout };

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function preview(v: unknown): string {
  if (v === undefined || v === null) return "";
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
}

export class TerminalSession implements ClaudeSessionLike, TerminalHookHandler {
  /** The exec'd claude's pid (`terminal_started`); never reported as another Claude in the worktree. */
  pid: number | undefined;
  private cliSessionId: string;
  private running = false;
  private hooksSeen = false;
  private waiting: TerminalWaiting | null = null;
  private interruptSuspected = false;
  private open: OpenTurn | null = null;
  private disposed = false;
  private token: string | null = null;
  private retireToken: ((token: string) => void) | null = null;
  private prompt: Waiter<PromptAnswer> | null = null;
  private adoption: { promise: Promise<boolean>; waiter: Waiter<{ ok: boolean; tree?: string }> } | null = null;
  private lastBgTasks = 0;
  private ctx: HookContext;
  private touched = new Map<string, Touched>();
  private changedOutside = new Set<string>();
  private editsSinceBash = new Set<string>();

  constructor(private readonly opts: TerminalSessionOptions) {
    this.cliSessionId = opts.cliSessionId;
    this.ctx = this.freshContext();
  }

  get chatId(): string {
    return this.opts.chatId;
  }

  /** The CLI conversation the terminal runs now. */
  get cliSession(): string {
    return this.cliSessionId;
  }

  get state(): TerminalSessionState {
    return {
      running: this.running,
      hooksSeen: this.hooksSeen,
      promptId: this.open?.promptId ?? null,
      waiting: this.waiting ? { ...this.waiting } : null,
      interruptSuspected: this.interruptSuspected,
    };
  }

  get isTurnActive(): boolean {
    return this.open !== null;
  }

  // ---- ClaudeSessionLike: the TUI does all of this itself

  async start(): Promise<void> {
    this.opts.emit({ type: "session_ready" });
  }

  sendUser(_text?: string): void {
    throw new Error("terminal_chat: the terminal takes its prompts in the TUI");
  }

  async interrupt(): Promise<void> {}
  respondPermission(): void {}
  setBudget(): void {}
  setPermissionSettings(): void {}
  async setPermissionMode(): Promise<void> {}

  /** Retires the token and answers every hook still waiting with block / deny. Emits nothing. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.setToken(null);
    this.settlePrompt({ ok: false, reason: RETIRED_REASON });
    this.settleAdoption({ ok: false });
  }

  /** §52 path: the engine took (true, with A's tree) or refused (false) the turn a write tool started. */
  autoTurnReady(ok: boolean, checkpointTree?: string): void {
    if (!this.adoption) {
      // The calls stopped waiting (denied) before the engine took the turn: it ends at once, so the gate opens again.
      if (ok && !this.disposed && !this.open) {
        this.opts.log("warn", "terminal: the review turn started after its tool call was denied; ending it");
        this.open = { promptId: null, hookPromptId: null, openedAt: this.now() };
        this.closeTurn("adopt_timeout");
      }
      return;
    }
    this.settleAdoption(ok ? { ok, ...(checkpointTree !== undefined ? { tree: checkpointTree } : {}) } : { ok });
  }

  // ---- what the engine calls

  /** A new spawn (`terminal_spec`): its token (the previous one is retired); not running, no hook seen until it shows. */
  setToken(token: string | null, retire?: (token: string) => void): void {
    if (this.token && this.retireToken) this.retireToken(this.token);
    this.token = token;
    if (retire) this.retireToken = retire;
    this.running = false;
    this.hooksSeen = false;
    this.waiting = null;
  }

  /** `terminal_started`: the PTY runs claude. */
  started(pid: number): void {
    this.pid = pid;
    this.running = true;
    this.touch();
  }

  /** The engine's answer to `terminal_prompt`. A late ok (the prompt was blocked meanwhile) ends the turn it opened. */
  answerPrompt(a: PromptAnswer): void {
    if (this.prompt) {
      this.settlePrompt(a);
      return;
    }
    if (a.ok) {
      this.opts.log("warn", "terminal: the review turn started after its prompt was blocked; ending it");
      this.open = { promptId: null, hookPromptId: null, openedAt: this.now() };
      this.closeTurn("prompt_timeout");
    }
  }

  /** `terminal_exited`: the PTY ended — an open turn ends. */
  ptyExited(): void {
    this.running = false;
    this.waiting = null;
    this.settlePrompt({ ok: false, reason: RETIRED_REASON });
    this.settleAdoption({ ok: false });
    if (this.open) this.closeTurn("terminal_exited");
    else this.touch();
  }

  /** "Review now" (`terminal_end_turn`): false when no turn is open. */
  endTurnByUser(): boolean {
    if (!this.open) return false;
    this.closeTurn("ended_by_user");
    return true;
  }

  // ---- hooks

  async handleHook(input: Record<string, unknown>): Promise<HookOutput> {
    const event = input.hook_event_name;
    if (this.disposed) return retiredAnswer(event);
    this.hooksSeen = true;
    const sid = str(input.session_id);
    if (sid && sid !== this.cliSessionId) {
      this.cliSessionId = sid;
      this.opts.emit({ type: "terminal_session_id", sessionId: sid });
    }
    if (event !== "Notification") this.waiting = null;
    const mode = input.permission_mode;
    if (typeof mode === "string" && PERMISSION_MODES.has(mode)) this.ctx.permissionMode = mode as PermissionMode;
    try {
      switch (event) {
        case "UserPromptSubmit":
          return await this.onPrompt(input);
        case "PreToolUse":
          return await this.onPreTool(input);
        case "PostToolUse":
        case "PostToolUseFailure":
          await this.onPostTool(input);
          return {};
        case "Stop":
          this.onStop(input, "end_turn");
          return {};
        case "StopFailure": {
          const error = str(input.error) ?? "unknown";
          const details = str(input.error_details);
          this.opts.emit({ type: "error", message: `Claude Code stopped on an API error: ${error}${details ? ` (${details})` : ""}`, fatal: false, code: "api_error" });
          this.onStop(input, `stop_failure:${error}`);
          return {};
        }
        case "Notification":
          this.onNotification(input);
          return {};
        case "SessionEnd":
          if (this.open) this.closeTurn("session_end");
          return {};
        default:
          return {};
      }
    } finally {
      this.touch();
    }
  }

  private async onPrompt(input: Record<string, unknown>): Promise<HookOutput> {
    const promptId = str(input.prompt_id);
    if (this.open) {
      if (promptId !== null && this.open.hookPromptId === promptId) {
        this.opts.log("info", `terminal: prompt ${promptId} again while its turn is open; it stays one turn`);
        return {};
      }
      // The Esc rule (§57.4): a turn left open by an interrupt ends at the next prompt.
      this.closeTurn("interrupted");
    }
    this.settlePrompt({ ok: false, reason: PROMPT_TIMEOUT_REASON }); // a stale wait (never: the CLI waits for each prompt)
    const answer = new Promise<PromptAnswer>((resolve) => {
      const timer = setTimeout(() => this.settlePrompt({ ok: false, reason: PROMPT_TIMEOUT_REASON }), this.opts.promptWaitMs);
      timer.unref?.();
      this.prompt = { resolve, timer };
    });
    this.opts.emit({ type: "terminal_prompt", prompt: typeof input.prompt === "string" ? input.prompt : "", promptId });
    const a = await answer;
    if (!a.ok) return { decision: "block", reason: a.reason };
    this.openTurn({ promptId, hookPromptId: promptId, openedAt: this.now() }, a.checkpointTree);
    return a.additionalContext ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: a.additionalContext } } : {};
  }

  private async onPreTool(input: Record<string, unknown>): Promise<HookOutput> {
    if (!this.open) {
      const ready = await this.adopt(str(input.prompt_id));
      if (!ready.ok) {
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: UNPROMPTED_REASON } };
      }
    }
    if (input.tool_name === "Bash") await this.beforeBash(input);
    return {};
  }

  /** A write tool with no turn open: the engine takes it as a turn Claude started (§52.1) — one wait for every call. */
  private async adopt(hookPromptId: string | null): Promise<{ ok: boolean }> {
    let pending = this.adoption;
    if (!pending) {
      let waiter!: Waiter<{ ok: boolean; tree?: string }>;
      const promise = new Promise<{ ok: boolean; tree?: string }>((resolve) => {
        const timer = setTimeout(() => this.settleAdoption({ ok: false }), this.opts.adoptWaitMs ?? 55_000);
        timer.unref?.();
        waiter = { resolve, timer };
      }).then((r) => {
        if (r.ok && !this.open && !this.disposed) this.openTurn({ promptId: null, hookPromptId, openedAt: this.now() }, r.tree);
        return r.ok;
      });
      pending = this.adoption = { promise, waiter };
      this.opts.emit({ type: "auto_turn_start", trigger: "continue", ...(hookPromptId ? { commandUuid: hookPromptId } : {}) });
    }
    return { ok: await pending.promise };
  }

  private async onPostTool(input: Record<string, unknown>): Promise<void> {
    const name = str(input.tool_name) ?? "";
    const id = str(input.tool_use_id);
    const ti = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    const failed = input.hook_event_name === "PostToolUseFailure";
    if (failed && input.is_interrupt === true) this.interruptSuspected = true;
    if (!this.open) {
      this.opts.log("debug", `terminal: ${name} ended with no review turn open`);
      return;
    }
    if (!id) return;
    const result = (): void => this.opts.emit({ type: "tool_result", toolUseId: id, isError: failed, preview: preview(failed ? input.error : input.tool_response) });
    if (name === "Bash") {
      this.opts.emit({ type: "tool_use", id, name, input: ti });
      await this.afterBash(input, id, String(ti.command ?? ""));
      result();
      return;
    }
    if (!EDIT_TOOLS_RE.test(name)) return;
    const file = toolFile(ti, this.opts.cwd);
    this.opts.emit({ type: "tool_use", id, name, input: ti, ...(file ? { file } : {}) });
    if (file && !failed) {
      this.touch_(file, name, id);
      this.editsSinceBash.add(normalizeForCompare(file));
      if (!isPlanFile(file, this.ctx)) {
        const reason = editScopeReason(file, await containmentRoot(this.ctx), isOutsideRoot, [], this.opts.scratchDirs);
        if (reason && reason.code !== "claude_config") this.changedOutside.add(file);
      }
    }
    result();
  }

  private onStop(input: Record<string, unknown>, stopReason: string): void {
    this.noteBackgroundTasks(input.background_tasks);
    if (this.open) this.closeTurn(stopReason);
    else this.opts.log("debug", `terminal: ${String(input.hook_event_name)} with no review turn open`);
  }

  /** §52: the background tasks Stop names (risk 6) — so the engine keeps A for the next turn while they may still write. */
  private noteBackgroundTasks(raw: unknown): void {
    const list = Array.isArray(raw) ? raw : [];
    if (list.length === 0 && this.lastBgTasks === 0) return;
    this.lastBgTasks = list.length;
    const at = new Date(this.now()).toISOString();
    const tasks: BackgroundTask[] = list.map((t, i) => {
      const o = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
      const type = str(o.type) ?? str(o.task_type) ?? "";
      return {
        taskId: str(o.id) ?? str(o.task_id) ?? str(o.taskId) ?? `terminal-bg-${i}`,
        kind: /bash/i.test(type) ? "bash" : /agent/i.test(type) ? "agent" : /monitor/i.test(type) ? "monitor" : "other",
        description: str(o.description) ?? str(o.command) ?? str(o.summary) ?? "background task",
        toolUseId: str(o.tool_use_id) ?? null,
        turn: null,
        startedAt: at,
        hasOutput: false,
      };
    });
    this.opts.emit({ type: "background_tasks", tasks });
  }

  private onNotification(input: Record<string, unknown>): void {
    const type = str(input.notification_type) ?? "";
    const message = typeof input.message === "string" ? input.message : "";
    const title = str(input.title);
    const since = new Date(this.now()).toISOString();
    if (type === "permission_prompt" || type === "agent_needs_input") this.waiting = { kind: "permission", message, since };
    else if (type === "elicitation_dialog") this.waiting = { kind: "question", message, since };
    else if (type === "idle_prompt") {
      // The Esc rule (§57.4): the TUI waits for the next prompt — a turn left open by an interrupt ends here.
      this.waiting = null;
      if (this.open) this.closeTurn("interrupted");
      return;
    } else this.waiting = null;
    if (this.waiting) this.opts.emit({ type: "terminal_attention", notificationType: type, message, ...(title ? { title } : {}) });
  }

  // ---- the turn

  private freshContext(): HookContext {
    return {
      budget: new BudgetState({ maxFiles: 0, maxLines: 0 }),
      cwd: this.opts.cwd,
      ignorePatterns: this.opts.ignorePatterns,
      autoAllowTools: new Set(),
      ...(this.opts.plansDir ? { plansDir: this.opts.plansDir } : {}),
      ...(this.opts.scratchDirs ? { scratchDirs: this.opts.scratchDirs } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
      readOnlyBash: new Set(),
      toolWindows: new Map(),
      onBashFiles: () => undefined, // set: bashBaseline takes a base only when attribution is on
      emit: this.opts.emit,
      log: this.opts.log,
    };
  }

  private openTurn(turn: OpenTurn, checkpointTree: string | undefined): void {
    const prior = this.ctx;
    this.ctx = this.freshContext();
    // The checkpoint and the root stay (the same repository); the per-turn rest starts over.
    if (prior.checkpoint) this.ctx.checkpoint = prior.checkpoint;
    if (prior.root) this.ctx.root = prior.root;
    if (prior.permissionMode) this.ctx.permissionMode = prior.permissionMode;
    if (checkpointTree !== undefined) this.ctx.checkpointTree = checkpointTree;
    this.touched = new Map();
    this.changedOutside = new Set();
    this.editsSinceBash = new Set();
    this.interruptSuspected = false;
    this.open = turn;
  }

  private closeTurn(stopReason: string): void {
    const turn = this.open;
    if (!turn) return;
    this.open = null;
    this.interruptSuspected = false;
    const toolFiles: ToolFileEntry[] = [...this.touched.values()].map((t) => ({ path: t.path, tools: [...t.tools], count: t.count, toolUseIds: [...t.toolUseIds] }));
    this.opts.emit({
      type: "turn_end",
      stopReason,
      sessionId: this.opts.chatId,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: Math.max(0, this.now() - turn.openedAt), cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0 },
      toolFiles,
      budget: { files: 0, lines: 0, denied: false },
      changedOutside: [...this.changedOutside].sort(),
      planFiles: [],
      toolWindows: [...(this.ctx.toolWindows?.values() ?? [])].filter((w) => w.end !== null).map((w) => ({ ...w })),
    });
  }

  private touch_(file: string, tool: string, toolUseId: string): void {
    const key = normalizeForCompare(file);
    const entry = this.touched.get(key) ?? { path: file, tools: new Set<string>(), count: 0, toolUseIds: [] };
    entry.tools.add(tool);
    entry.count++;
    if (!entry.toolUseIds.includes(toolUseId)) entry.toolUseIds.push(toolUseId);
    this.touched.set(key, entry);
  }

  /** Before a Bash call: a read-only one takes no snapshot (§31); otherwise the turn's base, then the call's window. */
  private async beforeBash(input: Record<string, unknown>): Promise<void> {
    const ti = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    const command = String(ti.command ?? "");
    const id = str(input.tool_use_id);
    const cwd = str(input.cwd) ?? this.opts.cwd;
    let readOnly = false;
    try {
      readOnly = isReadOnlyCommand(command, await readOnlyContextOf(this.ctx, cwd));
    } catch {
      readOnly = false;
    }
    if (readOnly && ti.run_in_background !== true && id) this.ctx.readOnlyBash?.add(id);
    else await bashBaseline(this.ctx);
    openWindow(this.ctx, input as unknown as HookInput, command);
  }

  /** After a Bash call (it ran, or failed after running): what it changed — postBash's attribution without budget or notices. */
  private async afterBash(input: Record<string, unknown>, toolUseId: string, command: string): Promise<void> {
    const ctx = this.ctx;
    const window = finishWindow(ctx, input as unknown as HookInput);
    if (/\bworktree\b/.test(command)) ctx.worktrees = undefined;
    if (ctx.readOnlyBash?.delete(toolUseId)) return;
    if (!ctx.checkpointTree) return;
    try {
      if (!ctx.checkpoint) ctx.checkpoint = await openCheckpoint(ctx.cwd);
      const cp = ctx.checkpoint;
      const tree = await cp.snapshot();
      const base = ctx.bashBaseTree ?? ctx.checkpointTree;
      ctx.bashBaseTree = tree;
      // §46: what a git command changed (a merge brings in another branch's files) is not Claude's.
      const changed = GIT_MUTATING_RE.test(command) ? [] : await changedBetween(cp, base, tree, ctx.ignorePatterns);
      const within = window ? await changedWithin(changed, window, cp.root, this.opts.windowMarginMs ?? WINDOW_MARGIN_MS) : changed;
      const attributed = within.filter((f) => !this.editsSinceBash.has(normalizeForCompare(f)));
      this.editsSinceBash = new Set();
      for (const f of attributed) this.touch_(f, "Bash", toolUseId);
      if (attributed.length > 0) this.opts.emit({ type: "tool_files", toolUseId, files: attributed });
      this.opts.emit({ type: "bash_snapshot", toolUseId, tree, root: cp.root });
    } catch (e) {
      this.opts.log("debug", `terminal: snapshot after Bash failed: ${String(e)}`);
    }
  }

  // ---- waits

  private settlePrompt(a: PromptAnswer): void {
    const w = this.prompt;
    if (!w) return;
    this.prompt = null;
    clearTimeout(w.timer);
    w.resolve(a);
  }

  private settleAdoption(r: { ok: boolean; tree?: string }): void {
    const a = this.adoption;
    if (!a) return;
    this.adoption = null;
    clearTimeout(a.waiter.timer);
    a.waiter.resolve(r);
  }

  private touch(): void {
    if (!this.disposed) this.opts.emit({ type: "terminal_state" });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
