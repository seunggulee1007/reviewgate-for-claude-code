// MARK: git-sync — docs/PROTOCOL.md §68 on Windows: the refusals' words, why Fetch / Pull / Rebase are off, the chip's
// badge, the branch menu's items, and the store's Fetch / Pull / automatic fetch with the engine bridge mocked.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BranchInfo, EngineCommand, RemoteSyncState, ReviewState } from "@reviewgate/engine";
import { refusalCodeText } from "./errorCodes";
import { fetchDisabledReason, fetchedText, isDiverged, lastFetchedText, pulledText, pullDisabledReason, rebaseDisabledReason, syncBadge, syncBadgeHelp, syncOf, unbrokenPaths } from "./gitSync";
import { initI18n } from "./i18n";

const branch = (o: Partial<BranchInfo> = {}): BranchInfo => ({ name: "main", isCurrent: true, upstream: "origin/main", ahead: 0, behind: 0, lastCommitDate: null, ...o });
const sync = (o: Partial<RemoteSyncState> = {}): RemoteSyncState => ({
  fetching: false, pulling: false, lastFetchAt: null, lastFetchError: null, remotes: ["origin"], upstream: "origin/main", operation: null,
  pullBlocker: null, fetchBlocker: null, autoFetch: true, ...o,
});
function st(o: { b?: Partial<BranchInfo>; s?: Partial<RemoteSyncState> | null; files?: number; dirty?: boolean; vcs?: "git" | "shadow" } = {}): ReviewState {
  return {
    project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null, vcs: o.vcs ?? "git" },
    branches: { list: [branch(o.b)], isWorktreeDirty: o.dirty === true, switchBlocker: o.dirty ? { kind: "dirtyWorktree" } : null, ...(o.s === null ? {} : { sync: sync(o.s ?? {}) }) },
    changedFiles: Array.from({ length: o.files ?? 0 }, (_, i) => ({ path: `f${i}.ts`, state: "pending" })),
  } as unknown as ReviewState;
}

describe("§68 fetch and pull — words and rules", () => {
  beforeAll(() => initI18n("en", "win32"));

  it("each refusal says what happened and what to do", () => {
    expect(refusalCodeText("pull_diverged", "2,3")).toBe("This branch and its upstream have diverged (2 local, 3 incoming commits) — a fast-forward is not possible. Rebase onto the upstream, or merge in a terminal.");
    expect(refusalCodeText("pull_no_upstream", "topic")).toBe("topic has no upstream — push it first (git push -u) to pull into it");
    expect(refusalCodeText("pull_in_progress", "cherry-pick")).toBe("A cherry-pick is in progress — finish or abort it in a terminal, then pull");
    expect(refusalCodeText("pull_would_overwrite", "a.ts, b.ts")).toBe(`Pull would overwrite your uncommitted changes: ${unbrokenPaths("a.ts, b.ts")} — commit them (or finish their review) first. Nothing was changed.`);
    // A line never ends inside a path ("src/cart.\nts"): a word joiner after each "/" "." "-" "_" within it.
    expect(unbrokenPaths("src/cart.ts, my-notes_1.md")).toBe("src/⁠cart.⁠ts, my-⁠notes_⁠1.⁠md");
    expect(unbrokenPaths("a/")).toBe("a/");
    expect(refusalCodeText("pull_blocked", "running")).toBe("Claude is working — pull when the turn ends");
    expect(refusalCodeText("pull_rebase_blocked", "dirty")).toBe("Commit your changes before rebasing");
    expect(refusalCodeText("pull_rebase_failed", "CONFLICT (content)")).toBe("The rebase stopped and was undone — nothing changed: CONFLICT (content)");
    expect(refusalCodeText("fetch_failed", "fatal: could not read from remote")).toBe("Fetch failed: fatal: could not read from remote");
    expect(pulledText({ mode: "fast_forward", upstream: "origin/main", commits: 2, fileCount: 5 })).toBe("Pulled 2 commit(s) from origin/main · 5 file(s) changed");
    expect(pulledText({ mode: "up_to_date", upstream: "origin/main", commits: 0, fileCount: 0 })).toBe("Already up to date with origin/main");
    expect(fetchedText({ remotes: ["origin"], behind: 3 })).toBe("Fetched origin — 3 incoming commit(s) to pull");
    expect(fetchedText({ remotes: ["origin"], behind: 0 })).toBe("Fetched origin — up to date");
    expect(lastFetchedText("2026-11-24T10:00:00.000Z", Date.parse("2026-11-24T10:07:30.000Z"))).toBe("Fetched 7 min ago");
    expect(lastFetchedText(null)).toBeNull();
  });

  it("reasons, badge and divergence", () => {
    expect(syncOf(st({ s: null }))).toBeNull(); // an older engine: hidden
    expect(syncOf(st({ vcs: "shadow" }))).toBeNull();
    expect(pullDisabledReason(sync())).toBeNull();
    expect(pullDisabledReason(sync({ pullBlocker: { kind: "noUpstream" } }))).toBe("This branch has no upstream — push it first (git push -u) to pull into it");
    expect(pullDisabledReason(sync({ pullBlocker: { kind: "operation", operation: "rebase" } }))).toBe("A rebase is in progress — finish or abort it in a terminal, then pull");
    expect(pullDisabledReason(sync({ fetching: true }))).toBe("A fetch or pull is already running");
    expect(fetchDisabledReason(sync({ fetchBlocker: { kind: "noRemote" } }))).toBe("The repository has no remote");
    expect(syncBadge(branch({ ahead: 2, behind: 3 }))).toBe("↑2 ↓3");
    expect(syncBadge(branch({ upstream: null, ahead: 2 }))).toBe("");
    expect(syncBadgeHelp(branch({ behind: 1 }))).toBe("1 commit(s) to pull — origin/main");
    expect(isDiverged(branch({ ahead: 1, behind: 1 }))).toBe(true);
    expect(isDiverged(branch({ behind: 1 }))).toBe(false);
    expect(rebaseDisabledReason(st({ files: 1 }))).toBe("Finish the review before rebasing — a rebase rewrites the files under review");
    expect(rebaseDisabledReason(st({ dirty: true }))).toBe("Commit your changes before rebasing");
    expect(rebaseDisabledReason(st())).toBeNull();
    // Pull's blockers in a rebase's own words — not "pull when the turn ends" on the Rebase item.
    expect(rebaseDisabledReason(st({ s: { pullBlocker: { kind: "running" } } }))).toBe("Claude is working — rebase when the turn ends");
    expect(rebaseDisabledReason(st({ s: { pullBlocker: { kind: "operation", operation: "merge" } } }))).toBe("A merge is in progress — finish or abort it in a terminal, then rebase");
    expect(rebaseDisabledReason(st({ s: { fetching: true }, files: 1 }))).toBe("A fetch or pull is already running");
  });

  it("the branch menu: Fetch, Pull with the count, Rebase only when diverged, the last fetch as a footer", async () => {
    installWindow();
    const { syncItems } = await import("./components/BranchSwitcher");
    const noop = async () => undefined;
    const behind = syncItems(st({ b: { behind: 3 }, s: { lastFetchAt: new Date(Date.now() - 120_000).toISOString() } }), sync({ lastFetchAt: new Date(Date.now() - 120_000).toISOString() }), noop, noop);
    const byId = (items: typeof behind, id: string) => items.find((i) => i.kind === "item" && i.testId === id) as Extract<(typeof behind)[number], { kind: "item" }> | undefined;
    expect(byId(behind, "Fetch")?.disabled).toBe(false);
    expect(byId(behind, "Pull")).toMatchObject({ label: "Pull 3 commit(s)", disabled: false });
    expect(byId(behind, "Pull")?.title).toContain("fast-forwards this branch to origin/main");
    expect(byId(behind, "Rebase onto upstream")).toBeUndefined();
    expect(behind[behind.length - 1]).toEqual({ kind: "footer", label: "Fetched 2 min ago" });

    const diverged = syncItems(st({ b: { ahead: 1, behind: 2 } }), sync(), noop, noop);
    expect(byId(diverged, "Pull")).toMatchObject({ disabled: true, title: refusalCodeText("pull_diverged", "1,2") });
    expect(byId(diverged, "Rebase onto upstream")).toMatchObject({ label: "Rebase onto origin/main", disabled: false });

    const failing = syncItems(st(), sync({ lastFetchError: "fetch_failed:fatal: offline", remotes: ["origin", "fork"], pullBlocker: { kind: "noUpstream" } }), noop, noop);
    expect(byId(failing, "Fetch all remotes")).toBeDefined();
    expect(byId(failing, "Pull")?.disabled).toBe(true);
    expect(failing[failing.length - 1]).toEqual({ kind: "footer", label: "Fetch failed: fatal: offline" });
  });

  it("every §68 refusal has Korean words", () => {
    initI18n("ko", "win32");
    try {
      for (const code of ["pull_blocked", "pull_no_upstream", "pull_in_progress", "pull_diverged", "pull_would_overwrite", "pull_rebase_blocked", "pull_rebase_failed", "pull_failed", "fetch_failed"]) {
        expect(refusalCodeText(code, code === "pull_diverged" ? "1,2" : "x")).toMatch(/[가-힣]/);
      }
      expect(pulledText({ mode: "fast_forward", upstream: "origin/main", commits: 2, fileCount: 5 })).toBe("origin/main에서 커밋 2개를 pull했어요 · 파일 5개 바뀜");
    } finally {
      initI18n("en", "win32");
    }
  });
});

// ---------------------------------------------------------------- the store, with the engine bridge mocked

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

function installWindow(): void {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rgInitialProject: null,
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return respond(c);
      },
      setSettings: async (patch: Record<string, unknown>) => ({ appearance: "system", ...patch }),
      getSettings: async () => ({ appearance: "system" }),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
}

async function loadStore() {
  installWindow();
  return (await import("./store")).useStore;
}

describe("§68 the store: Fetch, Pull and the automatic fetch", () => {
  let useStore: Awaited<ReturnType<typeof loadStore>>;
  let seq = 9000;
  beforeAll(async () => {
    initI18n("en", "win32");
    useStore = await loadStore();
  });
  afterAll(() => initI18n("en", "win32"));
  const snapshot = (o: Parameters<typeof st>[0] = {}) => {
    const s = useStore.getState().state;
    const next = st(o);
    useStore.getState().handleEvent({ type: "state", state: { ...s, seq: ++seq, project: next.project, branches: next.branches } as ReviewState });
  };
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    useStore.setState({ settings: { appearance: "system" } as never, gitSyncNotice: null });
    snapshot({ b: { behind: 2 } });
  });

  it("Pull leaves its outcome, a refused one its reason and files; nothing is sent while it is off", async () => {
    respond = (c) => (c.type === "git_pull" ? { ok: true, reply: { type: "pulled", branch: "main", upstream: "origin/main", mode: "fast_forward", from: "a", to: "b", commits: 2, files: ["x.ts"], fileCount: 1 } } : { ok: true, reply: { type: "result", ok: true } });
    await useStore.getState().gitPull();
    expect(sent.filter((c) => c.type === "git_pull")).toEqual([{ type: "git_pull" }]);
    expect(useStore.getState().gitSyncNotice).toEqual({ kind: "success", text: "Pulled 2 commit(s) from origin/main · 1 file(s) changed", paths: ["x.ts"] });

    respond = () => ({ ok: false, error: "pull_would_overwrite:a.ts", code: "pull_would_overwrite", paths: ["a.ts"] });
    await useStore.getState().gitPull();
    expect(useStore.getState().gitSyncNotice).toMatchObject({ kind: "error", paths: ["a.ts"] });
    expect(useStore.getState().gitSyncNotice?.text).toContain("Nothing was changed");
    useStore.getState().dismissGitSyncNotice();
    expect(useStore.getState().gitSyncNotice).toBeNull();

    snapshot({ s: { pullBlocker: { kind: "running" } } });
    sent.length = 0;
    await useStore.getState().gitPull(true);
    expect(sent).toEqual([]);
  });

  it("the automatic fetch follows the setting and never shows anything; Fetch says what came in", async () => {
    respond = () => ({ ok: false, error: "fetch_failed:offline", code: "fetch_failed" });
    await useStore.getState().autoFetch();
    expect(sent).toEqual([{ type: "git_fetch", auto: true }]);
    expect(useStore.getState().gitSyncNotice).toBeNull();
    useStore.setState({ settings: { appearance: "system", autoFetch: false } as never });
    sent.length = 0;
    await useStore.getState().autoFetch();
    expect(sent).toEqual([]);

    respond = () => ({ ok: true, reply: { type: "fetched", remotes: ["origin"], ahead: 0, behind: 4 } });
    await useStore.getState().gitFetch();
    expect(sent).toEqual([{ type: "git_fetch" }]);
    expect(useStore.getState().gitSyncNotice).toEqual({ kind: "info", text: "Fetched origin — 4 incoming commit(s) to pull", paths: [] });
  });
});
