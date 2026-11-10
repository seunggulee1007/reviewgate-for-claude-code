import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { agentWhy, planStepWhy } from "./whyQuestions";

/** MARK: wave5 w5-fixes — §43.5: '왜?' on plan steps and agent cards, the Mac's Core WhyQuestionsTests (Korean UI). */
describe("§43.5 '왜?' on plan steps and agent cards (w5-fixes)", () => {
  beforeAll(() => initI18n("ko-KR", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("a plan step is quoted and its question carries the step", () => {
    const why = planStepWhy(3, "  Update FooService.java and its mapper  ");
    expect(why.anchor).toEqual({ quote: { text: "3. Update FooService.java and its mapper", turn: null } });
    expect(why.question).toBe("계획의 3단계 「Update FooService.java and its mapper」 — 이 단계는 왜 필요하고, 지금까지 어떤 변경이 이 단계에 해당해?");
    const long = planStepWhy(1, "x".repeat(300));
    expect(long.question).toContain(`${"x".repeat(119)}…`);
    expect(long.anchor.quote!.text).toHaveLength(303);
  });

  it("an agent is asked about its call", () => {
    expect(agentWhy("toolu_01")).toEqual({ anchor: { toolUseId: "toolu_01" }, question: "이 에이전트는 왜 시작했고, 무엇을 찾거나 바꿨어?" });
  });
});
