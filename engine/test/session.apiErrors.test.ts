import { afterEach, describe, expect, it } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { codeOfAssistantError, codeOfErrorText, codeOfStatus, isoFromEpoch } from "../src/session/apiErrors.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §19.6: CLI / API failures reach the client as `error` events with a stable `code`. */

const harnesses: Harness[] = [];
const dirs: string[] = [];
const sessions: ClaudeSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose();
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function session(extra: Partial<ConstructorParameters<typeof ClaudeSession>[0]> = {}): { s: ClaudeSession; events: SessionEvent[]; feed: (m: unknown) => void } {
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    ...extra,
  });
  sessions.push(s);
  (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  const feed = (m: unknown) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m as SDKMessage);
  return { s, events, feed };
}

const errors = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "error" }> => e.type === "error");

const assistantError = (text: string, error?: string, model = "<synthetic>") => ({
  type: "assistant",
  parent_tool_use_id: null,
  uuid: "u",
  session_id: "s1",
  ...(error ? { error } : {}),
  message: { id: `m-${text.length}-${error ?? ""}`, model, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "stop_sequence", stop_sequence: "", usage: { input_tokens: 0, output_tokens: 0 } },
});

const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, total_cost_usd: 0, is_error: false, result: "", ...extra });

describe("classifier (pure)", () => {
  it("SDK assistant error values, status codes and free text", () => {
    expect(codeOfAssistantError("authentication_failed")).toBe("auth_required");
    expect(codeOfAssistantError("oauth_org_not_allowed")).toBe("auth_required");
    expect(codeOfAssistantError("billing_error")).toBe("usage_limit");
    expect(codeOfAssistantError("rate_limit")).toBe("rate_limited");
    expect(codeOfAssistantError("overloaded")).toBe("api_error");
    expect(codeOfAssistantError("max_output_tokens")).toBeNull();
    expect(codeOfAssistantError(undefined)).toBeNull();
    expect(codeOfStatus(401)).toBe("auth_required");
    expect(codeOfStatus(429)).toBe("rate_limited");
    expect(codeOfStatus(529)).toBe("api_error");
    expect(codeOfStatus(null)).toBeNull();
    expect(codeOfErrorText("Invalid API key · Please run /login")).toBe("auth_required");
    expect(codeOfErrorText("OAuth token has expired. Please obtain a new token or refresh your existing token.")).toBe("auth_required");
    expect(codeOfErrorText("Claude AI usage limit reached|1760000000")).toBe("usage_limit");
    expect(codeOfErrorText("You've hit your limit · resets 5pm")).toBe("usage_limit");
    expect(codeOfErrorText("Credit balance is too low")).toBe("usage_limit");
    expect(codeOfErrorText("API Error: 429 rate_limit_error")).toBe("rate_limited");
    expect(codeOfErrorText('API Error: 529 {"type":"overloaded_error"}')).toBe("api_error");
    expect(codeOfErrorText("all good")).toBeNull();
    expect(isoFromEpoch(1760000000)).toBe(new Date(1760000000 * 1000).toISOString());
    expect(isoFromEpoch(1760000000123)).toBe(new Date(1760000000123).toISOString());
    expect(isoFromEpoch(undefined)).toBeUndefined();
  });
});

describe("ClaudeSession reports classified API failures", () => {
  it("not logged in: a synthetic assistant message / authentication_failed → auth_required, once per turn", () => {
    const { events, feed } = session();
    feed(assistantError("Invalid API key · Please run /login"));
    feed(assistantError("Invalid API key · Please run /login", "authentication_failed"));
    feed(result({ is_error: true, result: "Invalid API key · Please run /login" }));
    const e = errors(events);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ code: "auth_required", fatal: false });
    expect(e[0]!.message).toContain("Invalid API key");
    // The turn still ends normally (the engine collects it).
    expect(events.some((x) => x.type === "turn_end")).toBe(true);
  });

  it("ordinary assistant text that mentions a rate limit is not an error", () => {
    const { events, feed } = session();
    feed(assistantError("The API has a rate limit of 429 requests; usage limit reached is handled", undefined, "claude-x"));
    expect(errors(events)).toEqual([]);
  });

  it("usage limit: rate_limit_event rejected carries resetAt; the assistant rate_limit error with usage text is not reported twice", () => {
    const { events, feed } = session();
    feed({ type: "rate_limit_event", uuid: "u", session_id: "s1", rate_limit_info: { status: "allowed_warning", resetsAt: 1760000000 } });
    expect(errors(events)).toEqual([]);
    feed({ type: "rate_limit_event", uuid: "u", session_id: "s1", rate_limit_info: { status: "rejected", resetsAt: 1760000000, rateLimitType: "five_hour" } });
    feed({ type: "rate_limit_event", uuid: "u", session_id: "s1", rate_limit_info: { status: "rejected", resetsAt: 1760000000, rateLimitType: "five_hour" } });
    feed(assistantError("Claude usage limit reached. Your limit will reset at 5pm.", "rate_limit"));
    const e = errors(events);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ code: "usage_limit", fatal: false, resetAt: new Date(1760000000 * 1000).toISOString() });
  });

  it("rate limit and API errors from an is_error result (status + text)", () => {
    const a = session();
    a.feed(result({ is_error: true, api_error_status: 429, result: "API Error: 429 Too Many Requests" }));
    expect(errors(a.events)).toMatchObject([{ code: "rate_limited", status: 429, fatal: false }]);
    const b = session();
    b.feed(result({ is_error: true, api_error_status: 500, result: "API Error: 500 Internal server error" }));
    expect(errors(b.events)).toMatchObject([{ code: "api_error", status: 500 }]);
    const c = session();
    c.feed({ ...result({}), subtype: "error_during_execution", is_error: true, errors: ["Error: Please run /login"] });
    expect(errors(c.events)).toMatchObject([{ code: "auth_required" }]);
    const d = session();
    d.feed({ ...result({}), subtype: "error_max_turns", is_error: true, errors: [] });
    // MARK: wave4 w4-longwork — §38.2: no API error, but the max_turns notice (test/longWork.test.ts).
    expect(errors(d.events).map((e) => e.code)).toEqual(["max_turns"]);
  });

  it("api_retry → api_retrying (non-fatal, attempt / maxRetries / retryDelayMs / status), every attempt", () => {
    const { events, feed } = session();
    feed({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: "overloaded", uuid: "u", session_id: "s1" });
    feed({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: null, error: "unknown", uuid: "u", session_id: "s1" });
    const e = errors(events);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ code: "api_retrying", fatal: false, attempt: 1, maxRetries: 10, retryDelayMs: 2000, status: 529 });
    expect(e[1]).toMatchObject({ code: "api_retrying", attempt: 2, status: null });
  });

  it("auth_status with an error → auth_required", () => {
    const { events, feed } = session();
    feed({ type: "auth_status", isAuthenticating: false, output: [], error: "OAuth token revoked", uuid: "u", session_id: "s1" });
    expect(errors(events)).toMatchObject([{ code: "auth_required", fatal: false }]);
  });

  it("cli_start_slow: a non-fatal hint when the CLI has not initialized in time; none once it has", async () => {
    let resolveInit: (() => void) | undefined;
    const makeQuery = (initResolves: boolean) =>
      (() => {
        const q = {
          async next() {
            await new Promise(() => {});
            return { done: true, value: undefined };
          },
          async return() {
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
          interrupt: async () => undefined,
          initializationResult: () => (initResolves ? Promise.resolve({}) : new Promise<void>((r) => (resolveInit = r))),
        };
        return q as unknown as Query;
      }) as never;
    const settings = { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", startSlowHintMs: 40 };
    const slow = session({ settings, queryFn: makeQuery(false) });
    await slow.s.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(errors(slow.events)).toMatchObject([{ code: "cli_start_slow", fatal: false }]);
    resolveInit?.();
    const fast = session({ settings, queryFn: makeQuery(true) });
    await fast.s.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(errors(fast.events)).toEqual([]);
  });
});

describe("engine forwards codes", () => {
  function repo(): string {
    const dir = makeTempDir("rg-apierr");
    dirs.push(dir);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@e.com");
    sh(dir, "config", "user.name", "T");
    write(dir, "a.txt", "a\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "i");
    return dir;
  }

  it("session error details reach the error event; hints do not become state.lastError; English refusals carry a code", async () => {
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(repo());
    h.session().emit({ type: "error", message: "retrying", fatal: false, code: "api_retrying", attempt: 1, maxRetries: 10, retryDelayMs: 500, status: 529 });
    await h.settle();
    expect(h.ofType("error").at(-1)).toEqual({ type: "error", message: "retrying", fatal: false, scope: "session", code: "api_retrying", attempt: 1, maxRetries: 10, retryDelayMs: 500, status: 529 });
    expect(h.engine.state.lastError).toBeNull();
    h.session().emit({ type: "error", message: "Usage limit", fatal: false, code: "usage_limit", resetAt: "2026-10-20T17:00:00.000Z" });
    await h.settle();
    expect(h.ofType("error").at(-1)).toMatchObject({ code: "usage_limit", resetAt: "2026-10-20T17:00:00.000Z", scope: "session" });
    expect(h.engine.state.lastError).toBe("Usage limit");

    await h.engine.handle({ type: "send", text: "   ", id: "e1" });
    expect(h.ofType("result").find((r) => r.id === "e1")).toMatchObject({ ok: false, error: "empty message", code: "empty_message" });
    await h.engine.handle({ type: "nope" as never, id: "e2" });
    expect(h.ofType("result").find((r) => r.id === "e2")).toMatchObject({ ok: false, code: "unknown_command" });
  });
});
