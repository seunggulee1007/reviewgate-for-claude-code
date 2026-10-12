import { execFile } from "node:child_process";

export type ExecOptions = {
  cwd?: string;
  /** Merged over `process.env` (a value of `undefined` removes the variable). */
  env?: Record<string, string | undefined>;
  /** Bytes written to the child's stdin, then closed. Without it stdin is `/dev/null`. */
  stdin?: Buffer;
  /** Milliseconds; on expiry the child gets SIGTERM, then SIGKILL 2s later if still alive. */
  timeoutMs?: number;
  maxBuffer?: number;
  /** Windows: pass `args` to the child's command line as-is (a `cmd.exe /s /c "…"` line built by platform/winShell.ts). */
  windowsVerbatimArguments?: boolean;
};

export type ExecResult = {
  stdout: Buffer;
  stderr: string;
  /** Exit code; `null` when the child was killed by a signal (see `signal`). */
  status: number | null;
  signal: NodeJS.Signals | null;
  /** True when the child was terminated because `timeoutMs` elapsed. */
  timedOut: boolean;
};

export class ExecError extends Error {
  constructor(public readonly exe: string, public readonly reason: string) {
    super(`${exe}: ${reason}`);
    this.name = "ExecError";
  }
}

export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

/**
 * Runs `exe` with `args` (never through a shell), draining stdout/stderr fully.
 * Resolves with the exit status; only spawn failures (ENOENT, EACCES, ...) reject.
 */
export function exec(exe: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;

    const child = execFile(
      exe,
      args,
      {
        cwd: opts.cwd,
        env,
        encoding: "buffer",
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (error, stdout, stderr) => {
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        const code = (error as { code?: number | string | null } | null)?.code;
        if (typeof code === "string") {
          // A string code is a spawn failure (ENOENT / EACCES) or ERR_CHILD_PROCESS_STDIO_MAXBUFFER;
          // a numeric code is just a non-zero exit, which the caller inspects via `status`.
          reject(new ExecError(exe, error!.message));
          return;
        }
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
          status: child.exitCode,
          signal: child.signalCode,
          timedOut,
        });
      },
    );

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => {
          if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
        }, KILL_GRACE_MS);
      }, opts.timeoutMs);
    }

    if (child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE when the child exits before reading stdin
      if (opts.stdin) child.stdin.end(opts.stdin);
      else child.stdin.end();
    }
  });
}
