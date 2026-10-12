/**
 * MARK: wave3 desktop-session — §36.6–36.9 on the client, the pure part: what an engine before §36 looks like, local
 * settings (per project, the restart notice, "Not applied in the app"), MCP scope local; later sections add §36.7–36.9.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServerInfo, ReviewState, SessionExtensions } from "@reviewgate/engine";
import { projectRootHash } from "../shared/hash";
import { initI18n } from "./i18n";
import { removableScope, scopeHelp } from "./mcp";
import { extensionsRetryBlockedReason, extensionsWaitingOf, knowsSessionTools, loadsLocalSettings, localSettingsNeedRestart, notAppliedOf, projectLoadsLocal, waitingDetail, waitingText } from "./sessionTools";
import { cliBannerOf, cliChangeText, cliInfoOf, loadDismissedCliVersions, pinnedVersionOf, saveDismissedCliVersions } from "./sessionTools";
import { cliSessionsOf, importedOf, runningStatusLabel, sortRunning, terminalResumeCommand } from "./sessionTools";
import { errorEventText } from "./errorCodes";

type Session = ReviewState["session"];
const base = { open: true, starting: false, sessionId: "s", model: null, capabilities: null, capabilitiesCached: false, pendingPermission: null, canRestart: true, rememberedAllows: [], permissionMode: "default", pendingPlan: null } as unknown as Session;

const ext = (more: Partial<SessionExtensions> = {}): SessionExtensions => ({
  settingSources: ["user", "project"],
  fallback: null,
  plugins: [],
  disabledPlugins: [],
  unresolvedDisabledPlugins: [],
  userHooksDisabled: false,
  skills: [],
  slashCommands: [],
  mcpServers: [],
  memoryFiles: null,
  claudeMd: { user: true, project: false, source: "cli" },
  hooks: [],
  ...more,
});

describe("an engine with or without §36.5–36.9", () => {
  it("knows it from any field only such an engine sends", () => {
    expect(knowsSessionTools(base)).toBe(false);
    expect(knowsSessionTools({ ...base, extensions: ext() })).toBe(false);
    expect(knowsSessionTools({ ...base, extensions: ext({ notApplied: null }) })).toBe(true);
    expect(knowsSessionTools({ ...base, extensions: ext({ settingSources: ["user", "project", "local"] }) })).toBe(true);
    expect(knowsSessionTools({ ...base, capabilities: { slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "ready" } })).toBe(true);
    expect(knowsSessionTools({ ...base, cli: null })).toBe(true);
    expect(knowsSessionTools({ ...base, extensionsWaitingOn: null })).toBe(true);
  });
});

describe("local settings (§36.6, SME-01)", () => {
  it("per project, on unless the project stored false", () => {
    const flags = { [projectRootHash("/repo")]: false };
    expect(projectLoadsLocal({ projectLoadLocalSettings: flags }, "/repo")).toBe(false);
    expect(projectLoadsLocal({ projectLoadLocalSettings: flags }, "/other")).toBe(true);
    expect(projectLoadsLocal(null, "/repo")).toBe(true);
    expect(projectLoadsLocal({ projectLoadLocalSettings: flags }, null)).toBe(true);
  });

  it("the session loaded them when its setting sources say local", () => {
    expect(loadsLocalSettings(ext({ settingSources: ["user", "project", "local"] }))).toBe(true);
    expect(loadsLocalSettings(ext())).toBe(false);
    expect(loadsLocalSettings(null)).toBe(false);
  });

  it("asks for a restart only when the choice differs from what a §36 session applied — never during the fallback", () => {
    const loaded = ext({ settingSources: ["user", "project", "local"], notApplied: null });
    expect(localSettingsNeedRestart(loaded, false, true)).toBe(true);
    expect(localSettingsNeedRestart(loaded, true, true)).toBe(false);
    expect(localSettingsNeedRestart(ext({ notApplied: null }), true, true)).toBe(true);
    // an engine before §36 never applies it; the §16 fallback drops local with user ("Retry with extensions" brings both back)
    expect(localSettingsNeedRestart(ext(), true, false)).toBe(false);
    expect(localSettingsNeedRestart(ext({ fallback: { reason: "init_timeout", timeoutMs: 20000, at: "2026-10-23T00:00:00Z" } }), true, true)).toBe(false);
    expect(localSettingsNeedRestart(null, false, true)).toBe(false);
  });

  it("'Not applied in the app': hooks, env keys, local MCP servers and the allow-rule count — null when there is nothing", () => {
    const na = notAppliedOf(ext({ notApplied: { hooks: [{ event: "Stop", command: "~/bin/on-stop.sh" }], envKeys: ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], mcpServers: ["notes", "serena"], allowRuleCount: 42 } }));
    expect(na).toEqual({ hooks: [{ event: "Stop", command: "~/bin/on-stop.sh" }], envKeys: ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], mcpServers: ["notes", "serena"], allowRuleCount: 42 });
    expect(notAppliedOf(ext({ notApplied: null }))).toBeNull();
    expect(notAppliedOf(ext({ notApplied: { hooks: [], envKeys: [], mcpServers: [], allowRuleCount: 0 } }))).toBeNull();
    expect(notAppliedOf(ext())).toBeNull();
    // lenient: bad rows dropped, a bad count is 0
    const odd = notAppliedOf(ext({ notApplied: { hooks: [{ event: 1 }, { event: "Stop", command: "x" }], envKeys: ["A", 2], mcpServers: "no", allowRuleCount: -3 } as unknown as SessionExtensions["notApplied"] }));
    expect(odd).toEqual({ hooks: [{ event: "Stop", command: "x" }], envKeys: ["A"], mcpServers: [], allowRuleCount: 0 });
  });
});

describe("MCP scope local (§36.6)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  const server = (source: McpServerInfo["source"]): McpServerInfo => ({ name: "serena", status: "connected", scope: source, source, transport: "stdio", toolCount: 0, tools: [], error: null, serverInfo: null, config: null } as unknown as McpServerInfo);

  it("a local server is removable with scope local — only when the engine has it", () => {
    expect(removableScope(server("local"), { localScope: true })).toBe("local");
    expect(removableScope(server("local"))).toBeNull();
    expect(removableScope(server("project"), { localScope: true })).toBe("project");
  });

  it("explains where scope local writes", () => {
    expect(scopeHelp("local")).toBe("이 프로젝트용으로 ~/.claude.json에 기록됩니다 — git으로 공유되지 않으며 터미널의 claude도 함께 씁니다. 세션을 다시 시작하면 적용됩니다.");
  });
});

describe("extensions start (§36.7, robustness-05)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("names what the starting CLI waits for — or the kind when the signal named none", () => {
    expect(waitingText({ kind: "mcp", name: "serena" })).toBe("serena 기다리는 중");
    expect(waitingText({ kind: "hook", name: null })).toBe("훅 기다리는 중");
    expect(waitingText({ kind: "plugin", name: null })).toBe("플러그인 기다리는 중");
    expect(waitingText({ kind: "unknown", name: null })).toBe("확장 기다리는 중");
    expect(waitingDetail({ kind: "hook", name: "SessionStart" })).toBe("Claude Code가 훅을 실행하는 중: SessionStart");
    expect(waitingDetail({ kind: "mcp", name: "serena" })).toBe("Claude Code가 MCP 서버 serena에 연결하는 중");
    expect(waitingDetail({ kind: "plugin", name: "team-plugin" })).toBe("Claude Code가 플러그인 team-plugin을(를) 설치하는 중");
    expect(waitingDetail({ kind: "unknown", name: "x" })).toBe("Claude Code가 확장을 불러오는 중: x");
    expect(waitingDetail({ kind: "mcp", name: null })).toBe("Claude Code가 확장을 불러오는 중");
  });

  it("only while the session starts; a stale value or an odd kind is never shown as is", () => {
    const waiting = { kind: "mcp", name: "serena" } as const;
    expect(extensionsWaitingOf({ ...base, starting: true, extensionsWaitingOn: waiting })).toEqual(waiting);
    expect(extensionsWaitingOf({ ...base, open: true, ready: false, extensionsWaitingOn: waiting })).toEqual(waiting);
    expect(extensionsWaitingOf({ ...base, ready: true, extensionsWaitingOn: waiting })).toBeNull();
    expect(extensionsWaitingOf({ ...base, starting: true, extensionsWaitingOn: null })).toBeNull();
    expect(extensionsWaitingOf({ ...base, starting: true, extensionsWaitingOn: { kind: "weird", name: 3 } as never })).toEqual({ kind: "unknown", name: null });
  });

  it("'Retry with extensions' waits for a start, a turn or a retry in flight — with the reason", () => {
    const idle = { phase: "idle", starting: false, retrying: false };
    expect(extensionsRetryBlockedReason(idle)).toBeNull();
    expect(extensionsRetryBlockedReason({ ...idle, starting: true })).toBe("세션을 시작하는 중입니다…");
    expect(extensionsRetryBlockedReason({ ...idle, retrying: true })).toBe("세션을 시작하는 중입니다…");
    expect(extensionsRetryBlockedReason({ ...idle, phase: "running" })).toBe("Claude가 턴을 마칠 때까지 기다리세요");
    expect(extensionsRetryBlockedReason({ ...idle, phase: "collecting" })).toBe("Claude가 턴을 마칠 때까지 기다리세요");
  });
});

describe("CLI version (§36.8, daily-06)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  const range = { min: "2.1.300", max: "2.1.307" };
  const cli = (more: object = {}) => ({ version: "2.1.308", verified: false, verifiedRange: range, previous: { version: "2.1.307", path: "/Users/me/.local/share/claude/versions/2.1.307" }, ...more });

  it("reads session.cli leniently (absent / malformed → null)", () => {
    expect(cliInfoOf({ ...base, cli: cli() as never })).toEqual(cli());
    expect(cliInfoOf(base)).toBeNull();
    expect(cliInfoOf({ ...base, cli: null })).toBeNull();
    expect(cliInfoOf({ ...base, cli: { version: 3 } as never })).toEqual({ version: null, verified: false, verifiedRange: null, previous: null });
    expect(cliInfoOf({ ...base, cli: cli({ previous: { version: "2.1.307", path: null } }) as never })?.previous).toEqual({ version: "2.1.307", path: null });
  });

  it("the pinned version from settings.claudePath (the native installer's folder only)", () => {
    expect(pinnedVersionOf("/Users/me/.local/share/claude/versions/2.1.307")).toBe("2.1.307");
    expect(pinnedVersionOf("C:\\Users\\me\\.local\\share\\claude\\versions\\2.1.307.exe")).toBe("2.1.307");
    expect(pinnedVersionOf("/usr/local/bin/claude")).toBeNull();
    expect(pinnedVersionOf("")).toBeNull();
    expect(pinnedVersionOf(undefined)).toBeNull();
  });

  it("the banner: an unverified version once (until closed), then the pin waiting for a restart", () => {
    expect(cliBannerOf(cli(), [], null)).toEqual({ kind: "unverified", version: "2.1.308", range, previous: { version: "2.1.307", path: "/Users/me/.local/share/claude/versions/2.1.307" } });
    expect(cliBannerOf(cli(), ["2.1.308"], null)).toBeNull();
    expect(cliBannerOf(cli({ verified: true }), [], null)).toBeNull();
    expect(cliBannerOf(cli({ version: null }), [], null)).toBeNull();
    expect(cliBannerOf(null, [], null)).toBeNull();
    // pinned 2.1.307 while 2.1.308 still runs: "used from the next session start"
    expect(cliBannerOf(cli(), [], "2.1.307")).toEqual({ kind: "pinned", version: "2.1.307" });
    // the pinned one runs now
    expect(cliBannerOf(cli({ version: "2.1.307", verified: true }), [], "2.1.307")).toBeNull();
  });

  it("closed versions persist (≤ 50) and survive a broken store", () => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveDismissedCliVersions(["2.1.308"], ls);
    expect(loadDismissedCliVersions(ls)).toEqual(["2.1.308"]);
    saveDismissedCliVersions(Array.from({ length: 60 }, (_, i) => `2.1.${i}`), ls);
    expect(loadDismissedCliVersions(ls).length).toBe(50);
    store.set("rg.cliBannerDismissed", "nope");
    expect(loadDismissedCliVersions(ls)).toEqual([]);
  });

  it("the cli_version_changed notice in words — live (cli) and restored (the engine's English)", () => {
    expect(cliChangeText({ cli: { from: "2.1.307", to: "2.1.308", verified: false }, message: "x" })).toBe("Claude Code가 2.1.307에서 2.1.308(으)로 바뀌었어요 (아직 검증 안 됨)");
    expect(cliChangeText({ cli: { from: "2.1.307", to: "2.1.308", verified: true }, message: "x" })).toBe("Claude Code가 2.1.307에서 2.1.308(으)로 바뀌었어요");
    expect(cliChangeText({ cli: { from: null, to: "2.1.308", verified: true }, message: "x" })).toBe("Claude Code 2.1.308을(를) 써요");
    expect(cliChangeText({ message: "Claude Code changed from 2.1.307 to 2.1.308 (not verified yet)." })).toBe("Claude Code가 2.1.307에서 2.1.308(으)로 바뀌었어요 (아직 검증 안 됨)");
    expect(cliChangeText({ message: "something else" })).toBe("Claude Code가 업데이트됐어요");
    expect(errorEventText({ code: "cli_version_changed", message: "Claude Code changed from 2.1.307 to 2.1.308.", cli: { from: "2.1.307", to: "2.1.308", verified: true } })).toBe("Claude Code가 2.1.307에서 2.1.308(으)로 바뀌었어요");
  });
});

describe("other Claude sessions (§36.9, market-03)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  /** The §36.9 example, plus odd rows. */
  const reply = {
    type: "cli_sessions",
    id: "q3",
    running: [
      { pid: 82411, sessionId: "5d0c", name: "acme-b4", cwd: "/Users/me/acme", status: "waiting", entrypoint: "cli", sameWorktree: true },
      { pid: 82500, sessionId: null, name: null, cwd: "/Users/me/acme-4790", status: "busy", entrypoint: "cli", sameWorktree: false },
      { pid: 82600, sessionId: "aa", name: "x", cwd: "/Users/me/acme", status: "napping", entrypoint: null, sameWorktree: false },
      { pid: "nope", cwd: "/x" },
    ],
    resumable: [{ sessionId: "9f1e", title: "장바구니 합계 수정", updatedAt: "2026-10-23T02:10:00.000Z", cwd: "/Users/me/acme-4790" }, { title: "no id" }],
  };

  it("reads cli_sessions leniently: bad rows dropped, an unknown status is unknown", () => {
    const s = cliSessionsOf(reply);
    expect(s.running.map((r) => r.pid)).toEqual([82411, 82500, 82600]);
    expect(s.running[2]!.status).toBe("unknown");
    expect(s.running[1]).toMatchObject({ sessionId: null, name: null, sameWorktree: false });
    expect(s.resumable).toEqual([{ sessionId: "9f1e", title: "장바구니 합계 수정", updatedAt: "2026-10-23T02:10:00.000Z", cwd: "/Users/me/acme-4790" }]);
    expect(cliSessionsOf(null)).toEqual({ running: [], resumable: [] });
  });

  it("status words; waiting for input first, then working, idle, unknown", () => {
    expect(runningStatusLabel("busy")).toBe("작업 중");
    expect(runningStatusLabel("waiting")).toBe("입력 대기");
    expect(runningStatusLabel("idle")).toBe("쉬는 중");
    expect(runningStatusLabel("unknown")).toBe("알 수 없음");
    const sorted = sortRunning(cliSessionsOf(reply).running);
    expect(sorted.map((r) => r.status)).toEqual(["waiting", "busy", "unknown"]);
  });

  it("'Continue in terminal' copies cd <folder> && claude --resume <id>, quoted when needed", () => {
    expect(terminalResumeCommand("/Users/me/acme", "9f1e-22", "darwin")).toBe("cd /Users/me/acme && claude --resume 9f1e-22");
    expect(terminalResumeCommand("/Users/me/my repo", "9f1e", "darwin")).toBe("cd '/Users/me/my repo' && claude --resume 9f1e");
    expect(terminalResumeCommand("/Users/me/it's", "9f1e", "linux")).toBe("cd '/Users/me/it'\\''s' && claude --resume 9f1e");
    expect(terminalResumeCommand("C:\\Users\\me\\my repo", "9f1e", "win32")).toBe('cd /d "C:\\Users\\me\\my repo" && claude --resume 9f1e');
    expect(terminalResumeCommand("C:\\src\\acme", "9f1e", "win32")).toBe("cd /d C:\\src\\acme && claude --resume 9f1e");
  });

  it("an imported chat (SessionMeta.imported)", () => {
    expect(importedOf({ imported: { at: "2026-10-23T02:12:00Z", cwd: "/Users/me/acme-4790" } })).toEqual({ at: "2026-10-23T02:12:00Z", cwd: "/Users/me/acme-4790" });
    expect(importedOf({ imported: { at: "x", cwd: null } })).toEqual({ at: "x", cwd: null });
    expect(importedOf({})).toBeNull();
    expect(importedOf(undefined)).toBeNull();
  });
});
