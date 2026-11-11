// MARK: wave4 w4-install — audit robustness-12: a forced stop takes the whole tree below `claude` with it, although
// `claude` is not a process-group leader (it runs in the sidecar's / Electron's group).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { descendantsOf, killProcessTree, parsePsTable } from "../src/platform/processTree.js";
import { WAIT_MS } from "./helpers/wait.js";

const posix = process.platform !== "win32";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pids: number[], ms = WAIT_MS): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pids.every((p) => !alive(p))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pids.every((p) => !alive(p));
}

const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
});

describe("process tree", () => {
  it("parses `ps -A -o pid=,ppid=` and walks every level below a pid", () => {
    const table = parsePsTable("    1     0\n  100     1\n  200   100\n  201   100\n  300   200\n  999     1\n garbage\n");
    expect(descendantsOf(100, table).sort((a, b) => a - b)).toEqual([200, 201, 300]);
    expect(descendantsOf(300, table)).toEqual([]);
    expect(descendantsOf(5, table)).toEqual([]);
  });

  it("stops the tree before the second look so nothing forks away, then kills all of it (and the group when it leads one)", async () => {
    const tables = ["10 1\n20 10\n", "10 1\n20 10\n30 20\n"];
    const calls: string[] = [];
    const killed = await killProcessTree(10, {
      listProcesses: async () => tables.shift() ?? "",
      kill: (pid, signal) => {
        calls.push(`${signal} ${pid}`);
        if (pid < 0) throw Object.assign(new Error("no such group"), { code: "ESRCH" });
      },
    });
    expect(killed).toEqual([10, 20, 30]);
    expect(calls).toEqual(["SIGSTOP 10", "SIGSTOP 20", "SIGKILL -10", "SIGKILL 10", "SIGKILL 20", "SIGKILL 30"]);
  });

  it("without ps the pid itself still goes (the old behaviour)", async () => {
    const calls: string[] = [];
    await killProcessTree(10, { listProcesses: async () => null, kill: (pid, signal) => void calls.push(`${signal} ${pid}`) });
    expect(calls).toEqual(["SIGSTOP 10", "SIGKILL -10", "SIGKILL 10"]);
  });

  it.skipIf(!posix)("a real child that is not a group leader: its grandchildren do not survive", async () => {
    // Like `claude` under the sidecar: spawned without `detached`, so it shares the test runner's process group.
    const child = spawn("/bin/sh", ["-c", "sleep 300 & echo $!; sleep 300 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
    const pids: number[] = [];
    const lines = createInterface({ input: child.stdout! });
    await new Promise<void>((resolve) => {
      lines.on("line", (l) => {
        pids.push(Number(l.trim()));
        if (pids.length === 2) resolve();
      });
    });
    leftovers.push(...pids);
    expect(pids.every(alive)).toBe(true);
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    await killProcessTree(child.pid!);
    await exited;
    expect(await gone(pids)).toBe(true);
  });

  it.skipIf(!posix)("the platform's killTree uses it", async () => {
    vi.resetModules();
    const { createPlatform } = await import("../src/platform/index.js");
    const child = spawn("/bin/sh", ["-c", "sleep 300 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = await new Promise<number>((resolve) => createInterface({ input: child.stdout! }).once("line", (l) => resolve(Number(l.trim()))));
    leftovers.push(grandchild);
    await createPlatform().killTree(child.pid!);
    expect(await gone([grandchild, child.pid!])).toBe(true);
  });
});
