/**
 * PROTOCOL §57.10 end to end in main, with a real node-pty and a real engine: a fake claude (testing/fakeClaudeTerminal.cjs,
 * never the real CLI) runs in a PTY the window's PtyHub opened — through ConPTY with its bundled DLL on Windows (the fake
 * as npm's `claude.cmd` + script, run under node.exe, never the `.cmd`), a plain PTY elsewhere — and drives one review turn
 * over the engine's http hooks. Temporary repository, REVIEWGATE data folder and CLAUDE_CONFIG_DIR; nothing of the user's.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlatform, ReviewEngine, type EngineOptions, type Platform, type ReviewState } from "@reviewgate/engine";
import type { PtyExit } from "../../shared/ipc.js";
import { countOrphans } from "../orphans.js";
import { nodePty } from "./nodePty.js";
import { PtyHub, type PtyHubDeps } from "./ptyHub.js";
import { buildChatLaunch, buildShellLaunch, whichSync, type LaunchPlatform } from "./terminalLaunch.js";
import { writeFakeClaude } from "./testing/fakeClaudeShim.js";

const WIN = process.platform === "win32";
const LP = (WIN ? "win32" : process.platform === "darwin" ? "darwin" : "linux") as LaunchPlatform;
const OWNER = 1;
const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const which = (name: string) => (name === "node" ? process.execPath : whichSync(name, { platform: LP, env: process.env, isFile }));
const realKill = createPlatform(process.platform);
/** The engine's platform for the test: PATH lookups only (no login shell, no Terminal.app). */
const platform: Platform = {
  name: LP,
  isWindows: WIN,
  which: async (name) => whichSync(name, { platform: LP, env: process.env, isFile }),
  loginPATH: async (e) => e?.PATH ?? process.env.PATH ?? "",
  openTerminal: async () => undefined,
  killTree: (pid) => realKill.killTree(pid),
  ghConfigDir: () => join(tmpdir(), "rg-no-gh"),
  tmpDir: () => tmpdir(),
};

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Text the terminal showed: escape sequences out, line breaks out (ConPTY may wrap a long line). */
const plain = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/[\r\n]/g, "");

async function until<T>(what: string, f: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a fake claude through a real PTY drives one review turn (§57.10)", () => {
  let engine: ReviewEngine;
  let hub: PtyHub;
  let repo: string;
  let sessionId: string;
  const output = new Map<string, string>();
  const exits: PtyExit[] = [];
  const screen = (id: string) => plain(output.get(id) ?? "");
  const state = (): ReviewState => engine.state;

  beforeAll(async () => {
    const load = nodePty();
    expect(load.ok, load.ok ? "" : load.reason).toBe(true);
    if (!load.ok) return;
    repo = temp("rg-pty-repo-");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const config = temp("rg-pty-config-");
    const claude = writeFakeClaude(temp("rg-pty-bin-"));
    const options: EngineOptions = {
      platform,
      env: { ...env, CLAUDE_CONFIG_DIR: config },
      dataDir: temp("rg-pty-data-"),
      cliVersionsDir: join(config, "no-versions"),
      graphifyPath: null,
      managedPolicy: () => ({ settings: null, sources: [], failed: null }),
      mcpPollMs: 0,
      pluginSyncMs: 0,
      parkIdleMs: 0,
      collectRetryMs: 0,
    };
    engine = new ReviewEngine(options);
    await engine.handle({
      type: "hello",
      protocolVersion: 2,
      client: WIN ? "windows" : "test",
      ...(WIN ? { capabilities: { terminalChat: true } } : {}),
      settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", claudePath: claude, ghHost: "github.com" },
    });
    await engine.handle({ type: "open_project", path: repo });
    await until("the project", () => state().project !== null && state().session.open);
    await engine.handle({ type: "session_new", kind: "terminal" });
    sessionId = (await until("the terminal chat", () => state().session.terminal && state().session.open && state().sessions.currentId))!;

    const deps: PtyHubDeps = {
      ownerId: OWNER,
      engine: engine as unknown as PtyHubDeps["engine"],
      spawn: (file, args, opts) => load.mod.spawn(file, args, opts),
      unavailable: null,
      platform: process.platform,
      send: (channel: string, a: unknown, b?: unknown) => {
        if (channel === "rg:pty:data") output.set(a as string, (output.get(a as string) ?? "") + (b as string));
        else exits.push(a as PtyExit);
      },
      setIgnoreMenuShortcuts: () => undefined,
      chatLaunch: (spec) => buildChatLaunch({ spec, platform: LP, parentEnv: process.env, appVersion: "0.5.17", fullRepaint: true, fs: { exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null) }, which }),
      shellLaunch: (shell, cwd) => buildShellLaunch({ shell, cwd, platform: LP, parentEnv: process.env, which }),
      projectPath: () => repo,
      isAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      killTree: (pid) => realKill.killTree(pid),
      log: () => undefined,
    };
    hub = new PtyHub(deps);
    engine.on((ev) => {
      if (ev.type === "state") hub.onEngineState(ev.state);
    });
  }, 120_000);

  afterAll(async () => {
    await hub?.killAll();
    await engine?.dispose();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  it("banner, a reviewed Write, the git guard, a rejected file's context, resize, Korean, Meta+Enter, /exit, restart, no orphans", async () => {
    const baseline = countOrphans(process.pid).orphanNames.sort();
    const opened = await hub.open(OWNER, { kind: "chat", sessionId, cols: 300, rows: 40 });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    const id = opened.ptyId;
    const send = (s: string) => hub.input(OWNER, id, s);

    // 1. argv, env and the literal token placeholder reached the fake; the token itself only through env.
    await until("the banner", () => screen(id).includes(`fake-claude session=${sessionId} resume=false term=ReviewGate token=yes literal=true`));
    expect(screen(id)).toContain("cursor=1 repaint=1");
    await until("terminal_started", () => state().session.terminal?.running === true);

    // 2. A Write turn is collected into the review.
    send("write\r");
    await until("done", () => screen(id).includes("done"));
    await until("the review", () => state().gate.phase === "reviewing" && state().changedFiles.some((f) => f.path === "notes.txt"));
    expect(state().session.terminal?.hooksSeen).toBe(true);

    // 3. §57.8: git that throws work away is denied (a `-C <folder>` path, Windows' on Windows).
    send("git\r");
    await until("git deny", () => screen(id).includes("git deny"));

    // 4. A rejected file goes back with the next prompt.
    await engine.handle({ type: "reject", paths: ["notes.txt"] });
    await until("notes.txt reverted", () => !existsSync(join(repo, "notes.txt")));
    send("again\r");
    await until("the review context", () => /context: \[Review gate\].*Rejected/.test(screen(id)));

    // 5. A resize reaches the TUI.
    hub.resize(OWNER, id, 100, 30);
    await until("size 100x30", () => screen(id).includes("size 100x30"));

    // 6. Korean input arrives as UTF-8.
    send("한글\r");
    await until("the UTF-8 bytes", () => screen(id).includes(`hex ${Buffer.from("한글", "utf8").toString("hex")}`));

    // 7. Shift+Enter's ESC CR.
    send("\x1b\r");
    await until("meta-enter", () => screen(id).includes("meta-enter"));

    // 8. /exit: the PTY ends, the engine hears it.
    send("/exit\r");
    const exit = await until("the exit", () => exits.find((e) => e.ptyId === id));
    expect(exit).toMatchObject({ exitCode: 0, reason: "exited" });
    await until("terminal not running", () => state().session.terminal?.running === false);

    // 9. Restart resumes the same conversation.
    const again = await hub.restart(OWNER, id);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    if (!again.ok) return;
    await until("the resumed banner", () => screen(again.ptyId).includes(`fake-claude session=${sessionId} resume=true`));

    // 10. Killed: nothing left behind (Windows counts node.exe and OpenConsole.exe children).
    await hub.kill(OWNER, again.ptyId);
    expect(exits.find((e) => e.ptyId === again.ptyId)).toMatchObject({ reason: "killed" });
    // Only the PTY's kind of child counts: the engine runs git in the background meanwhile.
    const ptyKind = (names: string[]) => names.filter((n) => /node|openconsole|claude|(^|[\\/])sh$/i.test(n)).sort();
    let last: string[] = [];
    await until("no orphans", () => {
      const now = countOrphans(process.pid);
      last = ptyKind(now.orphanNames);
      return now.orphans >= 0 && JSON.stringify(last) === JSON.stringify(ptyKind(baseline));
    }, 20_000).catch((err: Error) => {
      throw new Error(`${err.message}: left ${JSON.stringify(last)}, before ${JSON.stringify(ptyKind(baseline))}`);
    });
  }, 180_000);
});
