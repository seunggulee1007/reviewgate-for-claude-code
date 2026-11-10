import { describe, expect, it } from "vitest";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";

/**
 * docs/PROTOCOL.md §33 (audit agents-01), session side: the CLI can hold several `can_use_tool` requests at once
 * (two parallel subagents — verified with CLI 2.1.307, maxOutstanding = 2). Each `permission_request` carries the
 * tool call's id and the asking subagent's id; a response resolves only its own request.
 */

function session(): { s: ClaudeSession; events: SessionEvent[]; canUseTool: CanUseTool } {
  const events: SessionEvent[] = [];
  const s = new ClaudeSession({
    cwd: "/tmp",
    settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
    claudePath: "/nonexistent/claude",
    env: {},
    platform: { killTree: async () => undefined, isWindows: false },
    emit: (e) => events.push(e),
    log: () => {},
  });
  (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
  const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
  return { s, events, canUseTool };
}

const requests = (events: SessionEvent[]) => events.filter((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request");

/** canUseTool resolves the containment root (git) before it raises the card: wait until `n` cards are up. */
async function cards(events: SessionEvent[], n: number): Promise<Extract<SessionEvent, { type: "permission_request" }>[]> {
  for (let i = 0; i < 500 && requests(events).length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return requests(events);
}

describe("ClaudeSession: concurrent can_use_tool requests (§33)", () => {
  it("each request carries toolUseId + the subagent id and is answered on its own", async () => {
    const { s, events, canUseTool } = session();
    const signal = new AbortController().signal;
    const pA = canUseTool("Bash", { command: "touch a.txt" }, { signal, toolUseID: "toolu_A", agentID: "afd45e91c77e319d8", requestId: "cli-1" } as never);
    const pB = canUseTool("Bash", { command: "touch b.txt" }, { signal, toolUseID: "toolu_B", agentID: "abcd830407bd751b0", requestId: "cli-2" } as never);
    const raised = await cards(events, 2);
    const a = raised.find((r) => r.toolUseId === "toolu_A");
    const b = raised.find((r) => r.toolUseId === "toolu_B");
    expect(a).toMatchObject({ toolName: "Bash", input: { command: "touch a.txt" }, toolUseId: "toolu_A", agent: { agentId: "afd45e91c77e319d8" } });
    expect(b).toMatchObject({ toolName: "Bash", input: { command: "touch b.txt" }, toolUseId: "toolu_B", agent: { agentId: "abcd830407bd751b0" } });
    expect(a!.requestId).not.toBe(b!.requestId);

    let aDone = false;
    void pA.then(() => (aDone = true));
    s.respondPermission(b!.requestId, true);
    expect(await pB).toEqual({ behavior: "allow" });
    await new Promise((r) => setImmediate(r));
    expect(aDone).toBe(false);
    s.respondPermission(a!.requestId, false, "no");
    expect(await pA).toEqual({ behavior: "deny", message: "no" });
  });

  it("a main-agent request has no agent; a request the CLI aborts is reported as cancelled", async () => {
    const { events, canUseTool } = session();
    const ac = new AbortController();
    const p = canUseTool("WebFetch", { url: "https://example.com" }, { signal: ac.signal, toolUseID: "toolu_M" } as never);
    const [req] = await cards(events, 1);
    expect(req).toMatchObject({ toolUseId: "toolu_M" });
    expect(req).not.toHaveProperty("agent");
    ac.abort();
    expect(await p).toMatchObject({ behavior: "deny" });
    expect(events.filter((e) => e.type === "permission_cancelled")).toEqual([{ type: "permission_cancelled", requestId: req!.requestId }]);
  });

  it("interrupt answers every open request and reports each as cancelled", async () => {
    const { s, events, canUseTool } = session();
    const signal = new AbortController().signal;
    const p1 = canUseTool("Bash", { command: "make a" }, { signal, toolUseID: "t1", agentID: "x" } as never);
    const p2 = canUseTool("Bash", { command: "make b" }, { signal, toolUseID: "t2", agentID: "y" } as never);
    await cards(events, 2);
    (s as unknown as { q: unknown }).q = { interrupt: async () => undefined }; // a started query
    await s.interrupt();
    expect(await p1).toMatchObject({ behavior: "deny", interrupt: true });
    expect(await p2).toMatchObject({ behavior: "deny", interrupt: true });
    expect(events.filter((e) => e.type === "permission_cancelled").map((e) => (e as { requestId: string }).requestId).sort()).toEqual(requests(events).map((r) => r.requestId).sort());
  });
});
