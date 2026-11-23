import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionMeta } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import {
  START_MARK,
  activateStartMark,
  defaultTaskTemplate,
  fetchesFromGitHub,
  moveStartMark,
  needsNewChat,
  parseTaskReference,
  pressStartNumber,
  recentStartChats,
  renderTaskPrompt,
  shouldShowStartScreen,
  startScreenKey,
  taskBranchName,
  taskFetchRefusal,
  taskHint,
  taskSlug,
  taskDraft,
  taskStartBlocker,
  MAX_TASK_SLUG,
  type FetchedTask,
} from "./taskStart";
import { DEFAULT_TASK_START, globalTaskStartSettings, hasProjectTaskStartSettings, isTaskStartSettings, taskStartPatch, taskStartSettingsFor, taskStartSettingsOf } from "../shared/taskStartSettings";

// MARK: task-start — docs/PROTOCOL.md §63 on Windows: the same cases as the Mac's Core TaskStartTests — the reference, the
// branch, the first prompt, the settings, when the start screen shows, what it lists and its keys.

const task = (over: Partial<FetchedTask> = {}): FetchedTask => ({ id: "ACME-1", title: "", body: "", url: "", labels: [], ...over });

describe("the task reference (§63.3)", () => {
  it("reads keys, numbers and links", () => {
    expect(parseTaskReference("  ACME-123 ")).toMatchObject({ id: "ACME-123", url: null, issueRef: null });
    expect(parseTaskReference("#42")?.issueRef).toBe("42");
    expect(parseTaskReference("42")?.id).toBe("42");
    expect(parseTaskReference("acme/widgets#7")?.issueRef).toBe("acme/widgets#7");
    expect(parseTaskReference("https://github.com/acme/widgets/issues/42")).toMatchObject({ id: "42", isGitHubLink: true, issueRef: "https://github.com/acme/widgets/issues/42" });
    expect(parseTaskReference("https://github.example.com/acme/widgets/issues/9")?.isGitHubLink).toBe(true); // GitHub Enterprise
    expect(parseTaskReference("https://tracker.example.com/task/123")).toMatchObject({ id: "123", url: "https://tracker.example.com/task/123", issueRef: null });
    expect(parseTaskReference("https://acme.example.com/browse/ACME-77?focus=1")?.id).toBe("ACME-77");
    expect(parseTaskReference("see https://tracker.example.com/task/9 please")?.id).toBe("9"); // the link in a sentence
    expect(parseTaskReference("")).toBeNull();
    expect(parseTaskReference("장바구니")).toBeNull(); // nothing ASCII to name a branch with
  });

  it("GitHub reads only its issues", () => {
    expect(fetchesFromGitHub(parseTaskReference("https://github.com/acme/widgets/issues/42")!, "jira")).toBe(true); // a GitHub link always
    expect(fetchesFromGitHub(parseTaskReference("#42")!, "github")).toBe(true);
    expect(fetchesFromGitHub(parseTaskReference("#42")!, "linear")).toBe(false); // a number of another tracker
    expect(fetchesFromGitHub(parseTaskReference("ACME-1")!, "github")).toBe(false);
    expect(fetchesFromGitHub(parseTaskReference("https://tracker.example.com/task/123")!, "github")).toBe(false);
  });
});

describe("the branch (§63.3)", () => {
  it("is <prefix><id>-<slug>", () => {
    expect(taskBranchName("feature/", "ACME-123", "Fix the cart total")).toBe("feature/ACME-123-fix-the-cart-total");
    expect(taskBranchName("{type}/", "42", "Crash on save", ["bug"])).toBe("fix/42-crash-on-save");
    expect(taskBranchName("{type}/", "42", "Write docs", ["documentation"])).toBe("docs/42-write-docs");
    expect(taskBranchName("{type}/", "42", "Bump deps", ["chore"])).toBe("chore/42-bump-deps");
    expect(taskBranchName("{type}/", "42")).toBe("feature/42");
    expect(taskBranchName("", "7", "Café résumé")).toBe("7-cafe-resume"); // accents folded
    expect(taskBranchName("feature/", "ACME-9", "ACME-9 Add login")).toBe("feature/ACME-9-add-login"); // no id twice
    expect(taskBranchName("bad prefix~/", "1")).toBe("badprefix/1"); // the prefix kept valid
  });

  it("a Korean title leaves only the id; a long title stops at a word", () => {
    expect(taskBranchName("feature/", "ACME-5", "장바구니 합계 오류 수정")).toBe("feature/ACME-5");
    expect(taskBranchName("feature/", "5", "장바구니 total 오류")).toBe("feature/5-total"); // its ASCII words
    const slug = taskSlug("Refactor the checkout service so that every payment provider shares one retry policy");
    expect(slug.length).toBeLessThanOrEqual(MAX_TASK_SLUG);
    expect(slug).toBe("refactor-the-checkout-service-so-that-every");
  });
});

describe("the first prompt (§63.3)", () => {
  beforeAll(() => initI18n("en", "win32"));

  it("drops lines whose placeholders are empty and keeps the hint", () => {
    const template = "Work on task {id}: {title}\n{url}\n\n{mcp}\n\n{body}\n\nPlan first.";
    const full = task({ id: "42", title: "Cart total", body: "Steps\n1. add", url: "https://github.com/acme/widgets/issues/42" });
    expect(renderTaskPrompt(template, full, "")).toBe("Work on task 42: Cart total\nhttps://github.com/acme/widgets/issues/42\n\nSteps\n1. add\n\nPlan first.");
    expect(renderTaskPrompt(template, task(), "Read it with acme.")).toBe("Work on task ACME-1\n\nRead it with acme.\n\nPlan first.");
    // No {mcp} in the template: the hint goes first.
    expect(renderTaskPrompt("Do {id}.", task(), "Read it.")).toBe("Read it.\n\nDo ACME-1.");
  });

  it("the built-in template renders a task Claude reads", () => {
    const hint = taskHint("jira", "acme-tracker", task({ url: "https://tracker.example.com/task/1" }), false);
    const text = renderTaskPrompt(defaultTaskTemplate(), task({ url: "https://tracker.example.com/task/1" }), hint);
    expect(text).toBe(
      "Work on task ACME-1\nhttps://tracker.example.com/task/1\n\nRead this task with the acme-tracker MCP server (its mcp__acme-tracker__* tools) and summarize it before you start.\n\nSummarize the task first and tell me your plan before you change code.",
    );
  });

  it("the hint names the MCP server and its tools", () => {
    const t1 = task({ url: "https://tracker.example.com/task/1" });
    const hint = taskHint("jira", "acme tracker", t1, false);
    expect(hint).toContain("acme tracker");
    expect(hint).toContain("mcp__acme_tracker__*");
    expect(taskHint("linear", "", t1, false)).not.toBe(""); // read it somehow
    expect(taskHint("none", "x", t1, false)).toBe("");
    expect(taskHint("github", "", task({ id: "4", title: "T", body: "B" }), true)).toBe("");
    expect(taskHint("github", "", task({ id: "4" }), true)).toContain("gh issue view 4");
  });

  it("task_fetch refusals in the user's words", () => {
    expect(taskFetchRefusal("not_found", "")).toBe("No such issue in this repository");
    expect(taskFetchRefusal("task_fetch_failed", "HTTP 401")).toBe("Could not read the issue: HTTP 401");
    expect(taskFetchRefusal("task_fetch_failed", "")).toBe("Could not read the issue");
    expect(taskFetchRefusal("gh_missing", "")).toContain("GitHub CLI (gh)");
    expect(taskFetchRefusal("bad_task_ref", "")).toContain("owner/repo#123");
    expect(taskFetchRefusal("unknown_command", "")).toBeNull();
  });
});

describe("the task dialog (§63.3)", () => {
  beforeAll(() => initI18n("en", "win32"));
  const ref = (text: string) => parseTaskReference(text)!;

  it("fills the branch and the prompt from the issue read, else from the id and link", () => {
    const github = { ...DEFAULT_TASK_START, platform: "github" as const };
    const read = taskDraft(github, ref("#42"), task({ id: "42", title: "Crash on save", body: "Steps", url: "https://github.com/acme/widgets/issues/42", labels: ["bug"] }));
    expect(read.branch).toBe("feature/42-crash-on-save");
    expect(read.prompt).toContain("Work on task 42: Crash on save");
    expect(read.prompt).not.toContain("gh issue view");
    // The issue could not be read: its id, and Claude reads it with gh.
    const unread = taskDraft(github, ref("https://github.com/acme/widgets/issues/42"), null);
    expect(unread.branch).toBe("feature/42");
    expect(unread.prompt).toContain("gh issue view https://github.com/acme/widgets/issues/42");
    // A tracker Claude reads through MCP: the id only (its title is not known), the hint with the server's tools.
    const jira = taskDraft({ ...DEFAULT_TASK_START, platform: "jira", mcpServer: "acme-tracker", branchPrefix: "{type}/" }, ref("https://tracker.example.com/browse/ACME-12"), null);
    expect(jira.branch).toBe("feature/ACME-12");
    expect(jira.prompt).toContain("mcp__acme-tracker__*");
    // The project's own template.
    expect(taskDraft({ ...DEFAULT_TASK_START, promptTemplate: "Do {id}." }, ref("ACME-3"), null).prompt).toBe("Do ACME-3.");
  });

  it("Start says why it is off, in order", () => {
    const base = { ref: ref("ACME-1"), fetching: false, prompt: "Work", branchHint: null, createBlocker: null };
    expect(taskStartBlocker(base)).toBeNull();
    expect(taskStartBlocker({ ...base, ref: null })).toBe("Enter a task id or link");
    expect(taskStartBlocker({ ...base, fetching: true })).toBe("Reading the issue…");
    expect(taskStartBlocker({ ...base, prompt: "  " })).toBe("The first prompt is empty");
    expect(taskStartBlocker({ ...base, branchHint: "A branch with this name already exists", createBlocker: "x" })).toBe("A branch with this name already exists");
    expect(taskStartBlocker({ ...base, createBlocker: "Finish the merge first" })).toBe("Finish the merge first");
  });
});

describe("Korean", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "darwin"));

  it("the built-in template and the hint read in Korean", () => {
    expect(defaultTaskTemplate()).toContain("업무 {id}");
    expect(taskHint("linear", "acme", task(), false)).toContain("MCP 서버");
    expect(taskFetchRefusal("not_found", "")).toBe("이 저장소에 그런 이슈가 없어요");
  });
});

describe("settings: a repository's own, else the default (§63.3)", () => {
  it("falls back field by field and per repository", () => {
    expect(taskStartSettingsFor({}, "/work/acme")).toEqual(DEFAULT_TASK_START);
    const global = { ...DEFAULT_TASK_START, platform: "linear" as const, mcpServer: "linear" };
    let s = { ...taskStartPatch({}, null, global) };
    expect(taskStartSettingsFor(s, "/work/acme").platform).toBe("linear");
    const own = { ...global, platform: "github" as const, location: "workbench" as const };
    s = { ...s, ...taskStartPatch(s, "/work/acme", own) };
    expect(taskStartSettingsFor(s, "/work/acme")).toEqual(own);
    expect(taskStartSettingsFor(s, "C:\\work\\other")).toEqual(global);
    expect(hasProjectTaskStartSettings(s, "/work/acme")).toBe(true);
    s = { ...s, ...taskStartPatch(s, "/work/acme", null) };
    expect(taskStartSettingsFor(s, "/work/acme")).toEqual(global);
    // Lenient: an unknown platform from a newer app falls back on its own.
    expect(globalTaskStartSettings({ taskStartSettings: { platform: "someday", branchPrefix: "fix/" } as never })).toEqual({ ...DEFAULT_TASK_START, branchPrefix: "fix/" });
    expect(taskStartSettingsOf(null)).toEqual(DEFAULT_TASK_START);
  });

  it("main stores only well-formed entries", () => {
    expect(isTaskStartSettings({ ...DEFAULT_TASK_START, promptTemplate: "Do {id}" })).toBe(true);
    expect(isTaskStartSettings({ ...DEFAULT_TASK_START, platform: "someday" })).toBe(false);
    expect(isTaskStartSettings({ ...DEFAULT_TASK_START, branchPrefix: "a\nb" })).toBe(false);
    expect(isTaskStartSettings({ ...DEFAULT_TASK_START, token: "x" })).toBe(false); // no stray keys (the app keeps no token)
  });
});

describe("the start screen (§63.4)", () => {
  const show = (over: Partial<Parameters<typeof shouldShowStartScreen>[0]> = {}) =>
    shouldShowStartScreen({ skip: false, suppressed: false, phase: "idle", reviewPending: false, composerTask: false, ...over });

  it("shows when nothing is in progress and nobody said not to", () => {
    expect(show()).toBe(true);
    expect(show({ skip: true })).toBe(false);
    expect(show({ suppressed: true })).toBe(false);
    expect(show({ phase: "running" })).toBe(false);
    expect(show({ phase: "reviewing", reviewPending: true })).toBe(false);
    expect(show({ composerTask: true })).toBe(false);
  });

  it("lists the five newest chats with a conversation", () => {
    const meta = (id: string, at: string, over: Partial<SessionMeta> = {}): SessionMeta =>
      ({ id, title: id, createdAt: at, updatedAt: at, turns: 1, costUSD: 0, lastUserText: null, ...over }) as SessionMeta;
    const list = [
      meta("a", "2026-01-01"),
      meta("b", "2026-01-02"),
      meta("empty", "2026-01-10", { turns: 0 }),
      meta("archived", "2026-01-09", { archived: true }),
      meta("moved", "2026-01-08", { movedTo: { path: "/work/acme-wb", name: "acme-wb", at: "2026-01-08" } as never }),
      meta("continued", "2026-01-07", { continuedIn: "t1" }),
      meta("c", "2026-01-03"),
      meta("d", "2026-01-04"),
      meta("e", "2026-01-05"),
      meta("f", "2026-01-06"),
      meta("typed", "2026-01-01", { turns: 0, lastUserText: "hello" }),
    ];
    expect(recentStartChats(list).map((m) => m.id)).toEqual(["f", "e", "d", "c", "b"]);
    expect(needsNewChat(meta("empty", "", { turns: 0 }))).toBe(false);
    expect(needsNewChat(meta("a", ""))).toBe(true);
    expect(needsNewChat(null)).toBe(false);
  });

  it("the keyboard: 1 / 2 / 3, ↑ ↓ Enter, Esc = 바로 시작", () => {
    const chats = ["c1", "c2"];
    expect(activateStartMark(START_MARK, chats).action).toEqual({ kind: "start" }); // Enter on the first choice
    expect(pressStartNumber(START_MARK, 2, chats).action).toEqual({ kind: "task" });
    const three = pressStartNumber(START_MARK, 3, chats); // 3 marks the first chat …
    expect(three).toEqual({ mark: { chat: 0 }, action: null });
    const down = moveStartMark(three.mark, 1, chats);
    expect(activateStartMark(down, chats).action).toEqual({ kind: "openChat", id: "c2" }); // … ↓ Enter opens the next one
    expect(moveStartMark(down, 9, chats)).toEqual({ chat: 1 }); // stops at the end
    expect(moveStartMark(down, -9, chats)).toEqual({ choice: 1 });
    expect(moveStartMark(START_MARK, 2, [])).toEqual({ choice: 2 }); // without chats 대화로 열기 is skipped
    expect(pressStartNumber({ choice: 2 }, 3, [])).toEqual({ mark: { choice: 2 }, action: null });
    expect(activateStartMark({ choice: 3 }, chats)).toEqual({ mark: { chat: 0 }, action: null });
    expect(pressStartNumber(START_MARK, 7, chats).action).toBeNull();
  });

  it("maps the keys it takes and leaves the rest alone", () => {
    const chats = ["c1"];
    expect(startScreenKey("Escape", { chat: 0 }, chats)).toMatchObject({ handled: true, action: { kind: "start" } });
    expect(startScreenKey("ArrowDown", START_MARK, chats)).toMatchObject({ handled: true, mark: { choice: 2 }, action: null });
    expect(startScreenKey("ArrowUp", START_MARK, chats)).toMatchObject({ handled: true, mark: START_MARK });
    expect(startScreenKey("Enter", { chat: 0 }, chats).action).toEqual({ kind: "openChat", id: "c1" });
    expect(startScreenKey("2", START_MARK, chats).action).toEqual({ kind: "task" });
    expect(startScreenKey("a", START_MARK, chats).handled).toBe(false);
    expect(startScreenKey("Tab", START_MARK, chats).handled).toBe(false);
  });
});
