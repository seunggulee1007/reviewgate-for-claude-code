// MARK: wave4d w4d-windows — audit polish-07: the Windows client speaks Korean from its first screen — no Mac tool names,
// no "login shell" off a Mac, no raw gate states in a refusal.
import { afterAll, describe, expect, it } from "vitest";
import { refusalCodeText } from "./errorCodes";
import { gateText } from "./gateText";
import { initI18n, t } from "./i18n";
import { revealInFolderLabel, toolchainDetectedNote, toolchainOverrideNote, workbenchSetupNote } from "./platformWords";

describe("Windows in Korean (polish-07)", () => {
  afterAll(() => initI18n("en", "darwin"));

  it("names Explorer on Windows and the Finder only on a Mac", () => {
    initI18n("ko", "win32");
    expect(revealInFolderLabel("win32")).toBe("탐색기에서 보기");
    expect(revealInFolderLabel("darwin")).toBe("Finder에서 보기");
    expect(revealInFolderLabel("linux")).toBe("폴더에서 보기");
  });

  it("finds the toolchain on PATH off a Mac — no login shell there", () => {
    initI18n("ko", "win32");
    for (const s of [toolchainDetectedNote("win32", true), toolchainOverrideNote("win32")]) {
      expect(s).toContain("PATH");
      expect(s).not.toMatch(/로그인 셸|login shell/);
    }
    expect(toolchainDetectedNote("win32", false)).toBe(t("Detected when a project is opened."));
    expect(toolchainDetectedNote("darwin", true)).toBe("현재 세션의 로그인 셸로 감지했습니다.");
    expect(toolchainOverrideNote("darwin")).toContain("로그인 셸");
    // The workbench setup command runs through cmd.exe there (engine git/workbenchSetup.ts).
    expect(workbenchSetupNote("win32")).toContain("cmd.exe");
    expect(workbenchSetupNote("win32")).not.toMatch(/로그인 셸/);
    expect(workbenchSetupNote("darwin")).toContain("로그인 셸");
  });

  it("⌘⇧/ reads Ctrl+Shift+/ off a Mac", () => {
    initI18n("en", "win32");
    expect(t("Ask (⌘⇧/)")).toBe("Ask (Ctrl+Shift+/)");
    initI18n("en", "darwin");
    expect(t("Ask (⌘⇧/)")).toBe("Ask (⌘⇧/)");
  });

  it("a closed gate says why in the Mac's words (EngineMessages.gateText), never the raw state", () => {
    initI18n("ko", "win32");
    expect(refusalCodeText("gate_closed", "awaiting_permission")).toBe("대기 중인 권한 요청에 먼저 답하세요");
    expect(refusalCodeText("gate_closed", "running")).toBe("Claude가 작업 중입니다 — 턴이 끝날 때까지 기다리세요");
    expect(refusalCodeText("gate_closed", "brand_new_state")).toBe("지금은 보낼 수 없습니다");
    expect(refusalCodeText("gate_closed", "")).toBe("지금은 보낼 수 없습니다");
    // §29: another session's turn — unchanged.
    expect(refusalCodeText("gate_closed", "external_turn")).toBe(t("It goes out once the other work is done."));
    expect(refusalCodeText("request_changes_unavailable", "no_notes")).toBe("먼저 리뷰 메모를 추가하세요");
    expect(refusalCodeText("request_changes_unavailable", "")).toBe("변경을 요청할 리뷰가 없습니다");
    expect(refusalCodeText("request_changes_unavailable", "collecting")).toBe("변경 사항을 수집하는 중입니다 — 잠시 기다리세요");
    const states = ["running", "awaiting_permission", "collecting", "reverting", "collect_failed", "pending_review", "changes_requested", "no_session", "starting", "git_init_needed"];
    for (const d of states) {
      expect(gateText(d)).not.toContain(d);
      expect(gateText(d)).not.toBe(gateText("unknown"));
      expect(gateText(d)).toMatch(/[가-힣]/);
    }
  });
});
