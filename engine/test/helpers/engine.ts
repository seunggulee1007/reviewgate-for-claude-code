import { ReviewEngine, type EngineOptions } from "../../src/engine.js";
import type { Platform } from "../../src/platform/index.js";
import type { Budget, EffortLevel, EngineEvent, HelloCommand, PermissionMode, ReviewState, Settings, TurnUsage } from "../../src/protocol.js";
import type { ClaudeSessionLike, ClaudeSessionOptions, DenyOptions, PermissionSettings, SendUserOptions, SessionImage } from "../../src/session/claude.js";
import type { SessionEvent, ToolFileEntry } from "../../src/session/events.js";

/** Stands in for the Claude CLI: records sends, lets the test emit session events. */
export class FakeClaudeSession implements ClaudeSessionLike {
  readonly opts: ClaudeSessionOptions;
  readonly sends: { text: string; checkpointTree?: string; images?: readonly SessionImage[]; command?: SendUserOptions["command"] }[] = [];
  /** `set_model` calls that reached the live session (§25). */
  readonly models: (string | null)[] = [];
  readonly efforts: (EffortLevel | null)[] = [];
  readonly permissionResponses: { requestId: string; allow: boolean; message?: string; interrupt?: true }[] = [];
  budgets: Budget[] = [];
  permissionSettings: PermissionSettings[] = [];
  /** Every `set_permission_mode` this session took, in order. */
  permissionModes: PermissionMode[] = [];
  started = false;
  disposed = false;
  interrupts = 0;
  turnActive = false;
  /** When set, `sendUser` throws (simulates a dead session). */
  refuseSends: Error | null = null;
  /** When set, `start()` rejects. */
  failStart: Error | null = null;
  /** `start()` reports `session_ready` (the CLI answered initialize, §30); false = a CLI that dies before it. */
  readyOnStart = true;
  // MARK: wave4d w4d-peers — §42.2: the CLI child's pid (`cli_sessions.self`); unset like most doubles.
  pid?: number;

  constructor(opts: ClaudeSessionOptions) {
    this.opts = opts;
  }

  get isTurnActive(): boolean {
    return this.turnActive;
  }

  async start(): Promise<void> {
    if (this.failStart) throw this.failStart;
    this.started = true;
    if (this.readyOnStart) this.emit({ type: "session_ready" });
  }

  sendUser(text: string, checkpointTree?: string, images?: readonly SessionImage[], opts?: SendUserOptions): void {
    if (this.refuseSends) throw this.refuseSends;
    this.sends.push({ text, checkpointTree, ...(images && images.length > 0 ? { images } : {}), ...(opts?.command ? { command: opts.command } : {}) });
    this.turnActive = true;
  }

  /** §50: messages put into the running turn. */
  readonly steers: string[] = [];

  steerUser(text: string): void {
    if (this.refuseSends) throw this.refuseSends;
    if (!this.turnActive) throw new Error("no turn is running");
    this.steers.push(text);
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  respondPermission(requestId: string, allow: boolean, message?: string, _updatedInput?: Record<string, unknown>, opts?: DenyOptions): void {
    this.permissionResponses.push({ requestId, allow, message, ...(opts?.interrupt === true ? { interrupt: true as const } : {}) });
  }

  setBudget(budget: Budget): void {
    this.budgets.push(budget);
  }

  setPermissionSettings(settings: PermissionSettings): void {
    this.permissionSettings.push(settings);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionModes.push(mode);
  }

  async setModel(model: string | null): Promise<void> {
    this.models.push(model);
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    this.efforts.push(effort);
  }

  /** §29: releasePeers / dismissPeers / setPeerInbound calls, in order. */
  readonly peerCalls: { op: "release" | "dismiss" | "inbound"; ids?: string[]; tree?: string; value?: string }[] = [];
  /** §29: what `releasePeers` resolves with (default: every id) — or rejects with. */
  releaseResult: string[] | Error | null = null;

  async releasePeers(ids: readonly string[], checkpointTree?: string): Promise<string[]> {
    this.peerCalls.push({ op: "release", ids: [...ids], ...(checkpointTree !== undefined ? { tree: checkpointTree } : {}) });
    if (this.releaseResult instanceof Error) throw this.releaseResult;
    this.turnActive = true;
    return this.releaseResult ?? [...ids];
  }

  /** Like the CLI: every held message is dropped (refused) before the call returns. */
  async dismissPeers(ids: readonly string[]): Promise<string[]> {
    this.peerCalls.push({ op: "dismiss", ids: [...ids] });
    for (const id of ids) this.emit({ type: "peer_hold", state: "dropped", messageUuid: id, from: "", outcome: "refused" });
    return [...ids];
  }

  async setPeerInbound(value: "hold" | "refuse"): Promise<void> {
    this.peerCalls.push({ op: "inbound", value });
  }

  // MARK: wave3 engine-agents
  /** §36.2: the task ids `stopTask` was called with, in order; `stopTaskResult` (an Error) makes it reject. */
  readonly stopTasks: string[] = [];
  stopTaskResult: Error | null = null;

  async stopTask(taskId: string): Promise<void> {
    this.stopTasks.push(taskId);
    if (this.stopTaskResult) throw this.stopTaskResult;
  }

  // §52 background work
  backgroundWorkOn = true;
  /** `autoTurnReady` answers, in order. */
  readonly autoTurnAnswers: { ok: boolean; tree?: string }[] = [];
  /** `backgroundTasks` calls (Ctrl+B), in order; `backgroundResult` is what it resolves with (an Error rejects). */
  readonly backgroundCalls: (string | undefined)[] = [];
  backgroundResult: boolean | Error = true;
  /** task id → output file (`taskOutputFile`); live task ids (`isTaskLive`). */
  readonly taskFiles = new Map<string, string>();
  readonly liveTasks = new Set<string>();

  /** Like the real session on a turn the CLI starts itself: the turn counts as active, its calls wait for the engine. */
  emitAutoTurnStart(info: Omit<Extract<SessionEvent, { type: "auto_turn_start" }>, "type">): void {
    this.turnActive = true;
    this.emit({ type: "auto_turn_start", ...info });
  }

  autoTurnReady(ok: boolean, checkpointTree?: string): void {
    this.autoTurnAnswers.push({ ok, ...(checkpointTree !== undefined ? { tree: checkpointTree } : {}) });
    if (!ok) this.turnActive = false;
  }

  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    this.backgroundCalls.push(toolUseId);
    if (this.backgroundResult instanceof Error) throw this.backgroundResult;
    return this.backgroundResult;
  }

  taskOutputFile(taskId: string): string | null {
    return this.taskFiles.get(taskId) ?? null;
  }

  isTaskLive(taskId: string): boolean {
    return this.liveTasks.has(taskId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.turnActive = false;
  }

  emit(ev: SessionEvent): void {
    this.opts.emit(ev);
  }

  /** The v1 `session_info` a real session sends after the first user message. */
  emitSessionInfo(extra: Partial<Extract<SessionEvent, { type: "session_info" }>> = {}): void {
    this.emit({
      type: "session_info",
      sessionId: "sess-1",
      model: "claude-test",
      cwd: this.opts.cwd,
      slashCommands: ["commit"],
      skills: ["graphify"],
      plugins: [{ name: "p", path: "/p" }],
      mcpServers: [{ name: "fs", status: "connected" }],
      ...extra,
    });
  }

  /** Ends the current turn like the CLI's `result` message. */
  emitTurnEnd(opts: { stopReason?: string; usage?: Partial<TurnUsage>; toolFiles?: ToolFileEntry[]; budget?: { files: number; lines: number; denied: boolean }; changedOutside?: string[]; planFiles?: string[]; sessionId?: string; lastUuid?: string } = {}): void {
    this.turnActive = false;
    this.emit({
      type: "turn_end",
      stopReason: opts.stopReason ?? "end_turn",
      sessionId: opts.sessionId ?? "sess-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        durationMs: 1234,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 100,
        ...(opts.usage ?? {}),
      },
      toolFiles: opts.toolFiles ?? [],
      budget: opts.budget ?? { files: 0, lines: 0, denied: false },
      changedOutside: opts.changedOutside ?? [],
      planFiles: opts.planFiles ?? [],
      ...(opts.lastUuid ? { lastUuid: opts.lastUuid } : {}),
    });
    this.emit({ type: "activity", kind: "idle" });
  }
}

export const fakePlatform: Platform = {
  name: "linux",
  isWindows: false,
  which: async () => null,
  loginPATH: async (env) => env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin",
  openTerminal: async () => undefined,
  killTree: async () => undefined,
  ghConfigDir: () => "/nonexistent/gh",
  tmpDir: () => "/tmp",
};

export const testSettings: Settings = {
  budget: { maxFiles: 5, maxLines: 200 },
  ignorePatterns: [".omc/"],
  autoAllowTools: [],
  loadUserSettings: false,
  systemPromptAppend: "",
  // Must exist (the engine checks the override before starting the fake session): any executable will do.
  claudePath: process.platform === "win32" ? process.execPath : "/usr/bin/true",
  ghHost: "github.com",
};

export type Harness = {
  engine: ReviewEngine;
  events: EngineEvent[];
  states: ReviewState[];
  sessions: FakeClaudeSession[];
  /** The most recently created fake session. */
  session: () => FakeClaudeSession;
  /** Resolves once the engine has been quiet for a macrotask (state coalescing flushed). */
  settle: () => Promise<void>;
  /** Polls until `pred(state)` holds (≤ timeoutMs). */
  waitFor: (pred: (s: ReviewState) => boolean, what?: string, timeoutMs?: number) => Promise<ReviewState>;
  hello: (settings?: Partial<Settings>) => Promise<void>;
  open: (path: string) => Promise<ReviewState>;
  ofType: <T extends EngineEvent["type"]>(type: T) => Extract<EngineEvent, { type: T }>[];
};

/** `ready(index)`: whether the index-th fake session answers initialize on `start()` (default: every one does). */
export type FakeOptions = { ready?: (index: number) => boolean };

export function makeHarness(opts: EngineOptions = {}, fake: FakeOptions = {}): Harness {
  const events: EngineEvent[] = [];
  const states: ReviewState[] = [];
  const sessions: FakeClaudeSession[] = [];
  const engine = new ReviewEngine({
    platform: fakePlatform,
    now: () => 1_700_000_000_000,
    // The fake never ends an interrupted turn by itself: do not hold `interrupt` for the real 15 s.
    interruptWaitMs: 100,
    // M30 (§3): no automatic retry of a failed collection unless a test asks for one (`collectRetryMs`).
    collectRetryMs: 0,
    // §9.1: a switch stops the chat left at once, as before (engine.parkedSession.test.ts turns the parking on).
    parkIdleMs: 0,
    // Never read the developer's own ~/.claude (hooks / CLAUDE.md in state.session.extensions).
    env: { CLAUDE_CONFIG_DIR: "/nonexistent/reviewgate-test-claude-config" },
    sessionFactory: (o) => {
      const s = new FakeClaudeSession(o);
      if (fake.ready) s.readyOnStart = fake.ready(sessions.length);
      sessions.push(s);
      return s;
    },
    ...opts,
  });
  engine.on((ev) => {
    events.push(ev);
    if (ev.type === "state") states.push(ev.state);
  });
  const settle = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));
  const waitFor = async (pred: (s: ReviewState) => boolean, what = "condition", timeoutMs = 10_000): Promise<ReviewState> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = engine.state;
      if (pred(s)) return s;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; phase=${s.gate.phase} error=${s.lastError}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const hello = async (settings: Partial<Settings> = {}) => {
    const cmd: HelloCommand = { type: "hello", protocolVersion: 2, client: "test", settings: { ...testSettings, ...settings } };
    await engine.handle(cmd);
    await settle();
  };
  const open = async (path: string) => {
    await engine.handle({ type: "open_project", path });
    return waitFor((s) => !s.session.starting && (s.session.open || s.gitInit !== null || s.lastError !== null), "project open");
  };
  const ofType = <T extends EngineEvent["type"]>(type: T) => events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
  return { engine, events, states, sessions, session: () => sessions[sessions.length - 1]!, settle, waitFor, hello, open, ofType };
}
