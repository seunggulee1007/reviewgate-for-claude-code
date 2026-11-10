import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §42.2 at the engine (audit peer-05, peer-07): the session's `--name` carries the chat's title once it
 * has one, `cli_sessions.self` says how the user's other sessions see this window (name, address), and the session asks
 * the registry whom a SendMessage address reaches.
 */
const dirs: string[] = [];
const harnesses: Harness[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** In a folder named `acme` (the project's name in the session's `--name`). */
function makeRepo(): string {
  const dir = join(tmp("rg-peer-self"), "acme");
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@e.com");
  sh(dir, "config", "user.name", "T");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** A live pid that is never the engine's child: the test runner's parent (as §36.9's test). */
const LIVE_PID = process.ppid;

function registry(entries: Record<string, unknown>[]): string {
  const config = tmp("rg-peer-self-config");
  mkdirSync(join(config, "sessions"), { recursive: true });
  for (const e of entries) writeFileSync(join(config, "sessions", `${String(e.pid)}.json`), JSON.stringify(e));
  return config;
}

describe("the session's name for the user's other sessions (§42.2, peer-05)", () => {
  it("ReviewGate · <project> for a new chat; the chat's title joins it once the chat has one (the next start)", async () => {
    const dir = makeRepo();
    const h = harness();
    await h.hello();
    await h.open(dir);
    expect(h.session().opts.settings.sessionName).toBe(`ReviewGate · ${basename(dir)}`);
    await h.engine.request({ type: "send", text: "장바구니 합계 수정해줘\n테스트도" });
    await h.settle();
    h.session().emitTurnEnd({});
    await h.waitFor((s) => s.gate.phase !== "running", "turn ended");
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((s) => s.session.ready === true, "restarted");
    expect(h.session().opts.settings.sessionName).toBe("ReviewGate · acme · 장바구니 합계 수정해줘");
  });

  it("at most 64 characters: a long title is cut with …, never splitting a character in two", async () => {
    const dir = makeRepo();
    const h = harness();
    await h.hello();
    await h.open(dir);
    await h.engine.request({ type: "send", text: `${"가".repeat(40)}😀😀😀😀 끝` });
    await h.settle();
    h.session().emitTurnEnd({});
    await h.waitFor((s) => s.gate.phase !== "running", "turn ended");
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((s) => s.session.ready === true, "restarted");
    const name = h.session().opts.settings.sessionName!;
    expect([...name].length).toBe(64);
    expect(name).toBe(`ReviewGate · acme · ${"가".repeat(40)}😀😀😀…`);
  });
});

describe("cli_sessions.self and the SendMessage lookup (§42.2)", () => {
  it("self is this window's CLI as the registry lists it; the session's lookup finds a live session by its address", async () => {
    const dir = makeRepo();
    const config = registry([
      { pid: 424242, sessionId: "own", cwd: dir, name: "ReviewGate · x", status: "idle", entrypoint: "sdk-ts", messagingSocketPath: "/tmp/cc-socks/424242.sock" },
      { pid: LIVE_PID, sessionId: "term", cwd: "/Users/me/elsewhere", name: "acme-b4", status: "waiting", entrypoint: "cli", messagingSocketPath: `/tmp/cc-socks/${LIVE_PID}.sock` },
    ]);
    const h = harness({ env: { CLAUDE_CONFIG_DIR: config }, listCliSessions: async () => [] });
    await h.hello();
    await h.open(dir);
    // Before the CLI registered (no pid yet): no self.
    expect(await h.engine.request({ type: "cli_sessions" })).not.toHaveProperty("self");
    h.session().pid = 424242;
    const reply = await h.engine.request({ type: "cli_sessions" });
    expect(reply.self).toEqual({ pid: 424242, name: "ReviewGate · x", address: "uds:/tmp/cc-socks/424242.sock" });
    // The session asks the engine whom an address reaches — any folder, the live entry only.
    const resolve = h.session().opts.resolvePeer!;
    expect(await resolve(`uds:/tmp/cc-socks/${LIVE_PID}.sock`)).toEqual({
      address: `uds:/tmp/cc-socks/${LIVE_PID}.sock`, pid: LIVE_PID, name: "acme-b4", cwd: "/Users/me/elsewhere", status: "waiting", entrypoint: "cli",
      sessionId: "term", // r2-peers (§33.2): the conversation the registry names
    });
    expect(await resolve("acme-b4")).toBeNull();
  });
});
