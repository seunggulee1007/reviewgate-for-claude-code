// MARK: wave5 w5-model — §43.4 auto model, Electron words (the Mac's Core AutoModelText says the same).
import { describe, expect, it } from "vitest";
import type { AutoModelChoice, ModelOption } from "@reviewgate/engine";
import { autoModelChipHelp, autoModelChipText, autoModelCountsLine, autoModelReason, autoModelSummaryLine, autoModelSwitchLine, nextMessageLabel, oneMessageOptions } from "./autoModel";
import { sendExtras } from "./sendQueue";
import { initI18n } from "./i18n";

/** The store with the engine bridge stubbed (as composer.test.ts). */
async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), notify: async () => true, onEvent: () => () => undefined, platform: "win32" },
  };
  return (await import("./store")).useStore;
}

initI18n("ko-KR", "win32");

const design: AutoModelChoice = { model: "claude-opus-5-5", family: "opus", reason: "design", policy: "balanced", by: "auto", switched: true, from: "claude-sonnet-5-5" };

describe("§43.4 auto model words", () => {
  it("a switch is one faint line; no switch, no line", () => {
    expect(autoModelSwitchLine(design)).toBe("모델을 opus 로 바꿨어요 — 설계 판단");
    expect(autoModelSwitchLine({ ...design, switched: undefined })).toBeNull();
    expect(autoModelSwitchLine(undefined)).toBeNull();
  });
  it("the turn summary names the model and why", () => {
    expect(autoModelSummaryLine(design)).toBe("모델: opus (자동 · 설계 판단)");
    expect(autoModelSummaryLine({ model: "claude-haiku-5-5", family: "haiku", reason: "user_choice", policy: "balanced", by: "user" })).toBe("모델: haiku (이번 메시지에 직접 고름)");
    expect(autoModelSummaryLine({ model: null, reason: "manual", policy: "balanced", by: "manual" })).toBe("모델: 기본 모델 (고른 모델로 돌아감)");
  });
  it("the chip, its hover and the cost popover's counts", () => {
    expect(autoModelChipText(null)).toBe("자동");
    expect(autoModelChipText(design)).toBe("자동 · opus");
    expect(autoModelChipHelp(design, "cost")).toBe("자동이 opus 를 골랐어요 — 설계 판단 (비용 우선)");
    expect(autoModelChipHelp(null, "balanced")).toBe("메시지마다 모델을 자동으로 골라요 (균형)");
    expect(autoModelCountsLine([{ family: "opus", count: 3 }, { family: "sonnet", count: 5 }, { family: "haiku", count: 0 }])).toBe("opus 3 · sonnet 5");
    expect(autoModelCountsLine(undefined)).toBeNull();
    expect(autoModelReason("brand_new")).toBe("brand_new");
    expect(autoModelReason("after_revert")).toBe("거절·되돌리기 뒤 다시 시도");
  });
  it("the composer's one-message models: the newest of each family the session offers", () => {
    const models: ModelOption[] = [
      { value: "default", displayName: "Default", description: "", resolvedModel: "claude-sonnet-5-5" },
      { value: "claude-opus-4-1-20250805", displayName: "Opus 4.1", description: "" },
      { value: "opus", displayName: "Opus", description: "", resolvedModel: "claude-opus-5-5" },
      { value: "opus[1m]", displayName: "Opus 1M", description: "", resolvedModel: "claude-opus-5-5[1m]" },
      { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "" },
    ];
    expect(oneMessageOptions(models)).toEqual([{ family: "opus", value: "opus" }, { family: "sonnet", value: "claude-sonnet-5-5" }]);
    expect(nextMessageLabel("claude-haiku-5-5")).toBe("이번엔 haiku");
  });
  it("the chat keeps a turn's model on its user row, live and restored (older rows have none)", async () => {
    const useStore = await loadStore();
    useStore.getState().handleEvent({ type: "user_message", text: "설계해 줘", turn: 3, autoModel: design });
    expect(useStore.getState().transcript.at(-1)).toMatchObject({ kind: "user", text: "설계해 줘", autoModel: design });
    useStore.getState().handleEvent({ type: "transcript_restore", items: [{ at: "x", turn: 2, kind: "user_message", text: "old", autoModel: design }, { at: "y", turn: 3, kind: "user_message", text: "older engine" }] });
    const rows = useStore.getState().transcript.filter((r) => r.kind === "user" && (r.text === "old" || r.text === "older engine"));
    expect(rows).toEqual([
      { kind: "user", id: expect.any(Number), text: "old", turn: 2, autoModel: design },
      { kind: "user", id: expect.any(Number), text: "older engine", turn: 3 },
    ]);
  });
  it("a one-message model goes out with the message (send.model)", () => {
    expect(sendExtras({ mentions: [], model: "claude-opus-5-5" })).toEqual({ model: "claude-opus-5-5" });
    expect(sendExtras({ model: "" })).toEqual({});
  });
});
