/**
 * MARK: wave4d w4d-speed — audit polish-10: the screen-reader words for the review's rows, in Korean from the Mac's catalog
 * (Core `ReviewSpeech` keys through gen-i18n.mjs) — and the rows that carry them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countsText, diffLinePrefix, stateWord, statusWord } from "./a11yText";
import { initI18n } from "./i18n";

describe("screen-reader words (wave4d w4d-speed, polish-10)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("says a diff line's kind and number, as the Mac does", () => {
    expect(diffLinePrefix({ kind: "add", oldNo: null, newNo: 42 })).toBe("추가된 줄 42:");
    expect(diffLinePrefix({ kind: "del", oldNo: 41, newNo: null })).toBe("삭제된 줄 41:");
    expect(diffLinePrefix({ kind: "context", oldNo: 40, newNo: 40 })).toBe("문맥 줄 40:");
    expect(diffLinePrefix({ kind: "hunkHeader", oldNo: null, newNo: null })).toBe("변경 부분:");
    expect(diffLinePrefix({ kind: "context", oldNo: null, newNo: null })).toBe("문맥 줄:");
  });

  it("names a file's status, review state and counts", () => {
    expect(statusWord("M")).toBe("수정됨");
    expect(statusWord("A")).toBe("추가됨");
    expect(statusWord("D")).toBe("삭제됨");
    expect(statusWord("R")).toBe("이름 바뀜");
    expect(statusWord("X")).toBe("기타 변경");
    expect(stateWord("pending")).toBe("리뷰 대기");
    expect(stateWord("accepted")).toBe("수락됨");
    expect(stateWord("rejected")).toBe("거절됨");
    expect(stateWord("changesRequested")).toBe("변경 요청됨");
    expect(countsText(12, 3)).toBe("12줄 추가, 3줄 삭제");
  });

  it("reads in English without a dictionary", () => {
    initI18n("en", "darwin");
    expect(diffLinePrefix({ kind: "add", oldNo: null, newNo: 7 })).toBe("Added line 7:");
    expect(countsText(1, 2)).toBe("1 lines added, 2 removed");
    initI18n("ko", "darwin");
  });
});
