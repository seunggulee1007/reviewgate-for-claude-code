import { describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type SessionSettings } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";

/** ClaudeSession side of §24–28: fork options, image content blocks, model / effort calls, compact context, interrupt. */
function started(settings: Partial<SessionSettings> = {}) {
  const events: SessionEvent[] = [];
  const calls: { method: string; args: unknown[] }[] = [];
  let options: Options | undefined;
  let prompt: AsyncIterable<SDKUserMessage> | undefined;
  let release: (() => void) | null = null;
  const q = {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((r) => (release = r));
    },
    setModel: async (...args: unknown[]) => void calls.push({ method: "setModel", args }),
    applyFlagSettings: async (...args: unknown[]) => void calls.push({ method: "applyFlagSettings", args }),
    interrupt: async () => void calls.push({ method: "interrupt", args: [] }),
    return: async () => {
      release?.();
      return { done: true, value: undefined };
    },
  } as unknown as Query;
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", ...settings },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
    queryFn: ((args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      options = args.options;
      prompt = args.prompt;
      return q;
    }) as never,
  });
  const feed = (m: SDKMessage) => (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage(m);
  const firstMessage = async (): Promise<SDKUserMessage> => {
    const it = prompt![Symbol.asyncIterator]();
    return (await it.next()).value as SDKUserMessage;
  };
  return { s, events, calls, options: () => options!, firstMessage, feed };
}

describe("ClaudeSession §24–28", () => {
  it("a rewind fork starts with resume + resumeSessionAt + forkSession + the new id; effort rides on the start", async () => {
    const t = started({ resumeSessionId: "old", forkAt: "uuid-7", sessionId: "new-id", effort: "low", model: "sonnet" });
    await t.s.start();
    expect(t.options()).toMatchObject({ resume: "old", resumeSessionAt: "uuid-7", forkSession: true, sessionId: "new-id", effort: "low", model: "sonnet" });
    await t.s.dispose();
    // A plain resume never forks; a fresh session keeps its pre-chosen id.
    const r = started({ resumeSessionId: "old", sessionId: "ignored" });
    await r.s.start();
    expect(r.options().forkSession).toBeUndefined();
    expect(r.options().sessionId).toBeUndefined();
    expect(r.options().effort).toBeUndefined();
    await r.s.dispose();
  });

  it("images go out as base64 image blocks before the text; text-only stays a string", async () => {
    const t = started();
    await t.s.start();
    t.s.sendUser("What is it?", undefined, [{ mediaType: "image/png", dataBase64: "AAAA" }]);
    const m = await t.firstMessage();
    expect(m.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "What is it?" },
    ]);
    await t.s.dispose();
    const u = started();
    await u.s.start();
    u.s.sendUser("plain");
    expect((await u.firstMessage()).message.content).toBe("plain");
    await u.s.dispose();
  });

  it("setModel / setEffort reach Query.setModel and the flag effortLevel", async () => {
    const t = started();
    await t.s.start();
    await t.s.setModel("haiku");
    await t.s.setModel(null);
    await t.s.setEffort("max");
    await t.s.setEffort(null);
    expect(t.calls).toEqual([
      { method: "setModel", args: ["haiku"] },
      { method: "setModel", args: [undefined] },
      { method: "applyFlagSettings", args: [{ effortLevel: "max" }] },
      { method: "applyFlagSettings", args: [{ effortLevel: null }] },
    ]);
    await t.s.dispose();
  });

  it("a /compact turn reports the post-compaction context size; interrupt denies an open permission card", async () => {
    const t = started();
    await t.s.start();
    t.s.sendUser("/compact");
    t.feed({ type: "system", subtype: "compact_boundary", session_id: "s", uuid: "u", compact_metadata: { trigger: "manual", pre_tokens: 16340, post_tokens: 3704 } } as unknown as SDKMessage);
    t.feed({ type: "result", subtype: "success", is_error: false, result: "", session_id: "s", total_cost_usd: 0, duration_ms: 5, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} } as unknown as SDKMessage);
    const end = t.events.find((e) => e.type === "turn_end") as Extract<SessionEvent, { type: "turn_end" }>;
    expect(end.usage.contextTokens).toBe(3704);
    // The status line's context follows the compaction (not the last answer before it).
    expect(t.s.statusUsage.usage).toEqual({ input_tokens: 3704, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    // MARK: wave4c w4c-commit — §41.1 (SME-11): the turn says the conversation was compacted ("대화를 줄였어요"); the next one does not.
    expect(end.usage.compacted).toEqual({ trigger: "manual", preTokens: 16340 });

    t.s.sendUser("run it");
    const canUseTool = (t.s as unknown as { canUseTool: (n: string, i: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<{ behavior: string; interrupt?: boolean }> }).canUseTool;
    const decision = canUseTool("Bash", { command: "make deploy" }, { signal: new AbortController().signal });
    await new Promise((r) => setImmediate(r));
    expect(t.events.some((e) => e.type === "permission_request")).toBe(true);
    await t.s.interrupt();
    await expect(decision).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(t.calls.at(-1)!.method).toBe("interrupt");
    t.feed({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s", total_cost_usd: 0, duration_ms: 5, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} } as unknown as SDKMessage);
    const second = t.events.filter((e) => e.type === "turn_end").at(-1) as Extract<SessionEvent, { type: "turn_end" }>;
    expect(second).not.toBe(end);
    expect(second.usage.compacted).toBeUndefined();
    await t.s.dispose();
  });
});

describe("tool results with images (§24)", () => {
  it("an image block of a tool result becomes a placeholder, never base64 in the preview", async () => {
    const t = started();
    await t.s.start();
    t.s.sendUser("look");
    t.feed({ type: "user", parent_tool_use_id: null, session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_r", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } }] }] } } as unknown as SDKMessage);
    const r = t.events.find((e) => e.type === "tool_result") as Extract<SessionEvent, { type: "tool_result" }>;
    expect(r.preview).toBe("[image/png, 18 bytes]");
    await t.s.dispose();
  });
});
