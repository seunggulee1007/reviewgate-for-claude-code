import { createServer } from "node:net";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_BODY_MAX, HookServer, RETIRED_REASON, type TerminalHookHandler } from "../src/session/hookServer.js";

// docs/PROTOCOL.md §57.3: the hook server — 127.0.0.1, per-spawn tokens, statuses, retired tokens.

const servers: HookServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function started(): Promise<{ server: HookServer; port: number }> {
  const server = new HookServer();
  servers.push(server);
  return { server, port: await server.start() };
}

function recorder(answer: Record<string, unknown> = { ok: 1 }): TerminalHookHandler & { inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  return { inputs, handleHook: async (input) => (inputs.push(input), answer) };
}

async function post(port: number, opts: { token?: string; body?: string | Blob; path?: string; method?: string } = {}): Promise<{ status: number; json: unknown; type: string | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== undefined) headers["X-ReviewGate-Token"] = opts.token;
  const method = opts.method ?? "POST";
  const res = await fetch(`http://127.0.0.1:${port}${opts.path ?? "/hook"}`, { method, headers, ...(method === "GET" ? {} : { body: opts.body ?? "{}" }) });
  return { status: res.status, json: await res.json(), type: res.headers.get("content-type") };
}

describe("HookServer", () => {
  it("a request the CLI gives up on (the connection closes before the answer) aborts the handler's signal", async () => {
    const { server, port } = await started();
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const token = server.issue({ handleHook: async (_input, s) => ((signal = s), await held, {}) });
    const req = request({ host: "127.0.0.1", port, path: "/hook", method: "POST", headers: { "Content-Type": "application/json", "X-ReviewGate-Token": token } });
    req.on("error", () => undefined);
    req.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }));
    for (let i = 0; i < 100 && !signal; i++) await new Promise((r) => setTimeout(r, 10));
    expect(signal?.aborted).toBe(false);
    const aborted = new Promise<void>((r) => signal!.addEventListener("abort", () => r(), { once: true }));
    req.destroy();
    await aborted;
    expect(signal!.aborted).toBe(true);
    release();
    // An answered request never aborts.
    let answered: AbortSignal | undefined;
    const t2 = server.issue({ handleHook: async (_input, s) => ((answered = s), {}) });
    expect((await post(port, { token: t2 })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(answered?.aborted).toBe(false);
  });

  it("listens on 127.0.0.1 on a random port; a valid request reaches its handler", async () => {
    const { server, port } = await started();
    expect(port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${port}/hook`);
    const h = recorder({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } });
    const token = server.issue(h);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const r = await post(port, { token, body: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }) });
    expect(r).toEqual({ status: 200, type: "application/json", json: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" } } });
    expect(h.inputs).toEqual([{ hook_event_name: "UserPromptSubmit", prompt: "hi" }]);
  });

  it("401 for a missing or wrong token (same length too), 404 another path, 405 another method, 400 invalid JSON", async () => {
    const { server, port } = await started();
    const h = recorder();
    const token = server.issue(h);
    expect((await post(port)).status).toBe(401);
    expect((await post(port, { token: "nope" })).status).toBe(401);
    expect((await post(port, { token: token.replace(/^./, token[0] === "a" ? "b" : "a") })).status).toBe(401);
    expect(await post(port, { token, path: "/other" })).toMatchObject({ status: 404, json: {} });
    expect(await post(port, { token, method: "GET" })).toMatchObject({ status: 405, json: {} });
    expect(await post(port, { token, method: "PUT" })).toMatchObject({ status: 405, json: {} });
    expect(await post(port, { token, body: "{nope" })).toMatchObject({ status: 400, json: {} });
    expect(await post(port, { token, body: "[1]" })).toMatchObject({ status: 400, json: {} });
    expect(h.inputs).toEqual([]);
  });

  it("413 for a body over 16 MiB, declared or streamed", async () => {
    const { server, port } = await started();
    const h = recorder();
    const token = server.issue(h);
    expect((await post(port, { token, body: new Blob([" ".repeat(HOOK_BODY_MAX + 1)]) })).status).toBe(413);
    // Chunked (no Content-Length): the cap holds while streaming.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/hook", method: "POST", headers: { "X-ReviewGate-Token": token, "Transfer-Encoding": "chunked" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      for (let i = 0; i < 17; i++) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
    expect(h.inputs).toEqual([]);
  });

  it("a retired token gets a blocking answer per event; two live tokens route to their own handlers", async () => {
    const { server, port } = await started();
    const a = recorder({ from: "a" });
    const b = recorder({ from: "b" });
    const ta = server.issue(a);
    const tb = server.issue(b);
    expect((await post(port, { token: ta, body: JSON.stringify({ hook_event_name: "Stop" }) })).json).toEqual({ from: "a" });
    expect((await post(port, { token: tb, body: JSON.stringify({ hook_event_name: "Stop" }) })).json).toEqual({ from: "b" });
    server.retire(ta);
    const ups = await post(port, { token: ta, body: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "x" }) });
    expect(ups).toMatchObject({ status: 200, json: { decision: "block", reason: RETIRED_REASON } });
    const pre = await post(port, { token: ta, body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write" }) });
    expect(pre.json).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: RETIRED_REASON } });
    expect((await post(port, { token: ta, body: JSON.stringify({ hook_event_name: "Stop" }) })).json).toEqual({});
    expect(a.inputs).toHaveLength(1);
    expect((await post(port, { token: tb, body: JSON.stringify({ hook_event_name: "Stop" }) })).json).toEqual({ from: "b" });
  });

  it("a handler that throws gives 500 (fail closed where the hook says so)", async () => {
    const { server, port } = await started();
    const token = server.issue({ handleHook: async () => Promise.reject(new Error("boom")) });
    expect((await post(port, { token, body: JSON.stringify({ hook_event_name: "UserPromptSubmit" }) })).status).toBe(500);
  });

  it("close() frees the port and retires every token", async () => {
    const { server, port } = await started();
    server.issue(recorder());
    await server.close();
    expect(server.port).toBeNull();
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
  });
});
