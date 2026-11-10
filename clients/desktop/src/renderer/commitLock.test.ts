import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { commitLockReason } from "./commitLock";
import { initI18n } from "./i18n";

// polish p-foundation — P5-sheets-12: the commit button's reason, in the Mac's order (Core `commitLockReason`).

const gate = (phase: string, collectError: string | null = null) => ({ gate: { phase, collectError } }) as unknown as Pick<ReviewState, "gate">;

describe("why the commit waits", () => {
  beforeAll(() => initI18n("ko", "win32"));
  afterAll(() => initI18n("en", "darwin"));

  it("a failed collection, then a revert, then a turn or its collection; idle: nothing", () => {
    expect(commitLockReason(gate("collect_failed"))).toBe("변경 수집을 먼저 다시 시도하세요");
    // A collection error left on another phase still says Retry first.
    expect(commitLockReason(gate("running", "git status failed"))).toBe("변경 수집을 먼저 다시 시도하세요");
    expect(commitLockReason(gate("reverting"))).toBe("되돌리는 중…");
    expect(commitLockReason(gate("running"))).toBe("Claude가 작업 중입니다 — 턴이 끝날 때까지 기다리세요");
    expect(commitLockReason(gate("collecting"))).toBe("Claude가 작업 중입니다 — 턴이 끝날 때까지 기다리세요");
    expect(commitLockReason(gate("idle"))).toBeNull();
    expect(commitLockReason(gate("reviewing"))).toBeNull();
  });
});
