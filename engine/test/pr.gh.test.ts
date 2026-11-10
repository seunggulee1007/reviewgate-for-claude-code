import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { allLines, parseUnifiedDiff } from "../src/diff/parse.js";
import {
  GHClient,
  GHError,
  decodeComments,
  decodeDetail,
  decodeFiles,
  decodeReviews,
  decodeSearch,
  encodeReviewRequest,
} from "../src/pr/gh.js";
import { summaryId, type DraftComment } from "../src/pr/models.js";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "gh", name));

// Port of Core/Tests/ReviewGateCoreTests/GHClientTests.swift (10 fixture tests + live).
describe("GHClient decoders", () => {
  // search/issues (--paginate --slurp → array of pages)
  test("decodeSearchSlurpedPages", () => {
    const list = decodeSearch(fixture("search-slurped.json"), "github.com");
    expect(list).toHaveLength(3);
    expect(list[0].number).toBe(5);
    expect(list[0].repo).toBe("acme/widgets");
    expect(list[0].host).toBe("github.com");
    expect(list[0].author).toBe("alice");
    expect(list[0].url).toBe("https://github.com/acme/widgets/pull/5");
    expect(list[0].isDraft).toBe(false);
    expect(summaryId(list[0])).toBe("github.com/acme/widgets#5");
    expect(list[1].repo).toBe("team/svc"); // GHE `/api/v3/repos/` form
    expect(list[1].isDraft).toBe(true);
    expect(list[2].isDraft).toBe(false); // missing `draft`
    expect(list[2].author).toBe("carol");
    expect(list[0].updatedAt).toBe("2026-09-07T11:15:09Z");
    expect(Date.parse(list[0].updatedAt)).toBe(Date.UTC(2026, 8, 7, 11, 15, 9));
  });

  test("decodeSearchSingleObject", () => {
    const list = decodeSearch(fixture("search-single.json"), "github.com");
    expect(list.map((s) => s.repo)).toEqual(["a/b"]);
  });

  // gh pr view --json
  test("decodeDetail", () => {
    const d = decodeDetail(fixture("detail.json"));
    expect(d.number).toBe(5);
    expect(d.author).toBe("alice");
    expect(d.body).toBe("Hello\n\nworld");
    expect([d.headRefName, d.baseRefName]).toEqual(["feat/x", "main"]);
    expect(d.headRefOid).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(d.reviewDecision).toBe("CHANGES_REQUESTED");
    expect([d.additions, d.deletions, d.changedFiles]).toEqual([1029, 22, 9]);
    expect(d.state).toBe("OPEN");
  });

  test("decodeDetailWithEmptyReviewDecision", () => {
    const d = decodeDetail(fixture("detail-empty-decision.json"));
    expect(d.reviewDecision).toBe("");
  });

  // pulls/N/files
  test("decodeFilesSlurpedAndPatchParses", () => {
    const files = decodeFiles(fixture("files-slurped.json"));
    expect(files).toHaveLength(3);
    expect([files[0].filename, files[0].status]).toEqual(["README.md", "modified"]);
    expect([files[0].additions, files[0].deletions]).toEqual([1, 1]);
    expect(files[1].previousFilename).toBe("old/name.swift");
    expect(files[1].patch).toBeNull();
    expect(files[2].patch).toBeNull();

    const diff = parseUnifiedDiff(files[0].patch!);
    expect(diff.hunks).toHaveLength(1);
    const all = allLines(diff);
    expect(all.map((l) => l.kind)).toEqual(["hunkHeader", "context", "del", "add"]);
    expect(all[2].oldNo).toBe(2);
    expect(all[3].newNo).toBe(2);
  });

  test("decodeFilesNonSlurped", () => {
    const files = decodeFiles(fixture("files-single.json"));
    expect(files.map((f) => f.filename)).toEqual(["a.txt"]);
  });

  // pulls/N/comments
  test("decodeComments", () => {
    const list = decodeComments(fixture("comments-slurped.json"));
    expect(list).toHaveLength(4);
    expect(list[0].id).toBe(1001);
    expect(list[0].author).toBe("review-bot[bot]");
    expect([list[0].line, list[0].side, list[0].startLine]).toEqual([30, "RIGHT", null]);
    expect(list[0].inReplyTo).toBeNull();
    expect(list[0].diffHunk.startsWith("@@ -10,6 +10,51 @@")).toBe(true);
    expect(list[1].inReplyTo).toBe(1001);
    expect(list[2].line).toBeNull();
    expect([list[3].side, list[3].startLine, list[3].line]).toEqual(["LEFT", 18, 20]);
  });

  // pulls/N/reviews
  test("decodeReviews", () => {
    const list = decodeReviews(fixture("reviews-slurped.json"));
    expect(list).toHaveLength(2);
    expect([list[0].author, list[0].state]).toEqual(["review-bot[bot]", "CHANGES_REQUESTED"]);
    expect(list[0].submittedAt).not.toBeNull();
    expect([list[1].state, list[1].submittedAt, list[1].body]).toEqual(["PENDING", null, ""]);
  });

  // POST pulls/N/reviews body
  test("encodeReviewRequest", () => {
    const drafts: DraftComment[] = [
      { id: "1", path: "src/a.swift", line: 12, side: "RIGHT", startLine: null, body: "nit" },
      { id: "2", path: "src/b.swift", line: 8, side: "LEFT", startLine: 5, body: "why?" },
    ];
    const data = encodeReviewRequest({ commitId: "deadbeef", event: "REQUEST_CHANGES", body: "Overall", comments: drafts });
    const obj = JSON.parse(data.toString("utf8"));
    expect(obj.commit_id).toBe("deadbeef");
    expect(obj.event).toBe("REQUEST_CHANGES");
    expect(obj.body).toBe("Overall");
    const comments = obj.comments as Record<string, unknown>[];
    expect(comments).toHaveLength(2);
    expect(comments[0].path).toBe("src/a.swift");
    expect(comments[0].line).toBe(12);
    expect(comments[0].side).toBe("RIGHT");
    expect(comments[0].start_line).toBeUndefined();
    expect(comments[0].start_side).toBeUndefined();
    expect(comments[0].body).toBe("nit");
    expect(comments[1].start_line).toBe(5);
    expect(comments[1].start_side).toBe("LEFT");
    expect(comments[1].side).toBe("LEFT");
    expect(new Set(Object.keys(comments[0]))).toEqual(new Set(["path", "line", "side", "body"]));
  });

  test("ghErrorDescriptionIsStderrVerbatim", () => {
    const e = new GHError(1, "error connecting to ghe.example.com\ncheck your internet connection\n", ["api"]);
    expect(e.message).toBe("error connecting to ghe.example.com\ncheck your internet connection");
    const empty = new GHError(4, "", ["pr", "view"]);
    expect(empty.message).toBe("gh pr view exited with status 4");
  });
});

// Live (GH_LIVE=1): runs the real `gh` against github.com to confirm the decoders match GitHub's actual output.
describe.runIf(process.env.GH_LIVE === "1")("GHClient live", () => {
  test("liveGitHubDotCom", async () => {
    const gh = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find((p) => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    expect(gh).toBeDefined();
    const env = { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` };
    const client = new GHClient(gh!, "github.com", env);

    const mine = await client.myOpenPRs();
    const requested = await client.reviewRequestedPRs();
    console.log(`GH_LIVE mine=${mine.length} reviewRequested=${requested.length}`);
    for (const p of mine.slice(0, 3)) console.log(`  ${p.repo}#${p.number} ${p.author} ${p.updatedAt} ${p.title}`);
    expect(mine.every((p) => p.repo.split("/").length === 2)).toBe(true);
    expect(mine.length).toBeGreaterThanOrEqual(1);

    const first = mine[0] ?? requested[0];
    if (!first) return;
    const detail = await client.detail(first.repo, first.number);
    expect(detail.number).toBe(first.number);
    expect(detail.headRefOid).toHaveLength(40);

    const files = await client.files(first.repo, first.number);
    console.log(`GH_LIVE files=${files.length} changedFiles=${detail.changedFiles}`);
    expect(files).toHaveLength(detail.changedFiles);
    expect(files.reduce((n, f) => n + f.additions, 0)).toBe(detail.additions);
    expect(files.reduce((n, f) => n + f.deletions, 0)).toBe(detail.deletions);
    for (const f of files) {
      if (f.patch === null) continue;
      const all = allLines(parseUnifiedDiff(f.patch));
      expect(all.filter((l) => l.kind === "add").length, `${f.filename} adds`).toBe(f.additions);
      expect(all.filter((l) => l.kind === "del").length, `${f.filename} dels`).toBe(f.deletions);
    }

    const comments = await client.comments(first.repo, first.number);
    const reviews = await client.reviews(first.repo, first.number);
    console.log(`GH_LIVE comments=${comments.length} reviews=${reviews.length}`);
    expect(comments.every((c) => c.path.length > 0 && c.author.length > 0)).toBe(true);
    expect(reviews.every((r) => r.state.length > 0)).toBe(true);
  }, 120_000);
});
