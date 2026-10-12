import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capabilitiesFilePath } from "../src/review/persist.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §36.5 (audit SME-03): `capabilities.commands` (description / argument hint / source) right after the
 * session start, `capabilities.state` ("starting" until initialize answered — never null while a session starts), and the
 * common-git-dir cache a new workbench replays until its first initialize.
 */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-commands"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
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

const RAW = [
  { name: "mcp", description: "Manage MCP servers", argumentHint: "[reconnect|enable|disable [<server>|all]]", builtin: true },
  { name: "team-plugin:team-dev", description: "이슈 기반 개발", argumentHint: "<이슈 번호>", aliases: ["team-dev"] },
  { name: "rg-proj-cmd", description: "A project command (project)", argumentHint: "[file]" },
];
const INFOS = [
  { name: "mcp", description: "Manage MCP servers", argumentHint: "[reconnect|enable|disable [<server>|all]]", source: "builtin" },
  { name: "team-plugin:team-dev", description: "이슈 기반 개발", argumentHint: "<이슈 번호>", source: "plugin", plugin: "team-plugin", aliases: ["team-dev"] },
  { name: "rg-proj-cmd", description: "A project command", argumentHint: "[file]", source: "project" },
];
const EMPTY = { slashCommands: [], skills: [], plugins: [], mcpServers: [] };

describe("capabilities.commands / state (§36.5)", () => {
  it("a start without a cache shows empty lists while starting (never null), then the commands once initialize answered", async () => {
    const dir = track(makeRepo());
    const h = harness({}, { ready: () => false });
    await h.hello();
    let s = await h.open(dir);
    expect(s.session.ready).toBe(false);
    expect(s.session.capabilities).toEqual({ ...EMPTY, state: "starting" });
    expect(s.session.capabilitiesCached).toBe(false);

    // initialize answered (session_ready), and the commands came with it — no message sent.
    h.session().emit({ type: "session_ready" });
    h.session().emit({ type: "commands_info", commands: RAW });
    s = await h.waitFor((x) => x.session.capabilities?.commands !== undefined, "commands");
    expect(s.session.capabilities).toEqual({ ...EMPTY, commands: INFOS, state: "ready" });

    // The first message's session_info replaces the lists and keeps the commands.
    await h.engine.handle({ type: "send", text: "hi" });
    h.session().emitSessionInfo({ slashCommands: ["mcp", "team-plugin:team-dev"], skills: ["team-plugin:team-dev"] });
    s = await h.waitFor((x) => x.session.capabilities?.slashCommands.length === 2, "session_info");
    expect(s.session.capabilities?.commands).toEqual(INFOS);
    expect(s.session.capabilities?.state).toBe("ready");

    // commands_changed replaces the list.
    h.session().emit({ type: "commands_info", commands: [RAW[0]] });
    s = await h.waitFor((x) => x.session.capabilities?.commands?.length === 1, "commands_changed");
    expect(s.session.capabilities?.commands).toEqual([INFOS[0]]);
    h.session().emitTurnEnd();
    await h.waitFor((x) => x.gate.phase !== "running" && x.gate.phase !== "collecting", "turn end");
  });

  it("a start that never answers initialize — no CLI, or it died — is not 'starting' any more", async () => {
    const dir = track(makeRepo());
    const missing = harness();
    await missing.hello({ claudePath: "/nonexistent/rg-claude" });
    await missing.engine.handle({ type: "open_project", path: dir });
    await missing.waitFor((x) => x.lastError !== null && !x.session.starting, "cli_not_found");
    expect(missing.engine.state.session.capabilities?.state).toBeUndefined();

    const dying = harness({ autoRestartDelayMs: 60_000 }, { ready: () => false });
    await dying.hello();
    let s = await dying.open(track(makeRepo()));
    expect(s.session.capabilities?.state).toBe("starting");
    dying.session().emit({ type: "closed", code: 1 });
    s = await dying.waitFor((x) => !x.session.open, "session gone");
    expect(s.session.capabilities?.state).toBeUndefined();
  });

  it("commands are cached in the worktree's and the common git dir; a new workbench replays the common one until its first initialize", async () => {
    const dir = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(dir);
    h.session().emit({ type: "commands_info", commands: RAW });
    await h.waitFor((x) => x.session.capabilities?.commands !== undefined, "commands");
    await h.engine.handle({ type: "close_project" });
    await h.settle();
    const saved = JSON.parse(readFileSync(capabilitiesFilePath(join(dir, ".git")), "utf8")) as { capabilities: Record<string, unknown> };
    // `state` is the live session's, never cached.
    expect(saved.capabilities).toEqual({ ...EMPTY, commands: INFOS });

    // A linked worktree (a new workbench) has no cache of its own: it shows the common one while it starts.
    const wt = track(`${dir}-wt`);
    sh(dir, "worktree", "add", "-q", wt, "-b", "feature");
    const wtGitDir = sh(wt, "rev-parse", "--absolute-git-dir").trim();
    expect(existsSync(capabilitiesFilePath(wtGitDir))).toBe(false);
    const h2 = harness({}, { ready: () => false });
    await h2.hello();
    let s = await h2.open(wt);
    expect(s.session.capabilities).toEqual({ ...EMPTY, commands: INFOS, state: "starting" });
    expect(s.session.capabilitiesCached).toBe(true);

    // Its own first initialize writes its own cache (and refreshes the common one).
    h2.session().emit({ type: "session_ready" });
    h2.session().emit({ type: "commands_info", commands: [RAW[0]] });
    s = await h2.waitFor((x) => x.session.capabilities?.state === "ready" && x.session.capabilities.commands?.length === 1, "own commands");
    await h2.engine.handle({ type: "close_project" });
    await h2.settle();
    const own = JSON.parse(readFileSync(capabilitiesFilePath(wtGitDir), "utf8")) as { capabilities: { commands: unknown[] } };
    expect(own.capabilities.commands).toEqual([INFOS[0]]);
    const common = JSON.parse(readFileSync(capabilitiesFilePath(join(dir, ".git")), "utf8")) as { capabilities: { commands: unknown[] } };
    expect(common.capabilities.commands).toEqual([INFOS[0]]);
  });
});
