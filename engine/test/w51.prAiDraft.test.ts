import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cutPatch, findPRTemplate, parsePRAiDraft, PR_AI_DRAFT_HEADER, PR_AI_DRAFT_SYSTEM, PR_AI_TITLE_MAX } from "../src/review/prAiDraft.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { FakeSide, makeSideRepo, type SideScript } from "./helpers/fakeSide.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §51: "AI로 채우기" in the PR sheet — a read-only fork writes the PR's title and description. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function setup(script: SideScript) {
  const sides: FakeSide[] = [];
  const h = makeHarness({ sideQueryFactory: (o) => {
    const f = new FakeSide(o, script);
    sides.push(f);
    return f;
  } });
  harnesses.push(h);
  return { h, sides };
}

/** `main` (also as origin/main), then feature/PAY-42 with two commits that change the cart. */
function branchRepo(): string {
  const dir = makeSideRepo("rg-prai");
  dirs.push(dir);
  sh(dir, "update-ref", "refs/remotes/origin/main", "main");
  sh(dir, "switch", "-q", "-c", "feature/PAY-42");
  write(dir, "cart.ts", "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n");
  sh(dir, "add", "cart.ts");
  sh(dir, "commit", "-q", "-m", "PAY-42: 장바구니 합계 수정", "-m", "할인 전 금액으로 더하던 것을 고침");
  write(dir, "cart.test.ts", "// total\n");
  sh(dir, "add", "cart.test.ts");
  sh(dir, "commit", "-q", "-m", "PAY-42: 테스트 추가");
  return dir;
}

/** A turn so the main session has an id to fork. */
async function oneTurn(h: Harness): Promise<void> {
  await h.engine.handle({ type: "send", text: "장바구니 합계 고쳐줘" });
  h.session().emitSessionInfo();
  h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-1" });
  await h.settle();
}

describe("§51 pr_ai_draft", () => {
  it("a read-only fork gets the commits, the diff, the template and the sheet's draft; the reply is the parsed title and body", async () => {
    const dir = branchRepo();
    mkdirSync(join(dir, ".github"));
    write(dir, ".github/PULL_REQUEST_TEMPLATE.md", "## 변경 내용\n\n## 테스트\n- [ ] 단위 테스트\n");
    const { h, sides } = setup(() => ({ text: "TITLE: PAY-42: 장바구니 합계 수정\nBODY:\n## 변경 내용\n- 할인 후 금액으로 합계\n\n## 테스트\n- [x] 단위 테스트", cost: 0.01 }));
    await h.hello();
    await h.open(dir);
    await oneTurn(h);
    const head = sh(dir, "rev-parse", "HEAD").trim();
    const reply = await h.engine.request({ type: "pr_ai_draft", base: "main", title: "PAY-42: 장바구니 합계 수정", body: "- PAY-42: 장바구니 합계 수정\n- PAY-42: 테스트 추가" });
    expect(reply).toMatchObject({ type: "pr_ai_draft", title: "PAY-42: 장바구니 합계 수정", body: "## 변경 내용\n- 할인 후 금액으로 합계\n\n## 테스트\n- [x] 단위 테스트" });
    const o = sides[0]!.opts;
    expect(o.forkFrom).toBe("sess-1");
    expect(o.persistSession).toBe(false);
    expect(o.allowWeb).toBe(false);
    expect(o.system).toBe(PR_AI_DRAFT_SYSTEM);
    expect(o.prompt.startsWith(PR_AI_DRAFT_HEADER)).toBe(true);
    expect(o.prompt).toContain("branch feature/PAY-42, to be merged into origin/main");
    // Whole commit messages, oldest first.
    expect(o.prompt).toContain("PAY-42: 장바구니 합계 수정\n\n할인 전 금액으로 더하던 것을 고침");
    expect(o.prompt.indexOf("장바구니 합계 수정\n\n할인")).toBeLessThan(o.prompt.indexOf("PAY-42: 테스트 추가"));
    expect(o.prompt).toContain("(.github/PULL_REQUEST_TEMPLATE.md)");
    expect(o.prompt).toContain("- [ ] 단위 테스트");
    expect(o.prompt).toContain("+export const total");
    expect(o.prompt).toContain("cart.test.ts");
    expect(o.prompt).toContain("Title: PAY-42: 장바구니 합계 수정");
    // Nothing committed or pushed; the main conversation untouched; the cost on the side meter.
    expect(sh(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(h.session().sends).toHaveLength(1);
    await h.settle();
    expect(h.engine.state.hud.sideCostUSD).toBeCloseTo(0.01);
  });

  it("refuses a blank base, a base with no ref, a branch with no commits since it, a failed fork and an empty answer", async () => {
    const dir = branchRepo();
    let answer: { text: string; error?: string } = { text: "", error: "boom: the side session crashed" };
    const { h, sides } = setup(() => answer);
    await h.hello();
    await h.open(dir);
    await oneTurn(h);
    await expect(h.engine.request({ type: "pr_ai_draft", base: " " })).rejects.toThrow(/empty base/);
    await expect(h.engine.request({ type: "pr_ai_draft", base: "release" })).rejects.toThrow(/^pr_ai_draft_failed:no release to compare with$/);
    await expect(h.engine.request({ type: "pr_ai_draft", base: "feature/PAY-42" })).rejects.toThrow(/^pr_ai_draft_failed:no commits since feature\/PAY-42$/);
    expect(sides).toHaveLength(0);
    await expect(h.engine.request({ type: "pr_ai_draft", base: "main" })).rejects.toThrow(/^pr_ai_draft_failed:boom: the side session crashed$/);
    answer = { text: " \n " };
    await expect(h.engine.request({ type: "pr_ai_draft", base: "main" })).rejects.toThrow(/^pr_ai_draft_failed:empty answer$/);
    // No template, no draft in the sheet: the prompt asks for a summary, the changes and how it was checked.
    answer = { text: "Summary only" };
    expect(await h.engine.request({ type: "pr_ai_draft", base: "main" })).toMatchObject({ title: "", body: "Summary only" });
    const last = sides.at(-1)!.opts.prompt;
    expect(last).not.toContain("pull request template");
    expect(last).not.toContain("The draft in the pull request sheet now");
    expect(last).toContain("how it was tested");
  });
});

describe("§51 helpers", () => {
  it("parsePRAiDraft reads TITLE / BODY, a fence around the answer, bold labels; without TITLE all is the body", () => {
    expect(parsePRAiDraft("TITLE: Fix the cart\nBODY:\n## Summary\n- a")).toEqual({ title: "Fix the cart", body: "## Summary\n- a" });
    expect(parsePRAiDraft("Here it is:\n```\nTITLE: \"Fix the cart\"\nBODY: one line\nmore\n```")).toEqual({ title: "Fix the cart", body: "one line\nmore" });
    expect(parsePRAiDraft("**Title:** Fix\n**Body:**\ntext")).toEqual({ title: "Fix", body: "text" });
    expect(parsePRAiDraft("Title: Fix\n\nno body label")).toEqual({ title: "Fix", body: "no body label" });
    expect(parsePRAiDraft("Just a description")).toEqual({ title: "", body: "Just a description" });
    expect(parsePRAiDraft(`TITLE: ${"x".repeat(400)}\nBODY:\nb`).title).toHaveLength(PR_AI_TITLE_MAX);
  });

  it("findPRTemplate looks in .github, the root, docs, then the template folder — any case", async () => {
    const dir = makeTempDir("rg-prtpl");
    dirs.push(dir);
    expect(await findPRTemplate(dir)).toBeNull();
    mkdirSync(join(dir, ".github", "PULL_REQUEST_TEMPLATE"), { recursive: true });
    write(dir, ".github/PULL_REQUEST_TEMPLATE/feature.md", "feature\n");
    expect(await findPRTemplate(dir)).toEqual({ path: ".github/PULL_REQUEST_TEMPLATE/feature.md", text: "feature\n" });
    mkdirSync(join(dir, "docs"));
    write(dir, "docs/pull_request_template.md", "docs\n");
    expect((await findPRTemplate(dir))?.path).toBe("docs/pull_request_template.md");
    write(dir, "Pull_Request_Template.md", "root\n");
    expect((await findPRTemplate(dir))?.path).toBe("Pull_Request_Template.md");
    write(dir, ".github/pull_request_template.md", "  \n");   // blank: skipped
    expect((await findPRTemplate(dir))?.path).toBe("Pull_Request_Template.md");
    write(dir, ".github/pull_request_template.md", "github\n");
    expect((await findPRTemplate(dir))?.path).toBe(".github/pull_request_template.md");
  });

  it("cutPatch keeps the first lines and says it cut", () => {
    expect(cutPatch("a\nb\n", 5)).toEqual({ text: "a\nb\n", truncated: false, lines: 3 });
    expect(cutPatch("a\nb\nc\nd", 2)).toEqual({ text: "a\nb\n", truncated: true, lines: 2 });
  });
});
