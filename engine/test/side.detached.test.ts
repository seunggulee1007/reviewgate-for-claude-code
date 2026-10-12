import { describe, expect, it } from "vitest";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { SIDE_READ_ONLY_REASON, SideQuery, sideToolDenyReason, type SideQueryOptions } from "../src/side/sideQuery.js";
import { MAX_SIDE_RUNNING, SideThreads, type ForkSource, type SideHost } from "../src/side/threads.js";
import { FakeSide, type SideScript } from "./helpers/fakeSide.js";

/** wave3 engine-flow: the read-only one-shot forks behind §36.11 commit drafts and §36.13 pre-reviews. */

describe("report-only tools (§36.13)", () => {
  it("ReportFindings runs only when the fork was given it; extraTools never widens to a tool that changes something", () => {
    expect(sideToolDenyReason("ReportFindings", {}, { allowWeb: false })).toBe(SIDE_READ_ONLY_REASON);
    expect(sideToolDenyReason("ReportFindings", { findings: [] }, { allowWeb: false, extraTools: ["ReportFindings"] })).toBeUndefined();
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task", "mcp__fs__write"]) {
      expect(sideToolDenyReason(t, { file_path: "/x" }, { allowWeb: true, extraTools: [t, "ReportFindings"] }), t).toBe(SIDE_READ_ONLY_REASON);
    }
    expect(sideToolDenyReason("Bash", { command: "git commit -m x" }, { allowWeb: true, extraTools: ["Bash"] })).toBe(SIDE_READ_ONLY_REASON);
  });

  it("SideQuery passes persistSession false, maxTurns and the system text; its hook and canUseTool apply the same policy", async () => {
    const opts = new SideQuery({
      cwd: "/tmp/p", claudePath: "/nonexistent/claude", env: { CLAUDE_CODE_REPORT_FINDINGS: "1" }, platform: { killTree: async () => undefined, isWindows: false },
      settingSources: ["project"], flagSettings: { disableAllHooks: true }, prompt: "/code-review low", allowWeb: false,
      emit: () => {}, log: () => {}, extraTools: ["ReportFindings"], persistSession: false, maxTurns: 60, system: "You review.",
    }).queryOptions();
    expect(opts.persistSession).toBe(false);
    expect(opts.maxTurns).toBe(60);
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "You review." });
    expect((opts.env as Record<string, string>).CLAUDE_CODE_REPORT_FINDINGS).toBe("1");
    expect(opts.mcpServers).toEqual({});
    const hook = opts.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
    const decide = async (tool: string, input: Record<string, unknown>) => {
      const out = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s", transcript_path: "", cwd: "/tmp", tool_use_id: "t" } as unknown as HookInput, "t", { signal: new AbortController().signal });
      return (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
    };
    expect(await decide("ReportFindings", { findings: [] })).toBe("allow");
    expect(await decide("Write", { file_path: "/tmp/a" })).toBe("deny");
    expect(await decide("Edit", { file_path: "/tmp/a" })).toBe("deny");
    expect(await decide("Bash", { command: "rm -rf src" })).toBe("deny");
    expect(await decide("Agent", { prompt: "x" })).toBe("deny");
    const cut = await opts.canUseTool!("NotebookEdit", { notebook_path: "/tmp/n" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
    expect(cut).toEqual({ behavior: "deny", message: SIDE_READ_ONLY_REASON });
    // A plain side question keeps its defaults.
    const plain = new SideQuery({ cwd: "/tmp/p", claudePath: "/x", env: {}, platform: { killTree: async () => undefined, isWindows: false }, settingSources: ["project"], prompt: "q", allowWeb: true, emit: () => {}, log: () => {} }).queryOptions();
    expect(plain.persistSession).toBeUndefined();
    expect(plain.maxTurns).toBe(30);
  });
});

function host(script: SideScript, source: () => ForkSource = () => ({ mode: "fork_at", sessionId: "main-1", at: "uuid-1" })) {
  const queries: FakeSide[] = [];
  const costs: number[] = [];
  const h: SideHost = {
    gitDir: () => null,
    forkSource: source,
    launch: async () => ({ cwd: "/repo", claudePath: "/x/claude", env: { PATH: "/bin" }, platform: { killTree: async () => undefined, isWindows: false }, settingSources: ["project"], flagSettings: { disableAllHooks: true }, allowWeb: true }),
    firstPrompt: async (q) => q,
    emit: () => {},
    onCost: (usd) => costs.push(usd),
    log: () => {},
    makeQuery: (o: SideQueryOptions) => {
      const f = new FakeSide(o, script);
      queries.push(f);
      return f;
    },
  };
  return { h, queries, costs };
}

describe("SideThreads.startDetached", () => {
  it("forks like a first question with the merged options, reports its events and cost, and is no thread", async () => {
    const seen: string[] = [];
    const { h, queries, costs } = host(() => ({ text: "fix: guard empty input", cost: 0.01, events: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] }));
    const side = new SideThreads(h);
    await side.load("chat-1");
    const run = await side.startDetached({ key: "commit_draft:1", prompt: "Draft it", options: { env: { CLAUDE_CODE_REPORT_FINDINGS: "1" }, persistSession: false, allowWeb: false }, onEvent: (e) => seen.push(e.type) });
    const r = await run.done;
    expect(r.text).toBe("fix: guard empty input");
    expect(queries[0]!.opts).toMatchObject({ forkFrom: "main-1", forkAt: "uuid-1", prompt: "Draft it", persistSession: false, allowWeb: false, cwd: "/repo" });
    expect(queries[0]!.opts.env).toEqual({ PATH: "/bin", CLAUDE_CODE_REPORT_FINDINGS: "1" });
    expect(queries[0]!.opts.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toEqual(["session", "tool_use", "text_delta"]);
    expect(costs).toEqual([0.01]);
    expect(side.list()).toEqual([]);
    expect(side.runningCount).toBe(0);
  });

  it("a fork at an unknown uuid is retried on the whole session; it shares MAX_SIDE_RUNNING with questions; cancel and stopAll interrupt it", async () => {
    const { h, queries } = host((o) => (o.forkAt ? { text: "", error: "No message found with message.uuid", silent: true } : { text: "ok", hold: true }));
    const side = new SideThreads(h);
    await side.load("chat-1");
    const a = await side.startDetached({ key: "a", prompt: "p" });
    await new Promise((r) => setTimeout(r, 5));
    expect(queries.map((q) => [q.opts.forkFrom, q.opts.forkAt])).toEqual([["main-1", "uuid-1"], ["main-1", undefined]]);
    await expect(side.startDetached({ key: "a", prompt: "p" })).rejects.toThrow(/side_busy/);
    const others = [];
    for (let i = 1; i < MAX_SIDE_RUNNING; i++) others.push(await side.startDetached({ key: `k${i}`, prompt: "p" }));
    await expect(side.startDetached({ key: "one-more", prompt: "p" })).rejects.toThrow(/side_limit/);
    await expect(side.ask(undefined, null, "a question")).rejects.toThrow(/side_limit/);
    await a.cancel();
    expect((await a.done).stopReason).toBe("interrupted");
    await side.stopAll();
    for (const o of others) expect((await o.done).stopReason).toBe("interrupted");
    expect(side.runningCount).toBe(0);
  });

  it("no project → no_project", async () => {
    const { h } = host(() => ({ text: "x" }));
    const side = new SideThreads(h);
    await expect(side.startDetached({ key: "x", prompt: "p" })).rejects.toThrow(/no_project/);
  });
});
