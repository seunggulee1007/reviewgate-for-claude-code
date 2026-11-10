import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findConcurrentClaude, processInfo } from "../src/review/concurrent.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function registry(config: string, pid: number | string, entry: Record<string, unknown>): void {
  mkdirSync(join(config, "sessions"), { recursive: true });
  writeFileSync(join(config, "sessions", `${pid}.json`), JSON.stringify(entry));
}

describe("other Claude Code processes in the worktree (§31)", () => {
  it("live registered CLIs whose cwd is the worktree or a plain folder of it; not the engine's own, dead, reused, nested-worktree or foreign ones", async () => {
    const root = track(realpathSync(makeTempDir("rg-conc")));
    sh(root, "init", "-q");
    write(root, "sub/x.txt", "x\n");
    write(root, ".claude/worktrees/wt/.git", "gitdir: /elsewhere\n"); // a nested worktree has its own .git
    const config = track(realpathSync(makeTempDir("rg-conf")));
    const base = { kind: "interactive", entrypoint: "cli", status: "busy", version: "2.1.308" };
    registry(config, 101, { ...base, pid: 101, cwd: root, sessionId: "s-101", name: "acme-b4", startedAt: 1_792_000_000_000, procStart: "Thu Oct 22 05:50:52 2026" });
    registry(config, 102, { ...base, pid: 102, cwd: join(root, "sub") });
    registry(config, 103, { ...base, pid: 103, cwd: root }); // the engine's own CLI (parent = the engine)
    registry(config, 104, { ...base, pid: 104, cwd: root }); // dead
    registry(config, 105, { ...base, pid: 105, cwd: root, procStart: "Mon Jan  5 00:00:00 2026" }); // pid reused by another process
    registry(config, 106, { ...base, pid: 106, cwd: join(root, ".claude/worktrees/wt") });
    registry(config, 107, { ...base, pid: 107, cwd: "/somewhere/else" });
    registry(config, 108, { ...base, pid: 999, cwd: root }); // the file does not describe its own pid
    registry(config, 109, { ...base, pid: 109, cwd: root }); // excluded explicitly (the main session's CLI)
    writeFileSync(join(config, "sessions", "101.0123abcd.key"), "never read");
    const info = new Map([
      [101, { ppid: 1, lstart: "Thu Oct 22  05:50:52 2026" }],
      [102, { ppid: 1, lstart: "x" }],
      [103, { ppid: 4242, lstart: "x" }],
      [105, { ppid: 1, lstart: "Thu Oct 22 06:00:00 2026" }],
    ]);
    const found = await findConcurrentClaude({
      configDir: config,
      root,
      selfPid: 4242,
      excludePids: new Set([109]),
      isAlive: (pid) => pid !== 104,
      processInfo: async (pids) => new Map(pids.filter((p) => info.has(p)).map((p) => [p, info.get(p)!])),
    });
    expect(found).toEqual([
      { pid: 101, sessionId: "s-101", cwd: root, name: "acme-b4", kind: "interactive", entrypoint: "cli", status: "busy", startedAt: new Date(1_792_000_000_000).toISOString() },
      { pid: 102, sessionId: null, cwd: join(root, "sub"), name: null, kind: "interactive", entrypoint: "cli", status: "busy", startedAt: null },
    ]);
  });

  it("processInfo reads the parent pid and the UTC start of live processes (ps); a child of this process has it as parent", async () => {
    if (process.platform === "win32") return;
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    try {
      const info = await processInfo([child.pid!, 1]);
      expect(info.get(child.pid!)?.ppid).toBe(process.pid);
      expect(info.get(child.pid!)?.lstart).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d \d{4}$/);
      expect(info.has(1)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
