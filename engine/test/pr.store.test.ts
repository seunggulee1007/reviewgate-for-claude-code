import { describe, expect, test } from "vitest";
import { GHError } from "../src/pr/gh.js";
import type { PRComment, PRDetail, PRFile, PRReview, PRSummary } from "../src/pr/models.js";
import { PRStore, type GHClientLike, type PRStoreDeps } from "../src/pr/store.js";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const summary = (n: number, repo = "acme/widgets"): PRSummary => ({
  number: n,
  title: `pr ${n}`,
  repo,
  host: "github.com",
  author: "alice",
  updatedAt: "2026-09-07T11:15:09Z",
  url: `https://github.com/${repo}/pull/${n}`,
  isDraft: false,
});

const detailOf = (n: number): PRDetail => ({
  number: n,
  title: `pr ${n}`,
  body: "",
  author: "alice",
  state: "OPEN",
  url: `https://github.com/acme/widgets/pull/${n}`,
  headRefName: "feat",
  baseRefName: "main",
  headRefOid: `sha-${n}`,
  reviewDecision: "",
  additions: 1,
  deletions: 1,
  changedFiles: 2,
});

const filesOf = (n: number): PRFile[] => [
  { filename: `f${n}.txt`, previousFilename: null, status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n line\n-old\n+new" },
  { filename: "img.png", previousFilename: null, status: "added", additions: 0, deletions: 0, patch: null },
];

const commentOf = (id: number, inReplyTo: number | null = null): PRComment => ({
  id,
  path: "f1.txt",
  line: 2,
  side: "RIGHT",
  startLine: null,
  body: `c${id}`,
  author: "bob",
  createdAt: "2026-09-06T16:00:00Z",
  inReplyTo,
  diffHunk: "",
});

const reviewOf = (id: number): PRReview => ({ id, author: "me", state: "COMMENTED", body: "", submittedAt: "2026-09-06T16:00:00Z", url: `https://r/${id}` });

/** A scripted GHClient: every call is recorded; `detail` can be held back with `holdDetail`. */
class FakeClient implements GHClientLike {
  calls: string[] = [];
  holdDetail = new Map<number, Deferred<PRDetail>>();
  failWith: Error | null = null;
  commentsResult: PRComment[] = [commentOf(10), commentOf(11, 10)];
  reviewsResult: PRReview[] = [reviewOf(1)];
  submitResult: PRReview = { ...reviewOf(99), url: "https://github.com/acme/widgets/pull/1#pullrequestreview-99" };
  lastSubmit: Parameters<GHClientLike["submitReview"]>[2] | null = null;
  lastReply: { commentId: number; body: string } | null = null;

  private guard() {
    if (this.failWith) throw this.failWith;
  }
  async myOpenPRs() {
    this.calls.push("mine");
    this.guard();
    return [summary(1), summary(2)];
  }
  async reviewRequestedPRs() {
    this.calls.push("requested");
    this.guard();
    return [summary(3, "team/svc")];
  }
  async detail(_repo: string, n: number) {
    this.calls.push(`detail:${n}`);
    this.guard();
    const held = this.holdDetail.get(n);
    return held ? held.promise : detailOf(n);
  }
  async files(_repo: string, n: number) {
    this.calls.push(`files:${n}`);
    this.guard();
    return filesOf(n);
  }
  async comments(_repo: string, n: number) {
    this.calls.push(`comments:${n}`);
    this.guard();
    return this.commentsResult;
  }
  async reviews(_repo: string, n: number) {
    this.calls.push(`reviews:${n}`);
    this.guard();
    return this.reviewsResult;
  }
  async submitReview(_repo: string, n: number, input: Parameters<GHClientLike["submitReview"]>[2]) {
    this.calls.push(`submit:${n}`);
    this.guard();
    this.lastSubmit = input;
    return this.submitResult;
  }
  async reply(_repo: string, n: number, commentId: number, body: string) {
    this.calls.push(`reply:${n}:${commentId}`);
    this.guard();
    this.lastReply = { commentId, body };
    return commentOf(12, commentId);
  }
}

function makeStore(overrides: Partial<PRStoreDeps> = {}) {
  const client = new FakeClient();
  const changes: number[] = [];
  const terminal: string[] = [];
  const deps: PRStoreDeps = {
    resolveGH: async () => ({ path: "/fake/gh", env: {} }),
    platform: { openTerminal: async (cmd) => void terminal.push(cmd) },
    onChange: () => changes.push(1),
    makeClient: () => client,
    now: () => new Date("2026-09-13T00:00:00Z"),
    ...overrides,
  };
  return { store: new PRStore(deps, "github.com"), client, changes, terminal };
}

describe("PRStore", () => {
  test("refresh loads both lists and clears the error", async () => {
    const { store, client, changes } = makeStore();
    store.errorText = "stale";
    await store.refresh();
    expect(store.isLoading).toBe(false);
    expect(store.mine.map((s) => s.number)).toEqual([1, 2]);
    expect(store.reviewRequested.map((s) => s.repo)).toEqual(["team/svc"]);
    expect(store.errorText).toBeNull();
    expect(client.calls).toEqual(["mine", "requested"]);
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  test("open loads detail/files/comments/reviews concurrently and selects the first file", async () => {
    const { store, client } = makeStore();
    await store.refresh();
    await store.open("github.com/acme/widgets#2");
    expect(store.selectedSummary?.number).toBe(2);
    expect(store.selected?.headRefOid).toBe("sha-2");
    expect(store.files.map((f) => f.filename)).toEqual(["f2.txt", "img.png"]);
    expect(store.files.every((f) => !("patch" in f))).toBe(true); // patches never leave the store
    expect(store.patchFor("f2.txt")).toContain("@@ -1,2 +1,2 @@");
    expect(store.comments.map((c) => c.id)).toEqual([10, 11]);
    expect(store.reviews.map((r) => r.id)).toEqual([1]);
    expect(store.selectedFile?.filename).toBe("f2.txt");
    expect(store.selectedDiff?.hunks).toHaveLength(1);
    expect(store.selectedDiff?.hunks[0].lines.map((l) => l.kind)).toEqual(["hunkHeader", "context", "del", "add"]);
    expect(store.isLoading).toBe(false);
    expect(store.errorText).toBeNull();
    expect(client.calls.slice(2)).toEqual(["detail:2", "files:2", "comments:2", "reviews:2"]);

    store.selectFile("img.png");
    expect(store.selectedFile?.filename).toBe("img.png");
    expect(store.selectedDiff).toEqual({ oldPath: "img.png", newPath: "img.png", isBinary: true, hunks: [] });
  });

  test("open of an unknown id sets errorText and leaves the selection alone", async () => {
    const { store } = makeStore();
    await store.open("github.com/nope/nope#9");
    expect(store.errorText).toBe("Unknown PR: github.com/nope/nope#9");
    expect(store.selectedSummary).toBeNull();
  });

  test("a stale open is ignored when the user moved on", async () => {
    const { store, client } = makeStore();
    await store.refresh();
    const held = deferred<PRDetail>();
    client.holdDetail.set(1, held);
    const first = store.open("github.com/acme/widgets#1");
    expect(store.isLoading).toBe(true);
    await store.open("github.com/acme/widgets#2");
    expect(store.selected?.number).toBe(2);
    expect(store.isLoading).toBe(false);
    held.resolve(detailOf(1));
    await first;
    // #1 resolved after #2 was opened: nothing of it may leak into the state
    expect(store.selectedSummary?.number).toBe(2);
    expect(store.selected?.number).toBe(2);
    expect(store.files.map((f) => f.filename)).toEqual(["f2.txt", "img.png"]);
    expect(store.isLoading).toBe(false);
  });

  test("submit sends drafts, clears them, sets lastSubmitResult and reloads comments/reviews", async () => {
    const { store, client } = makeStore();
    await store.refresh();
    await store.open("github.com/acme/widgets#1");
    const id = store.addDraft({ path: "f1.txt", line: 2, side: "RIGHT", body: "nit" });
    store.addDraft({ path: "f1.txt", line: 2, side: "LEFT", startLine: 1, body: "why" });
    expect(store.draftComments).toHaveLength(2);
    store.removeDraft(id);
    expect(store.draftComments.map((d) => d.body)).toEqual(["why"]);

    client.commentsResult = [commentOf(10), commentOf(11, 10), commentOf(20)];
    client.reviewsResult = [reviewOf(1), reviewOf(99)];
    await store.submit("REQUEST_CHANGES", "Overall");

    expect(client.lastSubmit).toEqual({
      commitId: "sha-1",
      event: "REQUEST_CHANGES",
      body: "Overall",
      comments: [{ id: expect.any(String), path: "f1.txt", line: 2, side: "LEFT", startLine: 1, body: "why" }],
    });
    expect(store.draftComments).toEqual([]);
    expect(store.isSubmitting).toBe(false);
    expect(store.errorText).toBeNull();
    expect(store.lastSubmitResult).toEqual({
      reviewURL: "https://github.com/acme/widgets/pull/1#pullrequestreview-99",
      inlineCount: 1,
      event: "REQUEST_CHANGES",
      submittedAt: "2026-09-13T00:00:00.000Z",
    });
    expect(store.comments.map((c) => c.id)).toEqual([10, 11, 20]);
    expect(store.reviews.map((r) => r.id)).toEqual([1, 99]);
    expect(client.calls.filter((c) => c.startsWith("submit"))).toEqual(["submit:1"]);
  });

  test("submit falls back to the PR url when the review has none", async () => {
    const { store, client } = makeStore();
    await store.refresh();
    await store.open("github.com/acme/widgets#1");
    client.submitResult = { ...reviewOf(5), url: null };
    await store.submit("APPROVE", "");
    expect(store.lastSubmitResult?.reviewURL).toBe("https://github.com/acme/widgets/pull/1");
    expect(store.lastSubmitResult?.inlineCount).toBe(0);
  });

  test("reply targets the thread root", async () => {
    const { store, client } = makeStore();
    await store.refresh();
    await store.open("github.com/acme/widgets#1");
    await store.reply(11, "thanks"); // 11 is a reply to 10
    expect(client.lastReply).toEqual({ commentId: 10, body: "thanks" });
    await store.reply(10, "again");
    expect(client.lastReply).toEqual({ commentId: 10, body: "again" });
    await store.reply(555, "unknown comment id is used as-is");
    expect(client.lastReply?.commentId).toBe(555);
    expect(store.isSubmitting).toBe(false);
    expect(store.errorText).toBeNull();
  });

  test("gh failure surfaces stderr verbatim in errorText; drafts survive", async () => {
    const { store, client } = makeStore();
    await store.refresh();
    await store.open("github.com/acme/widgets#1");
    store.addDraft({ path: "f1.txt", line: 2, side: "RIGHT", body: "nit" });
    client.failWith = new GHError(1, "error connecting to github.com\n", ["api"]);
    await store.submit("COMMENT", "x");
    expect(store.errorText).toBe("error connecting to github.com");
    expect(store.draftComments).toHaveLength(1);
    expect(store.lastSubmitResult).toBeNull();
    expect(store.isSubmitting).toBe(false);

    await store.refresh();
    expect(store.errorText).toBe("error connecting to github.com");
    expect(store.isLoading).toBe(false);
    expect(store.mine.map((s) => s.number)).toEqual([1, 2]); // previous lists kept
  });

  test("open failure sets errorText only for the current selection", async () => {
    const { store, client } = makeStore();
    await store.refresh();
    client.failWith = new Error("boom");
    await store.open("github.com/acme/widgets#1");
    expect(store.errorText).toBe("boom");
    expect(store.selected).toBeNull();
    expect(store.isLoading).toBe(false);
  });

  test("missing gh sets errorText on refresh and refreshAccounts", async () => {
    const { store } = makeStore({
      resolveGH: async () => {
        throw new GHError(127, "gh not found on PATH", []);
      },
    });
    await store.refresh();
    expect(store.errorText).toBe("gh not found on PATH");
    await store.refreshAccounts();
    expect(store.accounts).toEqual([]);
    expect(store.errorText).toBe("gh not found on PATH");
  });

  test("refreshAccounts stores the probe result", async () => {
    const { store } = makeStore({
      accountStatus: async () => [{ host: "github.com", login: "me", ok: true, detail: "Logged in as me" }],
    });
    await store.refreshAccounts();
    expect(store.accounts).toEqual([{ host: "github.com", login: "me", ok: true, detail: "Logged in as me" }]);
  });

  test("openLoginInTerminal validates the host and hands the command to the platform", async () => {
    const { store, terminal } = makeStore();
    await store.openLoginInTerminal("ghe.example.com");
    expect(terminal).toEqual(["gh auth login --hostname 'ghe.example.com' --web --git-protocol https"]);
    await store.openLoginInTerminal("foo; rm -rf ~");
    expect(terminal).toHaveLength(1);
    expect(store.errorText).toBe("Invalid host: foo; rm -rf ~");
  });

  test("close resets the opened PR", async () => {
    const { store } = makeStore();
    await store.refresh();
    await store.open("github.com/acme/widgets#1");
    store.addDraft({ path: "f1.txt", line: 2, side: "RIGHT", body: "nit" });
    store.close();
    expect(store.selectedSummary).toBeNull();
    expect(store.selected).toBeNull();
    expect(store.files).toEqual([]);
    expect(store.draftComments).toEqual([]);
    expect(store.selectedDiff).toBeNull();
    expect(store.mine).toHaveLength(2); // lists survive
  });
});
