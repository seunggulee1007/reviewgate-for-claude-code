import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineRefusal, refusalOf } from "./engineRequest";
import { ERROR_EVENT_CODES, REFUSAL_CODES, errorEventText, presentationOf, refusalCodeText, refusalMessage, resetTimeText, retryChipText } from "./errorCodes";
import { initI18n } from "./i18n";

const HANGUL = /[가-힣]/;

describe("error / refusal codes → Korean (docs/PROTOCOL.md §19.6)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it.each(ERROR_EVENT_CODES)("error code %s has a Korean message", (code) => {
    const text = errorEventText({ code, message: "engine says (cli first line)", attempt: 2, maxRetries: 10, status: 529 });
    expect(text).toMatch(HANGUL);
  });

  it.each(REFUSAL_CODES)("refusal code %s has a Korean message", (code) => {
    const text = refusalCodeText(code, "x", ["a.txt"]);
    expect(text).not.toBeNull();
    expect(text!).toMatch(HANGUL);
  });

  it("formats the specific codes", () => {
    expect(errorEventText({ code: "auth_required", message: "Invalid API key · Please run /login" })).toBe("Claude 로그인이 필요합니다");
    expect(errorEventText({ code: "api_retrying", message: "retry", attempt: 2, maxRetries: 10 })).toBe("재시도 중 (2/10)…");
    expect(retryChipText(3, undefined)).toBe("재시도 중 (3)…");
    expect(errorEventText({ code: "api_error", message: "overloaded", status: 529 })).toContain("(HTTP 529)");
    expect(errorEventText({ code: "api_error", message: "overloaded", status: null })).not.toContain("HTTP");
    expect(errorEventText({ code: "send_failed", message: "snapshot failed" })).toBe("메시지를 Claude에 보내지 못했습니다: snapshot failed");
  });

  it("shows usage_limit's reset in local time", () => {
    const now = new Date("2026-10-20T03:00:00Z");
    const sameDay = resetTimeText("2026-10-20T05:30:00Z", { now, timeZone: "Asia/Seoul" });
    expect(sameDay).toBe("오후 2:30");
    const text = errorEventText({ code: "usage_limit", message: "hit your limit", resetAt: "2026-10-20T05:30:00Z" }, { now, timeZone: "Asia/Seoul" });
    expect(text).toContain("초기화");
    expect(text).toContain(sameDay!);
    expect(resetTimeText("2026-10-22T05:30:00Z", { now, timeZone: "Asia/Seoul" })).toMatch(/22/);
    expect(resetTimeText("not a date")).toBeNull();
    expect(errorEventText({ code: "usage_limit", message: "x" })).toContain("초기화된 뒤");
  });

  it("falls back to the engine text for an unknown code (or none)", () => {
    expect(errorEventText({ code: "brand_new_code", message: "Something new happened" })).toBe("Something new happened");
    expect(errorEventText({ message: "legacy engine error" })).toBe("legacy engine error");
    expect(refusalMessage(refusalOf(new EngineRefusal("some_future_refusal:x", "some_future_refusal")))).toBe("some_future_refusal:x");
    expect(refusalMessage(refusalOf(new Error("Plain english refusal")))).toBe("Plain english refusal");
  });

  it("uses the explicit code of an English-text refusal and the detail after the colon", () => {
    expect(refusalMessage(refusalOf(new EngineRefusal("empty base", "empty_base")))).toBe("기준 브랜치를 선택하세요.");
    // §35.1: a send whose snapshot A failed for want of git-lfs is refused — the banner's words, not "lfs_missing:…"
    const lfs = refusalMessage(refusalOf(new EngineRefusal("lfs_missing:git-lfs filter is missing", "lfs_missing")));
    expect(lfs).toBe(errorEventText({ code: "lfs_missing", message: "x" }));
    expect(lfs).not.toContain("lfs_missing");
    expect(refusalMessage(refusalOf(new Error("invalid_branch_name:a..b")))).toContain("a..b");
    expect(refusalMessage(refusalOf(new EngineRefusal("ENOENT: no such file", "command_failed")))).toContain("ENOENT: no such file");
    const changed = refusalMessage(refusalOf(new EngineRefusal("file_changed_since_review:a.txt, b.txt", "file_changed_since_review", ["a.txt", "b.txt"])));
    expect(changed).toContain("a.txt, b.txt");
    expect(changed).toContain("사라집니다");
  });

  // MARK: wave1 desktop-review
  it("not_captured lists the files that cannot be reverted (§32) and says what to do", () => {
    const text = refusalMessage(refusalOf(new EngineRefusal("not_captured:.claude/big.bin, logs/root.log", "not_captured", [".claude/big.bin", "logs/root.log"])));
    expect(text).toBe("내용을 수집하지 못한 파일이라 되돌릴 수 없습니다: .claude/big.bin, logs/root.log — 직접 고치거나 수락하세요");
    // an older bridge without `paths`: the list comes from the error text
    expect(refusalMessage(refusalOf(new Error("not_captured:a.bin")))).toContain("a.bin");
    // a partial revert of such a file never suggests a whole-file reject (that is refused too)
    expect(refusalMessage(refusalOf(new Error("partial_reject_unsupported:uncaptured")))).toBe("내용을 수집하지 못한 파일이라 부분 되돌리기도 할 수 없습니다");
    expect(refusalMessage(refusalOf(new Error("partial_reject_unsupported:A")))).toBe("이 파일은 부분적으로 되돌릴 수 없습니다 — 파일 전체를 거절하세요.");
  });

  it("routes codes to their presentation", () => {
    expect(presentationOf("api_retrying")).toBe("retrying");
    expect(presentationOf("cli_start_slow")).toBe("startSlow");
    expect(presentationOf("plan_followup_failed")).toBe("planFailed");
    expect(presentationOf("auth_required")).toBe("auth");
    expect(presentationOf("session_crashed")).toBe("fatalSession");
    expect(presentationOf("cli_not_found")).toBe("fatalSession");
    expect(presentationOf("cli_not_executable")).toBe("fatalSession");
    expect(errorEventText({ code: "cli_not_executable", message: "claude.cmd has no target" })).toBe("claude 실행 파일을 찾을 수 없습니다 — 설정에서 claude.exe를 직접 선택하세요");
    expect(presentationOf("rate_limited")).toBe("banner");
    expect(presentationOf(undefined)).toBe("banner");
  });
});
