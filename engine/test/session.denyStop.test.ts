import { describe, expect, it } from "vitest";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, USER_DENIED_MESSAGE } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";

/**
 * docs/PROTOCOL.md §33.10 (r2-chats-cards M25), session side: a deny says what the terminal's "No" says — Claude stops
 * and waits — unless the user wrote the reason; "멈추기" also ends the turn like Stop, marked as the app's interrupt so
 * the turn ends `interrupted`; a subagent's card never interrupts (the other agents keep running).
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

async function cards(events: SessionEvent[], n: number): Promise<Extract<SessionEvent, { type: "permission_request" }>[]> {
  for (let i = 0; i < 500 && requests(events).length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return requests(events);
}

const interrupted = (s: ClaudeSession): boolean => (s as unknown as { wasInterrupted(): boolean }).wasInterrupted();

describe("ClaudeSession: a deny like the terminal's No (§33.10)", () => {
  it("a deny without a message is the CLI's own No — stop and wait for the user; the turn is not interrupted", async () => {
    const { s, events, canUseTool } = session();
    const p = canUseTool("Bash", { command: "rm -rf build" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);
    const [req] = await cards(events, 1);
    s.respondPermission(req!.requestId, false);
    expect(await p).toEqual({ behavior: "deny", message: USER_DENIED_MESSAGE });
    expect(USER_DENIED_MESSAGE).toContain("STOP what you are doing and wait for the user to tell you how to proceed.");
    expect(interrupted(s)).toBe(false);
  });

  it("the user's own reason goes as it is (deny with an instruction, a skipped question)", async () => {
    const { s, events, canUseTool } = session();
    const p = canUseTool("Bash", { command: "npm test" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);
    const [req] = await cards(events, 1);
    s.respondPermission(req!.requestId, false, "run only the api tests");
    expect(await p).toEqual({ behavior: "deny", message: "run only the api tests" });
  });

  it("멈추기: deny + interrupt, marked as the app's interrupt so the turn ends `interrupted`", async () => {
    const { s, events, canUseTool } = session();
    const p = canUseTool("Bash", { command: "git push" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);
    const [req] = await cards(events, 1);
    s.respondPermission(req!.requestId, false, undefined, undefined, { interrupt: true });
    expect(await p).toEqual({ behavior: "deny", message: USER_DENIED_MESSAGE, interrupt: true });
    expect(interrupted(s)).toBe(true);
  });

  it("a subagent's card never interrupts the turn — the deny goes to that agent only", async () => {
    const { s, events, canUseTool } = session();
    const signal = new AbortController().signal;
    const p = canUseTool("Bash", { command: "./gradlew test" }, { signal, toolUseID: "tA", agentID: "a-123" } as never);
    const [req] = await cards(events, 1);
    s.respondPermission(req!.requestId, false, undefined, undefined, { interrupt: true });
    expect(await p).toEqual({ behavior: "deny", message: USER_DENIED_MESSAGE });
    expect(interrupted(s)).toBe(false);
  });

  it("an allow ignores the deny options", async () => {
    const { s, events, canUseTool } = session();
    const p = canUseTool("WebFetch", { url: "https://tasks.example.com" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);
    const [req] = await cards(events, 1);
    s.respondPermission(req!.requestId, true, undefined, undefined, { interrupt: true });
    expect(await p).toEqual({ behavior: "allow" });
    expect(interrupted(s)).toBe(false);
  });
});
