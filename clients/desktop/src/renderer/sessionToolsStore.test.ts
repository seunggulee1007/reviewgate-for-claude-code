/**
 * MARK: wave3 desktop-session — §36.5–36.9 in the store (engine bridge mocked, as in sessionStore.test.ts): the capability
 * cache during a start, retry_extensions, cli_versions / pinning, cli_sessions / import, the cli_version_changed notice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState, SessionCapabilities } from "@reviewgate/engine";
import { initI18n } from "./i18n";

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });
/** What `rg:setSettings` received (main keeps the renderer-writable keys and returns the merged settings). */
const patches: Record<string, unknown>[] = [];
let stored: Record<string, unknown> = {};
/** What `rg:pinClaudeVersion` / `rg:clearExecutable` received. */
const pins: string[] = [];

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return respond(c);
      },
      setSettings: async (patch: Record<string, unknown>) => {
        patches.push(patch);
        stored = { ...stored, ...patch };
        return stored;
      },
      pinClaudeVersion: async (version: string) => {
        pins.push(version);
        if (version === "9.9.9") throw new Error("no such version");
        stored = { ...stored, claudePath: `/Users/me/.local/share/claude/versions/${version}` };
        return stored;
      },
      clearExecutable: async (kind: string) => {
        pins.push(`clear:${kind}`);
        stored = { ...stored, claudePath: "" };
        return stored;
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

type UseStore = Awaited<ReturnType<typeof loadStore>>;

function reset(useStore: UseStore, session: Partial<ReviewState["session"]> = {}) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, ...session },
      gate: { ...s.gate, canSend: true, phase: "idle", blockedReason: null },
    } as ReviewState,
    transcript: [],
    errorBanner: null,
    lastError: null,
    cachedCapabilities: null,
    startSlowHint: null,
  });
}

function snapshot(useStore: UseStore, session: Partial<ReviewState["session"]>) {
  const s = useStore.getState().state;
  useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, session: { ...s.session, ...session } } });
}

const caps = (more: Partial<SessionCapabilities> = {}): SessionCapabilities => ({ slashCommands: ["mcp"], skills: [], plugins: [], mcpServers: [], state: "ready", ...more });
const startingCaps: SessionCapabilities = { slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "starting" };

describe("capabilities while a session starts (§36.5)", () => {
  beforeAll(() => initI18n("en", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("the engine's replayed cache counts as (cached)", async () => {
    const useStore = await loadStore();
    const { capabilitiesOf } = await import("./store");
    reset(useStore, { capabilities: caps(), capabilitiesCached: true });
    expect(capabilitiesOf(useStore.getState()).cached).toBe(true);
    snapshot(useStore, { capabilitiesCached: false });
    expect(capabilitiesOf(useStore.getState()).cached).toBe(false);
  });

  it("the client keeps the session's own capabilities, never the empty starting lists or the engine's cache", async () => {
    const useStore = await loadStore();
    reset(useStore, { capabilities: null, starting: true, ready: false });
    snapshot(useStore, { capabilities: startingCaps });
    expect(useStore.getState().cachedCapabilities).toBeNull();
    snapshot(useStore, { capabilities: caps({ slashCommands: ["cached-one"] }), capabilitiesCached: true });
    expect(useStore.getState().cachedCapabilities).toBeNull();
    snapshot(useStore, { capabilities: caps({ slashCommands: ["fresh"] }), capabilitiesCached: false, starting: false, ready: true });
    expect(useStore.getState().cachedCapabilities?.slashCommands).toEqual(["fresh"]);
  });

  it("the slow-start hint stays while the lists are the starting ones and goes once the CLI reported its own", async () => {
    const useStore = await loadStore();
    reset(useStore, { capabilities: null, starting: true, ready: false });
    snapshot(useStore, { capabilities: startingCaps });
    useStore.getState().handleEvent({ type: "error", message: "slow", fatal: false, scope: "session", code: "cli_start_slow" });
    expect(useStore.getState().startSlowHint).not.toBeNull();
    snapshot(useStore, { capabilities: { ...startingCaps, slashCommands: ["x"] } });
    expect(useStore.getState().startSlowHint).not.toBeNull();
    snapshot(useStore, { capabilities: caps(), starting: false, ready: true });
    expect(useStore.getState().startSlowHint).toBeNull();
  });
});

describe("local settings per project (§36.6)", () => {
  beforeEach(() => {
    patches.length = 0;
    stored = { budgetMaxFiles: 10, budgetMaxLines: 400, appearance: "system" };
  });

  it("turning it off stores false for this project; turning it on removes the entry (absent = on)", async () => {
    const useStore = await loadStore();
    const { projectRootHash } = await import("../shared/hash");
    reset(useStore);
    useStore.setState({ settings: stored as never });
    await useStore.getState().setLoadLocalSettings(false);
    expect(patches.at(-1)).toEqual({ projectLoadLocalSettings: { [projectRootHash("/p")]: false } });
    await useStore.getState().setLoadLocalSettings(true);
    expect(patches.at(-1)).toEqual({ projectLoadLocalSettings: {} });
  });

  it("does nothing without a project", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.setState((s) => ({ state: { ...s.state, project: null } }));
    await useStore.getState().setLoadLocalSettings(false);
    expect(patches).toEqual([]);
  });
});

describe("retry with extensions (§36.7)", () => {
  const fallback = { reason: "init_timeout" as const, timeoutMs: 45000, at: "2026-10-23T01:00:00.000Z" };
  const withFallback = (useStore: UseStore) =>
    reset(useStore, { extensions: { settingSources: ["project"], fallback, plugins: [], disabledPlugins: [], unresolvedDisabledPlugins: [], userHooksDisabled: false, skills: [], slashCommands: [], mcpServers: [], memoryFiles: null, claudeMd: { user: false, project: false, source: "files" }, hooks: [], notApplied: null } });
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("sends retry_extensions (the session restarts with the user's extensions, resumed)", async () => {
    const useStore = await loadStore();
    withFallback(useStore);
    expect(await useStore.getState().retryExtensions()).toBe("started");
    expect(sent.map((c) => c.type)).toEqual(["retry_extensions"]);
    expect(useStore.getState().extensionsRetrying).toBe(false);
    expect(useStore.getState().extensionsRetryError).toBeNull();
  });

  it("an engine without it (or without a session) reopens the project as before", async () => {
    const useStore = await loadStore();
    withFallback(useStore);
    respond = (c) => (c.type === "retry_extensions" ? { ok: false, error: "unknown command: retry_extensions", code: "unknown_command" } : { ok: true, reply: { type: "result", ok: true } });
    expect(await useStore.getState().retryExtensions()).toBe("unsupported");
    expect(sent.map((c) => c.type)).toEqual(["retry_extensions", "switch_project"]);
  });

  it("extensions_on is no error; a busy refusal says why (no banner, no row)", async () => {
    const useStore = await loadStore();
    withFallback(useStore);
    respond = () => ({ ok: false, error: "extensions_on", code: "extensions_on" });
    expect(await useStore.getState().retryExtensions()).toBe("alreadyOn");
    expect(useStore.getState().extensionsRetryError).toBeNull();
    respond = () => ({ ok: false, error: "session_busy", code: "session_busy" });
    expect(await useStore.getState().retryExtensions()).toBe("refused");
    expect(useStore.getState().extensionsRetryError).toBe("Claude가 작업 중…");
    expect(useStore.getState().errorBanner).toBeNull();
    expect(useStore.getState().transcript).toEqual([]);
  });

  it("a closed fallback banner stays closed for the project (the engine's own retry may fall back again); a project switch forgets it", async () => {
    const useStore = await loadStore();
    withFallback(useStore);
    useStore.getState().silenceFallbackBanner();
    expect(useStore.getState().fallbackBannerSilenced).toBe(true);
    useStore.getState().handleEvent({ type: "extensions_fallback", message: "again", timeoutMs: 45000 } as never);
    expect(useStore.getState().fallbackBannerSilenced).toBe(true);
    await useStore.getState().switchProject("/q");
    expect(useStore.getState().fallbackBannerSilenced).toBe(false);
  });
});

describe("CLI version (§36.8)", () => {
  const versionsReply = { type: "cli_versions", versions: [{ version: "2.1.308", path: "/Users/me/.local/share/claude/versions/2.1.308", verified: false }, { version: "2.1.307", path: "/Users/me/.local/share/claude/versions/2.1.307", verified: true }], current: "2.1.308", pinnedPath: null };
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    pins.length = 0;
    stored = {};
    respond = (c) => (c.type === "cli_versions" ? { ok: true, reply: versionsReply } : { ok: true, reply: { type: "result", ok: true } });
  });

  it("cli_versions fills the list; an engine without it turns the list off (no error)", async () => {
    const useStore = await loadStore();
    reset(useStore);
    await useStore.getState().loadCliVersions();
    expect(useStore.getState().cliVersions?.versions.map((v) => v.version)).toEqual(["2.1.308", "2.1.307"]);
    expect(useStore.getState().cliVersionsSupported).toBe(true);
    respond = () => ({ ok: false, error: "unknown command: cli_versions", code: "unknown_command" });
    await useStore.getState().loadCliVersions();
    expect(useStore.getState().cliVersionsSupported).toBe(false);
    expect(useStore.getState().cliVersionsError).toBeNull();
  });

  it("pinning names the version to main (never a path) and keeps the new settings; unpinning clears claudePath", async () => {
    const useStore = await loadStore();
    reset(useStore);
    expect(await useStore.getState().pinCliVersion("2.1.307")).toBeNull();
    expect(pins).toEqual(["2.1.307"]);
    expect(useStore.getState().settings?.claudePath).toBe("/Users/me/.local/share/claude/versions/2.1.307");
    expect(await useStore.getState().pinCliVersion(null)).toBeNull();
    expect(pins).toEqual(["2.1.307", "clear:claude"]);
    expect(useStore.getState().settings?.claudePath).toBe("");
  });

  it("a refused pin says why", async () => {
    const useStore = await loadStore();
    reset(useStore);
    expect(await useStore.getState().pinCliVersion("9.9.9")).toBe("no such version");
    expect(useStore.getState().cliPinError).toBe("no such version");
  });

  it("a closed banner stays closed (app-wide, per version)", async () => {
    const useStore = await loadStore();
    useStore.getState().dismissCliBanner("2.1.308");
    useStore.getState().dismissCliBanner("2.1.308");
    expect(useStore.getState().cliBannerDismissed.filter((k) => k === "2.1.308")).toHaveLength(1);
  });

  it("the cli_version_changed notice is a chat row only — no banner, the queue goes on", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.setState((s) => ({ queue: { ...s.queue, items: [{ id: 5, text: "next" }], paused: null } }));
    useStore.getState().handleEvent({ type: "error", message: "Claude Code changed from 2.1.307 to 2.1.308 (not verified yet).", fatal: false, scope: "session", code: "cli_version_changed", cli: { from: "2.1.307", to: "2.1.308", verified: false } });
    const rows = useStore.getState().transcript.filter((i) => i.kind === "error");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { message: string }).message).toBe("Claude Code가 2.1.307에서 2.1.308(으)로 바뀌었어요 (아직 검증 안 됨)");
    expect(useStore.getState().errorBanner).toBeNull();
    expect(useStore.getState().lastError).toBeNull();
    expect(useStore.getState().queue.paused).toBeNull();
  });
});

describe("other Claude sessions (§36.9)", () => {
  /** The §36.9 example. */
  const sessionsReply = {
    type: "cli_sessions",
    id: "q3",
    running: [{ pid: 82411, sessionId: "5d0c", name: "acme-b4", cwd: "/Users/me/acme", status: "waiting", entrypoint: "cli", sameWorktree: true }],
    resumable: [{ sessionId: "9f1e", title: "장바구니 합계 수정", updatedAt: "2026-10-23T02:10:00.000Z", cwd: "/Users/me/acme-1600" }],
  };
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = (c) => (c.type === "cli_sessions" ? { ok: true, reply: sessionsReply } : { ok: true, reply: { type: "result", ok: true } });
  });

  it("cli_sessions fills the section; an engine without it has none (no error, the sheet closes)", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.setState({ cliSessionsSupported: true, cliSessions: null });
    await useStore.getState().loadCliSessions();
    expect(useStore.getState().cliSessions?.running[0]).toMatchObject({ pid: 82411, status: "waiting", sameWorktree: true });
    expect(useStore.getState().cliSessions?.resumable[0]?.sessionId).toBe("9f1e");
    respond = () => ({ ok: false, error: "unknown command: cli_sessions", code: "unknown_command" });
    useStore.getState().setCliImportOpen(true);
    await new Promise((r) => setTimeout(r, 0));
    await useStore.getState().loadCliSessions();
    expect(useStore.getState().cliSessionsSupported).toBe(false);
    expect(useStore.getState().cliImportOpen).toBe(false);
    expect(useStore.getState().cliSessionsError).toBeNull();
    useStore.setState({ cliSessionsSupported: true });
  });

  it("an import resumes the terminal conversation as this window's current chat (rows replaced, a tab)", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.setState({ cliSessionsSupported: true, cliImportOpen: true });
    respond = (c) => {
      if (c.type === "cli_session_import") {
        // the engine makes the imported chat current
        const s = useStore.getState().state;
        useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, sessions: { list: [{ id: "9f1e", title: "장바구니 합계 수정", createdAt: "", updatedAt: "", turns: 0, costUSD: 0, lastUserText: null, cliKnown: true, imported: { at: "2026-10-23T02:12:00Z", cwd: "/Users/me/acme-1600" } }], currentId: "9f1e", openTabIds: [] } } });
        return { ok: true, reply: { type: "result", ok: true } };
      }
      return c.type === "cli_sessions" ? { ok: true, reply: sessionsReply } : { ok: true, reply: { type: "result", ok: true } };
    };
    expect(await useStore.getState().importCliSession("9f1e")).toBeNull();
    expect(sent.some((c) => c.type === "cli_session_import" && (c as { sessionId?: string }).sessionId === "9f1e")).toBe(true);
    expect(useStore.getState().replaceTranscript).toBe(true);
    expect(useStore.getState().state.sessions.openTabIds).toContain("9f1e");
    expect(useStore.getState().cliImportOpen).toBe(false);
    useStore.setState({ replaceTranscript: false });
  });

  it("a running terminal conversation is refused in words; a busy window does not even ask", async () => {
    const useStore = await loadStore();
    reset(useStore);
    respond = (c) => (c.type === "cli_session_import" ? { ok: false, error: "cli_session_running", code: "cli_session_running" } : { ok: true, reply: { type: "result", ok: true } });
    const words = await useStore.getState().importCliSession("5d0c");
    expect(words).toContain("아직 터미널에서 실행 중이에요");
    expect(useStore.getState().cliImportError).toBe(words);
    expect(useStore.getState().replaceTranscript).toBe(false);
    sent.length = 0;
    useStore.setState((s) => ({ state: { ...s.state, gate: { ...s.state.gate, phase: "running" } } }));
    expect(await useStore.getState().importCliSession("9f1e")).toBe("Claude가 작업 중…");
    expect(sent).toEqual([]);
  });
});
