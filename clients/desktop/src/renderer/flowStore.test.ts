/**
 * MARK: wave3 desktop-flow — §36.11–36.14 through the store with the engine bridge mocked (the §36 JSON shapes as replies,
 * events and snapshots; no engine behavior yet): the commit draft only fills the field, the workbench preview answers its
 * own request, a create collects its steps and opens its window (with the setup's log when that failed) also after the sheet
 * closed, the pre-review runs follow replies / events / the snapshot, dismiss and "Add as note", "Send to Claude" goes to the
 * PR head's workbench window or this composer, and an engine before §36 turns the controls off.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand, PRComment, PreReviewFinding, PreReviewRun, ReviewState, WorkbenchInfo } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { projectRootHash } from "../shared/hash";

const inserted: string[] = [];
vi.mock("./composerBridge", () => ({
  insertIntoComposer: (text: string) => {
    inserted.push(text);
    return false;
  },
  joinDraft: (d: string, text: string) => (d ? `${d}\n\n${text}` : text),
  useComposerInsert: () => undefined,
}));

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply | Promise<Reply> = () => ({ ok: true, reply: { type: "result", ok: true } });
const opened: { path: string; report: unknown }[] = [];
const composed: { path: string; text: string }[] = [];
let windowFor: (path: string) => boolean = () => false;
let reports: Record<string, unknown> = {};
let savedPatches: Record<string, unknown>[] = [];

async function loadStore() {
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
      setSettings: async (patch: Record<string, unknown>) => {
        savedPatches.push(patch);
        return { appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400, ...patch };
      },
      getSettings: async () => ({ appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400 }),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      openWorkbenchWindow: async (path: string, report?: unknown) => void opened.push({ path, report }),
      composeInWindow: async (path: string, text: string) => {
        if (!windowFor(path)) return false;
        composed.push({ path, text });
        return true;
      },
      takeWorkbenchSetupReport: async (paths: string[]) => {
        for (const p of paths) if (reports[p]) return reports[p];
        return null;
      },
      platform: "darwin",
      sep: "/",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const finding = (id: string, file: string, line: number | null = null, summary = "s"): PreReviewFinding => ({ id, file, line, summary, shortSummary: `short ${id}`, failureScenario: `scenario ${id}` });
const run = (prereviewId: string, o: Partial<PreReviewRun> = {}): PreReviewRun => ({ prereviewId, status: "done", source: "round", endTree: "B1", startedAt: "2026-10-23T03:00:00.000Z", findings: [], ...o });
const wb = (path: string, branch: string, o: Partial<WorkbenchInfo> = {}): WorkbenchInfo => ({ path, branch, head: "abc", isMain: false, isCurrent: false, locked: null, dirty: null, ...o });

let seq = 5000;

describe("the daily flow in the store (wave3 desktop-flow)", () => {
  let useStore: UseStore;
  beforeAll(async () => {
    initI18n("en", "darwin");
    useStore = await loadStore();
  });
  afterAll(() => initI18n("en", "darwin"));

  /** A snapshot through `handleEvent` (the live path); `project` path changes reset the flow state. */
  const snapshot = (patch: { path?: string; prereviews?: PreReviewRun[] | undefined; workbenches?: WorkbenchInfo[]; remotes?: boolean; reviewEndTree?: string | null } = {}) => {
    const s = useStore.getState().state;
    const path = patch.path ?? "/repo";
    useStore.getState().handleEvent({
      type: "state",
      state: {
        ...s,
        seq: ++seq,
        project: { path, root: path, name: "repo", branch: "feature/acme/4747", remoteURL: "git@ghe.example.com:acme/app.git" },
        changedFiles: [{ path: "api/Svc.java", oldPath: null, status: "M", added: 3, deleted: 1, isBinary: false, tools: ["Edit"], toolUseIds: [], state: "pending", noteCount: 0, origin: "tool" }],
        gate: { ...s.gate, phase: "reviewing", turnStartTree: "A", turnEndTree: "B1", reviewEndTree: patch.reviewEndTree === undefined ? "B1" : patch.reviewEndTree, ...("prereviews" in patch ? { prereviews: patch.prereviews } : { prereviews: [] }) },
        workbenches: { list: patch.workbenches ?? [wb(path, "feature/acme/4747", { isMain: true, isCurrent: true })], current: path, managedRoot: "/wt" },
        branches: { ...s.branches, ...(patch.remotes === false ? { remotes: undefined } : { remotes: [{ name: "origin/develop", isCurrent: false, upstream: null, ahead: 0, behind: 0, lastCommitDate: null, remote: true }] }) },
      } as ReviewState,
    });
  };

  beforeEach(() => {
    sent.length = 0;
    opened.length = 0;
    composed.length = 0;
    inserted.length = 0;
    savedPatches = [];
    reports = {};
    windowFor = () => false;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    // a fresh project view per test: another folder first so the next snapshot is a project change
    snapshot({ path: `/tmp/other-${seq}` });
    useStore.setState({ dialog: null, tab: "changes", transcript: [], errorBanner: null, settings: { appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400 } as never });
    snapshot();
  });

  // ---------------------------------------------------------------- §36.11

  it("§36.11 a draft only fills the field — trimmed; the main chat is untouched", async () => {
    respond = (c) => (c.type === "commit_draft" ? { ok: true, reply: { type: "commit_draft", id: "c4", message: "  #acme/4747: [주문] 재고 동기화 - 중복 차감 방지\n\n- 같은 주문의 재고를 두 번 차감하던 조건 수정\n " } } : { ok: true, reply: { type: "result", ok: true } });
    const message = await useStore.getState().draftCommitMessage(["api/Svc.java"]);
    expect(message).toBe("#acme/4747: [주문] 재고 동기화 - 중복 차감 방지\n\n- 같은 주문의 재고를 두 번 차감하던 조건 수정");
    expect(sent.filter((c) => c.type === "commit_draft")).toEqual([{ type: "commit_draft", paths: ["api/Svc.java"] }]);
    expect(sent.some((c) => c.type === "commit")).toBe(false);
    expect(useStore.getState().flow.drafting).toBe(false);
    expect(useStore.getState().transcript).toEqual([]);
  });

  it("§36.11 a failure is one line; an engine before §36 turns the button off", async () => {
    respond = () => ({ ok: false, error: "commit_draft_failed:the fork answered nothing", code: "commit_draft_failed" });
    expect(await useStore.getState().draftCommitMessage()).toBeNull();
    expect(useStore.getState().flow.draftError).toBe("Claude could not write a message: the fork answered nothing");
    expect(useStore.getState().flow.draftSupported).toBe(true);
    respond = () => ({ ok: true, reply: { type: "commit_draft", message: "  " } });
    expect(await useStore.getState().draftCommitMessage()).toBeNull();
    expect(useStore.getState().flow.draftError).toBe("Claude could not write a message");
    respond = () => ({ ok: false, error: "unknown command: commit_draft", code: "unknown_command" });
    expect(await useStore.getState().draftCommitMessage()).toBeNull();
    expect(useStore.getState().flow.draftSupported).toBe(false);
    expect(useStore.getState().flow.draftError).toBe("This engine does not support it yet — update ReviewGate");
    expect(useStore.getState().errorBanner).toBeNull();
  });

  // ---------------------------------------------------------------- §36.12

  it("§36.12 the preview answers its own request; an older answer never replaces a newer one", async () => {
    let release: (() => void) | null = null;
    respond = (c) => {
      if (c.type !== "workbench_preview") return { ok: true, reply: { type: "result", ok: true } };
      const reply: Reply = { ok: true, reply: { type: "workbench_preview", path: `/x/${c.branch}-${c.location ?? ""}`, copy: [{ path: "mvnw", bytes: 10 }], totalBytes: 10 } };
      if (c.branch === "slow") return new Promise((r) => (release = () => r(reply)));
      return reply;
    };
    useStore.getState().requestWorkbenchPreview({ branch: "slow" }, 0);
    useStore.getState().requestWorkbenchPreview({ branch: "feature/acme/4790", from: "origin/develop", location: "sibling" }, 0);
    await flush();
    release!();
    await flush();
    const f = useStore.getState().flow;
    expect(f.preview?.path).toBe("/x/feature/acme/4790-sibling");
    expect(f.previewKey).toBe(JSON.stringify(["feature/acme/4790", "origin/develop", "sibling"]));
    expect(f.previewLoading).toBe(false);
    respond = () => ({ ok: false, error: "unknown command: workbench_preview", code: "unknown_command" });
    useStore.getState().requestWorkbenchPreview({ branch: "b" }, 0);
    await flush();
    expect(useStore.getState().flow.previewSupported).toBe(false);
    expect(useStore.getState().flow.previewError).toBeNull();
  });

  it("§36.12 a create collects its own steps and opens its window with the failed setup's log — also after the sheet closed", async () => {
    let finish: (() => void) | null = null;
    respond = (c) => (c.type === "workbench_create" ? new Promise((r) => (finish = () => r({ ok: true, reply: { type: "result", ok: true } }))) : { ok: true, reply: { type: "result", ok: true } });
    useStore.setState({ dialog: { kind: "newWorkbench" } });
    const created = useStore.getState().createWorkbenchWith({ branch: "feature/acme/4790", from: "origin/develop", fetch: true, setup: true, location: "sibling" });
    await flush();
    expect(sent.find((c) => c.type === "workbench_create")).toEqual({ type: "workbench_create", branch: "feature/acme/4790", from: "origin/develop", fetch: true, setup: true, location: "sibling" });
    const h = useStore.getState().handleEvent;
    h({ type: "workbench_progress", path: "/Users/me/acme-4790", branch: "feature/acme/4790", step: "fetch", exitCode: 0 });
    h({ type: "workbench_progress", path: "/Users/me/x", branch: "another", step: "create" });
    h({ type: "workbench_progress", path: "/Users/me/acme-4790", branch: "feature/acme/4790", step: "create" });
    h({ type: "workbench_progress", path: "/Users/me/acme-4790", branch: "feature/acme/4790", step: "setup", logTail: "[ERROR] BUILD FAILURE\n", exitCode: 1 });
    h({ type: "workbench_progress", path: "/Users/me/acme-4790", branch: "feature/acme/4790", step: "done", exitCode: 1 });
    expect(useStore.getState().flow.create?.progress.map((p) => p.step)).toEqual(["fetch", "create", "setup", "done"]);
    expect(useStore.getState().flow.create?.running).toBe(true);
    expect(await useStore.getState().createWorkbenchWith({ branch: "another" })).toBeNull(); // one create at a time
    useStore.getState().openDialog(null); // "Close": the create goes on
    finish!();
    expect(await created).toBe("/Users/me/acme-4790");
    expect(opened).toEqual([{ path: "/Users/me/acme-4790", report: { branch: "feature/acme/4790", exitCode: 1, log: "[ERROR] BUILD FAILURE" } }]);
    expect(useStore.getState().flow.create).toMatchObject({ running: false, createdPath: "/Users/me/acme-4790", error: null });
  });

  it("§36.12 a refused create says why (in the sheet, else the banner); branch_in_use offers that workbench", async () => {
    respond = (c) => (c.type === "workbench_create" ? { ok: false, error: "branch_in_use:/wt/feature-x", code: "branch_in_use" } : { ok: true, reply: { type: "result", ok: true } });
    useStore.setState({ dialog: { kind: "newWorkbench" } });
    expect(await useStore.getState().createWorkbenchWith({ branch: "feature/x" })).toBeNull();
    expect(useStore.getState().flow.create).toMatchObject({ running: false, inUsePath: "/wt/feature-x", error: "That branch is already checked out in /wt/feature-x" });
    expect(useStore.getState().errorBanner).toBeNull(); // the sheet says it
    expect(opened).toEqual([]);
    respond = () => ({ ok: false, error: "fetch_failed:fatal: couldn't find remote ref develop", code: "fetch_failed" });
    useStore.setState({ dialog: null });
    expect(await useStore.getState().createWorkbenchWith({ branch: "feature/y", from: "origin/develop", fetch: true })).toBeNull();
    expect(useStore.getState().errorBanner?.message).toBe("Could not fetch from the remote: fatal: couldn't find remote ref develop"); // the sheet was closed
  });

  it("§36.12 a new workbench's window takes its failed setup's report once its project opens", async () => {
    reports = { "/Users/me/acme-4790": { branch: "feature/acme/4790", exitCode: 2, log: "BUILD FAILURE" } };
    snapshot({ path: "/Users/me/acme-4790" });
    await flush();
    expect(useStore.getState().flow.setupReport).toEqual({ branch: "feature/acme/4790", exitCode: 2, log: "BUILD FAILURE" });
    useStore.getState().dismissSetupReport();
    expect(useStore.getState().flow.setupReport).toBeNull();
  });

  // ---------------------------------------------------------------- §36.13

  it("§36.13 runs come from the reply, the events and the snapshot (the engine's list wins when it changes)", async () => {
    respond = (c) =>
      c.type === "prereview_start"
        ? { ok: true, reply: { type: "prereview", id: "p1", ...run("pr-1", { status: "running", findings: [] }) } }
        : { ok: true, reply: { type: "result", ok: true } };
    expect(await useStore.getState().startPreReview("round", undefined, "low")).toBe(true);
    expect(sent.find((c) => c.type === "prereview_start")).toEqual({ type: "prereview_start", scope: "round", effort: "low" });
    expect(useStore.getState().flow.runs.map((r) => r.status)).toEqual(["running"]);
    useStore.getState().handleEvent({ type: "prereview", ...run("pr-1", { findings: [finding("f1", "api/Svc.java", 42)] }) });
    useStore.getState().handleEvent({ type: "prereview", ...run("toolu_7", { source: "main", findings: [finding("f1", "api/Svc.java")] }) });
    expect(useStore.getState().flow.runs.map((r) => r.prereviewId)).toEqual(["toolu_7", "pr-1"]);
    snapshot({ prereviews: [] }); // the same list as before ([] → []): the events stay
    expect(useStore.getState().flow.runs).toHaveLength(2);
    snapshot({ prereviews: [run("pr-1", { findings: [] })] });
    expect(useStore.getState().flow.runs.map((r) => r.prereviewId)).toEqual(["pr-1"]);
    snapshot({ prereviews: [] });
    expect(useStore.getState().flow.runs).toEqual([]);
    expect(useStore.getState().transcript).toEqual([]);
  });

  it("§36.13 refusals in one line; an engine before §36.13 (no gate.prereviews / unknown_command) turns the button off", async () => {
    const { preReviewBlocker } = await import("./storeFlow");
    respond = () => ({ ok: false, error: "side_limit", code: "side_limit" });
    expect(await useStore.getState().startPreReview("round", undefined, "medium")).toBe(false);
    expect(useStore.getState().flow.preReviewError).toBe("Too many side sessions are running — wait for one to finish");
    expect(preReviewBlocker(useStore.getState().state, useStore.getState().flow)).toBeNull();
    snapshot({ prereviews: undefined });
    expect(preReviewBlocker(useStore.getState().state, useStore.getState().flow)).toBe("This engine does not support it yet — update ReviewGate");
    snapshot({ prereviews: [run("pr-9", { status: "running" })] });
    expect(preReviewBlocker(useStore.getState().state, useStore.getState().flow)).toBe("A pre-review is already running");
    snapshot({ prereviews: [], reviewEndTree: null });
    useStore.setState((s) => ({ state: { ...s.state, gate: { ...s.state.gate, turnEndTree: null } } }));
    expect(preReviewBlocker(useStore.getState().state, useStore.getState().flow)).toBe("There is no review to pre-review yet");
    respond = () => ({ ok: false, error: "unknown command: prereview_start", code: "unknown_command" });
    await useStore.getState().startPreReview("round", undefined, "medium");
    expect(useStore.getState().flow.preReviewSupported).toBe(false);
  });

  it("§36.13 dismiss is at once; a refusal brings the finding back; an already-gone one stays gone", async () => {
    snapshot({ prereviews: [run("pr-1", { findings: [finding("f1", "api/Svc.java", 42), finding("f2", "api/Svc.java")] })] });
    await useStore.getState().dismissFinding("pr-1", "f1");
    expect(useStore.getState().flow.runs[0]!.findings.map((f) => f.id)).toEqual(["f2"]);
    expect(sent.find((c) => c.type === "prereview_dismiss")).toEqual({ type: "prereview_dismiss", prereviewId: "pr-1", findingId: "f1" });
    respond = () => ({ ok: false, error: "session_running", code: "session_running" });
    await useStore.getState().dismissFinding("pr-1", "f2");
    expect(useStore.getState().flow.runs[0]!.findings.map((f) => f.id)).toEqual(["f2"]);
    expect(useStore.getState().flow.preReviewError).not.toBeNull();
    respond = () => ({ ok: false, error: "unknown_finding", code: "unknown_finding" });
    await useStore.getState().dismissFinding("pr-1", "f2");
    expect(useStore.getState().flow.runs[0]!.findings).toEqual([]);
  });

  it("§36.13 'Add as note' is an ordinary review note on the finding's line, then the finding goes", async () => {
    const f = finding("f1", "api/Svc.java", 42, "NPE");
    snapshot({ prereviews: [run("pr-1", { findings: [f] })] });
    expect(await useStore.getState().addFindingAsNote("pr-1", f, "return tenant.get();")).toBe(true);
    expect(sent.find((c) => c.type === "add_note")).toEqual({ type: "add_note", path: "api/Svc.java", line: 42, side: "new", excerpt: "return tenant.get();", body: "NPE\nscenario f1" });
    expect(useStore.getState().flow.runs[0]!.findings).toEqual([]);
    const g = finding("f3", "api/Svc.java");
    snapshot({ prereviews: [run("pr-1", { findings: [g] })] });
    respond = (c) => (c.type === "add_note" ? { ok: false, error: "session_running", code: "session_running" } : { ok: true, reply: { type: "result", ok: true } });
    expect(await useStore.getState().addFindingAsNote("pr-1", g, "")).toBe(false);
    expect(useStore.getState().flow.runs[0]!.findings.map((x) => x.id)).toEqual(["f3"]);
  });

  it("a new project forgets the flow state", async () => {
    snapshot({ prereviews: [run("pr-1", { findings: [finding("f1", "a.ts")] })] });
    expect(useStore.getState().flow.runs).toHaveLength(1);
    snapshot({ path: "/other", prereviews: undefined });
    expect(useStore.getState().flow.runs).toEqual([]);
    expect(useStore.getState().flow.create).toBeNull();
  });

  // ---------------------------------------------------------------- settings

  it("the flow settings are saved for the repository (its main worktree), shared by its workbenches", async () => {
    snapshot({ path: "/wt/acme-4790", workbenches: [wb("/repo", "develop", { isMain: true }), wb("/wt/acme-4790", "feature/acme/4790", { isCurrent: true })] });
    await useStore.getState().saveFlowSettings({ commitTemplate: "#acme/{issue}: ", prRespondCommand: " /acme-tools:review-reply {pr} ", workbenchSetup: { copy: ["mvnw"], setupCommand: "./mvnw -q compile" }, preReviewEffort: "high" });
    const patch = savedPatches.at(-1)!;
    expect(patch["projectCommitTemplate"]).toEqual({ [projectRootHash("/repo")]: "#acme/{issue}: " });
    expect(patch["projectPrRespondCommand"]).toEqual({ [projectRootHash("/repo")]: "/acme-tools:review-reply {pr}" });
    expect(patch["projectWorkbenchSetup"]).toEqual({ [projectRootHash("/repo")]: { copy: ["mvnw"], useWorktreeInclude: true, setupCommand: "./mvnw -q compile", fetchBase: true, location: "managed" } });
    expect(patch["preReviewEffort"]).toBe("high");
    // back to the defaults / empty: the entry goes
    await useStore.getState().saveFlowSettings({ workbenchSetup: {}, commitTemplate: "  " });
    expect(savedPatches.at(-1)).toEqual({ projectWorkbenchSetup: {}, projectCommitTemplate: {} });
  });

  // ---------------------------------------------------------------- §36.14

  it("§36.14 'Send to Claude' goes to the PR head's workbench window when one is open, else this composer", async () => {
    const comments: PRComment[] = [{ id: 1, path: "api/Svc.java", line: 42, side: "RIGHT", startLine: null, body: "NPE when tenant is null", author: "review-bot[bot]", createdAt: "2026-10-23T03:00:00Z", inReplyTo: null, diffHunk: "@@" }];
    snapshot({ workbenches: [wb("/repo", "develop", { isMain: true, isCurrent: true }), wb("/wt/acme-4790", "feature/acme/4790")] });
    useStore.setState((s) => ({
      settings: { ...s.settings!, projectPrRespondCommand: { [projectRootHash("/repo")]: "/acme-tools:review-reply {pr}" } },
      state: { ...s.state, pr: { ...s.state.pr, selected: { number: 512, title: "장바구니 정리", body: "", author: "yoon", state: "OPEN", url: "u", headRefName: "feature/acme/4790", baseRefName: "develop", headRefOid: "abc", reviewDecision: "", additions: 1, deletions: 0, changedFiles: 1 }, comments } },
      tab: "prs",
    }));
    const { prThreads } = await import("./prClaude");
    windowFor = (p) => p === "/wt/acme-4790";
    expect(await useStore.getState().sendPrThreads(prThreads(comments))).toBe("workbench");
    expect(composed).toHaveLength(1);
    expect(composed[0]!.path).toBe("/wt/acme-4790");
    expect(composed[0]!.text.startsWith("/acme-tools:review-reply 512\n\n")).toBe(true);
    expect(useStore.getState().tab).toBe("prs");
    // no window has that workbench open: this window's composer, the chat comes forward — nothing is sent
    windowFor = () => false;
    expect(await useStore.getState().sendPrThreads(prThreads(comments))).toBe("this");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain("- api/Svc.java:42 — @review-bot[bot]:\n  > NPE when tenant is null");
    expect(useStore.getState().tab).toBe("changes");
    expect(sent.some((c) => c.type === "send")).toBe(false);
  });
});
