/** wave4 w4-input (polish-14): elapsed times in the UI language, the same rule as the Mac's ElapsedFormat. */
import { afterAll, describe, expect, it } from "vitest";
import { formatDuration } from "./agents";
import { initI18n } from "./i18n";
import { formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
  afterAll(() => initI18n("en", "darwin"));

  it("stays as before in English", () => {
    initI18n("en", "darwin");
    expect(formatElapsed(0.95)).toBe("0.9s");
    expect(formatElapsed(12.34)).toBe("12s");
    expect(formatElapsed(12.34, { tenths: true })).toBe("12.3s");
    expect(formatElapsed(200)).toBe("3m 20s");
    expect(formatElapsed(245)).toBe("4m 05s");
    expect(formatElapsed(3725)).toBe("1h 02m");
    expect(formatElapsed(-3)).toBe("0.0s");
  });

  it("reads Korean units in Korean", () => {
    initI18n("ko", "darwin");
    expect(formatElapsed(0.95)).toBe("0.9초");
    expect(formatElapsed(12.34, { tenths: true })).toBe("12.3초");
    expect(formatElapsed(200)).toBe("3분 20초");
    expect(formatElapsed(245)).toBe("4분 5초");
    expect(formatElapsed(3725)).toBe("1시간 2분");
  });

  it("is what the agent cards show (the HUD's formatSeconds is formatElapsed with tenths)", () => {
    initI18n("ko", "win32");
    expect(formatDuration(200_000)).toBe("3분 20초");
    initI18n("en", "darwin");
    expect(formatDuration(75_000)).toBe("1m 15s");
  });
});
