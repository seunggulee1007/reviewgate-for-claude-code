/** Process-level I/O for the stdio adapter: NDJSON stdout, flush-before-exit, watchdogs. */
import { createInterface } from "node:readline";
import { wellFormedJson } from "@reviewgate/engine";

/**
 * One NDJSON line. MARK: wave6 w6-statusline — a lone surrogate half in any string (a settings file's command, a file
 * name, a tool's output) is written as U+FFFD: JSON.stringify escapes it as `\udc00`, which Swift's JSONDecoder refuses
 * with the whole line (the Mac would drop that event, every time it is sent).
 */
export function writeLine(obj: unknown): void {
  process.stdout.write(wellFormedJson(JSON.stringify(obj)) + "\n");
}

/**
 * `process.exit` right after a large write drops trailing stdout on macOS (200KB write + exit → 64KB
 * arrived). Exit only once the pipe has taken everything; a capped fallback covers a stuck/destroyed stdout.
 */
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
  process.stdout.write("", () => process.exit(code));
}

/**
 * If the app dies without closing our stdin (SIGKILL, crash), we are re-parented to launchd/init
 * (ppid 1). Poll for that and stop so neither node nor `claude` linger. darwin/linux only: on
 * Windows stdin EOF is the signal.
 */
export function watchParent(onGone: () => void): void {
  if (process.platform === "win32") return;
  const timer = setInterval(() => {
    if (process.ppid !== 1) return;
    clearInterval(timer);
    onGone();
  }, 1000);
  timer.unref();
}

/** Parsed NDJSON lines from stdin; non-JSON / non-object lines are reported through `onBad`. */
export function readLines(onLine: (msg: { type: string } & Record<string, unknown>) => void, onEnd: () => void, onBad: (why: string) => void): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      onBad("ignoring non-JSON input line");
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      onBad("ignoring input without string `type`");
      return;
    }
    onLine(parsed as { type: string } & Record<string, unknown>);
  });
  rl.on("close", onEnd);
}
