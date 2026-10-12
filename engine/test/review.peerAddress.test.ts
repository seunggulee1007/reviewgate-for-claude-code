import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { peerAtAddress, peerSocketOf, runningCliSessions, selfPeer } from "../src/review/cliSessions.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §42.2 (audit peer-05, peer-07): whom a cross-session address names — the SendMessage card's receiving
 * session and this window's own name / address as the user's other sessions see it — from the CLI's registry
 * (`<config>/sessions/<pid>.json` only; the `*.key` files are never opened).
 */

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function registry(entries: Record<string, unknown>[]): string {
  const config = tmp("rg-peer-addr");
  mkdirSync(join(config, "sessions"), { recursive: true });
  for (const e of entries) writeFileSync(join(config, "sessions", `${String(e.pid)}.json`), JSON.stringify(e));
  writeFileSync(join(config, "sessions", "76616.abcdef.key"), "secret-token");
  return config;
}

describe("cross-session addresses (§42.2)", () => {
  it("reads the socket path of a uds: address (percent-decoded like the CLI), a bare socket path; nothing else", () => {
    expect(peerSocketOf("uds:/tmp/cc-socks/76616.sock")).toBe("/tmp/cc-socks/76616.sock");
    expect(peerSocketOf("uds:/tmp/my%20socks/1.sock")).toBe("/tmp/my socks/1.sock");
    expect(peerSocketOf("/tmp/cc-socks/76616.sock")).toBe("/tmp/cc-socks/76616.sock");
    expect(peerSocketOf("\\\\.\\pipe\\claude-76616")).toBe("\\\\.\\pipe\\claude-76616");
    for (const other of ["acme-b4", "a1b2c3d4", "bridge:abc", "", "uds:", "team-lead"]) expect(peerSocketOf(other)).toBeNull();
  });

  it("the live registry entry whose messaging socket the address names; a dead pid, an unknown socket or a name is none", async () => {
    const config = registry([
      { pid: 76616, sessionId: "s-b4", cwd: "/Users/me/acme", name: "acme-b4", status: "waiting", entrypoint: "cli", messagingSocketPath: "/tmp/cc-socks/76616.sock" },
      // The socket's name does not have to carry the pid: found by scanning.
      { pid: 5001, sessionId: "s-rg", cwd: "/Users/me/acme-4790", name: "ReviewGate · acme-4790", status: "busy", entrypoint: "sdk-ts", messagingSocketPath: "/tmp/cc-socks/custom.sock" },
      { pid: 5002, sessionId: "s-dead", cwd: "/x", name: "gone", status: "idle", entrypoint: "cli", messagingSocketPath: "/tmp/cc-socks/5002.sock" },
      // A file named after one pid that claims another is not that session.
      { pid: 1, sessionId: "s-liar", cwd: "/y", name: "liar", status: "idle", entrypoint: "cli", messagingSocketPath: "/tmp/cc-socks/9999.sock" },
    ]);
    const alive = new Set([76616, 5001, 1]);
    const isAlive = (pid: number) => alive.has(pid);
    expect(await peerAtAddress({ configDir: config, address: "uds:/tmp/cc-socks/76616.sock", isAlive })).toEqual({
      address: "uds:/tmp/cc-socks/76616.sock", pid: 76616, name: "acme-b4", cwd: "/Users/me/acme", status: "waiting", entrypoint: "cli",
    });
    expect(await peerAtAddress({ configDir: config, address: "uds:/tmp/cc-socks/custom.sock", isAlive })).toMatchObject({ pid: 5001, name: "ReviewGate · acme-4790", status: "busy", entrypoint: "sdk-ts" });
    expect(await peerAtAddress({ configDir: config, address: "uds:/tmp/cc-socks/5002.sock", isAlive })).toBeNull();
    expect(await peerAtAddress({ configDir: config, address: "uds:/tmp/cc-socks/31337.sock", isAlive })).toBeNull();
    expect(await peerAtAddress({ configDir: config, address: "acme-b4", isAlive })).toBeNull();
    expect(await peerAtAddress({ configDir: join(config, "missing"), address: "uds:/tmp/cc-socks/76616.sock", isAlive })).toBeNull();
  });

  it("this window's own session: its registry name and address; none without an entry", async () => {
    const config = registry([{ pid: 4321, sessionId: "s-me", cwd: "/r", name: "ReviewGate · acme", status: "idle", entrypoint: "sdk-ts", messagingSocketPath: "/tmp/cc-socks/4321.sock" }]);
    expect(await selfPeer({ configDir: config, pid: 4321 })).toEqual({ pid: 4321, name: "ReviewGate · acme", address: "uds:/tmp/cc-socks/4321.sock" });
    const noSocket = registry([{ pid: 4322, sessionId: "s-me", cwd: "/r", name: "ReviewGate · acme", status: "idle", entrypoint: "sdk-ts" }]);
    expect(await selfPeer({ configDir: noSocket, pid: 4322 })).toEqual({ pid: 4322, name: "ReviewGate · acme", address: null });
    expect(await selfPeer({ configDir: config, pid: 9 })).toBeNull();
  });

  it("a running session of this repository carries its address when the registry lists a socket", async () => {
    const main = tmp("rg-peer-addr-repo");
    sh(main, "init", "-q", "-b", "main");
    write(main, "README.md", "r\n");
    const config = registry([
      { pid: 101, sessionId: "s1", cwd: main, name: "acme-b4", status: "waiting", entrypoint: "cli", messagingSocketPath: "/tmp/cc-socks/101.sock" },
      { pid: 102, sessionId: "s2", cwd: main, name: "old cli", status: "idle", entrypoint: "cli" },
    ]);
    const running = await runningCliSessions({ configDir: config, worktreeRoots: [main], currentRoot: main, selfPid: 9000, isAlive: () => true, processInfo: async () => new Map() });
    expect(running.map((r) => [r.pid, r.address])).toEqual([[101, "uds:/tmp/cc-socks/101.sock"], [102, undefined]]);
    expect("address" in running[1]!).toBe(false);
  });
});
