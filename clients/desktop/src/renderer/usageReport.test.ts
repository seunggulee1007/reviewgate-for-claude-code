// docs/PROTOCOL.md §71.1: `/usage` — the terminal's Session block and the plan windows, in its shapes. As Core UsageReportTests.
import { beforeAll, describe, expect, it } from "vitest";
import type { RateLimitWindow } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { codeChangesLine, modelTokensLine, orderedWindows, resetsText, usageCost, usageDuration, usageTokens, usedText, windowTitle } from "./usageReport";

beforeAll(() => initI18n("en", "win32"));

describe("§71.1 the terminal's shapes", () => {
  it("durations, token counts, the cost and the per-model line", () => {
    expect(usageDuration(380_000)).toBe("6m 20s");
    expect(usageDuration(23_590_000)).toBe("6h 33m 10s");
    expect(usageDuration(999)).toBe("0s");
    expect(usageDuration(-5)).toBe("0s");
    expect(usageTokens(512)).toBe("512");
    expect(usageTokens(1_234)).toBe("1.2k");
    expect(usageTokens(940_000)).toBe("940.0k");
    expect(usageTokens(1_500_000)).toBe("1.5M");
    expect(usageCost(0.55)).toBe("$0.5500");
    expect(modelTokensLine({ model: "claude-sonnet-4-6", costUsd: 0.55, inputTokens: 1200, outputTokens: 5300, cacheReadTokens: 940_000, cacheCreationTokens: 50_000 }))
      .toBe("1.2k input, 5.3k output, 940.0k cache read, 50.0k cache write");
    expect(codeChangesLine(12, 3)).toBe("12 lines added, 3 lines removed");
  });

  it("the plan windows: the terminal's order and names, used and resets", () => {
    const w = (kind: string, extra: Partial<RateLimitWindow> = {}): RateLimitWindow => ({ kind, status: "allowed", at: "2026-11-27T00:00:00Z", ...extra });
    expect(orderedWindows([w("seven_day_opus"), w("zz_other"), w("seven_day"), w("five_hour")]).map((x) => x.kind)).toEqual(["five_hour", "seven_day", "seven_day_opus", "zz_other"]);
    expect(orderedWindows(undefined)).toEqual([]);
    expect(windowTitle("five_hour")).toBe("Current session (5 hours)");
    expect(windowTitle("seven_day_sonnet")).toBe("Current week (Sonnet)");
    expect(windowTitle("zz_other")).toBe("zz other");
    expect(usedText(72)).toBe("72% used");
    expect(resetsText("2026-11-27T15:00:00Z", { now: new Date("2026-11-27T10:00:00Z"), timeZone: "UTC" })).toBe("Resets 3:00 PM");
    expect(resetsText(undefined)).toBeNull();
    expect(resetsText("not a date")).toBeNull();
  });

  it("the Korean words come from the Mac's catalog", () => {
    initI18n("ko", "win32");
    try {
      expect(usageDuration(380_000)).toBe("6분 20초");
      expect(codeChangesLine(12, 3)).toBe("12줄 추가, 3줄 삭제");
      expect(windowTitle("seven_day")).toBe("이번 주(모든 모델)");
    } finally {
      initI18n("en", "win32");
    }
  });
});
