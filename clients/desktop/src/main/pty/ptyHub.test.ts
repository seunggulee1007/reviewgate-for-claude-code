import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand, EngineEvent, ReviewState, TerminalSpecEvent } from "@reviewgate/engine";
import type { PtyExit, PtyOpenResult } from "../../shared/ipc.js";
import { BATCH_MAX, HIGH_WATER, KILL_GRACE_MS, LOW_WATER, MAX_INPUT, PtyHub, RING_BYTES, type PtyHubDeps, type PtyProcess, type PtySpawnOptions } from "./ptyHub.js";
import type { Launch } from "./terminalLaunch.js";

class FakePty implements PtyProcess {
  static nextPid = 4000;
  readonly pid = FakePty.nextPid++;
  writes: string[] = [];
  resizes: [number, number][] = [];
  paused = false;
  kills = 0;
  /** A process that ignores the pseudoconsole closing (its tree has to be killed). */
  stubborn = false;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  constructor(readonly file: string, readonly args: string | string[], readonly opts: PtySpawnOptions) {}
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
    return { dispose: () => (this.dataCb = null) };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
    return { dispose: () => (this.exitCb = null) };
  }
  write(d: string) {
    this.writes.push(d);
  }
  resize(c: number, r: number) {
    this.resizes.push([c, r]);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  kill() {
    this.kills++;
    if (!this.stubborn) queueMicrotask(() => this.exit(1));
  }
  emit(d: string) {
    this.dataCb?.(d);
  }
  exit(code: number) {
    this.exitCb?.({ exitCode: code });
  }
}

const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

function state(o: { currentId?: string | null; kind?: "terminal" | undefined; project?: string | null; hooksSeen?: boolean } = {}): ReviewState {
  const currentId = o.currentId === undefined ? SID : o.currentId;
  return {
    project: o.project === null ? null : { path: o.project ?? "/work/acme", root: o.project ?? "/work/acme" },
    session: { terminal: { running: false, hooksSeen: o.hooksSeen ?? false, promptId: null, waiting: null, interruptSuspected: false } },
    sessions: { currentId, list: [{ id: SID, kind: "kind" in o ? o.kind : "terminal" }, { id: OTHER }] },
  } as unknown as ReviewState;
}

class FakeEngine {
  state = state();
  commands: EngineCommand[] = [];
  requests: EngineCommand[] = [];
  specRefusal: { error: string; code: string } | null = null;
  private listeners = new Set<(ev: EngineEvent) => void>();
  on(l: (ev: EngineEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  async handle(cmd: EngineCommand) {
    this.commands.push(cmd);
  }
  async request(cmd: EngineCommand): Promise<never> {
    this.requests.push(cmd);
    if (this.specRefusal) {
      const r = this.specRefusal;
      queueMicrotask(() => this.listeners.forEach((l) => l({ type: "result", ok: false, error: r.error, code: r.code } as EngineEvent)));
      await Promise.resolve();
      throw new Error(r.error);
    }
    const spec: TerminalSpecEvent = { type: "terminal_spec", sessionId: SID, argv: ["/usr/local/bin/claude", `--session-id=${SID}`], env: { RG_HOOK_TOKEN: "t".repeat(64) }, cwd: "/work/acme", resume: false };
    return spec as never;
  }
}

type Rig = { hub: PtyHub; engine: FakeEngine; ptys: FakePty[]; sent: unknown[][]; logs: string[]; ignore: boolean[]; killed: number[]; alive: Set<number>; order: string[] };

function rig(o: Partial<PtyHubDeps> = {}, ownerId = 7): Rig {
  const engine = new FakeEngine();
  const ptys: FakePty[] = [];
  const sent: unknown[][] = [];
  const logs: string[] = [];
  const ignore: boolean[] = [];
  const killed: number[] = [];
  const alive = new Set<number>();
  const order: string[] = [];
  const origHandle = engine.handle.bind(engine);
  engine.handle = async (cmd) => {
    order.push(cmd.type);
    return origHandle(cmd);
  };
  const origRequest = engine.request.bind(engine);
  engine.request = (cmd) => {
    order.push(cmd.type);
    return origRequest(cmd);
  };
  const launch = (file: string): Launch => ({ ok: true, file, args: ["--x"], env: { TERM: "xterm-256color" }, cwd: "/work/acme" });
  const hub = new PtyHub({
    ownerId,
    engine: engine as unknown as PtyHubDeps["engine"],
    spawn: (file, args, opts) => {
      order.push("spawn");
      const p = new FakePty(file, args, opts);
      ptys.push(p);
      alive.add(p.pid);
      return p;
    },
    unavailable: null,
    platform: "win32",
    send: (...a: unknown[]) => void sent.push(a),
    setIgnoreMenuShortcuts: (v) => void ignore.push(v),
    chatLaunch: (spec) => launch(spec.argv[0]!),
    shellLaunch: (shell) => launch(shell === "cmd" ? "C:\\Windows\\system32\\cmd.exe" : "pwsh.exe"),
    projectPath: () => "/work/acme",
    isAlive: (pid) => alive.has(pid),
    killTree: async (pid) => {
      killed.push(pid);
      const p = ptys.find((x) => x.pid === pid);
      alive.delete(pid);
      queueMicrotask(() => p?.exit(1));
    },
    log: (_l, m) => void logs.push(m),
    ...o,
  });
  return { hub, engine, ptys, sent, logs, ignore, killed, alive, order };
}

const chat = (cols = 80, rows = 24) => ({ kind: "chat" as const, sessionId: SID, cols, rows });
const okId = (r: PtyOpenResult) => {
  expect(r.ok).toBe(true);
  return (r as { ptyId: string }).ptyId;
};
const exits = (r: Rig) => r.sent.filter((s) => s[0] === "rg:pty:exit").map((s) => s[1] as PtyExit);
const data = (r: Rig) => r.sent.filter((s) => s[0] === "rg:pty:data").map((s) => s[2] as string);

describe("PtyHub (§57.10)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens a chat: terminal_spec → spawn (ConPTY options) → terminal_started{pid}; never logs argv or env", async () => {
    const r = rig();
    const id = okId(await r.hub.open(7, chat(100, 30)));
    expect(r.order).toEqual(["terminal_spec", "spawn", "terminal_started"]);
    const p = r.ptys[0]!;
    expect(r.engine.commands.at(-1)).toEqual({ type: "terminal_started", sessionId: SID, pid: p.pid });
    expect(p.opts).toMatchObject({ name: "xterm-256color", cols: 100, rows: 30, cwd: "/work/acme", useConpty: true, useConptyDll: true, conptyInheritCursor: false, encoding: "utf8" });
    expect(r.logs.join("\n")).toContain(`chat PTY started pid=${p.pid} resume=false`);
    expect(r.logs.join("\n")).not.toContain("t".repeat(64));
    // Idempotent: a remount gets the running PTY.
    expect(await r.hub.open(7, chat())).toEqual({ ok: true, ptyId: id });
    expect(r.ptys).toHaveLength(1);
    expect(r.hub.list(7)).toEqual([{ ptyId: id, kind: "chat", sessionId: SID, running: true }]);
  });

  it("two opens racing get one PTY", async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.hub.open(7, chat()), r.hub.open(7, chat())]);
    expect(a).toEqual(b);
    expect(r.ptys).toHaveLength(1);
  });

  it("refuses: not the current terminal chat, an engine refusal passes its code through, invalid requests, closing, no node-pty", async () => {
    const r = rig();
    r.engine.state = state({ currentId: OTHER });
    expect(await r.hub.open(7, chat())).toMatchObject({ ok: false, code: "not_current" });
    r.engine.state = state({ kind: undefined });
    expect(await r.hub.open(7, chat())).toMatchObject({ ok: false, code: "not_current" });
    r.engine.state = state();
    r.engine.specRefusal = { error: "terminal_cli_too_old:2.1.200", code: "terminal_cli_too_old" };
    expect(await r.hub.open(7, chat())).toEqual({ ok: false, code: "terminal_cli_too_old", error: "terminal_cli_too_old:2.1.200" });
    expect(r.ptys).toHaveLength(0);
    for (const bad of [null, "x", { kind: "chat", cols: 80, rows: 24 }, { kind: "shell", shell: "bash", cols: 80, rows: 24 }, { kind: "chat", sessionId: SID, cols: "80", rows: 24 }]) {
      expect(await r.hub.open(7, bad)).toMatchObject({ ok: false, code: "invalid_request" });
    }
    const launchRefused = rig({ chatLaunch: () => ({ ok: false, code: "terminal_needs_native_claude", error: "needs claude.exe" }) });
    expect(await launchRefused.hub.open(7, chat())).toEqual({ ok: false, code: "terminal_needs_native_claude", error: "needs claude.exe" });
    const throws = rig({
      spawn: () => {
        throw new Error("File not found: C:\\x\\claude.exe");
      },
    });
    expect(await throws.hub.open(7, chat())).toMatchObject({ ok: false, code: "spawn_failed" });
    expect(throws.engine.commands.some((c) => c.type === "terminal_started")).toBe(false);
    const none = rig({ spawn: null, unavailable: "Terminal chat needs Windows 10 1903 or later" });
    expect(await none.hub.open(7, chat())).toEqual({ ok: false, code: "pty_unavailable", error: "Terminal chat needs Windows 10 1903 or later" });
    await r.hub.killAll();
    r.engine.specRefusal = null;
    expect(await r.hub.open(7, chat())).toMatchObject({ ok: false, code: "pty_unavailable" });
  });

  it("a PTY belongs to one webContents: another sender is ignored and logged", async () => {
    const a = rig({}, 7);
    const b = rig({}, 8);
    const id = okId(await a.hub.open(7, chat()));
    expect(await a.hub.open(8, chat())).toMatchObject({ ok: false });
    a.hub.input(8, id, "x");
    a.hub.resize(8, id, 90, 20);
    expect(a.hub.attach(8, id)).toBeNull();
    expect(a.hub.list(8)).toEqual([]);
    a.hub.focus(8, true);
    // Another window's hub does not know the id.
    b.hub.input(8, id, "y");
    await b.hub.kill(8, id);
    expect(a.ptys[0]!.writes).toEqual([]);
    expect(a.ptys[0]!.resizes).toEqual([]);
    expect(a.ptys[0]!.kills).toBe(0);
    expect(a.ignore).toEqual([]);
    expect(a.logs.filter((l) => l.includes("ignored")).length).toBeGreaterThanOrEqual(5);
    expect(b.logs.some((l) => l.includes("unknown pty"))).toBe(true);
  });

  it("input and resize are validated and clamped", async () => {
    const r = rig();
    const id = okId(await r.hub.open(7, chat()));
    const p = r.ptys[0]!;
    r.hub.input(7, id, "한글\r");
    r.hub.input(7, id, "");
    r.hub.input(7, id, 42);
    r.hub.input(7, id, "x".repeat(MAX_INPUT + 1));
    r.hub.input(7, id, "x".repeat(MAX_INPUT));
    expect(p.writes.map((w) => w.length)).toEqual([3, MAX_INPUT]);
    r.hub.resize(7, id, 100.4, 30);
    r.hub.resize(7, id, 1, 0);
    r.hub.resize(7, id, 5000, 9999);
    r.hub.resize(7, id, 5000, 9999); // the same size again: nothing
    r.hub.resize(7, id, Number.NaN, 10);
    r.hub.resize(7, id, "80", 10);
    expect(p.resizes).toEqual([[100, 30], [2, 1], [1000, 500]]);
  });

  it("batches output (5 ms / 64 KiB), keeps a bounded replay ring, pauses over 100,000 unacked and resumes below 5,000", async () => {
    const r = rig();
    const id = okId(await r.hub.open(7, chat()));
    const p = r.ptys[0]!;
    p.emit("a");
    p.emit("b");
    expect(data(r)).toEqual([]);
    vi.advanceTimersByTime(5);
    expect(data(r)).toEqual(["ab"]);
    p.emit("x".repeat(BATCH_MAX)); // a full batch goes at once
    expect(data(r)).toHaveLength(2);
    expect(p.paused).toBe(false);
    p.emit("y".repeat(HIGH_WATER - BATCH_MAX)); // unacked now > 100,000
    vi.advanceTimersByTime(5);
    expect(p.paused).toBe(true);
    r.hub.ack(7, id, 50_000);
    expect(p.paused).toBe(true);
    r.hub.ack(7, id, HIGH_WATER - 50_000 - LOW_WATER + 100);
    expect(p.paused).toBe(false);
    r.hub.ack(7, id, -5);
    r.hub.ack(7, id, "lots");

    for (let i = 0; i < 12; i++) p.emit(String(i % 10).repeat(BATCH_MAX));
    const att = r.hub.attach(7, id)!;
    expect(att.replay.length).toBe(RING_BYTES);
    expect(att.replay.endsWith("1".repeat(BATCH_MAX))).toBe(true);
    expect(att).toMatchObject({ running: true, exit: null });
    expect(p.paused).toBe(false); // a reloaded page starts its flow control afresh
  });

  it("exit → batch flushed, terminal_exited, rg:pty:exit with quickNoHooks", async () => {
    const r = rig();
    const id = okId(await r.hub.open(7, chat()));
    const p = r.ptys[0]!;
    p.emit("bye");
    vi.advanceTimersByTime(2_000);
    p.exit(1);
    expect(data(r)).toEqual(["bye"]);
    expect(r.engine.commands.at(-1)).toEqual({ type: "terminal_exited", sessionId: SID, exitCode: 1 });
    expect(exits(r)).toEqual([{ ptyId: id, exitCode: 1, quickNoHooks: true, reason: "exited" }]);
    expect(r.hub.attach(7, id)).toMatchObject({ running: false, exit: { exitCode: 1 } });

    // Hooks seen, or a long run: not a quick exit.
    const s = rig();
    okId(await s.hub.open(7, chat()));
    s.engine.state = state({ hooksSeen: true });
    s.ptys[0]!.exit(0);
    expect(exits(s)[0]!.quickNoHooks).toBe(false);
    const t = rig();
    okId(await t.hub.open(7, chat()));
    vi.advanceTimersByTime(10_001);
    t.ptys[0]!.exit(0);
    expect(exits(t)[0]!.quickNoHooks).toBe(false);
  });

  it("a state with another current chat, or the project closing, ends the chat PTY (switched); a project change ends the shells", async () => {
    const r = rig();
    r.hub.onEngineState(state());
    const id = okId(await r.hub.open(7, chat()));
    const shellId = okId(await r.hub.open(7, { kind: "shell", shell: "cmd", cols: 80, rows: 24 }));
    r.hub.onEngineState(state()); // nothing changed
    expect(r.ptys.map((p) => p.kills)).toEqual([0, 0]);
    r.hub.onEngineState(state({ currentId: OTHER }));
    r.hub.onEngineState(state({ currentId: OTHER })); // once
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ptys[0]!.kills).toBe(1);
    expect(exits(r)).toEqual([{ ptyId: id, exitCode: 1, quickNoHooks: false, reason: "switched" }]);
    expect(r.engine.commands.at(-1)).toEqual({ type: "terminal_exited", sessionId: SID, exitCode: 1 });
    expect(r.ptys[1]!.kills).toBe(0); // the shell stays: same project
    r.hub.onEngineState(state({ currentId: OTHER, project: "/work/acme-2" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ptys[1]!.kills).toBe(1);
    expect(exits(r).at(-1)).toMatchObject({ ptyId: shellId, reason: "closed" });

    const c = rig();
    c.hub.onEngineState(state());
    okId(await c.hub.open(7, chat()));
    c.hub.onEngineState(state({ project: null, currentId: null }));
    await vi.advanceTimersByTimeAsync(0);
    expect(exits(c)[0]!.reason).toBe("switched");
  });

  it("restart: kill, wait for the exit, terminal_exited, then a new spec and spawn", async () => {
    const r = rig();
    const id = okId(await r.hub.open(7, chat()));
    r.order.length = 0;
    const p = r.hub.restart(7, id);
    await vi.advanceTimersByTimeAsync(0);
    const id2 = okId(await p);
    expect(id2).not.toBe(id);
    expect(r.order).toEqual(["terminal_exited", "terminal_spec", "spawn", "terminal_started"]);
    expect(exits(r)).toEqual([{ ptyId: id, exitCode: 1, quickNoHooks: false, reason: "killed" }]);
    expect(r.hub.list(7).map((e) => e.ptyId)).toEqual([id2]);
    const shell = okId(await r.hub.open(7, { kind: "shell", shell: "powershell", cols: 80, rows: 24 }));
    expect(await r.hub.restart(7, shell)).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("a process that outlives its pseudoconsole has its tree killed after 3 s", async () => {
    const r = rig();
    const id = okId(await r.hub.open(7, chat()));
    r.ptys[0]!.stubborn = true;
    const k = r.hub.kill(7, id);
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    expect(r.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await k;
    expect(r.killed).toEqual([r.ptys[0]!.pid]);
    expect(exits(r)).toEqual([{ ptyId: id, exitCode: 1, quickNoHooks: false, reason: "killed" }]);
    expect(r.hub.list(7)).toEqual([]); // the renderer's × forgets it
  });

  it("killAll ends every PTY in parallel and nothing opens after; killAllSync is the exit hook's", async () => {
    const r = rig();
    okId(await r.hub.open(7, chat()));
    okId(await r.hub.open(7, { kind: "shell", shell: "cmd", cols: 80, rows: 24 }));
    okId(await r.hub.open(7, { kind: "shell", shell: "powershell", cols: 80, rows: 24 }));
    for (const p of r.ptys) p.stubborn = true;
    const all = r.hub.killAll();
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    await all;
    expect(r.killed.sort()).toEqual(r.ptys.map((p) => p.pid).sort()); // all three at 3 s, not 9 s
    expect(exits(r).map((e) => e.reason)).toEqual(["closed", "closed", "closed"]);
    expect(r.hub.isClosing).toBe(true);
    expect(await r.hub.open(7, { kind: "shell", shell: "cmd", cols: 80, rows: 24 })).toMatchObject({ ok: false, code: "pty_unavailable" });

    const s = rig();
    okId(await s.hub.open(7, chat()));
    s.ptys[0]!.stubborn = true;
    s.hub.killAllSync();
    expect(s.ptys[0]!.kills).toBe(1);
  });

  it("a shell tab opens in the window's project with the chosen shell; none without a project", async () => {
    const r = rig();
    okId(await r.hub.open(7, { kind: "shell", shell: "cmd", cols: 80, rows: 24 }));
    expect(r.ptys[0]!.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(r.engine.requests).toEqual([]); // no terminal_spec for a shell
    const none = rig({ projectPath: () => null });
    expect(await none.hub.open(7, { kind: "shell", shell: "cmd", cols: 80, rows: 24 })).toMatchObject({ ok: false, code: "no_project" });
  });

  it("focus → setIgnoreMenuShortcuts", () => {
    const r = rig();
    r.hub.focus(7, true);
    r.hub.focus(7, false);
    r.hub.focus(7, "yes");
    expect(r.ignore).toEqual([true, false, false]);
  });
});
