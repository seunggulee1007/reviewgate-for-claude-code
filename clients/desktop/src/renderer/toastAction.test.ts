import { afterEach, describe, expect, it, vi } from "vitest";
import { TOAST_ACTION_MS, TOAST_MS, useToast } from "./toast";

// polish p-foundation — P4-composer-09: a toast may carry one action ("대기열에서 2개를 지웠어요 · 실행 취소").

afterEach(() => vi.useRealTimers());

describe("the toast", () => {
  it("an action stays longer, runs once and closes the toast", () => {
    vi.useFakeTimers();
    let runs = 0;
    useToast.getState().show("대기열에서 2개를 지웠어요", { action: { label: "실행 취소", run: () => runs++ } });
    vi.advanceTimersByTime(TOAST_MS + 100);
    expect(useToast.getState().text).toBe("대기열에서 2개를 지웠어요");
    useToast.getState().runAction();
    useToast.getState().runAction();
    expect(runs).toBe(1);
    expect(useToast.getState().text).toBeNull();
    useToast.getState().show("저장했어요", { action: { label: "실행 취소", run: () => runs++ } });
    vi.advanceTimersByTime(TOAST_ACTION_MS + 100);
    expect(useToast.getState().text).toBeNull();
    expect(runs).toBe(1);
  });

  it("a toast without an action has none", () => {
    useToast.getState().show("복사됨");
    expect(useToast.getState().action).toBeNull();
    useToast.getState().hide();
  });
});
