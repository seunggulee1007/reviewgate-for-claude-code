import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { planBasisMenu, planBasisFileTitle } from "./planBasis";
import { refusalCodeText } from "./errorCodes";

/** MARK: wave5 w5-fixes — §43.5: the basis menu of "plan vs actual", the Mac's Core PlanBasisTests (Korean UI). */
describe("§43.5 the plan vs actual basis menu (w5-fixes)", () => {
  beforeAll(() => initI18n("ko-KR", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  const candidates = [".omc/plans/db-migration.md", "docs/plans/batch-plan.md", "/Users/dev/.claude/plans/quiet-otter.md"];

  it("an older engine (no planSource) has no menu", () => {
    expect(planBasisMenu(undefined)).toBeNull();
  });

  it("automatic is checked and says what it follows", () => {
    const named = planBasisMenu({ kind: "file", path: ".omc/plans/db-migration.md", candidates })!;
    expect(named.label).toBe("기준: 자동 · db-migration.md");
    expect(named.items.map((i) => i.path)).toEqual([null, ...candidates]);
    expect(named.items.map((i) => i.checked)).toEqual([true, false, false, false]);
    expect(named.chosenPath).toBeNull();
    expect(named.blocker).toBeNull();
    expect(named.note).toBe("다음 턴 요약부터 이 기준과 비교해요");
    expect(named.items.map((i) => i.title)).toEqual(["자동으로 고르기", "db-migration.md  ·  .omc/plans", "batch-plan.md  ·  docs/plans", "quiet-otter.md  ·  ~/.claude/plans"]);
    expect(named.items[3]!.help).toBe("/Users/dev/.claude/plans/quiet-otter.md");
    expect(planBasisMenu({ kind: "todos", candidates })!.label).toBe("기준: 자동 · Claude 할 일 목록");
    expect(planBasisMenu({ kind: "message", candidates })!.label).toBe("기준: 자동 · 첫 메시지의 목록");
    expect(planBasisMenu({ kind: "request", candidates })!.label).toBe("기준: 자동 · 요청 범위");
    expect(planBasisMenu({ kind: null, candidates })!.label).toBe("기준: 자동");
  });

  it("a chosen file is checked, also when it is no candidate", () => {
    const chosen = planBasisMenu({ kind: "file", path: "docs/plans/batch-plan.md", chosen: true, candidates })!;
    expect(chosen.label).toBe("기준: batch-plan.md");
    expect(chosen.items.map((i) => i.checked)).toEqual([false, false, true, false]);
    expect(chosen.chosenPath).toBe("docs/plans/batch-plan.md");
    const outside = planBasisMenu({ kind: "file", path: "/work/notes/plan.md", chosen: true, candidates })!;
    expect(outside.items.map((i) => i.path)).toEqual([null, "/work/notes/plan.md", ...candidates]);
    expect(outside.items[1]).toMatchObject({ checked: true, title: "plan.md  ·  /work/notes" });
  });

  it("an approved plan decides, so nothing can be chosen", () => {
    const menu = planBasisMenu({ kind: "approved", path: "/Users/dev/.claude/plans/quiet-otter.md", candidates })!;
    expect(menu.label).toBe("기준: 승인한 계획");
    expect(menu.blocker).toBe("이 채팅은 ReviewGate 에서 승인한 계획을 따라요");
    expect(menu.items.every((i) => !i.checked)).toBe(true);
  });

  it("without plan files the note says where they come from; Windows paths read the same", () => {
    const menu = planBasisMenu({ kind: "todos", candidates: [] })!;
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]!.checked).toBe(true);
    expect(menu.note).toBe("아직 계획 파일이 없어요 — .omc/plans, .claude/plans, docs/ 의 계획 파일이 여기에 보여요");
    expect(planBasisFileTitle("plan.md")).toBe("plan.md");
    expect(planBasisFileTitle("C:\\Users\\dev\\.claude\\plans\\a.md")).toBe("a.md  ·  ~\\.claude\\plans");
  });

  it("a refused plan_follow reads in Korean", () => {
    expect(refusalCodeText("invalid_plan_file", "docs/x.md")).toBe("그 계획 파일을 더는 읽을 수 없어요 — 다른 파일을 골라 주세요");
  });
});
