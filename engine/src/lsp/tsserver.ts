// MARK: lsp — docs/PROTOCOL.md §73.2: one tsserver process — its JSON protocol over stdio (requests as lines, responses and
// events as `Content-Length` frames), every request a promise with a timer, nothing that blocks the event loop.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A request that did not get its answer in time (the late answer is dropped). */
export class TsServerTimeout extends Error {
  constructor(readonly command: string, readonly ms: number) {
    super(`tsserver ${command}: no answer in ${ms} ms`);
  }
}
/** The process is gone (crashed, killed, or never started); `reason` is its last stderr line or the exit status. */
export class TsServerGone extends Error {}
/** tsserver answered `success: false`. */
export class TsServerError extends Error {}

export type TsServerSpawn = {
  /** The program: `process.execPath` (Node; Electron's binary with `ELECTRON_RUN_AS_NODE=1`). */
  execPath: string;
  /** `lib/tsserver.js` of the TypeScript to run. */
  tsserver: string;
  /** Where `node_modules/@vue/typescript-plugin` is (tsserver's `--pluginProbeLocations`). */
  pluginProbe: string;
  cwd: string;
  env: Record<string, string | undefined>;
  maxOldSpaceMb: number;
};

/** tsserver's arguments (§73.2): no typings acquisition (never npm, never the network), no diagnostics pushed. */
export function tsserverArgs(s: TsServerSpawn): string[] {
  return [
    `--max-old-space-size=${s.maxOldSpaceMb}`, s.tsserver,
    "--disableAutomaticTypingAcquisition", "--suppressDiagnosticEvents", "--noGetErrOnBackgroundUpdate",
    "--useInferredProjectPerProjectRoot", "--locale", "en",
    "--globalPlugins", "@vue/typescript-plugin", "--pluginProbeLocations", s.pluginProbe,
  ];
}

type Pending = { command: string; resolve: (body: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null };

export class TsServerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private buf: Buffer = Buffer.alloc(0);
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";
  private exited = false;
  private stopping = false;
  /** Resolves once the process is gone: `expected` when `stop()` asked for it. */
  readonly exit: Promise<{ expected: boolean; reason: string }>;

  constructor(spec: TsServerSpawn, private readonly onEvent?: (event: string, body: unknown) => void) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env)) if (v !== undefined && k !== "TSS_LOG" && k !== "TSS_DEBUG" && k !== "TSS_DEBUG_BRK") env[k] = v;
    env.ELECTRON_RUN_AS_NODE = "1";
    this.child = spawn(spec.execPath, tsserverArgs(spec), { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.exit = new Promise((resolve) => {
      const done = (reason: string) => {
        if (this.exited) return;
        this.exited = true;
        const err = new TsServerGone(`tsserver stopped: ${reason}`);
        for (const p of this.pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        resolve({ expected: this.stopping, reason });
      };
      this.child.on("error", (e) => done(e.message));
      this.child.on("exit", (code, signal) => done(this.stderrTail.trim().split("\n").pop()?.slice(0, 300) || (signal ? `signal ${signal}` : `exit status ${code}`)));
    });
    this.child.stdout.on("data", (d: Buffer) => this.read(d));
    this.child.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-2000);
    });
    this.child.stdin.on("error", () => undefined); // a write after the exit: the exit handler answers the requests
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
  get alive(): boolean {
    return !this.exited;
  }

  /** One request; its body, or `TsServerTimeout` / `TsServerGone` / `TsServerError`. */
  request<T = unknown>(command: string, args: unknown, timeoutMs: number): Promise<T> {
    if (this.exited) return Promise.reject(new TsServerGone("tsserver stopped"));
    const seq = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { command, resolve: resolve as (b: unknown) => void, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new TsServerTimeout(command, timeoutMs));
      }, Math.max(1, timeoutMs));
      this.pending.set(seq, entry);
      this.child.stdin.write(JSON.stringify({ seq, type: "request", command, arguments: args }) + "\n");
    });
  }

  /** stdin closed, SIGTERM, SIGKILL after `graceMs`. */
  stop(graceMs = 2000): Promise<void> {
    if (this.exited) return Promise.resolve();
    this.stopping = true;
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    this.child.kill("SIGTERM");
    const kill = setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, graceMs);
    kill.unref?.();
    return this.exit.then(() => clearTimeout(kill));
  }

  /** Test seam: the process dies as in a crash. */
  crash(): void {
    this.child.kill("SIGKILL");
  }

  private read(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      const head = this.buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, head).toString("latin1"));
      if (!m) {
        // Not a frame (a stray line): drop through the separator.
        this.buf = this.buf.subarray(head + 4);
        continue;
      }
      const len = Number(m[1]);
      if (this.buf.length < head + 4 + len) return;
      const raw = this.buf.subarray(head + 4, head + 4 + len).toString("utf8");
      this.buf = this.buf.subarray(head + 4 + len);
      let msg: { type?: string; request_seq?: number; success?: boolean; message?: string; body?: unknown; event?: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.type === "response" && typeof msg.request_seq === "number") {
        const p = this.pending.get(msg.request_seq);
        if (!p) continue; // timed out: dropped
        this.pending.delete(msg.request_seq);
        if (p.timer) clearTimeout(p.timer);
        if (msg.success === false) p.reject(new TsServerError(`tsserver ${p.command}: ${msg.message ?? "failed"}`));
        else p.resolve(msg.body);
      } else if (msg.type === "event" && typeof msg.event === "string") {
        this.onEvent?.(msg.event, msg.body);
      }
    }
  }
}
