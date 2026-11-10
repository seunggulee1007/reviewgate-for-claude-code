import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { isRejectShortcut, rejectBlockedText, rejectShortcutTarget } from "./rejectShortcut";

describe("polish-03: the reject shortcut never falls through to a reload", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  const state = (patch: { phase?: string; files?: { path: string; state: string }[] } = {}) =>
    ({ project: { root: "/p" }, gate: { phase: patch.phase ?? "reviewing" }, changedFiles: patch.files ?? [{ path: "a.ts", state: "pending" }] }) as unknown as ReviewState;
  const base = { selectedPath: "a.ts", tab: "changes", ui: {}, historyOpen: false, dialogOpen: false };

  it("recognizes ⌘⇧R / Ctrl+Shift+R only", () => {
    expect(isRejectShortcut({ key: "R", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(true);
    expect(isRejectShortcut({ key: "r", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false })).toBe(true);
    expect(isRejectShortcut({ key: "r", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
    expect(isRejectShortcut({ key: "r", metaKey: true, ctrlKey: false, shiftKey: true, altKey: true })).toBe(false);
  });

  it("rejects the shown pending file; otherwise says why", () => {
    expect(rejectShortcutTarget({ ...base, state: state() })).toEqual({ kind: "reject", path: "a.ts" });
    const why = (s: Parameters<typeof rejectShortcutTarget>[0]) => {
      const r = rejectShortcutTarget(s);
      return r.kind === "blocked" ? r.why : null;
    };
    expect(why({ ...base, state: state({ phase: "running" }) })).toBe("Claude가 아직 작업 중이에요");
    expect(why({ ...base, state: state({ phase: "reverting" }) })).toBe("파일을 되돌리는 중이에요");
    expect(why({ ...base, selectedPath: null, state: state() })).toBe("대기 중인 파일을 먼저 고르세요");
    expect(why({ ...base, state: state({ files: [{ path: "a.ts", state: "accepted" }] }) })).toBe("대기 중인 파일을 먼저 고르세요");
    expect(why({ ...base, tab: "prs", state: state() })).toBe("변경사항 탭에서 거절할 수 있어요");
    expect(why({ ...base, historyOpen: true, state: state() })).toBe("지난 리뷰를 보는 중이에요(읽기 전용)");
    expect(why({ ...base, dialogOpen: true, state: state() })).toBe("대화상자를 먼저 닫으세요");
    expect(why({ ...base, ui: { diffCollapsed: true }, state: state() })).toBe("diff 패널을 먼저 여세요");
    expect(rejectBlockedText("이유")).toBe("지금은 거절할 수 없어요 — 이유");
  });
});
