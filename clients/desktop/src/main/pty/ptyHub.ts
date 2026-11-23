/**
 * MARK: terminal-win — PROTOCOL §57.17: one PtyHub per window (Workbench). It owns that window's PTYs in main: at most one
 * terminal chat PTY (the engine has one live session), the shell panel's tabs and its Run tab's commands (§57.18).
 *
 * - The renderer never supplies a file, args, env or cwd. For a chat, main asks the engine for `terminal_spec` itself,
 *   builds the launch (terminalLaunch.ts), spawns, and sends `terminal_started` / `terminal_exited`: the hook token and
 *   the argv never leave main (and are never logged).
 * - Output: a 512 KiB replay ring per PTY (renderer reloads), batches flushed every 5 ms or at 64 KiB, and VS Code's flow
 *   control — over 100,000 unacknowledged characters the PTY pauses, below 5,000 it resumes.
 * - Lifecycle: switching chats, closing or changing the project, closing the window and quitting end the PTYs (the engine
 *   state observer lives here, in main, so it holds even when the renderer crashed). A kill closes the pseudoconsole;
 *   a process still alive 3 s later gets its whole tree killed.
 * Everything outside (node-pty, the engine, the window, timers' clock, kill) is injected: ptyHub.test.ts runs it with fakes.
 */
import { randomUUID } from "node:crypto";
import type { EngineCommand, ReviewState, TerminalSpecEvent } from "@reviewgate/engine";
import type { PtyAttach, PtyExit, PtyListEntry, PtyOpen, PtyOpenResult, ShellKind } from "../../shared/ipc.js";
import type { RunConfig } from "../../shared/runConfigs.js";
import { requestWithDetails, type EngineLike } from "../engineRequest.js";
import type { Launch, LaunchRefusal } from "./terminalLaunch.js";

/** What the hub needs of a node-pty `IPty`. */
export type PtyProcess = {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
};
export type PtySpawnOptions = {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  encoding: "utf8";
  useConpty?: boolean;
  useConptyDll?: boolean;
  conptyInheritCursor?: boolean;
};
export type PtySpawn = (file: string, args: string | string[], opts: PtySpawnOptions) => PtyProcess;

export type HubEngine = EngineLike & {
  readonly state: ReviewState;
  handle(cmd: EngineCommand): Promise<unknown>;
};

export type PtyHubDeps = {
  /** The webContents id of the window that owns every PTY of this hub. */
  ownerId: number;
  engine: HubEngine;
  /** node-pty's spawn, or null when node-pty is unavailable (`unavailable` says why). */
  spawn: PtySpawn | null;
  unavailable: string | null;
  platform: NodeJS.Platform;
  /** `rg:pty:data` / `rg:pty:exit` to the owner window (dropped when it is gone). */
  send(channel: "rg:pty:data", ptyId: string, data: string): void;
  send(channel: "rg:pty:exit", exit: PtyExit): void;
  setIgnoreMenuShortcuts(ignore: boolean): void;
  chatLaunch(spec: TerminalSpecEvent): Launch | LaunchRefusal;
  shellLaunch(shell: ShellKind, cwd: string): Launch;
  /** MARK: c-panel — §57.18: a kept command in Settings' terminal shell. */
  runLaunch(command: string, cwd: string): Launch;
  /** §57.18: the kept, runnable command of `runId` for the window's repository (a detected one only once confirmed); null: none. */
  runCommand(runId: string): string | null;
  /** §57.18: the candidates the project folder's files offer (read only). */
  detectRuns(cwd: string): RunConfig[];
  /** The window's project folder (worktree / workbench) for a new shell tab; null without a project. */
  projectPath(): string | null;
  isAlive(pid: number): boolean;
  killTree(pid: number): Promise<void>;
  log(level: "info" | "warn", msg: string): void;
  now?: () => number;
};

export const RING_BYTES = 512 * 1024;
export const BATCH_MS = 5;
export const BATCH_MAX = 64 * 1024;
export const HIGH_WATER = 100_000;
export const LOW_WATER = 5_000;
export const KILL_GRACE_MS = 3_000;
export const QUICK_EXIT_MS = 10_000;
export const MAX_INPUT = 1024 * 1024;

type Entry = {
  id: string;
  kind: "chat" | "shell" | "run";
  sessionId?: string;
  shell?: ShellKind;
  runId?: string;
  pty: PtyProcess;
  cols: number;
  rows: number;
  startedAt: number;
  running: boolean;
  exit: PtyExit | null;
  ring: string;
  batch: string;
  timer: ReturnType<typeof setTimeout> | null;
  unacked: number;
  paused: boolean;
  killReason: PtyExit["reason"] | null;
  terminating: Promise<void> | null;
  exited: Promise<void>;
  markExited: () => void;
  subs: { dispose(): void }[];
};

const clampInt = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null;

function refusal(code: string, error: string): PtyOpenResult {
  return { ok: false, code, error };
}

export class PtyHub {
  private readonly entries = new Map<string, Entry>();
  private readonly pendingChat = new Map<string, Promise<PtyOpenResult>>();
  private closing = false;
  private projectKey: string | null | undefined = undefined;
  private readonly now: () => number;

  constructor(private readonly d: PtyHubDeps) {
    this.now = d.now ?? Date.now;
  }

  /** The sender must be the owner window; anything else is ignored and logged. */
  private owns(senderId: number, what: string): boolean {
    if (senderId === this.d.ownerId) return true;
    this.d.log("warn", `pty: ${what} from webContents ${senderId} ignored (owner ${this.d.ownerId})`);
    return false;
  }

  private entryFor(senderId: number, ptyId: unknown, what: string): Entry | null {
    if (!this.owns(senderId, what)) return null;
    const e = typeof ptyId === "string" ? this.entries.get(ptyId) : undefined;
    if (!e) this.d.log("warn", `pty: ${what} for an unknown pty ignored`);
    return e ?? null;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  async open(senderId: number, raw: unknown): Promise<PtyOpenResult> {
    if (!this.owns(senderId, "open")) return refusal("not_current", "not this window's terminal");
    const req = raw as Partial<PtyOpen> | null;
    const cols = clampInt(req?.cols, 2, 1000);
    const rows = clampInt(req?.rows, 1, 500);
    if (!req || typeof req !== "object" || cols === null || rows === null) return refusal("invalid_request", "invalid terminal request");
    if (this.closing) return refusal("pty_unavailable", "the window is closing");
    if (!this.d.spawn) return refusal("pty_unavailable", this.d.unavailable ?? "no PTY");
    if (req.kind === "chat" && typeof req.sessionId === "string" && req.sessionId.length > 0) {
      const sessionId = req.sessionId;
      // A remount racing the first open gets the same answer.
      const pending = this.pendingChat.get(sessionId);
      if (pending) return pending;
      const p = this.openChat(sessionId, cols, rows).finally(() => this.pendingChat.delete(sessionId));
      this.pendingChat.set(sessionId, p);
      return p;
    }
    if (req.kind === "shell" && (req.shell === "powershell" || req.shell === "cmd")) return this.openShell(req.shell, cols, rows);
    if (req.kind === "run" && typeof req.runId === "string" && req.runId.length > 0 && req.runId.length <= 100) return this.openRun(req.runId, cols, rows);
    return refusal("invalid_request", "invalid terminal request");
  }

  private isCurrentTerminal(sessionId: string): boolean {
    const st = this.d.engine.state;
    if (st.sessions?.currentId !== sessionId) return false;
    return st.sessions.list.some((m) => m.id === sessionId && m.kind === "terminal");
  }

  private chatEntry(): Entry | undefined {
    return [...this.entries.values()].find((e) => e.kind === "chat");
  }

  private async openChat(sessionId: string, cols: number, rows: number): Promise<PtyOpenResult> {
    if (!this.isCurrentTerminal(sessionId)) return refusal("not_current", "not the current terminal chat");
    const existing = this.chatEntry();
    if (existing?.running && existing.sessionId === sessionId) return { ok: true, ptyId: existing.id };
    // At most one chat PTY per window: another chat's (or an exited one) goes first.
    if (existing) {
      await this.terminate(existing, "switched");
      this.entries.delete(existing.id);
    }
    const reply = await requestWithDetails(this.d.engine, { type: "terminal_spec", sessionId });
    if ("__error" in reply) return refusal(reply.__code ?? "spawn_failed", reply.__error);
    const spec = reply as TerminalSpecEvent;
    const launch = this.d.chatLaunch(spec);
    if (!launch.ok) return refusal(launch.code, launch.error);
    // The state may have moved on while the engine answered.
    if (this.closing) return refusal("pty_unavailable", "the window is closing");
    if (!this.isCurrentTerminal(sessionId)) return refusal("not_current", "not the current terminal chat");
    const spawned = this.spawnEntry(launch, cols, rows, { kind: "chat", sessionId });
    if (!spawned.ok) return spawned;
    const entry = this.entries.get(spawned.ptyId)!;
    this.d.log("info", `chat PTY started pid=${entry.pty.pid} resume=${spec.resume}`);
    await this.d.engine.handle({ type: "terminal_started", sessionId, pid: entry.pty.pid }).catch(() => undefined);
    return spawned;
  }

  private openShell(shell: ShellKind, cols: number, rows: number): PtyOpenResult {
    const cwd = this.d.projectPath();
    if (!cwd) return refusal("no_project", "no project is open in this window");
    const r = this.spawnEntry(this.d.shellLaunch(shell, cwd), cols, rows, { kind: "shell", shell });
    if (r.ok) this.d.log("info", `shell PTY started (${shell}) pid=${this.entries.get(r.ptyId)!.pty.pid}`);
    return r;
  }

  /**
   * MARK: c-panel — §57.18: a Run tab command. The renderer names only the kept config's id; main reads its command from
   * the settings (refused when it is not kept, or detected and not yet confirmed). One PTY per id: a running one first ends.
   */
  private async openRun(runId: string, cols: number, rows: number): Promise<PtyOpenResult> {
    const cwd = this.d.projectPath();
    if (!cwd) return refusal("no_project", "no project is open in this window");
    const command = this.d.runCommand(runId);
    if (command === null) return refusal("not_confirmed", "this command is not kept or not confirmed");
    for (const e of [...this.entries.values()]) {
      if (e.kind !== "run" || e.runId !== runId) continue;
      await this.terminate(e, "killed");
      this.entries.delete(e.id);
    }
    if (this.closing) return refusal("pty_unavailable", "the window is closing");
    const r = this.spawnEntry(this.d.runLaunch(command, cwd), cols, rows, { kind: "run", runId });
    // The command is the user's; only its id goes to the log.
    if (r.ok) this.d.log("info", `run PTY started (${runId}) pid=${this.entries.get(r.ptyId)!.pty.pid}`);
    return r;
  }

  /** §57.18: Run tab candidates of this window's project folder (nothing runs). */
  detectRuns(senderId: number): RunConfig[] {
    if (!this.owns(senderId, "detect runs")) return [];
    const cwd = this.d.projectPath();
    if (!cwd) return [];
    try {
      return this.d.detectRuns(cwd);
    } catch (err) {
      this.d.log("warn", `run: detection failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private spawnEntry(launch: Launch, cols: number, rows: number, what: { kind: "chat"; sessionId: string } | { kind: "shell"; shell: ShellKind } | { kind: "run"; runId: string }): PtyOpenResult {
    let pty: PtyProcess;
    try {
      pty = this.d.spawn!(launch.file, launch.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: launch.cwd,
        env: launch.env,
        encoding: "utf8",
        ...(this.d.platform === "win32" ? { useConpty: true, useConptyDll: true, conptyInheritCursor: false } : {}),
      });
    } catch (err) {
      // The message may name the program; never the argv or env.
      const msg = err instanceof Error ? err.message : String(err);
      this.d.log("warn", `pty: spawn failed: ${msg}`);
      return refusal("spawn_failed", msg);
    }
    let markExited = () => undefined as void;
    const exited = new Promise<void>((r) => (markExited = r));
    const e: Entry = {
      id: randomUUID(),
      ...what,
      pty,
      cols,
      rows,
      startedAt: this.now(),
      running: true,
      exit: null,
      ring: "",
      batch: "",
      timer: null,
      unacked: 0,
      paused: false,
      killReason: null,
      terminating: null,
      exited,
      markExited,
      subs: [],
    };
    this.entries.set(e.id, e);
    e.subs.push(pty.onData((data) => this.onData(e, data)));
    e.subs.push(pty.onExit(({ exitCode }) => this.onExit(e, exitCode)));
    return { ok: true, ptyId: e.id };
  }

  private onData(e: Entry, data: string): void {
    if (!e.running) return;
    e.ring += data;
    if (e.ring.length > RING_BYTES) e.ring = e.ring.slice(e.ring.length - RING_BYTES);
    e.batch += data;
    if (e.batch.length >= BATCH_MAX) this.flush(e);
    else e.timer ??= setTimeout(() => this.flush(e), BATCH_MS);
  }

  private flush(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    if (!e.batch) return;
    const chunk = e.batch;
    e.batch = "";
    this.d.send("rg:pty:data", e.id, chunk);
    e.unacked += chunk.length;
    if (!e.paused && e.unacked > HIGH_WATER && e.running) {
      e.paused = true;
      try {
        e.pty.pause();
      } catch {
        /* exiting */
      }
    }
  }

  private onExit(e: Entry, exitCode: number | null): void {
    if (!e.running) return;
    this.flush(e);
    e.running = false;
    for (const s of e.subs.splice(0)) s.dispose();
    let quickNoHooks = false;
    if (e.kind === "chat" && e.sessionId) {
      const st = this.d.engine.state;
      const current = st.sessions?.currentId === e.sessionId;
      quickNoHooks = current && e.killReason === null && this.now() - e.startedAt < QUICK_EXIT_MS && st.session.terminal?.hooksSeen !== true;
      // Lenient: a chat switched away from has nothing to end.
      void this.d.engine.handle({ type: "terminal_exited", sessionId: e.sessionId, exitCode }).catch(() => undefined);
      this.d.log("info", `chat PTY exited code=${exitCode ?? "none"}${e.killReason ? ` (${e.killReason})` : ""}`);
    }
    e.exit = { ptyId: e.id, exitCode, quickNoHooks, reason: e.killReason ?? "exited" };
    this.d.send("rg:pty:exit", e.exit);
    e.markExited();
  }

  /** Ends a running PTY: close the pseudoconsole, then the whole tree if it is still alive after 3 s. Once per PTY. */
  private terminate(e: Entry, reason: PtyExit["reason"]): Promise<void> {
    if (!e.running) return Promise.resolve();
    e.killReason ??= reason;
    e.terminating ??= this.terminateNow(e);
    return e.terminating;
  }

  private async terminateNow(e: Entry): Promise<void> {
    try {
      e.pty.kill();
    } catch {
      /* already gone */
    }
    if (await this.waitExit(e, KILL_GRACE_MS)) return;
    if (this.d.isAlive(e.pty.pid)) await this.d.killTree(e.pty.pid).catch(() => undefined);
    if (await this.waitExit(e, KILL_GRACE_MS)) return;
    this.onExit(e, null); // the PTY never said so: its window still learns it ended
  }

  private waitExit(e: Entry, ms: number): Promise<boolean> {
    if (!e.running) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      void e.exited.then(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  async restart(senderId: number, ptyId: unknown): Promise<PtyOpenResult> {
    const e = this.entryFor(senderId, ptyId, "restart");
    if (!e) return refusal("not_current", "unknown terminal");
    if (e.kind !== "chat" || !e.sessionId) return refusal("invalid_request", "only a terminal chat restarts");
    await this.terminate(e, "killed");
    this.entries.delete(e.id);
    return this.open(senderId, { kind: "chat", sessionId: e.sessionId, cols: e.cols, rows: e.rows });
  }

  /** The renderer's ×: a running PTY is ended, an exited one forgotten. */
  async kill(senderId: number, ptyId: unknown): Promise<void> {
    const e = this.entryFor(senderId, ptyId, "kill");
    if (!e) return;
    await this.terminate(e, "killed");
    this.entries.delete(e.id);
  }

  attach(senderId: number, ptyId: unknown): PtyAttach | null {
    const e = this.entryFor(senderId, ptyId, "attach");
    if (!e) return null;
    // What a reloaded page shows must not count against the flow control of the page that is gone.
    e.unacked = 0;
    if (e.paused && e.running) {
      e.paused = false;
      e.pty.resume();
    }
    return { replay: e.ring, running: e.running, exit: e.exit };
  }

  list(senderId: number): PtyListEntry[] {
    if (!this.owns(senderId, "list")) return [];
    return [...this.entries.values()].map((e) => ({
      ptyId: e.id,
      kind: e.kind,
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e.shell ? { shell: e.shell } : {}),
      ...(e.runId ? { runId: e.runId } : {}),
      running: e.running,
    }));
  }

  input(senderId: number, ptyId: unknown, data: unknown): void {
    const e = this.entryFor(senderId, ptyId, "input");
    if (!e || !e.running) return;
    if (typeof data !== "string" || data.length === 0 || data.length > MAX_INPUT) {
      this.d.log("warn", `pty: input ignored (${typeof data === "string" ? `${data.length} chars` : typeof data})`);
      return;
    }
    e.pty.write(data);
  }

  resize(senderId: number, ptyId: unknown, cols: unknown, rows: unknown): void {
    const e = this.entryFor(senderId, ptyId, "resize");
    const c = clampInt(cols, 2, 1000);
    const r = clampInt(rows, 1, 500);
    if (!e || !e.running || c === null || r === null) return;
    if (c === e.cols && r === e.rows) return;
    e.cols = c;
    e.rows = r;
    try {
      e.pty.resize(c, r);
    } catch {
      /* exiting */
    }
  }

  ack(senderId: number, ptyId: unknown, chars: unknown): void {
    const e = this.entryFor(senderId, ptyId, "ack");
    if (!e || typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return;
    e.unacked = Math.max(0, e.unacked - Math.floor(chars));
    if (e.paused && e.unacked < LOW_WATER && e.running) {
      e.paused = false;
      e.pty.resume();
    }
  }

  /** A terminal has the keyboard: registered menu accelerators (Ctrl+B, R, O, P, N, Edit roles) leave its keys alone. */
  focus(senderId: number, focused: unknown): void {
    if (!this.owns(senderId, "focus")) return;
    this.d.setIgnoreMenuShortcuts(focused === true);
  }

  /**
   * The engine state observer: the chat PTY ends when its chat is no longer the current one, or the project closes or
   * changes; on a project change or close the shell tabs end too (their folder was the old project's).
   */
  onEngineState(st: ReviewState): void {
    const key = st.project?.path ?? null;
    const projectChanged = this.projectKey !== undefined && key !== this.projectKey;
    this.projectKey = key;
    for (const e of this.entries.values()) {
      if (!e.running) continue;
      if (e.kind === "chat" && (projectChanged || key === null || st.sessions?.currentId !== e.sessionId)) void this.terminate(e, "switched");
      else if ((e.kind === "shell" || e.kind === "run") && projectChanged) void this.terminate(e, "closed");
    }
  }

  /** Window close / quit: nothing opens any more, every PTY ends in parallel. */
  async killAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.entries.values()].map((e) => this.terminate(e, "closed")));
  }

  /** `process.on("exit")`: the last resort, synchronous. */
  killAllSync(): void {
    this.closing = true;
    for (const e of this.entries.values()) {
      if (!e.running) continue;
      try {
        e.pty.kill();
      } catch {
        /* gone */
      }
    }
  }
}
