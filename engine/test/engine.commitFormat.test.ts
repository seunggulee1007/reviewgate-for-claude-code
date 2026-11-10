import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { FakeSide, makeSideRepo, type SideScript } from "./helpers/fakeSide.js";
import { removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §41.1 (market-10): the team's commit format through the engine — `commit_format`, `commit_draft`, `pr_draft`. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function setup(script: SideScript = () => ({ text: "PAY-1800: 재고 동기화 - 중복 방지" })) {
  const sides: FakeSide[] = [];
  const h = makeHarness({ sideQueryFactory: (o) => {
    const f = new FakeSide(o, script);
    sides.push(f);
    return f;
  } });
  harnesses.push(h);
  return { h, sides };
}

/** An acme-style history and the branch feature/PAY-1800-2. */
function acmeRepo(): string {
  const dir = makeSideRepo("rg-format");
  dirs.push(dir);
  for (const s of ["PAY-1301: 반품 신청 - 화면 개선", "PAY-1400: 주문 마감 - 할인 계산 오류 수정", "오타 수정"]) sh(dir, "commit", "-q", "--allow-empty", "-m", s);
  sh(dir, "switch", "-q", "-c", "feature/PAY-1800-2");
  return dir;
}

describe("§41.1 commit_format", () => {
  it("learns the format from the recent subjects and the issue from the branch (not its last number)", async () => {
    const dir = acmeRepo();
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    const reply = await h.engine.request({ type: "commit_format" });
    expect(reply).toMatchObject({
      type: "commit_format",
      learned: "PAY-{issue}: {title} - {summary}",
      kind: "key",
      examples: ["PAY-1400: 주문 마감 - 할인 계산 오류 수정", "PAY-1301: 반품 신청 - 화면 개선"],
      issue: "1800",
      branch: "feature/PAY-1800-2",
      effective: "PAY-1800: {title} - {summary}",
      source: "learned",
    });
    // The project's own template wins; the learned one is still offered.
    await h.engine.request({ type: "set_settings", settings: { commitTemplate: "[{issue}] " } });
    expect(await h.engine.request({ type: "commit_format" })).toMatchObject({ learned: "PAY-{issue}: {title} - {summary}", effective: "[1800] ", source: "settings" });
  });

  it("commit_draft without a template asks for the learned format with its examples", async () => {
    const dir = acmeRepo();
    const { h, sides } = setup();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "재고 동기화 고쳐" });
    h.session().emitSessionInfo();
    write(dir, "README.md", "line1\nline2 changed\nline3\n");
    h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-1" });
    await h.waitFor((s) => s.gate.phase === "reviewing" && s.changedFiles.length === 1, "review");
    await h.engine.request({ type: "accept", paths: ["README.md"] });
    await h.settle();
    expect((await h.engine.request({ type: "commit_draft" })).message).toBe("PAY-1800: 재고 동기화 - 중복 방지");
    const prompt = sides[0]!.opts.prompt;
    expect(prompt).toContain(`the team's format, learned from the recent subjects; start the message with it and follow its pattern: "PAY-1800: {title} - {summary}"`);
    expect(prompt).toContain("Replace each placeholder in braces");
    expect(prompt).toContain("Examples of this format from the repository (newest first):\n- PAY-1400: 주문 마감 - 할인 계산 오류 수정");
  });
});

describe("§41.1 /clear (SME-11)", () => {
  it("is the app's new chat — the CLI never gets it, the earlier chat stays in the list", async () => {
    const dir = acmeRepo();
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "첫 질문" });
    h.session().emitSessionInfo();
    h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-1" });
    await h.waitFor((s) => s.gate.canSend, "idle");
    const first = h.engine.state.sessions.currentId!;
    const firstSession = h.session();
    await h.engine.request({ type: "send", text: " /clear " });
    await h.waitFor((s) => s.sessions.currentId !== first && !s.session.starting, "new chat");
    expect(firstSession.sends.map((s) => s.text)).toEqual(["첫 질문"]);
    expect(h.session()).not.toBe(firstSession);
    expect(h.session().sends).toEqual([]);
    expect(h.engine.state.sessions.list.some((m) => m.id === first)).toBe(true);
    expect(h.engine.state.gate.phase).not.toBe("running");
  });
});

describe("§41.1 pr_draft", () => {
  it("drafts the title / body from the branch's commits since the base, says a push comes first, and that gh is missing", async () => {
    const dir = acmeRepo();
    sh(dir, "commit", "-q", "--allow-empty", "-m", "PAY-1800: 재고 동기화 - 중복 방지");
    sh(dir, "commit", "-q", "--allow-empty", "-m", "PAY-1800: 재고 동기화 - 테스트 추가");
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    const reply = await h.engine.request({ type: "pr_draft", base: "main" });
    expect(reply).toEqual({
      type: "pr_draft",
      id: expect.any(String),
      title: "PAY-1800: 재고 동기화",
      body: "- PAY-1800: 재고 동기화 - 중복 방지\n- PAY-1800: 재고 동기화 - 테스트 추가",
      commits: ["PAY-1800: 재고 동기화 - 중복 방지", "PAY-1800: 재고 동기화 - 테스트 추가"],
      baseRef: "main",
      hasUpstream: false,
      gh: "not_found",
      host: null,
    });
    expect((await h.engine.request({ type: "pr_draft", base: "nope" })).baseRef).toBeNull();
    await expect(h.engine.request({ type: "pr_draft", base: " " })).rejects.toThrow(/empty base/);
  });
});
