import { describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { stopReasonWords } from "./stopWords";

// wave4b w4b-check4 — docs/PROTOCOL.md §40.1: the turn-end line's stop reason in words (as on the Mac, Check4Tests.swift).

describe("stopReasonWords", () => {
  it("the CLI's and the engine's stop reasons in words; an unknown one as it came", () => {
    initI18n("en", "darwin");
    expect(stopReasonWords("success")).toBe("Finished");
    expect(stopReasonWords("ended")).toBe("Finished");
    expect(stopReasonWords("interrupted")).toBe("Stopped by you");
    expect(stopReasonWords("error_max_turns")).toBe("Stopped at the tool-call limit");
    expect(stopReasonWords("error_max_budget_usd")).toBe("Stopped at the cost limit");
    expect(stopReasonWords("error_during_execution")).toBe("Stopped by an error");
    expect(stopReasonWords("chat moved")).toBe("Stopped — the chat moved to another worktree");
    expect(stopReasonWords("something_new")).toBe("something_new");
  });

  it("in Korean, the same words as the stop reasons' list", () => {
    initI18n("ko", "darwin");
    expect(stopReasonWords("error_max_turns")).toBe("도구 호출 한도에 닿아 멈췄어요");
    expect(stopReasonWords("interrupted")).toBe("사용자가 중지");
    expect(stopReasonWords("success")).toBe("완료");
    initI18n("en", "darwin");
  });
});
