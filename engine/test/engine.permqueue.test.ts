import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §33 (audit agents-01): two parallel subagents can hold a permission prompt each at the same
 * time. The engine keeps every open request (oldest first), attributes it to the agent that asked, and a
 * `permission_response` reaches exactly the request it names.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

async function started(): Promise<Harness> {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "compile and test in parallel" });
  return h;
}

/** Two subagents (executor / test-engineer) running at once, each about to ask for a Bash command. */
function twoAgents(h: Harness): void {
  const s = h.session();
  s.emit({ type: "tool_use", id: "agA", name: "Agent", input: { description: "compile", subagent_type: "executor", prompt: "compile" } });
  s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "taskA", toolUseId: "agA", description: "compile", subagentType: "executor", taskType: "local_agent" } });
  s.emit({ type: "tool_use", id: "agB", name: "Agent", input: { description: "test", subagent_type: "test-engineer", prompt: "test" } });
  s.emit({ type: "agent_signal", signal: { kind: "task_started", taskId: "taskB", toolUseId: "agB", description: "test", subagentType: "test-engineer", taskType: "local_agent" } });
  s.emit({ type: "tool_use", id: "bashA", name: "Bash", input: { command: "./gradlew :acme-api:compileJava" }, parentToolUseId: "agA" });
  s.emit({ type: "tool_use", id: "bashB", name: "Bash", input: { command: "./gradlew test" }, parentToolUseId: "agB" });
}

describe("concurrent permission requests (§33, audit agents-01)", () => {
  it("queues every open request oldest first and answers exactly the one a response names", async () => {
    const h = await started();
    const s = h.session();
    twoAgents(h);
    s.emit({ type: "permission_request", requestId: "R1", toolName: "Bash", input: { command: "./gradlew :acme-api:compileJava" }, toolUseId: "bashA", agent: { agentId: "taskA" } });
    s.emit({ type: "permission_request", requestId: "R2", toolName: "Bash", input: { command: "./gradlew test" }, toolUseId: "bashB", agent: { agentId: "taskB" } });
    await h.settle();

    let st = h.engine.state;
    expect(st.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["R1", "R2"]);
    // The single field stays for older clients: the request that has waited longest.
    expect(st.session.pendingPermission?.requestId).toBe("R1");
    expect(st.gate.blockedReason).toBe("awaiting_permission");
    expect(st.session.pendingPermissions![0]).toMatchObject({
      toolUseId: "bashA",
      agent: { agentId: "taskA", agentToolUseId: "agA", subagentType: "executor", description: "compile" },
    });
    expect(st.session.pendingPermissions![1]).toMatchObject({
      toolUseId: "bashB",
      agent: { agentId: "taskB", agentToolUseId: "agB", subagentType: "test-engineer", description: "test" },
    });
    // The wire event carries the same attribution.
    expect(h.ofType("permission_request").map((e) => [e.requestId, e.agent?.agentToolUseId])).toEqual([["R1", "agA"], ["R2", "agB"]]);

    // The newer card is answered first: only R2 leaves the queue, R1 still waits.
    await h.engine.handle({ type: "permission_response", requestId: "R2", allow: true });
    st = h.engine.state;
    expect(st.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["R1"]);
    expect(st.session.pendingPermission?.requestId).toBe("R1");
    expect(st.gate.blockedReason).toBe("awaiting_permission");

    await h.engine.handle({ type: "permission_response", requestId: "R1", allow: false, message: "not now" });
    st = h.engine.state;
    expect(st.session.pendingPermissions).toEqual([]);
    expect(st.session.pendingPermission).toBeNull();
    expect(st.gate.blockedReason).toBe("running");
    expect(s.permissionResponses).toEqual([
      { requestId: "R2", allow: true, message: undefined },
      { requestId: "R1", allow: false, message: "not now" },
    ]);

    // A response to a request that is no longer open is refused, and nothing reaches the session.
    await expect(h.engine.request({ type: "permission_response", requestId: "R1", allow: true })).rejects.toThrow("unknown_permission_request");
    expect(s.permissionResponses).toHaveLength(2);
  });

  it("a main-agent request carries its tool_use id and no agent; an agent the engine never saw keeps the bare id", async () => {
    const h = await started();
    const s = h.session();
    s.emit({ type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://example.com" } });
    s.emit({ type: "permission_request", requestId: "M1", toolName: "WebFetch", input: { url: "https://example.com" }, toolUseId: "t1" });
    s.emit({ type: "permission_request", requestId: "X1", toolName: "Bash", input: { command: "make" }, toolUseId: "tx", agent: { agentId: "unknown-task" } });
    await h.settle();
    const [main, stray] = h.engine.state.session.pendingPermissions!;
    expect(main).toEqual({ requestId: "M1", toolName: "WebFetch", input: { url: "https://example.com" }, toolUseId: "t1" });
    expect(stray!.agent).toEqual({ agentId: "unknown-task" });
  });

  it("an agent is found through the asking call's parent when its task was not reported (older CLIs)", async () => {
    const h = await started();
    const s = h.session();
    s.emit({ type: "tool_use", id: "agC", name: "Task", input: { description: "lint", subagent_type: "linter" } });
    s.emit({ type: "tool_use", id: "bashC", name: "Bash", input: { command: "npm run lint" }, parentToolUseId: "agC" });
    s.emit({ type: "permission_request", requestId: "C1", toolName: "Bash", input: { command: "npm run lint" }, toolUseId: "bashC", agent: { agentId: "a-123" } });
    await h.settle();
    expect(h.engine.state.session.pendingPermissions![0]!.agent).toEqual({ agentId: "a-123", agentToolUseId: "agC", subagentType: "linter", description: "lint" });
  });

  it("a request the CLI withdrew (aborted call, interrupt) leaves the queue; the turn end clears what is left", async () => {
    const h = await started();
    const s = h.session();
    s.emit({ type: "permission_request", requestId: "W1", toolName: "Bash", input: { command: "make a" }, toolUseId: "ta" });
    s.emit({ type: "permission_request", requestId: "W2", toolName: "Bash", input: { command: "make b" }, toolUseId: "tb" });
    s.emit({ type: "permission_cancelled", requestId: "W1" });
    await h.settle();
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["W2"]);
    expect(h.engine.state.session.pendingPermission?.requestId).toBe("W2");
    s.emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
    expect(h.engine.state.session.pendingPermissions).toEqual([]);
    expect(h.engine.state.session.pendingPermission).toBeNull();
  });

  it("remembering one answer also answers the queued requests it covers", async () => {
    const h = await started();
    const s = h.session();
    twoAgents(h);
    s.emit({ type: "permission_request", requestId: "G1", toolName: "Bash", input: { command: "./gradlew test --tests A" }, toolUseId: "bashA", agent: { agentId: "taskA" } });
    s.emit({ type: "permission_request", requestId: "G2", toolName: "Bash", input: { command: "./gradlew test --tests B" }, toolUseId: "bashB", agent: { agentId: "taskB" } });
    s.emit({ type: "permission_request", requestId: "G3", toolName: "Bash", input: { command: "rm -rf build" }, toolUseId: "bashX" });
    await h.settle();
    await h.engine.handle({ type: "permission_response", requestId: "G1", allow: true, remember: true });
    await h.settle();
    expect(h.engine.state.session.rememberedAllows).toEqual(["Bash:./gradlew test"]);
    expect(s.permissionResponses.map((r) => [r.requestId, r.allow])).toEqual([["G1", true], ["G2", true]]);
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["G3"]);
  });

  it("remember on a SendMessage or a reason card stores no key and answers no other request (§33.2 / §33.3)", async () => {
    const h = await started();
    const s = h.session();
    s.emit({ type: "permission_request", requestId: "S1", toolName: "SendMessage", input: { to: "team-lead", message: "done" }, toolUseId: "s1" });
    s.emit({ type: "permission_request", requestId: "S2", toolName: "SendMessage", input: { to: "team-lead", message: "again" }, toolUseId: "s2" });
    const reason = { code: "outside_project" as const, message: "Outside the project", path: "/elsewhere" };
    s.emit({ type: "permission_request", requestId: "O1", toolName: "Bash", input: { command: "touch /elsewhere/a" }, toolUseId: "o1", reason });
    s.emit({ type: "permission_request", requestId: "O2", toolName: "Bash", input: { command: "touch /elsewhere/b" }, toolUseId: "o2" });
    await h.settle();
    // An older client sends "세션 동안 허용" on every card.
    await h.engine.handle({ type: "permission_response", requestId: "S1", allow: true, remember: true });
    await h.engine.handle({ type: "permission_response", requestId: "O1", allow: true, remember: true });
    await h.settle();
    expect(h.engine.state.session.rememberedAllows).toEqual([]);
    expect(s.permissionResponses.map((r) => [r.requestId, r.allow])).toEqual([["S1", true], ["O1", true]]);
    // The second message and the plain command still wait for their own cards.
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["S2", "O2"]);
    expect([...(s.opts.rememberedAllows ?? [])]).toEqual([]);
  });

  // MARK: r2-peers — §33.2
  it("remember on a SendMessage card to a live session stores SendMessage:<its session id> and answers the queued messages to it — no other", async () => {
    const h = await started();
    const s = h.session();
    const b4 = { address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-b4", cwd: "/work/acme", status: "idle" as const, entrypoint: "cli", sessionId: "s-b4" };
    const other = { ...b4, address: "uds:/tmp/cc-socks/4343.sock", pid: 4343, name: "acme-c7", sessionId: "s-c7" };
    s.emit({ type: "permission_request", requestId: "P1", toolName: "SendMessage", input: { to: b4.address, message: "#42 done" }, toolUseId: "p1", toSession: b4 });
    s.emit({ type: "permission_request", requestId: "P2", toolName: "SendMessage", input: { to: b4.address, message: "and the tests" }, toolUseId: "p2", toSession: b4 });
    s.emit({ type: "permission_request", requestId: "P3", toolName: "SendMessage", input: { to: other.address, message: "hi" }, toolUseId: "p3", toSession: other });
    s.emit({ type: "permission_request", requestId: "P4", toolName: "SendMessage", input: { to: "acme-b4", message: "a name only" }, toolUseId: "p4" });
    await h.settle();
    await h.engine.handle({ type: "permission_response", requestId: "P1", allow: true, remember: true });
    await h.settle();
    expect(h.engine.state.session.rememberedAllows).toEqual(["SendMessage:s-b4"]);
    expect([...(s.opts.rememberedAllows ?? [])]).toEqual(["SendMessage:s-b4"]);
    expect(s.permissionResponses.map((r) => [r.requestId, r.allow])).toEqual([["P1", true], ["P2", true]]);
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["P3", "P4"]);
    // A late answer to the card the engine answered is a no-op; a plain allow of another session stores nothing.
    await h.engine.handle({ type: "permission_response", requestId: "P2", allow: true });
    await h.engine.handle({ type: "permission_response", requestId: "P3", allow: true });
    await h.engine.handle({ type: "permission_response", requestId: "P4", allow: true, remember: true });
    await h.settle();
    expect(h.engine.state.session.rememberedAllows).toEqual(["SendMessage:s-b4"]);
  });

  it("a card for Claude Code's own settings (reason claude_config, §33.9) is never answered by a new pattern or a remembered key", async () => {
    const h = await started();
    const s = h.session();
    const reason = { code: "claude_config" as const, message: "Changes Claude Code's own settings (.mcp.json) — …", path: "/repo/.mcp.json" };
    s.emit({ type: "permission_request", requestId: "K1", toolName: "Bash", input: { command: "sed -i '' s/a/b/ .mcp.json" }, toolUseId: "k1", reason });
    s.emit({ type: "permission_request", requestId: "K2", toolName: "Bash", input: { command: "sed -i '' s/a/b/ README.md" }, toolUseId: "k2" });
    s.emit({ type: "permission_request", requestId: "K3", toolName: "Bash", input: { command: "sed -i '' s/x/y/ README.md" }, toolUseId: "k3" });
    await h.settle();
    expect(h.engine.state.session.pendingPermissions![0]).toMatchObject({ requestId: "K1", reason: { code: "claude_config", path: "/repo/.mcp.json" } });
    expect(h.ofType("permission_request")[0]!.reason).toEqual(reason);
    // A pattern covering every sed command answers K2 / K3, never K1.
    await h.engine.handle({ type: "set_settings", settings: { bashAllowPatterns: ["Bash(sed:*)"] } });
    await h.settle();
    expect(s.permissionResponses.map((r) => r.requestId)).toEqual(["K2", "K3"]);
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["K1"]);
    // Neither does a remembered answer to another card whose key ("Bash:sed s/a/b/", §19.3 M21) would cover it.
    await h.engine.handle({ type: "set_settings", settings: { bashAllowPatterns: [] } });
    s.emit({ type: "permission_request", requestId: "K4", toolName: "Bash", input: { command: "sed -i '' s/a/b/ other.txt" }, toolUseId: "k4" });
    await h.settle();
    await h.engine.handle({ type: "permission_response", requestId: "K4", allow: true, remember: true });
    await h.settle();
    expect(h.engine.state.session.rememberedAllows).toEqual(["Bash:sed s/a/b/"]);
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["K1"]);
    await h.engine.handle({ type: "permission_response", requestId: "K1", allow: false });
    expect(s.permissionResponses.at(-1)).toEqual({ requestId: "K1", allow: false, message: undefined });
  });
});
