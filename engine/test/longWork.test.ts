import { afterEach, describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import {
  budgetChangeNote,
  budgetNumbers,
  clampMaxTurns,
  DEFAULT_MAX_TURNS,
  hookFailureNotice,
  informationalNotice,
  maxTurnsNotice,
  maxTurnsOption,
  rateLimitWindowOf,
  rateLimitWindowsOf,
  upsertRateLimit,
} from "../src/session/longWork.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §38.2 (wave4 w4-longwork): long work never stops silently. */

const harnesses: Harness[] = [];
const dirs: string[] = [];
const sessions: ClaudeSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose();
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const NOW = Date.parse("2026-10-23T10:00:00Z");

describe("pure rules", () => {
  it("maxTurns: no limit (0) unless set — a whole number in 10–1000 when it is", () => {
    expect(DEFAULT_MAX_TURNS).toBe(0);
    expect(clampMaxTurns(undefined)).toBe(0);
    expect(clampMaxTurns(0)).toBe(0);
    expect(clampMaxTurns(-5)).toBe(0);
    expect(clampMaxTurns(Number.NaN)).toBe(0);
    expect(clampMaxTurns("300")).toBe(0);
    expect(clampMaxTurns(50)).toBe(50);
    expect(clampMaxTurns(3)).toBe(10);
    expect(clampMaxTurns(150.4)).toBe(150);
    expect(clampMaxTurns(5000)).toBe(1000);
    expect(maxTurnsOption(undefined)).toEqual({});
    expect(maxTurnsOption(0)).toEqual({});
    expect(maxTurnsOption(50)).toEqual({ maxTurns: 50 });
    // A turn can stop at a limit only when one was set; the words never say "0 calls".
    expect(maxTurnsNotice(0)).toEqual({ code: "max_turns", message: 'Claude stopped at the tool-call limit before it finished; send "continue" to go on.' });
  });

  it("informational: a hook's block → hook_blocked, warning / suggestion → cli_warning, notice → cli_notice, info → nothing", () => {
    expect(informationalNotice({ content: "UserPromptSubmit operation blocked by hook: commit first", level: "warning", prevent_continuation: true })).toEqual({
      code: "hook_blocked",
      message: "A hook stopped this turn: UserPromptSubmit operation blocked by hook: commit first",
      detail: "UserPromptSubmit operation blocked by hook: commit first",
    });
    expect(informationalNotice({ content: "Stop hook feedback", level: "info", prevent_continuation: true })?.code).toBe("hook_blocked");
    expect(informationalNotice({ content: "  Context low  ", level: "warning" })).toEqual({ code: "cli_warning", message: "Context low", detail: "Context low" });
    expect(informationalNotice({ content: "Try /compact", level: "suggestion" })?.code).toBe("cli_warning");
    expect(informationalNotice({ content: "Model switched", level: "notice" })).toEqual({ code: "cli_notice", message: "Model switched", detail: "Model switched" });
    expect(informationalNotice({ content: "debug line", level: "info" })).toBeNull();
    // A tool's progress line goes with its tool, never a chat row of its own.
    expect(informationalNotice({ content: "Downloading 40%", level: "notice", tool_use_id: "toolu_1" })).toBeNull();
    expect(informationalNotice({ content: "blocked", level: "warning", tool_use_id: "toolu_1", prevent_continuation: true })?.code).toBe("hook_blocked");
    expect(informationalNotice({ content: "", level: "warning" })).toBeNull();
    // A token in the CLI's text is masked like a stderr detail (§30).
    expect(informationalNotice({ content: "hook said api_key=abcdef", level: "warning" })?.detail).toBe("hook said api_key=***");
  });

  it("hook_response: outcome error → hook_failed with the name, exit code and stderr's first line", () => {
    expect(hookFailureNotice({ outcome: "error", hook_name: "PostToolUse:Bash", hook_event: "PostToolUse", exit_code: 1, stderr: "commit-sweep.sh: not found\nmore", output: "" })).toEqual({
      code: "hook_failed",
      message: "The hook PostToolUse:Bash failed (exit 1): commit-sweep.sh: not found",
      hookName: "PostToolUse:Bash",
      exitCode: 1,
      detail: "commit-sweep.sh: not found",
    });
    // MARK: wave4b w4b-check4 — §40.1: exit 2 is a hook's deliberate block (Claude Code's blocking exit code), not a failure.
    expect(hookFailureNotice({ outcome: "error", hook_name: "PreToolUse:Bash", hook_event: "PreToolUse", exit_code: 2, stderr: "no rm -rf in this repo\nsee CONTRIBUTING", output: "" })).toEqual({
      code: "hook_blocked",
      message: "The hook PreToolUse:Bash blocked this: no rm -rf in this repo",
      hookName: "PreToolUse:Bash",
      exitCode: 2,
      detail: "no rm -rf in this repo",
    });
    // A command hook's JSON decision (exit 0): "block" / a PreToolUse deny, with its reason.
    expect(hookFailureNotice({ outcome: "success", hook_name: "Stop", hook_event: "Stop", exit_code: 0, stdout: '{"decision":"block","reason":"tests are red"}', output: "" })).toEqual({
      code: "hook_blocked",
      message: "The hook Stop blocked this: tests are red",
      hookName: "Stop",
      exitCode: 0,
      detail: "tests are red",
    });
    expect(hookFailureNotice({ outcome: "success", hook_name: "PreToolUse:Edit", exit_code: 0, output: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"generated file"}}' })?.detail).toBe("generated file");
    expect(hookFailureNotice({ outcome: "error", hook_name: "PreToolUse:Edit", exit_code: 2, stderr: "" })).toEqual({ code: "hook_blocked", message: "The hook PreToolUse:Edit blocked this.", hookName: "PreToolUse:Edit", exitCode: 2 });
    // An in-process callback (no exit code) or a hook that allowed: nothing.
    expect(hookFailureNotice({ outcome: "success", hook_name: "PreToolUse", output: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"The app manages git"}}' })).toBeNull();
    expect(hookFailureNotice({ outcome: "success", hook_name: "x", exit_code: 0, stdout: '{"decision":"approve"}' })).toBeNull();
    expect(hookFailureNotice({ outcome: "success", hook_name: "x", exit_code: 0, stdout: "not json {" })).toBeNull();
    expect(hookFailureNotice({ outcome: "error", hook_name: "", hook_event: "SessionStart", stderr: "" })).toEqual({ code: "hook_failed", message: "The hook SessionStart failed.", hookName: "SessionStart", exitCode: null });
    expect(hookFailureNotice({ outcome: "success", hook_name: "x" })).toBeNull();
    expect(hookFailureNotice({ outcome: "cancelled", hook_name: "x" })).toBeNull();
  });

  it("rate limit windows: percent from the 0–1 fraction, ISO reset, one per kind, past resets dropped", () => {
    const resets = NOW / 1000 + 3600;
    const five = rateLimitWindowOf({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82, resetsAt: resets }, NOW);
    expect(five).toEqual({ kind: "five_hour", status: "allowed_warning", percent: 82, utilization: 0.82, resetsAt: new Date(resets * 1000).toISOString(), at: new Date(NOW).toISOString() });
    expect(rateLimitWindowOf({ status: "allowed", rateLimitType: "seven_day", utilization: 41 }, NOW)).toMatchObject({ kind: "seven_day", percent: 41 });
    expect(rateLimitWindowOf({ status: "allowed" }, NOW)).toBeNull();
    expect(rateLimitWindowOf({ status: "odd", rateLimitType: "five_hour" }, NOW)).toBeNull();
    const old = { kind: "seven_day", status: "allowed" as const, resetsAt: new Date(NOW - 1000).toISOString(), at: "" };
    const list = upsertRateLimit([old, { ...five!, percent: 50 }], five!, NOW);
    expect(list).toEqual([five]);
  });

  it("CLI 2.1.309 puts the use of every window in unifiedWindows (a 0-1 fraction), seen with haiku", () => {
    // The event as CLI 2.1.309 sends it (invented values): top-level status / resetsAt / rateLimitType, no utilization.
    const info = {
      status: "allowed",
      resetsAt: 1792764000,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1792764000 }, seven_day: { utilization: 0.05, resetsAt: 1793181600 } },
    };
    expect(rateLimitWindowsOf(info, NOW)).toEqual([
      { kind: "five_hour", status: "allowed", percent: 25, utilization: 0.25, resetsAt: new Date(1792764000 * 1000).toISOString(), at: new Date(NOW).toISOString() },
      { kind: "seven_day", status: "allowed", percent: 5, utilization: 0.05, resetsAt: new Date(1793181600 * 1000).toISOString(), at: new Date(NOW).toISOString() },
    ]);
    // A rejection of the weekly window: its status is the event's; the five-hour one stays allowed.
    expect(rateLimitWindowsOf({ ...info, status: "rejected", rateLimitType: "seven_day" }, NOW).map((w) => [w.kind, w.status, w.percent])).toEqual([
      ["five_hour", "allowed", 25],
      ["seven_day", "rejected", 5],
    ]);
    expect(rateLimitWindowsOf({ status: "allowed" }, NOW)).toEqual([]);
  });

  it("budget note: only when the numbers differ from what Claude was told", () => {
    expect(budgetChangeNote({ maxFiles: 10, maxLines: 400 }, { maxFiles: 10, maxLines: 400, hardMultiplier: 3 })).toBeNull();
    expect(budgetChangeNote(null, { maxFiles: 10, maxLines: 400 })).toBeNull();
    expect(budgetChangeNote({ maxFiles: 10, maxLines: 400 }, { maxFiles: 20, maxLines: 1200 })).toBe(
      "[Review gate] The change budget is now at most 20 files and about 1200 changed lines per reply (this replaces the numbers in your instructions).",
    );
  });

  it("§54 budget note: turned on, Claude gets the numbers; turned off, Claude is told the limit is gone; 0 and below are the same", () => {
    expect(budgetChangeNote({ maxFiles: 0, maxLines: 0 }, { maxFiles: 0, maxLines: 0, hardMultiplier: 2 })).toBeNull();
    expect(budgetChangeNote({ maxFiles: 0, maxLines: 0 }, { maxFiles: -1, maxLines: Number.NaN })).toBeNull();
    expect(budgetChangeNote({ maxFiles: 0, maxLines: 0 }, { maxFiles: 10, maxLines: 400 })).toBe(
      "[Review gate] The user set a change budget: at most 10 files and about 400 changed lines per reply.",
    );
    expect(budgetChangeNote({ maxFiles: 10, maxLines: 400 }, { maxFiles: 0, maxLines: 0 })).toBe(
      "[Review gate] The change budget is off: there is no limit on files or changed lines per reply (this replaces the numbers in your instructions).",
    );
    // One count without a limit is left out of the words.
    expect(budgetChangeNote({ maxFiles: 10, maxLines: 400 }, { maxFiles: 0, maxLines: 300 })).toBe(
      "[Review gate] The change budget is now about 300 changed lines per reply (this replaces the numbers in your instructions).",
    );
    expect(budgetNumbers({ maxFiles: -3, maxLines: 400 })).toEqual({ maxFiles: 0, maxLines: 400 });
  });
});

function session(maxTurns?: number): { s: ClaudeSession; events: SessionEvent[]; feed: (m: unknown) => void; options: () => Options | undefined } {
  const events: SessionEvent[] = [];
  let options: Options | undefined;
  const queryFn = (args: { options?: Options }): Query => {
    options = args.options;
    let done: () => void = () => {};
    const ended = new Promise<void>((r) => (done = r));
    return {
      async next() {
        await ended;
        return { done: true, value: undefined };
      },
      async return() {
        done();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      initializationResult: () => new Promise(() => {}),
    } as unknown as Query;
  };
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", ...(maxTurns !== undefined ? { maxTurns } : {}) },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: queryFn as never,
  });
  sessions.push(s);
  (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  const feed = (m: unknown) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m as SDKMessage);
  return { s, events, feed, options: () => options };
}

const errors = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "error" }> => e.type === "error");
const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: 0, is_error: false, result: "", ...extra });
const sys = (subtype: string, extra: Record<string, unknown>) => ({ type: "system", subtype, uuid: "u", session_id: "s1", ...extra });

describe("ClaudeSession (§38.2)", () => {
  it("starts the CLI without a tool-call limit unless the settings set one, and with every hook's events", async () => {
    const a = session();
    await a.s.start();
    expect(a.options()).toMatchObject({ includeHookEvents: true });
    expect(a.options() && "maxTurns" in a.options()!).toBe(false);
    const z = session(0);
    await z.s.start();
    expect(z.options() && "maxTurns" in z.options()!).toBe(false);
    const b = session(500);
    await b.s.start();
    expect(b.options()?.maxTurns).toBe(500);
  });

  it("error_max_turns → a max_turns notice naming the limit; the turn still ends", () => {
    const { events, feed } = session(120);
    feed({ ...result({}), subtype: "error_max_turns", is_error: true, errors: [], num_turns: 121 });
    expect(errors(events)).toEqual([
      { type: "error", fatal: false, code: "max_turns", maxTurns: 120, message: 'Claude stopped at the tool-call limit (120 calls) before it finished; send "continue" to go on.' },
    ]);
    expect(events.some((e) => e.type === "turn_end" && e.stopReason === "error_max_turns")).toBe(true);
  });

  it("a hook's block reason (informational) is one hook_blocked notice — the result's terminal reason adds none", () => {
    const { events, feed } = session();
    feed(sys("informational", { content: "Stop hook prevented continuation: tests are red", level: "warning", prevent_continuation: true }));
    feed(result({ terminal_reason: "stop_hook_prevented" }));
    expect(errors(events).map((e) => [e.code, e.message])).toEqual([["hook_blocked", "A hook stopped this turn: Stop hook prevented continuation: tests are red"]]);
  });

  it("a turn a hook ended without a message → hook_blocked with the generic text; a plain end → nothing", () => {
    const a = session();
    a.feed(result({ terminal_reason: "hook_stopped" }));
    expect(errors(a.events).map((e) => [e.code, e.message])).toEqual([["hook_blocked", "A hook stopped this turn."]]);
    const b = session();
    b.feed(result({ terminal_reason: "completed" }));
    expect(errors(b.events)).toEqual([]);
  });

  it("CLI warnings and notices become notices; an info line does not", () => {
    const { events, feed } = session();
    feed(sys("informational", { content: "Auto-compact is off", level: "warning" }));
    feed(sys("informational", { content: "Switched to Haiku", level: "notice" }));
    feed(sys("informational", { content: "verbose", level: "info" }));
    expect(errors(events).map((e) => [e.code, e.detail])).toEqual([
      ["cli_warning", "Auto-compact is off"],
      ["cli_notice", "Switched to Haiku"],
    ]);
  });

  it("a failed hook after initialize → hook_failed; started / successful hooks say nothing", () => {
    const { s, events, feed } = session();
    (s as unknown as { initialized: boolean }).initialized = true;
    feed(sys("hook_started", { hook_id: "h1", hook_name: "PostToolUse:Bash", hook_event: "PostToolUse" }));
    feed(sys("hook_response", { hook_id: "h1", hook_name: "PostToolUse:Bash", hook_event: "PostToolUse", outcome: "success", stdout: "", stderr: "", output: "", exit_code: 0 }));
    feed(sys("hook_response", { hook_id: "h2", hook_name: "UserPromptSubmit", hook_event: "UserPromptSubmit", outcome: "error", stdout: "", stderr: "permission denied", output: "", exit_code: 1 }));
    expect(errors(events)).toMatchObject([{ code: "hook_failed", hookName: "UserPromptSubmit", exitCode: 1, detail: "permission denied", fatal: false }]);
    expect(events.some((e) => e.type === "start_progress")).toBe(false);
  });

  it("every rate_limit_event with a window → rate_limit_info (allowed ones too); a rejection is still usage_limit", () => {
    const { events, feed } = session();
    feed({ type: "rate_limit_event", uuid: "u", session_id: "s1", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: 1760000000 } });
    feed({ type: "rate_limit_event", uuid: "u", session_id: "s1", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1760000000 } });
    const windows = events.filter((e): e is Extract<SessionEvent, { type: "rate_limit_info" }> => e.type === "rate_limit_info").map((e) => [e.window.status, e.window.percent]);
    expect(windows).toEqual([["allowed", 30], ["rejected", undefined]]);
    expect(errors(events).map((e) => e.code)).toEqual(["usage_limit"]);
  });
});

function makeRepo(): string {
  const dir = makeTempDir("rg-longwork-");
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "T");
  write(dir, "README.md", "hello\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}

async function endTurn(h: Harness): Promise<void> {
  h.session().emitTurnEnd();
  await h.waitFor((s) => s.gate.phase === "idle" || s.gate.phase === "reviewing", "turn collected");
}

describe("ReviewEngine (§38.2)", () => {
  it("passes settings.maxTurns to the session it starts", async () => {
    const h = harness();
    await h.hello({ maxTurns: 300 });
    await h.open(makeRepo());
    expect(h.session().opts.settings.maxTurns).toBe(300);
  });

  it("the notices are rows without state.lastError; the usage windows reach state.hud.rateLimits and survive a new chat", async () => {
    const h = harness();
    await h.hello();
    await h.open(makeRepo());
    h.session().emit({ type: "error", message: "stopped", fatal: false, code: "max_turns", maxTurns: 200 });
    h.session().emit({ type: "error", message: "The hook X failed.", fatal: false, code: "hook_failed", hookName: "X" });
    h.session().emit({ type: "rate_limit_info", window: { kind: "five_hour", status: "allowed_warning", percent: 85, at: "2026-10-23T10:00:00.000Z" } });
    const s = await h.waitFor((x) => (x.hud.rateLimits ?? []).length === 1, "rate limits");
    expect(s.lastError).toBeNull();
    expect(h.ofType("error").map((e) => [e.code, e.scope])).toEqual([["max_turns", "session"], ["hook_failed", "session"]]);
    expect(s.hud.rateLimits).toEqual([{ kind: "five_hour", status: "allowed_warning", percent: 85, at: "2026-10-23T10:00:00.000Z" }]);
    await h.engine.request({ type: "session_new" });
    const after = await h.waitFor((x) => x.session.open && !x.session.starting, "new chat");
    expect(after.hud.rateLimits?.map((w) => w.kind)).toEqual(["five_hour"]);
  });

  it("daily-18: a budget changed after the prompt was rendered goes in front of the next message, once", async () => {
    const h = harness();
    await h.hello({ budget: { maxFiles: 5, maxLines: 200 }, systemPromptAppend: "at most 5 files and about 200 lines" });
    await h.open(makeRepo());
    await h.engine.request({ type: "send", text: "first" });
    expect(h.session().sends[0]!.text).toBe("first");
    await endTurn(h);
    // The Mac sends the budget alone; the running session's system prompt still says 5 / 200.
    await h.engine.handle({ type: "set_settings", settings: { budget: { maxFiles: 20, maxLines: 1000 } } });
    await h.engine.request({ type: "send", text: "second" });
    expect(h.session().sends[1]!.text).toBe(
      "[Review gate] The change budget is now at most 20 files and about 1000 changed lines per reply (this replaces the numbers in your instructions).\n\nsecond",
    );
    await endTurn(h);
    await h.engine.request({ type: "send", text: "third" });
    expect(h.session().sends[2]!.text).toBe("third");
  });

  it("§54: without a budget nothing is said; turning one on and off again tells the running session each time", async () => {
    const h = harness();
    await h.hello({ budget: { maxFiles: 0, maxLines: 0 }, systemPromptAppend: "no budget words" });
    await h.open(makeRepo());
    await h.engine.request({ type: "send", text: "first" });
    expect(h.session().sends[0]!.text).toBe("first");
    await endTurn(h);
    await h.engine.handle({ type: "set_settings", settings: { budget: { maxFiles: 10, maxLines: 400, hardMultiplier: 2 } } });
    await h.engine.request({ type: "send", text: "second" });
    expect(h.session().sends[1]!.text).toBe("[Review gate] The user set a change budget: at most 10 files and about 400 changed lines per reply.\n\nsecond");
    await endTurn(h);
    await h.engine.handle({ type: "set_settings", settings: { budget: { maxFiles: 0, maxLines: 0, hardMultiplier: 2 } } });
    await h.engine.request({ type: "send", text: "third" });
    expect(h.session().sends[2]!.text.startsWith("[Review gate] The change budget is off: there is no limit")).toBe(true);
    await endTurn(h);
    await h.engine.request({ type: "send", text: "fourth" });
    expect(h.session().sends[3]!.text).toBe("fourth");
  });

  it("daily-18: a prompt re-rendered with the new budget (Electron) still tells the running session; a new session needs no note", async () => {
    const h = harness();
    await h.hello({ budget: { maxFiles: 5, maxLines: 200 }, systemPromptAppend: "5 / 200" });
    await h.open(makeRepo());
    await h.engine.handle({ type: "set_settings", settings: { budget: { maxFiles: 8, maxLines: 300 }, systemPromptAppend: "8 / 300" } });
    await h.engine.request({ type: "send", text: "go" });
    expect(h.session().sends[0]!.text.startsWith("[Review gate] The change budget is now at most 8 files and about 300 changed lines")).toBe(true);
    await endTurn(h);
    await h.engine.request({ type: "session_new" });
    await h.waitFor((x) => x.session.open && !x.session.starting && h.sessions.length === 2, "new chat");
    await h.engine.request({ type: "send", text: "fresh" });
    expect(h.session().sends[0]!.text).toBe("fresh");
  });
});
