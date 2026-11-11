import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * docs/PROTOCOL.md §30 at the session level: `session_ready` once the CLI answered initialize (crash-4), and how a CLI
 * death is reported — classified from the CLI's own stderr (`session_id_in_use`, `resume_not_found`), else
 * `session_start_failed` before initialize / `session_crashed` after it, with `detail` (stderr's first line, home folder
 * masked), `exitCode` and `signal` (crash-2 / robustness-02). The "CLI" is a real child process the scripted SDK spawns
 * through the session's own `spawnClaudeCodeProcess`, so stderr capture and the exit status are the real ones.
 */

type Script = {
  /** What the fake CLI child does: write `stderr`, exit with `exitCode`. */
  stderr: string;
  exitCode: number;
  /** initialize answered (true) or the child died first (false). */
  initialize: boolean;
  /** Messages the CLI emits before dying. */
  messages?: SDKMessage[];
  /** The SDK's error after the child died (null: the iterator just ends). */
  throws?: string | null;
};

function scripted(script: Script): { queryFn: (args: { options?: Options }) => Query } {
  const queryFn = (args: { options?: Options }): Query => {
    const spawn = args.options!.spawnClaudeCodeProcess!;
    let exited: Promise<void> | null = null;
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((r) => (readyResolve = r));
    const start = () => {
      if (exited) return exited;
      const code = `process.stderr.write(${JSON.stringify(script.stderr)}); setTimeout(() => process.exit(${script.exitCode}), ${script.initialize ? 150 : 20});`;
      const child = spawn({ command: process.execPath, args: ["-e", code], cwd: process.cwd(), env: { ...process.env }, signal: new AbortController().signal });
      exited = new Promise<void>((r) => (child as unknown as { once: (e: string, f: () => void) => void }).once("exit", () => r()));
      if (script.initialize) setTimeout(() => readyResolve?.(), 5);
      return exited;
    };
    const queue = [...(script.messages ?? [])];
    let done = false;
    const q = {
      async next(): Promise<IteratorResult<SDKMessage>> {
        await start();
        if (queue.length > 0) return { done: false, value: queue.shift()! };
        if (done) return { done: true, value: undefined };
        done = true;
        if (script.throws) throw new Error(script.throws);
        return { done: true, value: undefined };
      },
      async return() {
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => undefined,
      initializationResult: () => {
        void start();
        return script.initialize ? ready : exited!.then(() => Promise.reject(new Error("exited before initialize")));
      },
    };
    return q as unknown as Query;
  };
  return { queryFn };
}

async function run(script: Script, resume?: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: process.cwd(),
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", startSlowHintMs: 0, ...(resume ? { resumeSessionId: resume } : { sessionId: "86281b8f-1ea4-4073-a0fb-63afefff9b81" }) },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: scripted(script).queryFn as never,
  });
  await s.start();
  const deadline = Date.now() + WAIT_MS;
  while (!events.some((e) => e.type === "closed")) {
    if (Date.now() > deadline) throw new Error(`no closed event: ${JSON.stringify(events)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  return events;
}

const errorsOf = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "error" }> => e.type === "error");

describe("ClaudeSession start / death reporting (§30)", () => {
  it("--session-id of a conversation the CLI already has: session_id_in_use with the CLI's line as detail, no session_ready", async () => {
    const events = await run({ stderr: "Error: Session ID 86281b8f-1ea4-4073-a0fb-63afefff9b81 is already in use.\n", exitCode: 1, initialize: false, throws: "Claude Code process exited with code 1" });
    expect(events.some((e) => e.type === "session_ready")).toBe(false);
    expect(errorsOf(events)).toEqual([{
      type: "error",
      message: "Claude Code process exited with code 1",
      fatal: true,
      code: "session_id_in_use",
      detail: "Error: Session ID 86281b8f-1ea4-4073-a0fb-63afefff9b81 is already in use.",
      exitCode: 1,
      signal: null,
    }]);
    expect(events.at(-1)).toEqual({ type: "closed", code: 1 });
  });

  it("--resume of a conversation the CLI has no record of: resume_not_found; its error result is not an unprompted turn", async () => {
    const id = "9db4cb56-0000-4000-8000-000000000000";
    const failed = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: id, total_cost_usd: 0, duration_ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, errors: [`No conversation found with session ID: ${id}`] } as unknown as SDKMessage;
    const events = await run({ stderr: `No conversation found with session ID: ${id}\n`, exitCode: 1, initialize: false, messages: [failed], throws: `Claude Code returned an error result: No conversation found with session ID: ${id}` }, id);
    expect(events.some((e) => e.type === "unprompted_turn_end")).toBe(false);
    expect(errorsOf(events)).toMatchObject([{ fatal: true, code: "resume_not_found", detail: `No conversation found with session ID: ${id}`, exitCode: 1 }]);
  });

  it("any other death before initialize is session_start_failed (home folder masked in detail); after it, session_crashed", async () => {
    const before = await run({ stderr: `Invalid settings file ${homedir()}/.claude/settings.json: Unexpected token\n`, exitCode: 2, initialize: false, throws: "Claude Code process exited with code 2" });
    expect(errorsOf(before)).toEqual([{ type: "error", message: "Claude Code process exited with code 2", fatal: true, code: "session_start_failed", detail: "Invalid settings file ~/.claude/settings.json: Unexpected token", exitCode: 2, signal: null }]);
    expect(before.some((e) => e.type === "session_ready")).toBe(false);

    const after = await run({ stderr: "panic: something broke\n", exitCode: 1, initialize: true, throws: "Claude Code process exited with code 1" });
    expect(after.filter((e) => e.type === "session_ready")).toHaveLength(1);
    expect(after.findIndex((e) => e.type === "session_ready")).toBeLessThan(after.findIndex((e) => e.type === "error"));
    expect(errorsOf(after)).toMatchObject([{ fatal: true, code: "session_crashed", detail: "panic: something broke", exitCode: 1 }]);
  });

  it("a CLI that quits before initialize without an exception still reports session_start_failed (never silently)", async () => {
    const events = await run({ stderr: "Error: unknown option '--frobnicate'\n", exitCode: 1, initialize: false, throws: null });
    expect(errorsOf(events)).toMatchObject([{ fatal: true, code: "session_start_failed", detail: "Error: unknown option '--frobnicate'", exitCode: 1 }]);
  });
});
