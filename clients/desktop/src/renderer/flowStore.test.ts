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
const leftComposer: string[] = []; // MARK: §49 the task texts that left the composer
vi.mock("./composerBridge", () => ({
  insertIntoComposer: (text: string) => {
    inserted.push(text);
    return false;
  },
  joinDraft: (d: string, text: string) => (d ? `${d}\n\n${text}` : text),
  useComposerInsert: () => undefined,
  taskLeftComposer: (text: string) => void leftComposer.push(text),
  useTaskLeftComposer: () => undefined,
}));

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[]; partial?: unknown };
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
        project: { path, root: path, name: "repo", branch: "feature/PAY-1502", remoteURL: "git@ghe.example.com:acme/app.git" },
        changedFiles: [{ path: "api/Svc.java", oldPath: null, status: "M", added: 3, deleted: 1, isBinary: false, tools: ["Edit"], toolUseIds: [], state: "pending", noteCount: 0, origin: "tool" }],
        gate: { ...s.gate, phase: "reviewing", turnStartTree: "A", turnEndTree: "B1", reviewEndTree: patch.reviewEndTree === undefined ? "B1" : patch.reviewEndTree, ...("prereviews" in patch ? { prereviews: patch.prereviews } : { prereviews: [] }) },
        workbenches: { list: patch.workbenches ?? [wb(path, "feature/PAY-1502", { isMain: true, isCurrent: true })], current: path, managedRoot: "/wt" },
        branches: { ...s.branches, ...(patch.remotes === false ? { remotes: undefined } : { remotes: [{ name: "origin/develop", isCurrent: false, upstream: null, ahead: 0, behind: 0, lastCommitDate: null, remote: true }] }) },
      } as ReviewState,
    });
  };

  beforeEach(() => {
    sent.length = 0;
    opened.length = 0;
    composed.length = 0;
    inserted.length = 0;
    leftComposer.length = 0;
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
    respond = (c) => (c.type === "commit_draft" ? { ok: true, reply: { type: "commit_draft", id: "c4", message: "  PAY-1502: 재고 동기화 - 중복 차감 방지\n\n- 같은 주문의 재고를 두 번 차감하던 조건 수정\n " } } : { ok: true, reply: { type: "result", ok: true } });
    const message = await useStore.getState().draftCommitMessage(["api/Svc.java"]);
    expect(message).toBe("PAY-1502: 재고 동기화 - 중복 차감 방지\n\n- 같은 주문의 재고를 두 번 차감하던 조건 수정");
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

  // ---------------------------------------------------------------- §53

  it("§53 commit_hunks / commit_split_draft / commit_series: commands as sent, replies as the split sheet reads them", async () => {
    respond = (c) => {
      if (c.type === ("commit_hunks" as string)) return { ok: true, reply: { type: "commit_hunks", files: [{ path: "a.ts", status: "M", binary: false, hunks: [] }] } };
      if (c.type === ("commit_split_draft" as string)) return { ok: true, reply: { type: "commit_split_draft", commits: [{ message: "a", parts: [{ path: "a.ts" }], why: "w" }], unassigned: [{ path: "b.ts" }] } };
      return { ok: true, reply: { type: "committed_series", commits: [{ sha: "abc1234567", shortSha: "abc1234", message: "a", files: ["a.ts"] }], branch: "main", pushed: true } };
    };
    expect(await useStore.getState().loadCommitHunks(["a.ts"])).toMatchObject({ ok: true, files: [{ path: "a.ts" }] });
    expect(await useStore.getState().splitCommitWithClaude(["a.ts"])).toMatchObject({ ok: true, unassigned: [{ path: "b.ts" }] });
    expect(useStore.getState().flow.splitting).toBe(false);
    const plan = [{ message: "a", parts: [{ path: "a.ts" }] }];
    expect(await useStore.getState().commitSeries(plan, true)).toMatchObject({ ok: true, pushed: true, made: [{ shortSha: "abc1234" }] });
    expect(sent.filter((c) => String(c.type).startsWith("commit_")).slice(-3)).toEqual([
      { type: "commit_hunks", paths: ["a.ts"] },
      { type: "commit_split_draft", paths: ["a.ts"] },
      { type: "commit_series", commits: plan, push: true },
    ]);
  });

  it("§53 refusals keep their words; an engine before §53 is unsupported; a partial series reports what it made", async () => {
    respond = () => ({ ok: false, error: "unknown command: commit_hunks", code: "unknown_command" });
    expect(await useStore.getState().loadCommitHunks()).toEqual({ ok: false, error: "unknown command: commit_hunks", unsupported: true });
    respond = () => ({ ok: false, error: "commit_split_failed:the fork answered nothing", code: "commit_split_failed" });
    expect(await useStore.getState().splitCommitWithClaude()).toMatchObject({ ok: false, error: "commit_split_failed:the fork answered nothing", unsupported: false });
    respond = () => ({ ok: false, error: "commit_failed:hook failed", code: "commit_failed" });
    expect(await useStore.getState().commitSeries([{ message: "a", parts: [{ path: "a" }] }], false)).toEqual({ ok: false, error: "commit_failed:hook failed", made: [] });
    // §53: a series that stopped in the middle reports what it made on the refused result itself
    const partial = { commits: [{ sha: "s", shortSha: "s1", message: "m", files: ["a"] }], branch: "x", pushed: false as const };
    respond = () => ({ ok: false, error: "commit_failed:hook failed", code: "commit_failed", partial });
    expect(await useStore.getState().commitSeries([{ message: "a", parts: [{ path: "a" }] }, { message: "b", parts: [{ path: "b" }] }], false)).toEqual({ ok: false, error: "commit_failed:hook failed", made: partial.commits });
    // the next series does not inherit it
    respond = () => ({ ok: false, error: "commit_failed:hook failed", code: "commit_failed" });
    expect(await useStore.getState().commitSeries([{ message: "a", parts: [{ path: "a" }] }], false)).toMatchObject({ ok: false, made: [] });
    expect(useStore.getState().flow.splitting).toBe(false);
  });

  // ---------------------------------------------------------------- §51

  it("§51 Fill with Claude sends pr_ai_draft with the sheet's title / description only when non-empty; the reply comes back trimmed", async () => {
    respond = (c) => (c.type === "pr_ai_draft" ? { ok: true, reply: { type: "pr_ai_draft", id: "p1", title: " PAY-42: 재고 동기화 ", body: "\n## 요약\n- 중복 차감 방지\n" } } : { ok: true, reply: { type: "result", ok: true } });
    expect(await useStore.getState().fillPRWithClaude("develop", { title: "PAY-42: 재고", body: "  " })).toEqual({ ok: true, title: "PAY-42: 재고 동기화", body: "## 요약\n- 중복 차감 방지" });
    expect(await useStore.getState().fillPRWithClaude("develop", { title: "", body: "- 메모" })).toMatchObject({ ok: true });
    expect(await useStore.getState().fillPRWithClaude("main", { title: "", body: "" })).toMatchObject({ ok: true });
    expect(sent.filter((c) => c.type === "pr_ai_draft")).toEqual([
      { type: "pr_ai_draft", base: "develop", title: "PAY-42: 재고" },
      { type: "pr_ai_draft", base: "develop", body: "- 메모" },
      { type: "pr_ai_draft", base: "main" },
    ]);
    // nothing is pushed or created, the main chat is untouched
    expect(sent.some((c) => c.type === "pr_create" || c.type === "send")).toBe(false);
    expect(useStore.getState().transcript).toEqual([]);
    // an answer without a title: "" (the sheet keeps its own)
    respond = () => ({ ok: true, reply: { type: "pr_ai_draft", title: "", body: "- 재고 동기화" } });
    expect(await useStore.getState().fillPRWithClaude("develop", { title: "", body: "" })).toEqual({ ok: true, title: "", body: "- 재고 동기화" });
  });

  it("§51 a refusal is one line; no base is said without asking; an engine before §51 is unsupported", async () => {
    respond = () => ({ ok: false, error: "pr_ai_draft_failed:no commits since origin/main", code: "pr_ai_draft_failed" });
    expect(await useStore.getState().fillPRWithClaude("main", { title: "", body: "" })).toEqual({ ok: false, error: "Claude could not fill in the PR: no commits since origin/main", unsupported: false });
    respond = () => ({ ok: true, reply: { type: "pr_ai_draft", title: " ", body: "" } });
    expect(await useStore.getState().fillPRWithClaude("main", { title: "", body: "" })).toEqual({ ok: false, error: "Claude could not fill in the PR", unsupported: false });
    respond = () => ({ ok: false, error: "empty base", code: "empty_base" });
    expect(await useStore.getState().fillPRWithClaude("main", { title: "", body: "" })).toEqual({ ok: false, error: "Choose a base branch first", unsupported: false });
    sent.length = 0;
    expect(await useStore.getState().fillPRWithClaude("  ", { title: "x", body: "" })).toEqual({ ok: false, error: "Choose a base branch first", unsupported: false });
    expect(sent).toEqual([]);
    respond = () => ({ ok: false, error: "unknown command: pr_ai_draft", code: "unknown_command" });
    expect(await useStore.getState().fillPRWithClaude("main", { title: "", body: "" })).toEqual({ ok: false, error: "This engine does not support it yet — update ReviewGate", unsupported: true });
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
    useStore.getState().requestWorkbenchPreview({ branch: "feature/PAY-1600", from: "origin/develop", location: "sibling" }, 0);
    await flush();
    release!();
    await flush();
    const f = useStore.getState().flow;
    expect(f.preview?.path).toBe("/x/feature/PAY-1600-sibling");
    expect(f.previewKey).toBe(JSON.stringify(["feature/PAY-1600", "origin/develop", "sibling"]));
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
    const created = useStore.getState().createWorkbenchWith({ branch: "feature/PAY-1600", from: "origin/develop", fetch: true, setup: true, location: "sibling" });
    await flush();
    expect(sent.find((c) => c.type === "workbench_create")).toEqual({ type: "workbench_create", branch: "feature/PAY-1600", from: "origin/develop", fetch: true, setup: true, location: "sibling" });
    const h = useStore.getState().handleEvent;
    h({ type: "workbench_progress", path: "/Users/me/acme-1600", branch: "feature/PAY-1600", step: "fetch", exitCode: 0 });
    h({ type: "workbench_progress", path: "/Users/me/x", branch: "another", step: "create" });
    h({ type: "workbench_progress", path: "/Users/me/acme-1600", branch: "feature/PAY-1600", step: "create" });
    h({ type: "workbench_progress", path: "/Users/me/acme-1600", branch: "feature/PAY-1600", step: "setup", logTail: "[ERROR] BUILD FAILURE\n", exitCode: 1 });
    h({ type: "workbench_progress", path: "/Users/me/acme-1600", branch: "feature/PAY-1600", step: "done", exitCode: 1 });
    expect(useStore.getState().flow.create?.progress.map((p) => p.step)).toEqual(["fetch", "create", "setup", "done"]);
    expect(useStore.getState().flow.create?.running).toBe(true);
    expect(await useStore.getState().createWorkbenchWith({ branch: "another" })).toBeNull(); // one create at a time
    useStore.getState().openDialog(null); // "Close": the create goes on
    finish!();
    expect(await created).toBe("/Users/me/acme-1600");
    expect(opened).toEqual([{ path: "/Users/me/acme-1600", report: { branch: "feature/PAY-1600", exitCode: 1, log: "[ERROR] BUILD FAILURE" } }]);
    expect(useStore.getState().flow.create).toMatchObject({ running: false, createdPath: "/Users/me/acme-1600", error: null });
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

  // ---------------------------------------------------------------- §49 Run as Task

  it("§49 the task goes out with workbench_create; once created the prefix is remembered and the composer lets the text go", async () => {
    let finish: (() => void) | null = null;
    respond = (c) => (c.type === "workbench_create" ? new Promise((r) => (finish = () => r({ ok: true, reply: { type: "result", ok: true } }))) : { ok: true, reply: { type: "result", ok: true } });
    useStore.setState({ dialog: { kind: "newWorkbench", task: "Fix the cart https://tasks.example.com/acme/1700" } });
    const created = useStore.getState().createWorkbenchWith({ branch: "feature/cart/1700", from: "develop", task: { text: "Fix the cart https://tasks.example.com/acme/1700", mode: "plan" }, handedTask: "Fix the cart https://tasks.example.com/acme/1700" });
    await flush();
    // The composer's text is the sheet's business: only the task goes on the wire.
    expect(sent.find((c) => c.type === "workbench_create")).toEqual({ type: "workbench_create", branch: "feature/cart/1700", from: "develop", task: { text: "Fix the cart https://tasks.example.com/acme/1700", mode: "plan" } });
    useStore.getState().handleEvent({ type: "workbench_progress", path: "/work/acme-1700", branch: "feature/cart/1700", step: "done" });
    expect(leftComposer).toEqual([]); // not before it was created
    finish!();
    expect(await created).toBe("/work/acme-1700");
    expect(savedPatches).toContainEqual({ taskBranchPrefix: "feature/cart/" });
    expect(leftComposer).toEqual(["Fix the cart https://tasks.example.com/acme/1700"]);
    expect(opened).toEqual([{ path: "/work/acme-1700", report: undefined }]);
    expect(useStore.getState().dialog).toBeNull();
    expect(inserted).toEqual([]); // nothing is sent or put back from here
    expect(sent.some((c) => c.type === "send")).toBe(false);
  });

  it("§49 a task from the menu (nothing handed over) leaves the composer alone; a refused one keeps the text and remembers nothing", async () => {
    useStore.setState({ dialog: { kind: "newWorkbench", task: "" } });
    await useStore.getState().createWorkbenchWith({ branch: "hotfix-4802", task: { text: "ABC-4802" } });
    expect(sent.find((c) => c.type === "workbench_create")).toEqual({ type: "workbench_create", branch: "hotfix-4802", task: { text: "ABC-4802" } });
    expect(savedPatches).toContainEqual({ taskBranchPrefix: "" });
    expect(leftComposer).toEqual([]);
    savedPatches = [];
    respond = (c) => (c.type === "workbench_create" ? { ok: false, error: "invalid_task", code: "invalid_task" } : { ok: true, reply: { type: "result", ok: true } });
    useStore.setState({ dialog: { kind: "newWorkbench", task: "x" } });
    expect(await useStore.getState().createWorkbenchWith({ branch: "task/4803", task: { text: " " }, handedTask: " " })).toBeNull();
    expect(useStore.getState().flow.create).toMatchObject({ running: false, error: "Describe the task first (at most 100,000 characters)." });
    respond = (c) => (c.type === "workbench_create" ? { ok: false, error: "task_handoff_failed:EACCES", code: "task_handoff_failed" } : { ok: true, reply: { type: "result", ok: true } });
    expect(await useStore.getState().createWorkbenchWith({ branch: "task/4804", task: { text: "Fix it" }, handedTask: "Fix it" })).toBeNull();
    expect(useStore.getState().flow.create?.error).toBe("The workbench was created, but the task could not be handed to it: EACCES");
    expect(useStore.getState().dialog).toEqual({ kind: "newWorkbench", task: "x" }); // the sheet stays, with the text
    expect(savedPatches).toEqual([]);
    expect(leftComposer).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("§49 task_started: a task sent in a fresh chat stays out of the composer; one the session could not take goes into it, once", () => {
    const h = useStore.getState().handleEvent;
    h({ type: "task_started", text: "Fix the cart", mode: "plan", from: "/work/acme", sent: true });
    expect(inserted).toEqual([]);
    h({ type: "task_started", text: "Fix the cart", mode: "auto", from: "/work/acme", sent: false });
    expect(inserted).toEqual(["Fix the cart"]);
    h({ type: "task_started", text: "", mode: "default", from: "/work/acme", sent: false });
    expect(inserted).toEqual(["Fix the cart"]);
    expect(sent.some((c) => c.type === "send")).toBe(false);
  });

  it("§36.12 a new workbench's window takes its failed setup's report once its project opens", async () => {
    reports = { "/Users/me/acme-1600": { branch: "feature/PAY-1600", exitCode: 2, log: "BUILD FAILURE" } };
    snapshot({ path: "/Users/me/acme-1600" });
    await flush();
    expect(useStore.getState().flow.setupReport).toEqual({ branch: "feature/PAY-1600", exitCode: 2, log: "BUILD FAILURE" });
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
    expect(await useStore.getState().addFindingAsNote("pr-1", f, "return cart.get();")).toBe(true);
    expect(sent.find((c) => c.type === "add_note")).toEqual({ type: "add_note", path: "api/Svc.java", line: 42, side: "new", excerpt: "return cart.get();", body: "NPE\nscenario f1" });
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
    snapshot({ path: "/wt/acme-1600", workbenches: [wb("/repo", "develop", { isMain: true }), wb("/wt/acme-1600", "feature/PAY-1600", { isCurrent: true })] });
    await useStore.getState().saveFlowSettings({ commitTemplate: "PAY-{issue}: ", prRespondCommand: " /acme-tools:review-reply {pr} ", workbenchSetup: { copy: ["mvnw"], setupCommand: "./mvnw -q compile" }, preReviewEffort: "high" });
    const patch = savedPatches.at(-1)!;
    expect(patch["projectCommitTemplate"]).toEqual({ [projectRootHash("/repo")]: "PAY-{issue}: " });
    expect(patch["projectPrRespondCommand"]).toEqual({ [projectRootHash("/repo")]: "/acme-tools:review-reply {pr}" });
    expect(patch["projectWorkbenchSetup"]).toEqual({ [projectRootHash("/repo")]: { copy: ["mvnw"], useWorktreeInclude: true, setupCommand: "./mvnw -q compile", fetchBase: true, location: "managed" } });
    expect(patch["preReviewEffort"]).toBe("high");
    // back to the defaults / empty: the entry goes
    await useStore.getState().saveFlowSettings({ workbenchSetup: {}, commitTemplate: "  " });
    expect(savedPatches.at(-1)).toEqual({ projectWorkbenchSetup: {}, projectCommitTemplate: {} });
  });

  // ---------------------------------------------------------------- §36.14

  it("§36.14 'Send to Claude' goes to the PR head's workbench window when one is open, else this composer", async () => {
    const comments: PRComment[] = [{ id: 1, path: "api/Svc.java", line: 42, side: "RIGHT", startLine: null, body: "NPE when cart is null", author: "review-bot[bot]", createdAt: "2026-10-23T03:00:00Z", inReplyTo: null, diffHunk: "@@" }];
    snapshot({ workbenches: [wb("/repo", "develop", { isMain: true, isCurrent: true }), wb("/wt/acme-1600", "feature/PAY-1600")] });
    useStore.setState((s) => ({
      settings: { ...s.settings!, projectPrRespondCommand: { [projectRootHash("/repo")]: "/acme-tools:review-reply {pr}" } },
      state: { ...s.state, pr: { ...s.state.pr, selected: { number: 512, title: "장바구니 정리", body: "", author: "yoon", state: "OPEN", url: "u", headRefName: "feature/PAY-1600", baseRefName: "develop", headRefOid: "abc", reviewDecision: "", additions: 1, deletions: 0, changedFiles: 1 }, comments } },
      tab: "prs",
    }));
    const { prThreads } = await import("./prClaude");
    windowFor = (p) => p === "/wt/acme-1600";
    expect(await useStore.getState().sendPrThreads(prThreads(comments))).toBe("workbench");
    expect(composed).toHaveLength(1);
    expect(composed[0]!.path).toBe("/wt/acme-1600");
    expect(composed[0]!.text.startsWith("/acme-tools:review-reply 512\n\n")).toBe(true);
    expect(useStore.getState().tab).toBe("prs");
    // no window has that workbench open: this window's composer, the chat comes forward — nothing is sent
    windowFor = () => false;
    expect(await useStore.getState().sendPrThreads(prThreads(comments))).toBe("this");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toContain("- api/Svc.java:42 — @review-bot[bot]:\n  > NPE when cart is null");
    expect(useStore.getState().tab).toBe("changes");
    expect(sent.some((c) => c.type === "send")).toBe(false);
  });
});
