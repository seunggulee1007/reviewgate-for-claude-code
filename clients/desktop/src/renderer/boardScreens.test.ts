/**
 * MARK: wave5 w5-board — §43.1: the agent board and the panel's compact rows through the store (engine bridge mocked), the
 * views rendered to static markup: faces per type and mood, what each agent runs in words, the summary line, the earlier
 * turns, the tabs; an engine before §39.3 / §42.4 (no steps, no history) still shows every agent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentNode, GateState, PermissionRequest, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

vi.mock("./components/chat/Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", { className: "markdown" }, text) }));

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }),
      setSettings: async (patch: Record<string, unknown>) => patch,
      getSettings: async () => ({}),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;

const gate = (p: Partial<GateState> = {}): GateState =>
  ({
    phase: "running",
    canSend: false,
    canRequestChanges: false,
    blockedReason: "running",
    collectError: null,
    pendingCount: 0,
    changesRequestedCount: 0,
    isRequestingChanges: false,
    turnStartTree: null,
    turnEndTree: null,
    lastReviewSummary: null,
    changedOutside: [],
    ignoredTouched: [],
    filteredByPattern: [],
    restored: false,
    reviewSummary: { files: 0, added: 0, deleted: 0 },
    externalPendingCount: 0,
    ...p,
  }) as GateState;

const now = Date.now();
const node = (id: string, patch: Partial<AgentNode> = {}): AgentNode => ({
  id: `task-${id}`,
  toolUseId: id,
  type: "oh-my-claudecode:executor",
  description: "",
  status: "running",
  isBackground: false,
  depth: 1,
  startedAt: now - 60_000,
  files: [],
  ...patch,
});

let seq = 7000;

describe("the agent board (§43.1)", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "darwin"));

  let useStore: UseStore;
  beforeEach(async () => {
    useStore = await loadStore();
    const s = useStore.getState().state;
    useStore.setState({
      transcript: [],
      dialog: null,
      tab: "changes",
      state: {
        ...s,
        seq: ++seq,
        gate: gate(),
        hud: { ...s.hud, agents: [], agentHistory: undefined, turnStartedAt: now - 90_000, activity: { kind: "subagent", toolName: "Agent" } },
        project: { path: "C:\\work\\acme", root: "C:\\work\\acme", name: "acme", branch: "main", remoteURL: null },
      } as ReviewState,
    });
  });

  const setHud = (patch: Partial<ReviewState["hud"]>) => {
    const s = useStore.getState().state;
    useStore.setState({ state: { ...s, seq: ++seq, hud: { ...s.hud, ...patch } } as ReviewState });
  };
  const setPending = (list: PermissionRequest[]) => {
    const s = useStore.getState().state;
    useStore.setState({ state: { ...s, seq: ++seq, session: { ...s.session, pendingPermissions: list } } as ReviewState });
  };
  const render = async (path: string, name = "default") => {
    const mod = (await import(path)) as Record<string, unknown>;
    Object.assign(useStore.getInitialState(), useStore.getState());
    return renderToStaticMarkup(createElement(mod[name] as never));
  };

  it("shows each agent as a face with what it runs in words, the summary line and the earlier turns", async () => {
    setHud({
      agents: [
        node("ex", { description: "변경 내용 확인", lastStep: { tool: "mcp__acme__acme_list_issues", detail: "1800", since: now - 5_000 }, toolUses: 12, tokens: 35_400, apiModel: "claude-sonnet-4-5-20250929" }),
        node("te", { type: "oh-my-claudecode:test-engineer", description: "테스트 보강" }),
        node("gp", { type: "general-purpose", status: "failed", error: "API Error: 529 Overloaded", endedAt: now - 1_000 }),
        node("xp", { type: "Explore", status: "completed", reportPreview: "## 사용처 14곳\n- api", endedAt: now - 2_000 }),
      ],
      agentHistory: [node("old1", { type: "debugger", status: "completed", turn: 3, endedAt: now - 500_000, startedAt: now - 600_000 }), node("old2", { type: "planner", status: "stopped", turn: 2, startedAt: now - 900_000, endedAt: now - 800_000 })],
    });
    setPending([{ requestId: "r1", toolName: "Bash", input: { command: "./gradlew test" }, agent: { agentToolUseId: "te", agentType: "test-engineer" } } as unknown as PermissionRequest]);
    const html = await render("./components/board/AgentBoard");
    expect(html).toContain("지금 1명 일하는 중 · 1명 권한 대기 · 오늘 6명 다녀감");
    expect(html).toContain('data-testid="Agent board tile ex"');
    expect(html).toMatch(/data-icon="hammer" data-mood="working"/);
    expect(html).toMatch(/data-icon="flask" data-mood="waiting"/);
    expect(html).toMatch(/data-icon="robot" data-mood="failed"/);
    expect(html).toMatch(/data-icon="binoculars" data-mood="done"/);
    expect(html).toMatch(/data-icon="claude" data-mood="working"/);
    expect(html).toContain("acme · list issues · 1800");
    expect(html).toContain("API Error: 529 Overloaded");
    expect(html).toContain("사용처 14곳");
    expect(html).toContain(">OMC<");
    expect(html).toContain("도구 12회");
    expect(html).toContain("sonnet");
    expect(html).toContain("이전 턴");
    expect(html).toMatch(/data-icon="bug"/);
    expect(html).toMatch(/data-icon="map" data-mood="stopped"/);
  });

  it("is a quiet board without agents, and still shows agents from an engine before §39.3 (no steps, no history)", async () => {
    let html = await render("./components/board/AgentBoard");
    expect(html).toContain("이번 턴에는 서브에이전트가 없습니다");
    expect(html).not.toContain("이전 턴");
    setHud({ agents: [node("a1", { lastTool: "Read" })] });
    html = await render("./components/board/AgentBoard");
    expect(html).toContain('data-testid="Agent board tile a1"');
    expect(html).toContain("Read");
  });

  it("has the three tabs, the remembered one in front, and the real sub-brain and code graph tabs (§43.2, §43.3)", async () => {
    const html = await render("./components/board/BoardDialog", "BoardDialog");
    expect(html).toContain('data-testid="Agent board tab agents"');
    expect(html).toContain('data-testid="Agent board tab brain"');
    expect(html).toContain('data-testid="Agent board tab graph"');
    expect(html).toContain("관제판");
    expect(html).toContain("열기/닫기 Ctrl+Alt+B");
    const brain = await render("./components/board/SubBrainBoard");
    expect(brain).toContain('data-testid="sub-brain"');
    expect(brain).not.toContain("준비 중이에요");
    const graph = await render("./components/board/CodeGraphBoard");
    expect(graph).toContain('data-testid="Code graph board"');
    expect(graph).not.toContain("준비 중이에요");
  });

  it("steps aside for a new side question from a tile's menu (§43.5's 왜?), not for a side answer arriving", async () => {
    const { sideStepsAside } = await import("./components/board/BoardDialog");
    const list = { kind: "list" } as const;
    const before = useStore.getState().sideView;
    // The card's menu item asks through askAbout: a new question view with its own nonce.
    useStore.getState().askAbout({ toolUseId: "a1" }, { question: "왜 시작했어?" });
    const asked = useStore.getState().sideView;
    expect(asked.kind).toBe("new");
    expect(sideStepsAside(before, asked)).toBe(true);
    expect(sideStepsAside(list, asked)).toBe(true);
    expect(sideStepsAside(asked, asked)).toBe(false);
    expect(sideStepsAside(asked, { kind: "thread", threadId: "t1" })).toBe(false);
    expect(sideStepsAside(list, { kind: "thread", threadId: "t1" })).toBe(false);
    expect(sideStepsAside(list, list)).toBe(false);
  });

  it("opens and closes from the store, never without a project", () => {
    useStore.getState().toggleBoard();
    expect(useStore.getState().boardOpen).toBe(true);
    useStore.getState().toggleBoard();
    expect(useStore.getState().boardOpen).toBe(false);
    const s = useStore.getState().state;
    useStore.setState({ state: { ...s, project: null } as ReviewState });
    useStore.getState().toggleBoard(true);
    expect(useStore.getState().boardOpen).toBe(false);
  });

  it("makes three agents that ran at the same time compact rows in the agent panel, each in its type's color", async () => {
    setHud({
      agents: [
        node("p1", { startedAt: now - 30_000, lastStep: { tool: "Edit", detail: "CartService.java", since: now - 2_000 } }),
        node("p2", { type: "oh-my-claudecode:architect", startedAt: now - 29_000 }),
        node("p3", { type: "Explore", startedAt: now - 28_000, status: "completed", endedAt: now - 1_000, reportPreview: "## 결론\n- x" }),
      ],
    });
    const html = await render("./components/agents/AgentPanel", "AgentPanel");
    expect(html).toContain('data-testid="Agent rows"');
    expect(html).toContain('data-testid="Agent row p1"');
    expect(html).toMatch(/agent-row tone-av-coral/);
    expect(html).toMatch(/agent-row tone-av-sky/);
    expect(html).toContain("Edit · CartService.java");
    expect(html).toContain("결론");
    expect(html).toContain('data-testid="Open agent board"');
  });

  it("keeps two side by side as cards with the identity band and the plugin badge", async () => {
    setHud({ agents: [node("c1", { startedAt: now - 30_000 }), node("c2", { type: "acme-tools:smoke", startedAt: now - 29_000 })] });
    const html = await render("./components/agents/AgentPanel", "AgentPanel");
    expect(html).not.toContain('data-testid="Agent rows"');
    expect(html).toMatch(/agent-card tone-blue ident tone-av-coral/);
    expect(html).toMatch(/agent-card tone-blue ident tone-av-periwinkle/);
    expect(html).toContain(">acme-tools<");
  });
});
