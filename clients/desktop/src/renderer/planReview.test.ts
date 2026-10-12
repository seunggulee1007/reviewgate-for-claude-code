import { beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { planHandoffBlocker, planHandoffLine, planNoteCount, planNotesMessage, planSourceTitle, suggestPlanBranch, unplannedBadge, unplannedChip, unplannedTitle } from "./planReview";

/** MARK: wave4d w4d-plan — §42.1: the Mac's Core PlanReviewTests, same words (Korean UI). */
describe("§42.1 plan review (w4d-plan)", () => {
  beforeAll(() => initI18n("ko-KR", "darwin"));
  const steps = [{ index: 0, text: "Update FooService.java" }, { index: 1, text: "Add the mapper" }, { index: 2, text: "x".repeat(80) }];

  it("keep planning collects the step notes, then the general note", () => {
    expect(planNotesMessage(steps, { 2: "  drop it ", 1: "also FooMapper.xml", 0: "  " }, "and the tests")).toBe(
      `단계 2 (Add the mapper): also FooMapper.xml\n단계 3 (${"x".repeat(59)}…): drop it\nand the tests`,
    );
    expect(planNotesMessage(steps, {}, " only this ")).toBe("only this");
    expect(planNotesMessage(steps, { 0: " " }, "")).toBeNull();
    expect(planNoteCount({ 0: "a", 1: " ", 2: "b" })).toBe(2);
  });

  it("offers the new chat / workbench answers only to an engine that sends steps, and not while Claude works", () => {
    const plan = { path: "/p.md", plan: "1. a", at: "x" };
    expect(planHandoffBlocker(plan, false)).toBe("이 앱 버전의 엔진이 필요해요 — 프로젝트를 다시 열어 주세요");
    expect(planHandoffBlocker({ ...plan, steps: [] }, true)).toBe("Claude가 작업 중이에요 — 턴이 끝나면 답할 수 있어요");
    expect(planHandoffBlocker({ ...plan, steps: [] }, false)).toBeNull();
  });

  it("names the plan section by its source; the request's scope says 'outside the request'", () => {
    const request = { path: null, steps: [], unplannedFiles: ["a"], source: "request" as const, title: "Fix it." };
    expect(planSourceTitle(request)).toBe("요청 범위");
    expect(unplannedTitle(request)).toBe("요청 범위 밖");
    expect(unplannedChip(2, request)).toBe("요청 밖 2개");
    expect(unplannedBadge(request)).toBe("요청 범위 밖");
    const approved = { path: "/p.md", steps: [], unplannedFiles: [] };
    expect(planSourceTitle(approved)).toBe("계획 대비");
    expect(unplannedTitle(approved)).toBe("계획 외 변경");
    expect(unplannedChip(2, approved)).toBe("계획 외 2개");
    expect(planSourceTitle({ ...approved, source: "todos" })).toBe("Claude 할 일 목록 대비");
  });

  it("says where an approved plan went, and names its workbench's branch after the file", () => {
    expect(planHandoffLine({ into: "workbench", target: "/wt/feat-db" })).toBe("계획 승인됨 — 워크벤치 feat-db 에 보내 그곳에서 구현해요");
    expect(planHandoffLine({ into: "workbench", from: "C:\\work\\acme" })).toBe("acme 에서 승인한 계획을 구현해요");
    expect(planHandoffLine({ into: "new_chat" })).toBe("계획 승인됨 — 이 새 채팅에서 구현해요");
    expect(suggestPlanBranch("/Users/a/.claude/plans/DB Migration_plan.md")).toBe("plan/db-migration_plan");
    expect(suggestPlanBranch("/x/계획.md")).toBe("");
    expect(suggestPlanBranch(null)).toBe("");
  });
});
