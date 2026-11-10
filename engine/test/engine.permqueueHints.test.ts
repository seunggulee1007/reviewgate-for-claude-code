import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClaudeSession, makeHarness, type Harness } from "./helpers/engine.js";
import { makeRepo, removeDir, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.7 (§33.1 × §33.5): "세션 동안 허용" on one card answers the other queued requests the hooks would now
 * allow — with the hooks' own rules, the MCP servers' annotations included. Before, the engine judged the queue without
 * them, so a tool its server marks destructive (or not read-only) whose name merely looks like a read (`get_…`) was
 * answered `allow` by the user's `mcp__server` rule although the hooks had put it on a card for exactly that reason.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** The live session's MCP annotations, as `mcpServerStatus()` reported them to the real session. */
class AnnotatedSession extends FakeClaudeSession {
  readonly mcpToolHints = new Map<string, { readOnly?: boolean; destructive?: boolean }>([
    ["mcp__srv__get_and_rotate_key", { destructive: true }],
    ["mcp__srv__get_report", { readOnly: true }],
  ]);
}

async function started(): Promise<Harness> {
  const dir = realpathSync(makeRepo());
  dirs.push(dir);
  // The user's own rule (project settings): every tool of the server.
  write(dir, ".claude/settings.json", JSON.stringify({ permissions: { allow: ["mcp__srv"] } }));
  const sessions: FakeClaudeSession[] = [];
  const h = makeHarness({
    sessionFactory: (o) => {
      const s = new AnnotatedSession(o);
      sessions.push(s);
      h.sessions.push(s);
      return s;
    },
  });
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "rotate the key and run the tests" });
  return h;
}

describe("a remembered allow answers the queue with the hooks' rules (§35.7)", () => {
  it("a destructive MCP tool with a read-looking name keeps its card; an annotated read is answered", async () => {
    const h = await started();
    const s = h.session();
    s.emit({ type: "permission_request", requestId: "R1", toolName: "Bash", input: { command: "npm test" }, toolUseId: "b1" });
    s.emit({ type: "permission_request", requestId: "R2", toolName: "mcp__srv__get_and_rotate_key", input: { name: "prod" }, toolUseId: "m1" });
    await h.settle();
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["R1", "R2"]);

    await h.engine.handle({ type: "permission_response", requestId: "R1", allow: true, remember: true });
    expect(s.permissionResponses.map((r) => [r.requestId, r.allow])).toEqual([["R1", true]]);
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["R2"]);

    // The same rule still answers a tool the server says only reads.
    s.emit({ type: "permission_request", requestId: "R3", toolName: "Bash", input: { command: "npm run lint" }, toolUseId: "b2" });
    s.emit({ type: "permission_request", requestId: "R4", toolName: "mcp__srv__get_report", input: {}, toolUseId: "m2" });
    await h.settle();
    await h.engine.handle({ type: "permission_response", requestId: "R3", allow: true, remember: true });
    expect(s.permissionResponses.map((r) => [r.requestId, r.allow])).toEqual([["R1", true], ["R3", true], ["R4", true]]);
    expect(h.engine.state.session.pendingPermissions!.map((p) => p.requestId)).toEqual(["R2"]);
  });
});
