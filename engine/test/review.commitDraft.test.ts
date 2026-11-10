import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { branchIssue, cleanCommitDraft, COMMIT_DRAFT_MAX, commitDraftPrompt, renderCommitTemplate } from "../src/review/commitDraft.js";
import { fileListLines, roundPatch } from "../src/review/roundPatch.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.11 (daily-05): the commit-message draft's template, prompt and answer cleanup. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("commit template (§36.11)", () => {
  it("{issue} is the branch name's longest run of digits since §41.1 (empty without one), {branch} the branch", () => {
    expect(branchIssue("feature/PAY-1502")).toBe("1502");
    expect(branchIssue("fix/PROJ-12-part-3")).toBe("12");
    expect(branchIssue("feature/PAY-1800-2")).toBe("1800");
    expect(renderCommitTemplate("PAY-{issue}: ", "feature/PAY-1100-2", ["2"])).toBe("PAY-2: ");
    expect(branchIssue("main")).toBe("");
    expect(branchIssue(null)).toBe("");
    expect(renderCommitTemplate("PAY-{issue}: ", "feature/PAY-1502")).toBe("PAY-1502: ");
    expect(renderCommitTemplate("[{branch}] {issue} {issue}", "feature/PAY-1502")).toBe("[feature/PAY-1502] 1502 1502");
    expect(renderCommitTemplate("PAY-{issue}: ", null)).toBe("PAY-: ");
  });
});

describe("cleanCommitDraft", () => {
  it("keeps the message alone: no fence, no one-line preamble, trimmed, ≤ 5 000 chars", () => {
    expect(cleanCommitDraft("  fix: guard empty input\n\n- body\n  ")).toBe("fix: guard empty input\n\n- body");
    expect(cleanCommitDraft("```\nPAY-1502: 수정\n\n- 본문\n```")).toBe("PAY-1502: 수정\n\n- 본문");
    expect(cleanCommitDraft("```text\nfeat: x\n```\n")).toBe("feat: x");
    expect(cleanCommitDraft("Here is the commit message:\n\n```\nfeat: y\n\nbody\n```")).toBe("feat: y\n\nbody");
    expect(cleanCommitDraft("feat: z\n\n```js\ncode();\n```\nmore")).toBe("feat: z\n\n```js\ncode();\n```\nmore");
    expect(cleanCommitDraft("   ")).toBe("");
    const long = cleanCommitDraft("s".repeat(COMMIT_DRAFT_MAX + 50));
    expect(long).toHaveLength(COMMIT_DRAFT_MAX);
  });
});

describe("commitDraftPrompt", () => {
  it("carries the branch, the rendered template, the recent subjects and the fenced patch, and asks for the message only", () => {
    const p = commitDraftPrompt({
      branch: "feature/PAY-1502",
      template: "PAY-1502: ",
      subjects: ["PAY-1501: 재고 동기화 - 로그 정리", "PAY-1500: 할인 - 쿠폰 계산"],
      patch: { text: "diff --git a/a.ts b/a.ts\n+x\n", lines: 2, truncated: false },
      files: [{ path: "a.ts", oldPath: null, status: "M", added: 1, deleted: 0, isBinary: false }],
    });
    expect(p).toContain("Branch: feature/PAY-1502");
    expect(p).toContain('"PAY-1502: "');
    expect(p).toContain("- PAY-1501: 재고 동기화 - 로그 정리");
    expect(p).toContain("```diff\ndiff --git a/a.ts b/a.ts\n+x\n```");
    expect(p).toMatch(/commit message only/i);
    const bare = commitDraftPrompt({ branch: null, template: null, subjects: [], patch: { text: "", lines: 0, truncated: true }, files: [{ path: "b.png", oldPath: null, status: "A", added: 0, deleted: 0, isBinary: true }] });
    expect(bare).not.toContain("template");
    expect(bare).not.toContain("Recent commit subjects");
    expect(bare).toContain("(detached HEAD)");
    expect(bare).toContain("- b.png (A, binary)");
  });
});

describe("roundPatch", () => {
  it("concatenates the files' A → B patches in order and cuts after maxLines with the file list", async () => {
    const dir = realpathSync(makeTempDir("rg-patch"));
    dirs.push(dir);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "T");
    write(dir, "a.txt", "1\n2\n3\n");
    write(dir, "b.txt", "x\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "init");
    const cp = await openCheckpoint(dir);
    const start = await cp.snapshot([]);
    write(dir, "a.txt", "1\nTWO\n3\n");
    write(dir, "b.txt", "x\ny\nz\n");
    const end = await cp.snapshot([]);
    const files = (await cp.changes(start, end)).sort((p, q) => p.path.localeCompare(q.path));
    const full = await roundPatch(cp, start, end, files, 100);
    expect(full.truncated).toBe(false);
    expect(full.text.indexOf("+TWO")).toBeGreaterThan(0);
    expect(full.text.indexOf("+z")).toBeGreaterThan(full.text.indexOf("+TWO"));
    const cut = await roundPatch(cp, start, end, files, 6);
    expect(cut.truncated).toBe(true);
    expect(cut.text.split("\n").length).toBeLessThanOrEqual(6 + 1);
    expect(cut.text).not.toContain("+z");
    expect(fileListLines(files)).toEqual(["- a.txt (M, +1 −1)", "- b.txt (M, +2 −0)"]);
  });
});
