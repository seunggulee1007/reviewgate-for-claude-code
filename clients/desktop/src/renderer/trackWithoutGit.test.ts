/**
 * docs/PROTOCOL.md §59 — the git-init dialog's "Track without git": its screens rendered to static HTML, the store's
 * `trackWithoutGit` through a mocked engine bridge (`folder_unsafe` → ask → resend with `confirm: true`, the size guard's
 * three limits, `track_failed`, another session's lock) and the reopen errors. English, so the words do not wait for ko.json.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineCommand, GitInitState, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

const sent: EngineCommand[] = [];
let answer: (cmd: EngineCommand) => Promise<unknown> = async () => ({ ok: true, reply: { type: "result", ok: true } });
const refuse = (error: string, code: string) => async () => ({ ok: false, error, code });

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => void sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return answer(c);
      },
      focusProjectWindow: async () => false,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "win32",
      sep: "\\",
    },
  };
  const { useStore } = await import("./store");
  const { GitInitView } = await import("./components/dialogs/GitInitDialog");
  const { errorEventText, refusalCodeText } = await import("./errorCodes");
  return { useStore, GitInitView, errorEventText, refusalCodeText };
}
type Loaded = Awaited<ReturnType<typeof load>>;
let L: Loaded;

const gitInit: GitInitState = { path: "C:/Users/dev/notes", candidates: [], looksUnsafe: false };
const noop = () => undefined;
const view = (over: Partial<Parameters<Loaded["GitInitView"]>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(L.GitInitView, {
      gitInit, step: "choose", busy: false, error: null,
      onTrack: noop, onInit: noop, onBack: noop, onOpenCandidate: noop, onChooseAnother: noop, onCancel: noop,
      ...over,
    }),
  );
/** The opening tag of the element with `testId`. */
const tag = (out: string, testId: string): string => {
  const at = out.indexOf(`data-testid="${testId}"`);
  if (at < 0) return "";
  return out.slice(out.lastIndexOf("<", at), out.indexOf(">", at) + 1);
};

describe("the git-init dialog offers Track without git (§59)", () => {
  beforeAll(async () => {
    initI18n("en", "win32");
    L = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    answer = async () => ({ ok: true, reply: { type: "result", ok: true } });
    L.useStore.setState({ state: { ...L.useStore.getState().state, gitInit, project: null } as unknown as ReviewState, dialog: { kind: "gitInit" }, lockedProjectPath: null });
  });

  it("the choices: Track without git first (recommended, explained), then Initialize git here, Choose another folder…, Cancel", () => {
    const out = view({ gitInit: { ...gitInit, candidates: ["C:/Users/dev/notes/app"] } });
    expect(tag(out, "Track without git")).toContain('class="primary"');
    expect(tag(out, "Track without git")).toContain("hidden copy outside this folder");
    expect(out).toContain("Recommended");
    expect(out).toContain("ReviewGate keeps a hidden copy outside this folder to show what Claude changed. The folder itself is not touched; commit, branches, workbenches and PRs are off.");
    expect(out.indexOf('data-testid="Track without git"')).toBeLessThan(out.indexOf('data-testid="Initialize git"'));
    expect(tag(out, "Initialize git")).toContain("title=");
    expect(out).toContain('data-testid="Choose another folder"');
    expect(out).toContain('data-testid="Cancel"');
    expect(out).toContain('data-testid="Git candidate app"');
    expect(out).toContain("C:\\Users\\dev\\notes"); // the OS separator
    expect(out).not.toContain('data-testid="Track without git error"');
  });

  it("busy: every choice waits; a refusal's words show in the dialog", () => {
    const busy = view({ busy: true });
    for (const id of ["Track without git", "Initialize git", "Choose another folder", "Cancel"]) expect(tag(busy, id), id).toContain('disabled=""');
    const failed = view({ error: "This folder holds more than 1 GB — too much to track without git. Initialize git here, or open a smaller folder." });
    expect(tag(failed, "Track without git error")).toContain('role="alert"');
    expect(failed).toContain("more than 1 GB");
  });

  it("the confirm screens: tracking a large or personal folder, initializing one", () => {
    const track = view({ step: "confirmTrack" });
    expect(track).toContain("Track this folder without git?");
    expect(track).toContain('data-testid="Track anyway"');
    expect(track).not.toContain('class="danger"');
    const init = view({ step: "confirmInit" });
    expect(init).toContain("Initialize git in this folder?");
    expect(init).toContain('data-testid="Initialize anyway"');
  });

  it("success sends track_without_git without confirm", async () => {
    expect(await L.useStore.getState().trackWithoutGit()).toEqual({ kind: "ok" });
    expect(sent).toEqual([{ type: "track_without_git" }]);
  });

  it("folder_unsafe asks first; the answer goes again with confirm: true", async () => {
    answer = async (c) => ((c as { confirm?: boolean }).confirm ? { ok: true, reply: { type: "result", ok: true } } : { ok: false, error: "folder_unsafe", code: "folder_unsafe" });
    expect(await L.useStore.getState().trackWithoutGit()).toEqual({ kind: "confirm" });
    expect(await L.useStore.getState().trackWithoutGit(true)).toEqual({ kind: "ok" });
    expect(sent).toEqual([{ type: "track_without_git" }, { type: "track_without_git", confirm: true }]);
  });

  it("folder_too_large says which limit and the two ways out", async () => {
    const cases: [string, string][] = [
      ["files", "more than 20,000 files"],
      ["bytes", "more than 1 GB"],
      ["scan", "took too long"],
    ];
    for (const [limit, words] of cases) {
      answer = refuse(`folder_too_large:${limit}`, "folder_too_large");
      const o = await L.useStore.getState().trackWithoutGit();
      expect(o.kind).toBe("failed");
      const text = (o as { text: string }).text;
      expect(text, limit).toContain(words);
      expect(text, limit).toContain("Initialize git here, or open a smaller folder.");
    }
  });

  it("track_failed and any other refusal show the error's words", async () => {
    answer = refuse("track_failed: spawn git ENOENT", "track_failed");
    expect(await L.useStore.getState().trackWithoutGit()).toEqual({ kind: "failed", text: "This folder could not be tracked without git: spawn git ENOENT" });
    answer = refuse("something new", "something_new");
    expect(await L.useStore.getState().trackWithoutGit()).toEqual({ kind: "failed", text: "something new" });
  });

  it("another session's lock opens the take-over dialog on that folder", async () => {
    answer = refuse("locked_by_other_session:4242", "locked_by_other_session");
    expect(await L.useStore.getState().trackWithoutGit()).toEqual({ kind: "ok" });
    const s = L.useStore.getState();
    expect(s.dialog).toEqual({ kind: "lockConflict" });
    expect(s.lockedProjectPath).toBe("C:/Users/dev/notes");
    expect(s.refusedLockPid).toBe(4242);
  });

  it("nothing is sent without a pending prompt", async () => {
    L.useStore.setState({ state: { ...L.useStore.getState().state, gitInit: null } as unknown as ReviewState });
    expect(await L.useStore.getState().trackWithoutGit()).toEqual({ kind: "ok" });
    expect(sent).toEqual([]);
  });

  it("a remembered folder that cannot be reopened: the error says why (the prompt comes back by itself)", () => {
    expect(L.errorEventText({ code: "folder_too_large", message: "folder_too_large:files — the folder holds more than 20000 files (20001 files, 5 bytes counted); open a smaller folder or make it a git repository" }))
      .toBe("This folder has more than 20,000 files — too many to track without git. Initialize git here, or open a smaller folder.");
    expect(L.errorEventText({ code: "track_failed", message: "EACCES: permission denied" })).toBe("This folder could not be tracked without git: EACCES: permission denied");
    expect(L.refusalCodeText("not_a_git_repo", "branches")).toBe("This folder is not a git repository");
  });
});
