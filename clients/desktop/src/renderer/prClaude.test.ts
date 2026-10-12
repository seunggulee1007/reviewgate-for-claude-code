/**
 * MARK: wave3 desktop-flow — §36.14 PRs and Claude (the Mac's PRClaude rules): threads and what is still unresolved, the
 * composer draft, the PR workbench branch and repository, and a PR diff line's side-question anchor with its hunk.
 */
import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff, PRComment } from "@reviewgate/engine";
import {
  MAX_PR_HUNK_CHARS,
  isProjectRepo,
  prAnchorLocation,
  prCommentsDraft,
  prHunkPreview,
  prHunkText,
  prLineAnchor,
  prThreads,
  prWorkbenchBranch,
  repoSlug,
  respondCommand,
  threadOf,
  unresolvedThreads,
} from "./prClaude";

const comment = (id: number, author: string, o: Partial<PRComment> & { minute: number }): PRComment => ({
  id,
  path: o.path ?? "api/Svc.java",
  line: o.line === undefined ? 42 : o.line,
  side: "RIGHT",
  startLine: null,
  body: o.body ?? "body",
  author,
  createdAt: new Date(Date.UTC(2026, 9, 23, 3, o.minute)).toISOString(),
  inReplyTo: o.inReplyTo ?? null,
  diffHunk: "@@",
});

describe("§36.14 threads", () => {
  const comments = [
    comment(1, "review-bot[bot]", { body: "NPE when tenant is null", minute: 0 }),
    comment(2, "yoon", { body: "고쳤어요", inReplyTo: 1, minute: 5 }),
    comment(3, "kim", { body: "이 쿼리 인덱스 타나요?", path: "api/Repo.java", line: 10, minute: 1 }),
    comment(4, "kim", { body: "그리고 이것도", inReplyTo: 3, minute: 2 }),
    comment(5, "park", { body: "orphan reply", inReplyTo: 99, minute: 3 }),
  ];

  it("groups replies under their first comment; a reply without one is a thread of its own", () => {
    const threads = prThreads(comments);
    expect(threads.map((th) => th.root.id)).toEqual([1, 3, 5]);
    expect(threads[0]!.replies.map((c) => c.id)).toEqual([2]);
    expect(threadOf(comments[3]!, comments)?.root.id).toBe(3);
  });

  it("unresolved = the last word is not the user's (case-insensitive); without a login every thread", () => {
    const threads = prThreads(comments);
    expect(unresolvedThreads(threads, "Yoon").map((th) => th.root.id)).toEqual([3, 5]);
    expect(unresolvedThreads(threads, null)).toHaveLength(3);
  });
});

describe("§36.14 the composer draft", () => {
  it("starts with the repository's PR command and quotes every comment", () => {
    const threads = prThreads([
      comment(3, "kim", { body: "이 쿼리 인덱스 타나요?\n확인 부탁", path: "api/Repo.java", line: 10, minute: 1 }),
      comment(4, "kim", { body: "그리고 이것도", inReplyTo: 3, minute: 2 }),
    ]);
    const command = respondCommand("/acme-tools:review-reply {pr}", 512);
    expect(command).toBe("/acme-tools:review-reply 512");
    expect(respondCommand("  ", 1)).toBeNull();
    const text = prCommentsDraft(512, "장바구니 정리", threads, command);
    const lines = text.split("\n");
    expect(lines[0]).toBe("/acme-tools:review-reply 512");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Handle this review comment on PR #512 (장바구니 정리):");
    expect(text).toContain("- api/Repo.java:10 — @kim:\n  > 이 쿼리 인덱스 타나요?\n  > 확인 부탁");
    expect(text).toContain("  ↳ @kim:\n  > 그리고 이것도");
  });

  it("several threads; an outdated comment has no line; no command = the comments only", () => {
    const threads = prThreads([comment(9, "a", { line: null, minute: 0 }), comment(10, "b", { minute: 1 })]);
    const text = prCommentsDraft(1, "t", threads, null);
    expect(text.startsWith("Handle these 2 review comments on PR #1 (t):")).toBe(true);
    expect(text).toContain("- api/Svc.java — @a:");
    expect(text).toContain("- api/Svc.java:42 — @b:");
  });
});

describe("§36.14 PR workbench and repository", () => {
  it("the head branch, else pr-<number>", () => {
    expect(prWorkbenchBranch(512, "feature/acme/4790", "develop")).toBe("feature/acme/4790");
    expect(prWorkbenchBranch(512, "develop", "develop")).toBe("pr-512");
    expect(prWorkbenchBranch(7, " ", "main")).toBe("pr-7");
  });

  it("owner/name of the remote, compared with the PR's repository", () => {
    expect(repoSlug("git@ghe.example.com:ACME/app.git")).toBe("acme/app");
    expect(repoSlug("https://ghe.example.com/acme/app")).toBe("acme/app");
    expect(repoSlug("ssh://git@ghe.example.com:22/acme/app.git/")).toBe("acme/app");
    expect(repoSlug("/local/path")).toBeNull();
    expect(repoSlug(null)).toBeNull();
    expect(isProjectRepo("acme/App", "git@ghe.example.com:acme/app.git")).toBe(true);
    expect(isProjectRepo("acme/other", "git@ghe.example.com:acme/app.git")).toBe(false);
    expect(isProjectRepo("acme/app", null)).toBe(false);
  });
});

describe("§36.14 a PR line's side question", () => {
  const lines: DiffLine[] = [
    { id: 0, kind: "hunkHeader", oldNo: null, newNo: null, text: "@@ -10,3 +10,4 @@" },
    { id: 1, kind: "context", oldNo: 10, newNo: 10, text: "a" },
    { id: 2, kind: "del", oldNo: 11, newNo: null, text: "b" },
    { id: 3, kind: "add", oldNo: null, newNo: 11, text: "c" },
  ];
  const other: DiffLine[] = [
    { id: 4, kind: "hunkHeader", oldNo: null, newNo: null, text: "@@ -50 +51 @@" },
    { id: 5, kind: "context", oldNo: 50, newNo: 51, text: "z" },
  ];
  const diff: FileDiff = { oldPath: "x.ts", newPath: "x.ts", isBinary: false, hunks: [{ id: 0, header: "@@", lines }, { id: 1, header: "@@", lines: other }] };

  it("carries its hunk (only that hunk) and the side its number lives on", () => {
    expect(prHunkText(diff, lines[3]!)).toBe("@@ -10,3 +10,4 @@\n a\n-b\n+c\n");
    expect(prLineAnchor(7, "x.ts", lines[3]!, diff, "abc")).toEqual({ number: 7, path: "x.ts", line: 11, side: "RIGHT", hunk: "@@ -10,3 +10,4 @@\n a\n-b\n+c\n", commitId: "abc" });
    expect(prLineAnchor(7, "x.ts", lines[2]!, diff, null)).toMatchObject({ side: "LEFT", line: 11 });
    expect(prLineAnchor(7, "x.ts", lines[0]!, diff, null)).toBeNull();
    expect(prAnchorLocation({ number: 7, path: "x.ts", line: 11, side: "RIGHT", hunk: "" })).toBe("PR #7 · x.ts:11");
  });

  it("the side question reads the hunk back, numbered from its @@ header, around the line", () => {
    const added = prLineAnchor(7, "x.ts", lines[3]!, diff, "abc")!;
    const preview = prHunkPreview(added)!;
    expect(preview.lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["context", 10, 10, "a"],
      ["del", 11, null, "b"],
      ["add", null, 11, "c"],
    ]);
    expect(preview.lines.find((l) => l.id === preview.focus)?.text).toBe("c");
    const deleted = prHunkPreview(prLineAnchor(7, "x.ts", lines[2]!, diff, null)!)!;
    expect(deleted.lines.find((l) => l.id === deleted.focus)?.text).toBe("b");
    expect(prHunkPreview({ number: 1, path: "a", line: 1, side: "RIGHT", hunk: "+x\n" })).toBeNull();
  });

  it("a long hunk is cut at 4 000 chars", () => {
    const long: DiffLine[] = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, kind: "add", oldNo: null, newNo: i, text: "x".repeat(40) }));
    const big: FileDiff = { oldPath: "x.ts", newPath: "x.ts", isBinary: false, hunks: [{ id: 0, header: "@@", lines: long }] };
    expect(prHunkText(big, long[0]!).length).toBeLessThanOrEqual(MAX_PR_HUNK_CHARS);
  });
});
