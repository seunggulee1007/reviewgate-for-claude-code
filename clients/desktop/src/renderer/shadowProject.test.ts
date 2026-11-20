/**
 * docs/PROTOCOL.md §59 — a folder tracked without git (`project.vcs = "shadow"`): what needs a real repository is hidden
 * (the PRs tab, the branch line) or disabled with the reason (Commit, a plan into a workbench), and the store never sends a
 * command the engine would refuse `not_a_git_repo`. Rendered to static HTML with the engine bridge mocked; English.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

const sent: EngineCommand[] = [];

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    rg: {
      send: (c: EngineCommand) => void sent.push(c),
      request: async (c: EngineCommand) => void sent.push(c),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return { ok: true, reply: { type: "result", ok: true } };
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  const { useStore } = await import("./store");
  const { Sidebar } = await import("./components/Sidebar");
  const { ChangedFiles } = await import("./components/ChangedFiles");
  const { PlanApproveButtons } = await import("./components/chat/PlanReviewDialog");
  const { commitLockReason } = await import("./commitLock");
  return { useStore, Sidebar, ChangedFiles, PlanApproveButtons, commitLockReason };
}
type Loaded = Awaited<ReturnType<typeof load>>;
let L: Loaded;

const shadowProject = { path: "C:/Users/dev/notes", root: "C:/Users/dev/notes", name: "notes", branch: null, remoteURL: null, vcs: "shadow" };
const gitProject = { path: "C:/work/acme", root: "C:/work/acme", name: "acme", branch: "main", remoteURL: "https://example.com/acme.git", vcs: "git" };
const pendingFile = { path: "notes.md", oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false, tools: ["Edit"], toolUseIds: ["toolu_1"], state: "pending", noteCount: 0, origin: "tool" };

/** The opening tag of the element with `testId`. */
const tag = (out: string, testId: string): string => {
  const at = out.indexOf(`data-testid="${testId}"`);
  if (at < 0) return "";
  return out.slice(out.lastIndexOf("<", at), out.indexOf(">", at) + 1);
};

/** A server render reads the store's initial state: the scene is set on that object (and on the live one). */
function scene(project: object | null, over: Partial<ReviewState> = {}) {
  const init = L.useStore.getInitialState();
  const state = { ...base, project, changedFiles: [pendingFile], ...over } as unknown as ReviewState;
  Object.assign(init, { state, tab: "changes", dialog: null });
  L.useStore.setState({ state, tab: "changes", dialog: null });
}
let base: ReviewState;

describe("a folder tracked without git (§59)", () => {
  beforeAll(async () => {
    initI18n("en", "win32");
    L = await load();
    base = L.useStore.getInitialState().state;
  });
  afterAll(() => {
    Object.assign(L.useStore.getInitialState(), { state: base });
    initI18n("en", "darwin");
  });
  beforeEach(() => {
    sent.length = 0;
  });

  it("the sidebar: no PRs tab, no branch / remote line — one calm line with a tooltip instead", () => {
    scene(shadowProject);
    const out = renderToStaticMarkup(createElement(L.Sidebar));
    expect(out).not.toContain('data-testid="PRs tab"');
    expect(out).not.toContain('data-testid="Branch switcher"');
    expect(out).not.toContain('data-testid="Project remote"');
    expect(out).toContain("Not a git repository — changes tracked by ReviewGate");
    expect(tag(out, "Not a git repository")).toContain("hidden copy outside this folder");
    expect(out).toContain('data-testid="History tab"');
  });

  it("a repository keeps the PRs tab and the branch line", () => {
    scene(gitProject);
    const out = renderToStaticMarkup(createElement(L.Sidebar));
    expect(out).toContain('data-testid="PRs tab"');
    expect(out).toContain('data-testid="Branch switcher"');
    expect(out).not.toContain('data-testid="Not a git repository"');
  });

  it("Commit stays, disabled, with the reason; a repository's Commit opens (pending files are committed from the dialog)", () => {
    scene(shadowProject);
    const commit = tag(renderToStaticMarkup(createElement(L.ChangedFiles)), "Commit accepted");
    expect(commit).toContain('disabled=""');
    expect(commit).toContain('title="This folder is not a git repository"');
    scene(gitProject);
    expect(tag(renderToStaticMarkup(createElement(L.ChangedFiles)), "Commit accepted")).not.toContain('disabled=""');
    expect(L.commitLockReason({ gate: base.gate, project: shadowProject } as unknown as ReviewState)).toBe("This folder is not a git repository");
    expect(L.commitLockReason({ gate: base.gate })).toBeNull();
  });

  it("a plan cannot go into a new workbench — the button says why; the other answers stay", () => {
    scene(shadowProject);
    const answers = { approve: () => undefined, newChat: () => undefined, workbench: () => undefined };
    const out = renderToStaticMarkup(createElement(L.PlanApproveButtons, { busy: false, handoffBlocker: null, answers }));
    expect(tag(out, "Approve plan new workbench")).toContain('disabled=""');
    expect(tag(out, "Approve plan new workbench")).toContain('title="This folder is not a git repository"');
    expect(tag(out, "Approve plan new chat")).not.toContain('disabled=""');
    expect(tag(out, "Approve plan")).not.toContain('disabled=""');
  });

  it("the store sends nothing the engine would refuse: branch / workbench / PR refreshes, commit, push", async () => {
    scene(shadowProject);
    const s = L.useStore.getState();
    await s.refreshBranches();
    await s.refreshWorkbenches();
    await s.pruneWorkbenches();
    await s.switchBranch("main");
    await s.createBranch("topic");
    await s.prRefresh();
    expect(await s.commitAccepted({ message: "x", paths: ["notes.md"], push: false })).toBe("not_a_git_repo");
    expect(await s.pushNow()).toBe("not_a_git_repo");
    expect(await s.createPR("main", null, null, false)).toBeNull();
    expect(sent).toEqual([]);
  });

  it("the PRs tab and the dialogs that need a repository never open", () => {
    scene(shadowProject);
    const s = L.useStore.getState();
    s.setTab("prs");
    expect(L.useStore.getState().tab).toBe("changes");
    for (const kind of ["commit", "newWorkbench", "newBranch", "createPR"] as const) {
      s.openDialog({ kind });
      expect(L.useStore.getState().dialog, kind).toBeNull();
    }
    s.openDialog({ kind: "rejectAll" });
    expect(L.useStore.getState().dialog).toEqual({ kind: "rejectAll" });
  });

  it("a repository still refreshes its branches and opens its dialogs", async () => {
    scene(gitProject);
    await L.useStore.getState().refreshBranches();
    expect(sent).toEqual([{ type: "branches" }]);
    L.useStore.getState().openDialog({ kind: "commit" });
    expect(L.useStore.getState().dialog).toEqual({ kind: "commit" });
  });
});
