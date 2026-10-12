/**
 * ReviewGate sidecar: NDJSON-over-stdio adapter around `@reviewgate/engine` (docs/PROTOCOL.md).
 * The first input line must be `hello` (protocol v2); anything else is answered with a fatal
 * `error` and exit code 2. Only this file and `io.ts` touch process I/O.
 */
import { ReviewEngine, type EngineCommand, type EngineEvent } from "@reviewgate/engine";
import { exitAfterFlush, readLines, watchParent, writeLine } from "./io.js";

function main(): void {
  const engine = new ReviewEngine({
    log: (level, message) => process.stderr.write(`[sidecar:${level}] ${message}\n`),
  });
  engine.on((ev: EngineEvent) => writeLine(ev));

  let exiting = false;
  const finish = (code: number) => {
    if (exiting) return;
    exiting = true;
    setTimeout(() => exitAfterFlush(code), 3000).unref();
    void engine.dispose().then(() => exitAfterFlush(code), () => exitAfterFlush(code));
  };
  let sawHello = false;
  const fatal = (message: string, code = 1) => {
    writeLine({ type: "error", message, fatal: true, scope: "engine" });
    // Before `hello` the engine holds nothing to dispose, and disposing would emit a `state`.
    if (sawHello) finish(code);
    else if (!exiting) {
      exiting = true;
      exitAfterFlush(code);
    }
  };

  readLines(
    (msg) => {
      if (!sawHello) {
        if (msg.type !== "hello") {
          fatal(`protocol v2 requires "hello" as the first message (got "${msg.type}")`, 2);
          return;
        }
        sawHello = true;
        process.stderr.write("[sidecar:info] protocol v2\n");
      }
      // Each command is awaited on its own so a slow one (open_project) never blocks reading stdin;
      // the engine serializes what must be ordered.
      void engine
        .handle(msg as EngineCommand)
        .then(() => {
          if (msg.type === "shutdown") finish(0);
        })
        .catch((e) => fatal(e instanceof Error ? e.message : String(e)));
    },
    () => finish(0),
    (why) => process.stderr.write(`[sidecar:warn] ${why}\n`),
  );

  // EPIPE on stdout/stderr means the app closed its end (or died): stop instead of throwing.
  process.stdout.on("error", () => finish(0));
  process.stderr.on("error", () => finish(0));
  watchParent(() => {
    process.stderr.write("[sidecar:warn] parent process is gone; aborting\n");
    finish(0);
  });
  process.on("uncaughtException", (e) => fatal(`uncaught: ${e.message}`));
  process.on("unhandledRejection", (e) => fatal(`unhandled: ${e instanceof Error ? e.message : String(e)}`));
}

main();
