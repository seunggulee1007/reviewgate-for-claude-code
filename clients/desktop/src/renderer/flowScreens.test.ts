/**
 * MARK: wave3 desktop-flow — the §36.11–36.14 screens as they render (react-dom/server, no window): the commit sheet's draft
 * row, the New Workbench sheet with and without an engine that knows §36.12 (and on a PR's head), the create's steps, the
 * new workbench's setup banner, the AI pre-review head / badge / line cards, and the PR tab's Claude buttons. An engine
 * before §36 keeps the old screens (or the control off with its one-line reason).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangedFileState, PRComment, PRDetail, PreReviewRun, ReviewState, WorkbenchInfo } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { projectRootHash } from "../shared/hash";

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setUI: async () => undefined, onEvent: () => () => undefined, platform: "darwin", sep: "/" },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;
let useStore: UseStore;
/** Server rendering reads the store's initial state: it is the current one for the render. */
const html = (el: ReactElement) => {
  Object.assign(useStore.getInitialState(), useStore.getState());
  return renderToStaticMarkup(el);
};

const file = (path: string, p: Partial<ChangedFileState> = {}): ChangedFileState => ({ path, oldPath: null, status: "M", added: 3, deleted: 1, isBinary: false, tools: ["Edit"], toolUseIds: [], state: "pending", noteCount: 0, origin: "tool", ...p });
const wb = (path: string, branch: string, o: Partial<WorkbenchInfo> = {}): WorkbenchInfo => ({ path, branch, head: "abc", isMain: false, isCurrent: false, locked: null, dirty: null, ...o });
const run = (prereviewId: string, o: Partial<PreReviewRun> = {}): PreReviewRun => ({ prereviewId, status: "done", source: "round", endTree: "B1", startedAt: "2026-10-23T03:00:00.000Z", findings: [], ...o });

/** The store as a project view with the §36 fields (`modern`) or as an engine before §36 sent it. */
function setState(o: { modern?: boolean; prereviews?: PreReviewRun[]; files?: ChangedFileState[]; settings?: Record<string, unknown>; workbenches?: WorkbenchInfo[]; pr?: Partial<ReviewState["pr"]> } = {}) {
  const modern = o.modern !== false;
  const s0 = useStore.getState().state;
  // an engine before §36 never sent `gate.prereviews`
  const { prereviews: _older, ...oldGate } = s0.gate;
  const s = { ...s0, gate: oldGate } as ReviewState;
  useStore.setState({
    settings: { appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400, worktreeRoot: "", ...(o.settings ?? {}) } as never,
    selectedPath: null,
    flow: { ...useStore.getState().flow, runs: o.prereviews ?? [] },
    state: {
      ...s,
      project: { path: "/Users/me/acme", root: "/Users/me/acme", name: "acme", branch: "feature/acme/4747", remoteURL: "git@ghe.example.com:acme/app.git" },
      changedFiles: o.files ?? [file("api/Svc.java")],
      gate: { ...s.gate, phase: "reviewing", turnStartTree: "A", turnEndTree: "B1", reviewEndTree: "B1", ...(modern ? { prereviews: o.prereviews ?? [] } : {}) },
      workbenches: { list: o.workbenches ?? [wb("/Users/me/acme", "develop", { isMain: true, isCurrent: true })], current: "/Users/me/acme", managedRoot: "/Users/me/.reviewgate/worktrees" },
      branches: {
        list: [
          { name: "develop", isCurrent: true, upstream: "origin/develop", ahead: 0, behind: 0, lastCommitDate: null },
          { name: "feature/acme/4747", isCurrent: false, upstream: null, ahead: 0, behind: 0, lastCommitDate: null },
        ],
        isWorktreeDirty: false,
        switchBlocker: null,
        ...(modern ? { remotes: [{ name: "origin/develop", isCurrent: false, upstream: null, ahead: 0, behind: 0, lastCommitDate: null, remote: true as const }] } : {}),
      },
      pr: { ...s.pr, ...(o.pr ?? {}) },
    } as ReviewState,
  });
}

describe("§36.11–36.14 screens (wave3 desktop-flow)", () => {
  beforeAll(async () => {
    initI18n("en", "darwin");
    useStore = await loadStore();
  });
  beforeEach(() => setState());

  // ---------------------------------------------------------------- §36.11

  it("§36.11 'Write with Claude' under the message; the template's first line rendered on this branch", async () => {
    const { CommitDraftRow } = await import("./components/flow/CommitDraft");
    setState({ settings: { projectCommitTemplate: { [projectRootHash("/Users/me/acme")]: "#acme/{issue}: [주문]\n\n- …" } } });
    const out = html(createElement(CommitDraftRow, { message: "", onMessage: () => undefined, paths: ["api/Svc.java"] }));
    expect(out).toContain("Write with Claude");
    expect(out).not.toMatch(/data-testid="Write commit message with Claude"[^>]*disabled/);
    expect(out).toContain("#acme/4747: [주문]");
    // no file ticked: off with the reason (the title), nothing hidden
    const none = html(createElement(CommitDraftRow, { message: "", onMessage: () => undefined, paths: [] }));
    expect(none).toMatch(/disabled="" title="Tick at least one accepted file"/);
  });

  it("§36.11 an engine before §36: off with 'update ReviewGate' in one line", async () => {
    const { CommitDraftRow } = await import("./components/flow/CommitDraft");
    useStore.setState((s) => ({ flow: { ...s.flow, draftSupported: false, draftError: "x" } }));
    const out = html(createElement(CommitDraftRow, { message: "", onMessage: () => undefined, paths: ["a"] }));
    expect(out).toContain('data-testid="Commit draft error"');
    expect(out).toContain("This engine does not support it yet — update ReviewGate");
    useStore.setState((s) => ({ flow: { ...s.flow, draftSupported: true, draftError: null } }));
  });

  // ---------------------------------------------------------------- §36.12

  it("§36.12 the sheet with an engine that knows the setup: remote base by default, fetch, folder rule, files to copy", async () => {
    const { NewWorkbenchDialog } = await import("./components/dialogs/NewWorkbenchDialog");
    setState({ settings: { projectWorkbenchSetup: { [projectRootHash("/Users/me/acme")]: { copy: ["mvnw"], setupCommand: "./mvnw -q -o compile" } } } });
    const out = html(createElement(NewWorkbenchDialog, { onClose: () => undefined }));
    expect(out).toContain('<optgroup label="Remote"><option value="origin/develop" selected="">origin/develop</option>');
    expect(out).toContain("Fetch before creating");
    expect(out).toContain("Managed folder");
    expect(out).toContain("Next to the repository");
    expect(out).toContain('data-testid="Workbench setup section"');
    expect(out).toContain("./mvnw -q -o compile");
    expect(out).toContain("Copy the files and run the setup command after creating");
  });

  it("§36.12 'N files will be copied' counts every file (count), not the first 500 the list carries", async () => {
    const { WorkbenchSetupSection } = await import("./components/flow/WorkbenchSetup");
    const props = { setup: { copy: [], useWorktreeInclude: true, setupCommand: "", fetchBase: true, location: "managed" as const }, loading: false, error: null, runSetup: true, onRunSetup: () => undefined, disabled: false };
    const listed = Array.from({ length: 500 }, (_, i) => ({ path: `local/f${i}.yml`, bytes: 10 }));
    expect(html(createElement(WorkbenchSetupSection, { ...props, preview: { type: "workbench_preview", path: "/w", copy: listed, totalBytes: 8120, count: 812, truncated: true } }))).toContain("812 files will be copied");
    // an engine without `count`: the list's length, "+" when it was cut
    expect(html(createElement(WorkbenchSetupSection, { ...props, preview: { type: "workbench_preview", path: "/w", copy: listed, totalBytes: 5000, truncated: true } }))).toContain("500+ files will be copied");
  });

  it("§36.12 an engine before §36.12 (no remotes): the old sheet", async () => {
    const { NewWorkbenchDialog } = await import("./components/dialogs/NewWorkbenchDialog");
    setState({ modern: false });
    const out = html(createElement(NewWorkbenchDialog, { onClose: () => undefined }));
    expect(out).not.toContain("optgroup");
    expect(out).not.toContain("Fetch before creating");
    expect(out).not.toContain("Managed folder");
    expect(out).not.toContain("Workbench setup section");
    // as before: the project's branch first
    expect(out).toContain('<option value="feature/acme/4747" selected="">feature/acme/4747</option>');
    expect(out).toContain("/Users/me/.reviewgate/worktrees/");
  });

  it("§36.14 the sheet on a PR's head: its branch, 'From PR #n', 'Open as workbench'", async () => {
    const { NewWorkbenchDialog } = await import("./components/dialogs/NewWorkbenchDialog");
    const out = html(createElement(NewWorkbenchDialog, { onClose: () => undefined, fromPr: { number: 512, headRef: "feature/acme/4790", baseRef: "develop", title: "장바구니 정리" } }));
    expect(out).toContain("Open PR #512 as a workbench");
    expect(out).toContain('value="feature/acme/4790"');
    expect(out).toContain("PR #512 · feature/acme/4790");
    expect(out).toContain(">Open as workbench</button>");
    expect(out).not.toContain('data-testid="Workbench base"');
  });

  // MARK: §49 Run as Task
  it("§49 the sheet as 'Run as Task': the task, this chat's mode, the branch suggested from the task with the last prefix", async () => {
    const { NewWorkbenchDialog } = await import("./components/dialogs/NewWorkbenchDialog");
    setState({ settings: { taskBranchPrefix: "feature/acme/" } });
    useStore.setState((s) => ({ state: { ...s.state, session: { ...s.state.session, permissionMode: "plan" } } }));
    const out = html(createElement(NewWorkbenchDialog, { onClose: () => undefined, task: "장바구니 합계 오류 https://tasks.example.com/acme/4811\n\n@api/Cart.java" }));
    expect(out).toContain(">Run as Task</h");
    expect(out).toContain('data-testid="Run as Task text"');
    expect(out).toContain("https://tasks.example.com/acme/4811");
    expect(out).toContain('value="feature/acme/4811"');
    expect(out).toMatch(/<option value="plan" selected="">Plan — /);
    expect(out).toContain("its window sends the task in a fresh chat");
    expect(out).toMatch(/<button type="button" class="primary"[^>]*>Run as Task<\/button>/);
    expect(out).not.toMatch(/<button type="button" class="primary" disabled/);
    useStore.setState((s) => ({ state: { ...s.state, session: { ...s.state.session, permissionMode: "default" } } }));
  });

  it("§49 from the menu: an empty task asks for one first (the date as the branch until then)", async () => {
    const { NewWorkbenchDialog } = await import("./components/dialogs/NewWorkbenchDialog");
    setState();
    const out = html(createElement(NewWorkbenchDialog, { onClose: () => undefined, task: "" }));
    expect(out).toContain('data-testid="New workbench hint">Describe the task</div>');
    expect(out).toMatch(/value="task\/\d{8}-\d{4}"/);
    expect(out).toMatch(/<button type="button" class="primary" disabled=""[^>]*>Run as Task<\/button>/);
    // a plain New Workbench is unchanged
    expect(html(createElement(NewWorkbenchDialog, { onClose: () => undefined }))).not.toContain("Run as Task");
  });

  it("§36.12 the steps while creating, the latest log; a failed setup's banner in the new window", async () => {
    const { WorkbenchProgressView, WorkbenchSetupBanner } = await import("./components/flow/WorkbenchSetup");
    const p = (step: "fetch" | "create" | "setup", extra = {}) => ({ type: "workbench_progress" as const, path: "/w/acme-4790", branch: "b", step, ...extra });
    const out = html(createElement(WorkbenchProgressView, { progress: [p("fetch", { exitCode: 0 }), p("create"), p("setup", { logTail: "[INFO] Compiling 120 files\n" })], running: true }));
    expect(out).toContain('class="wb-step done" data-testid="Workbench step fetch"');
    expect(out).toContain('data-testid="Workbench step setup"');
    expect(out).toContain('class="wb-step pending" data-testid="Workbench step done"');
    expect(out).toContain("[INFO] Compiling 120 files");
    useStore.setState((s) => ({ flow: { ...s.flow, setupReport: { branch: "b", exitCode: 1, log: "[ERROR] BUILD FAILURE" } } }));
    const banner = html(createElement(WorkbenchSetupBanner));
    expect(banner).toContain("The setup command of this workbench failed (exit 1). The workbench is ready otherwise — fix it in a terminal.");
    expect(banner).toContain("[ERROR] BUILD FAILURE");
    useStore.setState((s) => ({ flow: { ...s.flow, setupReport: null } }));
    expect(html(createElement(WorkbenchSetupBanner))).toBe("");
  });

  // ---------------------------------------------------------------- §36.13

  const finding = (id: string, line: number | null, o: Record<string, unknown> = {}) => ({ id, file: "api/Svc.java", line, summary: `summary ${id}`, shortSummary: `short ${id}`, failureScenario: `scenario ${id}`, ...o });

  it("§36.13 the Changes head: running with cancel, then 'N findings' (a chip for an earlier B), failed with the reason", async () => {
    const { PreReviewHead } = await import("./components/flow/PreReview");
    setState({ prereviews: [run("pr-1", { status: "running" })] });
    let out = html(createElement(PreReviewHead));
    expect(out).toContain("Pre-reviewing…");
    expect(out).toContain('data-testid="Cancel pre-review"');
    expect(out).toMatch(/disabled="" title="A pre-review is already running"[^>]*data-testid="AI pre-review"/);
    setState({ prereviews: [run("pr-1", { findings: [finding("f1", 42), finding("f2", null)] })] });
    out = html(createElement(PreReviewHead));
    expect(out).toContain("2 findings");
    expect(out).not.toContain("Earlier version");
    setState({ prereviews: [run("pr-1", { endTree: "B0", findings: [finding("f1", 42)] })] });
    expect(html(createElement(PreReviewHead))).toContain("Earlier version");
    setState({ prereviews: [run("pr-1", { status: "failed", error: "side_limit" })] });
    expect(html(createElement(PreReviewHead))).toContain("Failed: Too many side sessions are running — wait for one to finish");
  });

  it("§36.13 an engine before §36.13: the button is off with the reason on screen (one line)", async () => {
    const { PreReviewHead } = await import("./components/flow/PreReview");
    setState({ modern: false });
    const out = html(createElement(PreReviewHead));
    expect(out).toMatch(/disabled="" title="This engine does not support it yet — update ReviewGate"[^>]*data-testid="AI pre-review"/);
    expect(out).toContain('data-testid="Pre-review notice"');
    // nothing to review and no runs: no head at all (as before)
    setState({ files: [] });
    expect(html(createElement(PreReviewHead))).toBe("");
  });

  it("§36.13 a badge per file; a mark at the end of the finding's line and its card under it; the rest above the diff", async () => {
    const { PreReviewBadge, PreReviewUnplaced } = await import("./components/flow/PreReview");
    const { UnifiedView } = await import("./components/diff/UnifiedView");
    setState({ prereviews: [run("toolu_9", { source: "main", findings: [finding("f3", 2)] }), run("pr-1", { findings: [finding("f1", 2, { category: "correctness" }), finding("f2", null)] })] });
    expect(html(createElement(PreReviewBadge, { path: "api/Svc.java" }))).toContain("✦ 3");
    expect(html(createElement(PreReviewBadge, { path: "other.ts" }))).toBe("");
    const diff = {
      oldPath: "api/Svc.java",
      newPath: "api/Svc.java",
      isBinary: false,
      hunks: [
        {
          id: 0,
          header: "@@ -1,2 +1,2 @@",
          lines: [
            { id: 0, kind: "hunkHeader" as const, oldNo: null, newNo: null, text: "@@ -1,2 +1,2 @@" },
            { id: 1, kind: "context" as const, oldNo: 1, newNo: 1, text: "class Svc {" },
            { id: 2, kind: "del" as const, oldNo: 2, newNo: null, text: "  return tenant;" },
            { id: 3, kind: "add" as const, oldNo: null, newNo: 2, text: "  return tenant.get();" },
          ],
        },
      ],
    };
    const noop = () => undefined;
    const view = html(createElement(UnifiedView, { diff, notes: [], composer: null, onOpenComposer: noop, onCloseComposer: noop, onAddNote: noop, onRemoveNote: noop, path: "api/Svc.java" }));
    expect((view.match(/data-testid="Pre-review line mark"/g) ?? []).length).toBe(1);
    expect(view).toContain('class="line add prereview-line"');
    expect(view).toContain('data-testid="Pre-review finding f1"');
    expect(view).toContain('data-testid="Pre-review finding f3"');
    expect(view).toContain("From the chat");
    expect(view).toContain("correctness");
    expect(view).toContain("Ask in a side thread");
    expect(view).toContain(">Dismiss finding</button>");
    expect(view).not.toContain('data-testid="Pre-review finding f2"'); // the whole-file one sits above the diff
    const above = html(createElement(PreReviewUnplaced, { path: "api/Svc.java", diff, placesLines: true }));
    expect(above).toContain('data-testid="Pre-review finding f2"');
    expect(above).toContain("whole file");
    expect(above).not.toContain('data-testid="Pre-review finding f1"');
    // the full-file view places no line: every finding of the file
    expect((html(createElement(PreReviewUnplaced, { path: "api/Svc.java", diff, placesLines: false })).match(/data-testid="Pre-review finding f/g) ?? []).length).toBe(3);
  });

  // ---------------------------------------------------------------- §36.14

  const prDetail: PRDetail = { number: 512, title: "장바구니 정리", body: "", author: "kim", state: "OPEN", url: "https://ghe.example.com/acme/app/pull/512", headRefName: "feature/acme/4790", baseRefName: "develop", headRefOid: "abc123", reviewDecision: "", additions: 3, deletions: 1, changedFiles: 1 };
  const comment = (id: number, author: string, o: Partial<PRComment> = {}): PRComment => ({ id, path: "api/Svc.java", line: 42, side: "RIGHT", startLine: null, body: "NPE when tenant is null", author, createdAt: `2026-10-23T03:0${id}:00Z`, inReplyTo: null, diffHunk: "@@", ...o });
  const prState = (o: { repo?: string; workbenches?: WorkbenchInfo[]; comments?: PRComment[]; modern?: boolean } = {}) =>
    setState({
      modern: o.modern,
      workbenches: o.workbenches,
      pr: {
        host: "ghe.example.com",
        accounts: [{ host: "ghe.example.com", login: "yoon", ok: true, detail: "" }],
        selectedSummary: { number: 512, title: "장바구니 정리", repo: o.repo ?? "acme/app", host: "ghe.example.com", author: "kim", updatedAt: "", url: "", isDraft: false },
        selected: prDetail,
        comments: o.comments ?? [comment(1, "review-bot[bot]"), comment(2, "yoon", { inReplyTo: 1 }), comment(3, "kim", { path: "api/Repo.java", line: 10 })],
      },
    });

  it("§36.14 the PR head: 'Open as workbench' for this repository, 'Send all unresolved' with the count of threads still waiting", async () => {
    const { PRClaudeHeaderButtons } = await import("./components/flow/PRClaude");
    prState();
    const out = html(createElement(PRClaudeHeaderButtons, { pr: prDetail }));
    expect(out).toMatch(/title="Checks out the PR&#x27;s head in a workbench of its own \(with the repository&#x27;s Workbench setup\)" data-testid="Open PR as workbench">Open as workbench/);
    // thread 1's last word is the user's: only thread 3 waits
    expect(out).toContain('Send all unresolved<span class="count num">1</span>');
    expect(out).toContain("Claude&#x27;s message box in this window");
  });

  it("§36.14 off with the reason: another repository, an engine before §36.12, nothing unresolved; an existing workbench is offered instead", async () => {
    const { PRClaudeHeaderButtons } = await import("./components/flow/PRClaude");
    prState({ repo: "acme/other" });
    expect(html(createElement(PRClaudeHeaderButtons, { pr: prDetail }))).toMatch(/disabled="" title="This PR is not of the open project&#x27;s repository \(acme\/other\)"/);
    prState({ modern: false });
    expect(html(createElement(PRClaudeHeaderButtons, { pr: prDetail }))).toMatch(/disabled="" title="This engine does not support it yet — update ReviewGate" data-testid="Open PR as workbench"/);
    prState({ comments: [comment(1, "kim"), comment(2, "yoon", { inReplyTo: 1 })] });
    expect(html(createElement(PRClaudeHeaderButtons, { pr: prDetail }))).toMatch(/disabled="" title="No unresolved comments — every thread&#x27;s last word is yours" data-testid="Send all unresolved"/);
    prState({ workbenches: [wb("/Users/me/acme", "develop", { isMain: true, isCurrent: true }), wb("/w/acme-4790", "feature/acme/4790")] });
    const out = html(createElement(PRClaudeHeaderButtons, { pr: prDetail }));
    expect(out).toContain('data-testid="Open PR workbench">Open workbench</button>');
    expect(out).toContain("Claude&#x27;s message box in the feature/acme/4790 workbench window");
  });

  it("§36.14 'Send to Claude' on a comment; a PR anchor names the PR in the side question", async () => {
    const { SendCommentButton } = await import("./components/flow/PRClaude");
    const { anchorLabel, anchorTitle, sameAnchor } = await import("./sideThreads");
    prState();
    const out = html(createElement(SendCommentButton, { comment: comment(3, "kim") }));
    expect(out).toContain(">Send to Claude</button>");
    expect(out).not.toContain("disabled");
    const pr = { number: 512, path: "api/Svc.java", line: 42, side: "RIGHT" as const, hunk: "@@ -40 +40 @@\n+x\n" };
    expect(anchorLabel({ pr })).toBe("PR #512 · api/Svc.java:42");
    expect(anchorTitle({ pr })).toBe("PR #512 api/Svc.java:42 (RIGHT)");
    expect(sameAnchor({ pr }, { pr: { ...pr, hunk: "other" } })).toBe(true);
    expect(sameAnchor({ pr }, null)).toBe(false);
    expect(sameAnchor({ pr }, { pr: { ...pr, line: 43 } })).toBe(false);
  });

  it("Settings › Project: the repository's template, workbench setup and PR command (named after its main worktree)", async () => {
    const { ProjectTab } = await import("./components/settings/ProjectTab");
    const h = projectRootHash("/repo");
    setState({
      workbenches: [wb("/repo", "develop", { isMain: true }), wb("/Users/me/acme", "feature/acme/4747", { isCurrent: true })],
      settings: { projectCommitTemplate: { [h]: "#acme/{issue}: " }, projectPrRespondCommand: { [h]: "/acme-tools:review-reply {pr}" }, projectWorkbenchSetup: { [h]: { copy: ["mvnw", ".mvn/**"], location: "sibling" } } },
    });
    const out = html(createElement(ProjectTab));
    expect(out).toContain("Settings of repo — every workbench of this repository uses them.");
    expect(out).toContain("#acme/{issue}: </textarea>");
    expect(out).toContain("#acme/4747: ");
    expect(out).toContain("mvnw\n.mvn/**</textarea>");
    expect(out).toContain('<option value="sibling" selected="">Next to the repository</option>');
    expect(out).toContain('value="/acme-tools:review-reply {pr}"');
    useStore.setState((s) => ({ state: { ...s.state, project: null } }));
    expect(html(createElement(ProjectTab))).toContain("Open a project to edit the settings of its repository.");
  });

  it("§36.13 'Add as note' waits while Claude works on a change request, with the reason", async () => {
    const { PreReviewCards } = await import("./components/flow/PreReview");
    const { findingsOfFile } = await import("./preReview");
    setState({ prereviews: [run("pr-1", { findings: [finding("f1", 2)] })] });
    useStore.setState((s) => ({ state: { ...s.state, gate: { ...s.state.gate, phase: "running", isRequestingChanges: true } } }));
    const out = html(createElement(PreReviewCards, { items: findingsOfFile(useStore.getState().flow.runs, "api/Svc.java"), excerpt: "x" }));
    expect(out).toMatch(/disabled="" title="Claude is working…"[^>]*data-testid="Pre-review add as note"/);
  });

  // ---------------------------------------------------------------- §51

  it("§51 the PR sheet: every field has its name on screen (a <label>), 'Fill with Claude' under the body with its help", async () => {
    const { CreatePRDialog } = await import("./components/dialogs/CreatePRDialog");
    const out = html(createElement(CreatePRDialog, { onClose: () => undefined }));
    for (const [name, id] of [["Base", "PR base"], ["Title", "PR title"], ["Body", "PR body"], ["Assignees", "PR assignees"], ["Labels", "PR labels"], ["Reviewers", "PR reviewers"], ["Projects", "PR projects"]]) {
      expect(out).toMatch(new RegExp(`<label class="field(?:-row)?"><span>${name}</span><(?:select|input|textarea)[^>]*data-testid="${id}"`));
    }
    expect(out.indexOf('data-testid="PR body"')).toBeLessThan(out.indexOf('data-testid="Fill PR with Claude"'));
    expect(out.indexOf('data-testid="Fill PR with Claude"')).toBeLessThan(out.indexOf('data-testid="PR assignees"'));
    expect(out).toContain("Fill with Claude");
    expect(out).not.toMatch(/disabled=""[^>]*data-testid="Fill PR with Claude"/);
    expect(out).toContain("in a read-only side session; the main chat is untouched and nothing is pushed or created");
    expect(out).not.toContain('data-testid="PR fill progress"');
    expect(out).not.toContain('data-testid="Restore PR text"');
  });
});
