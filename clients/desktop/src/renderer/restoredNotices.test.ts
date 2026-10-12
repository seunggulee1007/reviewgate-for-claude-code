import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState, TranscriptItem } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ErrorRow } from "./sessionErrors";

// wave2 check-clients — restored `kind: "error"` rows of the §33.4 notices (store level, the engine bridge mocked as in
// sessionStore.test.ts): they read like the live banner did and two different notices never merge.

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

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
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

type UseStore = Awaited<ReturnType<typeof loadStore>>;

function reset(useStore: UseStore, gate: Partial<ReviewState["gate"]> = {}) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, peerInbox: [], externalTurn: null },
      gate: { ...s.gate, canSend: true, phase: "idle", blockedReason: null, ...gate },
    } as ReviewState,
    transcript: [],
    errorBanner: null,
    lastError: null,
    queue: { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
    replaceTranscript: true,
  });
}

const errorRows = (useStore: UseStore) => useStore.getState().transcript.filter((i) => i.kind === "error") as ErrorRow[];

describe("restored §33.4 notices read like the live ones (wave2 check-clients)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  // The engine's English text (engine/src/session/reviewScope.ts `scopeNoticeMessage`) is all a restored row keeps.
  const blockedEnter = "Claude tried to work in a git worktree (\"feat-x\"); ReviewGate blocked it because this window's review would not see that work. For parallel work, open a separate workbench.";
  const blockedWorkflow = "Claude tried to work in Workflow outside this folder; ReviewGate blocked it because this window's review would not see that work. For parallel work, open a separate workbench.";
  const outside = "Bash worked outside this window's review (/p/.claude/worktrees/wt1): those changes are not reviewed here. Open it as a workbench to review them.";

  it("a blocked EnterWorktree and a blocked Workflow stay two rows, each with its own words; the folder of worktree_outside_review is kept", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const items: TranscriptItem[] = [
      { at: "2026-10-22T08:00:00Z", turn: 1, kind: "user_message", text: "go" },
      { at: "2026-10-22T08:00:10Z", turn: 1, kind: "error", message: blockedEnter, fatal: false, scope: "session", code: "worktree_blocked" },
      { at: "2026-10-22T08:00:20Z", turn: 1, kind: "error", message: blockedWorkflow, fatal: false, scope: "session", code: "worktree_blocked" },
      { at: "2026-10-22T08:00:30Z", turn: 1, kind: "error", message: outside, fatal: false, scope: "session", code: "worktree_outside_review" },
    ];
    useStore.getState().handleEvent({ type: "transcript_restore", items });
    const rows = errorRows(useStore);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.message).toBe("Claude가 별도 worktree('feat-x')에서 작업하려 해서 막았어요. 이 창의 리뷰에 잡히지 않기 때문이에요.");
    expect(rows[0]!.facts).toMatchObject({ code: "worktree_blocked", toolName: "EnterWorktree", branch: "feat-x" });
    expect(rows[1]!.message).toBe("워크플로 도구는 이 창 밖에서 에이전트를 돌려서 막았어요.");
    expect(rows[1]!.facts).toMatchObject({ toolName: "Workflow" });
    expect(rows[2]!.facts).toMatchObject({ code: "worktree_outside_review", toolName: "Bash", path: "/p/.claude/worktrees/wt1" });
    expect(rows[2]!.message).toContain("/p/.claude/worktrees/wt1");
  });

  it("§35.3: a row with the event's details uses them (not the words); usage_limit's reset time and the CLI's exit code come back", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.getState().handleEvent({
      type: "transcript_restore",
      items: [
        // the engine's words say Workflow, the row's own details say EnterWorktree on "feat-y": the details win
        { at: "2026-10-22T08:00:10Z", turn: 1, kind: "error", message: blockedWorkflow, fatal: false, scope: "session", code: "worktree_blocked", toolName: "EnterWorktree", branch: "feat-y" },
        { at: "2026-10-22T08:00:20Z", turn: 1, kind: "error", message: "You've hit your limit", fatal: false, scope: "session", code: "usage_limit", resetAt: "2026-10-22T09:30:00Z" },
        { at: "2026-10-22T08:00:30Z", turn: 1, kind: "error", message: "Claude Code exited while starting.", fatal: true, scope: "session", code: "session_start_failed", detail: "boom", exitCode: 1, signal: null },
      ],
    });
    const rows = errorRows(useStore);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.facts).toMatchObject({ toolName: "EnterWorktree", branch: "feat-y" });
    expect(rows[0]!.message).toContain("feat-y");
    expect(rows[1]!.message).toContain("초기화");
    expect(rows[2]!.facts).toMatchObject({ code: "session_start_failed", cliDetail: "boom", exitCode: 1 });
  });

  it("the same notice twice still merges (×2)", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.getState().handleEvent({
      type: "transcript_restore",
      items: [
        { at: "2026-10-22T08:00:10Z", turn: 1, kind: "error", message: blockedEnter, fatal: false, scope: "session", code: "worktree_blocked" },
        { at: "2026-10-22T08:00:20Z", turn: 1, kind: "error", message: blockedEnter, fatal: false, scope: "session", code: "worktree_blocked" },
      ],
    });
    const rows = errorRows(useStore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, facts: { branch: "feat-x" } });
  });
});

