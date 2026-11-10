// MARK: wave4 w4-install — audit robustness-12
// `claude` is spawned without `detached`, so it is NOT a process-group leader: it shares the sidecar's (Mac) or
// Electron's group, and the Mac app's stop of the sidecar's group still reaches it. The old forced stop
// (`kill(-pid)`, else `kill(pid)`) therefore killed only `claude` itself and left what it had started — dev servers,
// MCP servers — running without a parent. This walks the tree instead.
import { exec } from "../util/exec.js";

/** `ps -A -o pid=,ppid=` → the children of each pid. */
export function parsePsTable(text: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/** Every pid below `pid`, any depth. */
export function descendantsOf(pid: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const queue = [...(children.get(pid) ?? [])];
  const seen = new Set<number>([pid]);
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    queue.push(...(children.get(p) ?? []));
  }
  return out;
}

export type ProcessTreeDeps = {
  /** The `ps` table, or null when it could not be read. */
  listProcesses: () => Promise<string | null>;
  /** `process.kill`; throws when the process (or group) is gone. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
};

const defaultDeps: ProcessTreeDeps = {
  listProcesses: async () => {
    try {
      const out = await exec(process.platform === "darwin" ? "/bin/ps" : "ps", ["-A", "-o", "pid=,ppid="], { timeoutMs: 5000 });
      return out.status === 0 ? out.stdout.toString("utf8") : null;
    } catch {
      return null;
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
};

/**
 * SIGKILLs `pid` and everything below it: look at the tree, SIGSTOP all of it (nothing forks or reparents away
 * meanwhile), look again for children started before the stop, then SIGKILL the group (when `pid` leads one) and every
 * pid found. Resolves with the pids it signalled, `pid` first.
 */
export async function killProcessTree(pid: number, deps: ProcessTreeDeps = defaultDeps): Promise<number[]> {
  const signal = (p: number, s: NodeJS.Signals) => {
    try {
      deps.kill(p, s);
    } catch {
      // already gone
    }
  };
  const first = descendantsOf(pid, parsePsTable((await deps.listProcesses()) ?? ""));
  for (const p of [pid, ...first]) signal(p, "SIGSTOP");
  const second = first.length > 0 ? descendantsOf(pid, parsePsTable((await deps.listProcesses()) ?? "")) : [];
  const all = [pid, ...new Set([...first, ...second])];
  signal(-pid, "SIGKILL");
  for (const p of all) signal(p, "SIGKILL");
  return all;
}
