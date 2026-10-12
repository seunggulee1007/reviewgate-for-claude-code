// Sidecar stdio adapter: v2 hello/ready/state/shutdown, first-message guard, exit codes.
// No `claude` needed (no project is opened). Run: npm test -w sidecar
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIDECAR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");

function run(lines, { closeStdin = true } = {}) {
  const p = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
  const out = [];
  const err = [];
  createInterface({ input: p.stdout }).on("line", (l) => out.push(JSON.parse(l)));
  createInterface({ input: p.stderr }).on("line", (l) => err.push(l));
  for (const l of lines) p.stdin.write(JSON.stringify(l) + "\n");
  if (closeStdin) p.stdin.end();
  const exit = new Promise((resolve) => p.on("exit", (code) => resolve(code)));
  return { p, out, err, exit };
}

const settings = { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", ghHost: "github.com" };

test("v2: hello → ready(id) + state seq 1; shutdown → result + exit 0", async () => {
  const t0 = Date.now();
  const { out, err, exit } = run([
    { type: "hello", id: "h", protocolVersion: 2, client: "test", settings },
    { type: "shutdown", id: "bye" },
  ], { closeStdin: false });
  assert.equal(await exit, 0);
  const ready = out.find((m) => m.type === "ready");
  assert.deepEqual({ ...ready, engineVersion: "x" }, { type: "ready", id: "h", engineVersion: "x", platform: process.platform, protocolVersion: 2 });
  const state = out.find((m) => m.type === "state");
  assert.equal(state.state.seq, 1);
  assert.equal(state.state.gate.blockedReason, "no_session");
  assert.equal(state.state.pr.host, "github.com");
  assert.deepEqual(out.find((m) => m.type === "result" && m.id === "bye"), { type: "result", id: "bye", ok: true });
  assert.ok(err.some((l) => l.includes("protocol v2")), err.join("\n"));
  assert.ok(Date.now() - t0 < 5000, "shutdown must not hang");
});

test("v2: stdin EOF disposes and exits 0", async () => {
  const { exit } = run([{ type: "hello", protocolVersion: 2, client: "test", settings }]);
  assert.equal(await exit, 0);
});

test("v2: command with id on a closed gate gets result ok:false", async () => {
  const { out, exit } = run([
    { type: "hello", protocolVersion: 2, client: "test", settings },
    { type: "send", id: "s", text: "hi" },
    { type: "shutdown" },
  ], { closeStdin: false });
  assert.equal(await exit, 0);
  assert.deepEqual(out.find((m) => m.type === "result" && m.id === "s"), { type: "result", id: "s", ok: false, error: "gate_closed:no_session", code: "gate_closed" });
});

test("first message other than hello → fatal error + exit 2", async () => {
  const { out, exit } = run([
    { type: "start_session", cwd: process.cwd(), budget: { maxFiles: 1, maxLines: 1 }, systemPromptAppend: "", claudePath: "/nonexistent/claude" },
    { type: "shutdown" },
  ], { closeStdin: false });
  assert.equal(await exit, 2);
  const err = out.find((m) => m.type === "error");
  assert.equal(err.fatal, true);
  assert.equal(err.scope, "engine");
  assert.match(err.message, /"hello"/);
  assert.ok(out.every((m) => m.type !== "state" && m.type !== "ready"), "no v2 traffic without hello");
});

test("non-JSON input is ignored with a stderr warning", async () => {
  const p = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
  const err = [];
  createInterface({ input: p.stderr }).on("line", (l) => err.push(l));
  p.stdin.write("not json\n");
  p.stdin.write(JSON.stringify({ type: "hello", protocolVersion: 2, client: "test", settings }) + "\n");
  p.stdin.end();
  const code = await new Promise((r) => p.on("exit", r));
  assert.equal(code, 0);
  assert.ok(err.some((l) => l.includes("non-JSON")), err.join("\n"));
});
