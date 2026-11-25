import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Platform } from "../src/platform/index.js";
import { cleanShellOutput, shellCommandOf, shellContext, SHELL_COMMAND_MAX, SHELL_PENDING_MAX, withPendingShell } from "../src/session/shellRun.js";
import type { ShellResult } from "../src/protocol.js";
import { fakePlatform, makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §67.2 `!` shell mode: the user's command between turns, its row, and Claude's context. */

const posix = process.platform !== "win32";
const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-shell"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "a.txt", "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** Kills the command's process group (it runs detached), as the real platform's tree kill does. */
const platform: Platform = {
  ...fakePlatform,
  killTree: async (pid) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  },
};

async function rig(extra: Parameters<typeof makeHarness>[0] = {}): Promise<{ h: Harness; dir: string }> {
  const h = makeHarness({ platform, env: { CLAUDE_CONFIG_DIR: "/nonexistent/reviewgate-test-claude-config", SHELL: "/bin/sh", PATH: process.env.PATH ?? "/usr/bin:/bin" }, ...extra });
  harnesses.push(h);
  const dir = makeRepo();
  await h.hello();
  await h.open(dir);
  return { h, dir };
}

const result = (over: Partial<ShellResult> = {}): ShellResult => ({ id: "r1", command: "npm test", cwd: "/work/acme", output: "ok\n", exitCode: 0, durationMs: 10, ...over });

describe("§67.2 pure helpers", () => {
  it("the command: trimmed, a leading ! dropped, refused empty or too long", () => {
    expect(shellCommandOf("  ! git status ")).toBe("git status");
    expect(() => shellCommandOf("!")).toThrow("empty_command");
    expect(() => shellCommandOf("x".repeat(SHELL_COMMAND_MAX + 1))).toThrow("command_too_long");
  });

  it("output as a terminal shows it: no escapes, a redrawn line as its last drawing", () => {
    expect(cleanShellOutput("\x1b[32mPASS\x1b[0m a\r\n10%\r50%\r100%\ndone")).toBe("PASS a\n100%\ndone");
  });

  it("the context names the command, its output and how it ended; at most SHELL_PENDING_MAX wait", () => {
    expect(shellContext([])).toBe("");
    const text = shellContext([result({ exitCode: 1, output: "FAIL x\n" }), result({ command: "sleep 9", cancelled: true, exitCode: null, output: "" })]);
    expect(text).toContain("you did not run them");
    expect(text).toContain("<bash-input>npm test</bash-input>\n<bash-stdout>FAIL x\n</bash-stdout>\n<bash-exit-code>exit code 1</bash-exit-code>");
    expect(text).toContain("<bash-exit-code>stopped by the user</bash-exit-code>");
    let pending: ShellResult[] = [];
    for (let i = 0; i < SHELL_PENDING_MAX + 2; i++) pending = withPendingShell(pending, result({ id: `r${i}` }));
    expect(pending.map((r) => r.id)).toEqual(["r2", "r3", "r4", "r5", "r6"]);
  });
});

describe.runIf(posix)("§67.2 shell_run", () => {
  it("runs in the project folder, records its row, and goes to Claude in front of the next message", async () => {
    const { h, dir } = await rig();
    await h.engine.request({ type: "shell_run", command: "!echo hello; pwd; exit 3" });
    expect(h.engine.state.session.shell?.command).toBe("echo hello; pwd; exit 3");
    expect(h.engine.state.gate.canSend).toBe(false);
    expect(h.engine.state.gate.blockedReason).toBe("shell_running");
    await expect(h.engine.request({ type: "shell_run", command: "true" })).rejects.toThrow("shell_busy");
    await expect(h.engine.request({ type: "send", text: "now" })).rejects.toThrow("gate_closed:shell_running");
    const s = await h.waitFor((st) => st.session.shell === null && (st.session.shellPending ?? 0) === 1, "command ended");
    expect(s.gate.canSend).toBe(true);
    const ev = h.ofType("shell_result").at(-1)!;
    expect(ev).toMatchObject({ command: "echo hello; pwd; exit 3", cwd: dir, exitCode: 3 });
    expect(ev.output).toContain("hello");
    expect(ev.output).toContain(dir);
    expect(ev.files).toBeUndefined();
    // The row is the chat's (its transcript file), so it comes back with the chat.
    const rows = read(dir, `.git/reviewgate/sessions/${s.sessions.currentId}.ndjson`) ?? "";
    expect(rows).toContain('"kind":"shell"');

    await h.engine.request({ type: "send", text: "why did it fail?" });
    const sent = h.session().sends.at(-1)!.text;
    expect(sent).toContain("<bash-input>echo hello; pwd; exit 3</bash-input>");
    expect(sent).toContain("<bash-exit-code>exit code 3</bash-exit-code>");
    expect(sent.endsWith("why did it fail?")).toBe(true);
    expect(h.engine.state.session.shellPending).toBe(0);
    // The chat's row is the user's own text only.
    expect(h.ofType("user_message").at(-1)).toMatchObject({ text: "why did it fail?" });
  });

  it("what it changes reaches the next turn's review as an outside change (not swallowed by a fresh A)", async () => {
    const { h, dir } = await rig();
    await h.engine.request({ type: "shell_run", command: "printf 'by shell\\n' > a.txt; printf 'new\\n' > b.txt" });
    await h.waitFor((st) => st.session.shell === null && (st.session.shellPending ?? 0) === 1, "command ended");
    expect(h.ofType("shell_result").at(-1)!.files).toEqual(["a.txt", "b.txt"]);
    await h.engine.request({ type: "send", text: "look" });
    await h.waitFor((st) => st.gate.phase === "running", "turn running");
    h.session().emitTurnEnd();
    const s = await h.waitFor((st) => st.gate.turnEndTree !== null && st.gate.phase !== "collecting" && st.gate.phase !== "running", "collection");
    expect(s.changedFiles.map((f) => [f.path, f.origin])).toEqual([["a.txt", "external"], ["b.txt", "external"]]);
    expect(read(dir, "a.txt")).toBe("by shell\n");
  });

  it("shell_cancel (and interrupt between turns) stops it; its row says so", async () => {
    const { h } = await rig();
    await expect(h.engine.request({ type: "shell_cancel" })).rejects.toThrow("no_shell_running");
    await h.engine.request({ type: "shell_run", command: "echo started; sleep 30" });
    await h.waitFor(() => h.ofType("shell_output").some((e) => e.output.includes("started")), "output streamed");
    await h.engine.request({ type: "shell_cancel" });
    await h.waitFor((st) => st.session.shell === null, "stopped");
    expect(h.ofType("shell_result").at(-1)).toMatchObject({ cancelled: true, exitCode: null });
    await h.engine.request({ type: "shell_run", command: "sleep 30" });
    await h.engine.request({ type: "interrupt" });
    await h.waitFor((st) => st.session.shell === null, "stopped by interrupt");
    expect(h.ofType("shell_result").at(-1)).toMatchObject({ cancelled: true });
  });

  it("reject / reject_all / reject_hunks / reject_undo are refused shell_running while it runs", async () => {
    const { h } = await rig();
    await h.engine.request({ type: "shell_run", command: "sleep 30" });
    await expect(h.engine.request({ type: "reject", paths: ["a.txt"] })).rejects.toThrow("shell_running");
    await expect(h.engine.request({ type: "reject_all" })).rejects.toThrow("shell_running");
    await expect(h.engine.request({ type: "reject_hunks", path: "a.txt", hunks: [0] })).rejects.toThrow("shell_running");
    await expect(h.engine.request({ type: "reject_undo", path: "a.txt" })).rejects.toThrow("shell_running");
    await h.engine.request({ type: "shell_cancel" });
    await h.waitFor((st) => st.session.shell === null, "stopped");
    const after = await h.engine.request({ type: "reject", paths: ["a.txt"] }).then(() => "ok", (e: Error) => e.message);
    expect(after).not.toContain("shell_running");
  });

  it("a command past its limit is stopped (timedOut)", async () => {
    const { h } = await rig({ shellTimeoutMs: 300 });
    await h.engine.request({ type: "shell_run", command: "sleep 30" });
    await h.waitFor((st) => st.session.shell === null, "timed out");
    expect(h.ofType("shell_result").at(-1)).toMatchObject({ timedOut: true, exitCode: null });
    expect(h.ofType("shell_result").at(-1)!.output).toMatch(/timed out/);
  });

  it("refused while a turn runs and without a project", async () => {
    const h0 = makeHarness();
    harnesses.push(h0);
    await h0.hello();
    await expect(h0.engine.request({ type: "shell_run", command: "ls" })).rejects.toThrow("no_project");
    const { h } = await rig();
    await expect(h.engine.request({ type: "shell_run", command: "   " })).rejects.toThrow("empty_command");
    await h.engine.request({ type: "send", text: "work" });
    await h.waitFor((st) => st.gate.phase === "running", "turn running");
    await expect(h.engine.request({ type: "shell_run", command: "ls" })).rejects.toThrow("turn_running");
  });
});
