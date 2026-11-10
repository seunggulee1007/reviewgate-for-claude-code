import { describe, expect, it } from "vitest";
import { prCreateArgs } from "../src/pr/create.js";
import { branchIssue, learnCommitFormat, prDraftFrom } from "../src/review/commitFormat.js";

describe("prCreateArgs metadata (§41.1)", () => {
  it("adds one --flag=value per assignee / label / reviewer / project; blank and over-long values are dropped", () => {
    const remote = { host: "ghe.example.com", owner: "acme", repo: "app" };
    const args = prCreateArgs(remote, {
      branch: "feature/PAY-1800-2",
      base: "develop",
      title: "PAY-1800: 재고 동기화",
      body: "- a",
      assignees: ["@me", " "],
      labels: ["bug", "-x"],
      reviewers: ["kim"],
      projects: ["Acme 2026", "p".repeat(300)],
    });
    expect(args).toEqual([
      "pr", "create", "--repo", "ghe.example.com/acme/app", "--head", "feature/PAY-1800-2", "--base", "develop",
      "--title", "PAY-1800: 재고 동기화", "--body", "- a",
      "--assignee=@me", "--label=bug", "--label=-x", "--reviewer=kim", "--project=Acme 2026",
    ]);
    expect(prCreateArgs(remote, { branch: "b", base: "main" })).toEqual(["pr", "create", "--repo", "ghe.example.com/acme/app", "--head", "b", "--base", "main", "--fill"]);
  });
});

/** docs/PROTOCOL.md §41.1 (market-10): the team's commit format learned from the recent subjects, the branch's issue, the PR draft. */

describe("learnCommitFormat (§41.1)", () => {
  it("learns '#repo/123/title - summary' and keeps the repository segment", () => {
    const f = learnCommitFormat([
      "#shop/1800/장바구니 합계 수정 - 중복 할인 방지",
      "#shop/1400/주문 마감 - 할인 계산 오류 수정",
      "#shop/1301/반품 신청 화면 개선",
      "오타 수정",
      "#shop/1300/상품 목록 - 품절 상품 노출",
    ]);
    expect(f?.kind).toBe("path");
    expect(f?.template).toBe("#shop/{issue}/{title} - {summary}");
    expect(f?.examples).toEqual([
      "#shop/1800/장바구니 합계 수정 - 중복 할인 방지",
      "#shop/1400/주문 마감 - 할인 계산 오류 수정",
      "#shop/1301/반품 신청 화면 개선",
      "#shop/1300/상품 목록 - 품절 상품 노출",
    ]);
    expect(f?.issues).toEqual(["1800", "1400", "1301", "1300"]);
    expect(f?.matched).toBe(4);
    expect(f?.total).toBe(5);
  });

  it("drops ' - {summary}' when most subjects have none, and keeps the separator after the number", () => {
    expect(learnCommitFormat(["#shop/12/a", "#shop/13/b - c", "#shop/14/d"])?.template).toBe("#shop/{issue}/{title}");
    expect(learnCommitFormat(["#web/5: a", "#web/6: b"])?.template).toBe("#web/{issue}: {title}");
  });

  it("learns '[ABC-123] title' and 'ABC-123: title' with the Jira key kept", () => {
    const f = learnCommitFormat(["[PAY-120] 결제 재시도", "[PAY-119] 환불 API 추가", "[OPS-1] 배포 스크립트"]);
    expect(f?.kind).toBe("key");
    expect(f?.template).toBe("[PAY-{issue}] {title}");
    expect(f?.examples).toEqual(["[PAY-120] 결제 재시도", "[PAY-119] 환불 API 추가"]);
    expect(learnCommitFormat(["PAY-12: fix", "PAY-11: add", "PAY-10: x"])?.template).toBe("PAY-{issue}: {title}");
  });

  it("learns '#123 title' / '[#123] title'", () => {
    expect(learnCommitFormat(["#12 fix login", "#11 add page"])?.template).toBe("#{issue} {title}");
    expect(learnCommitFormat(["[#12] fix login", "[#11] add page"])?.template).toBe("[#{issue}] {title}");
  });

  it("learns conventional commits, with a scope when most have one", () => {
    const f = learnCommitFormat(["feat(engine): a", "fix(app): b", "test(engine): c", "chore: 0.2.7"]);
    expect(f?.kind).toBe("conventional");
    expect(f?.template).toBe("{type}({scope}): {summary}");
    expect(f?.issues).toEqual([]);
    expect(learnCommitFormat(["feat: a", "fix: b", "docs(x): c"])?.template).toBe("{type}: {summary}");
  });

  it("finds no format in free subjects, in too few matches and in an empty log; skips merges, reverts and fixups", () => {
    expect(learnCommitFormat(["Fix the login", "Add a page", "Update README"])).toBeNull();
    expect(learnCommitFormat(["#shop/1/a", "free 1", "free 2", "free 3", "free 4", "free 5"])).toBeNull();
    expect(learnCommitFormat([])).toBeNull();
    expect(learnCommitFormat(["#shop/1/only one"])?.template).toBe("#shop/{issue}/{title}");
    const f = learnCommitFormat(['Revert "#shop/1/a"', "fixup! #shop/2/b", "Merge branch 'develop'", "#shop/3/c", "#shop/4/d"]);
    expect(f?.total).toBe(2);
    expect(f?.examples).toEqual(["#shop/3/c", "#shop/4/d"]);
  });

  it("follows the most used repository segment and keeps at most five examples", () => {
    const f = learnCommitFormat(["#shop/1/a", "#other/2/b", "#shop/3/c", "#shop/4/d", "#shop/5/e", "#shop/6/f", "#shop/7/g"]);
    expect(f?.template).toBe("#shop/{issue}/{title}");
    expect(f?.examples).toHaveLength(5);
    expect(f?.examples[0]).toBe("#shop/1/a");
  });
});

describe("branchIssue (§41.1)", () => {
  it("is the number the recent subjects already use, else the longest run of digits (the first of equals)", () => {
    expect(branchIssue("feature/PAY-1800-2")).toBe("1800");
    expect(branchIssue("feature/PAY-1100-2", ["2", "1"])).toBe("2");
    expect(branchIssue("feature/PAY-1502")).toBe("1502");
    expect(branchIssue("fix/PROJ-12-part-3")).toBe("12");
    expect(branchIssue("fix/12-34")).toBe("12");
    expect(branchIssue("main")).toBe("");
    expect(branchIssue(null)).toBe("");
  });
});

describe("prDraftFrom (§41.1)", () => {
  it("one commit: its subject; several: their shared title before ' - ', else the oldest; the body lists them oldest first", () => {
    expect(prDraftFrom(["PAY-1800: 재고 동기화 - 중복 방지"])).toEqual({ title: "PAY-1800: 재고 동기화 - 중복 방지", body: "- PAY-1800: 재고 동기화 - 중복 방지" });
    expect(prDraftFrom(["PAY-1800: 재고 동기화 - 중복 방지", "PAY-1800: 재고 동기화 - 테스트 추가"])).toEqual({
      title: "PAY-1800: 재고 동기화",
      body: "- PAY-1800: 재고 동기화 - 중복 방지\n- PAY-1800: 재고 동기화 - 테스트 추가",
    });
    expect(prDraftFrom(["PAY-1800: 재고 동기화 - 중복 방지", "PAY-1800: 코드 정리"]).title).toBe("PAY-1800: 재고 동기화 - 중복 방지");
    expect(prDraftFrom([])).toEqual({ title: "", body: "" });
  });
});
