import Foundation
import Testing
@testable import ReviewGateCore

/// wave4 w4-input: elapsed times in the UI language (polish-14).
@Suite struct InputPolishTests {
    @Test func elapsedReadsKoreanUnitsInKorean() {
        #expect(ElapsedFormat.text(seconds: 12.34, language: "ko") == "12.3초")
        #expect(ElapsedFormat.text(seconds: 200, language: "ko") == "3분 20초")
        #expect(ElapsedFormat.text(seconds: 245, language: "ko") == "4분 5초")
        #expect(ElapsedFormat.text(seconds: 3725, language: "ko") == "1시간 2분")
        #expect(ElapsedFormat.text(seconds: 200, language: "ko-KR") == "3분 20초")
    }

    @Test func elapsedStaysAsBeforeInEnglish() {
        #expect(ElapsedFormat.text(seconds: 12.34, language: "en") == "12.3s")
        #expect(ElapsedFormat.text(seconds: 200, language: "en") == "3m 20s")
        #expect(ElapsedFormat.text(seconds: 245, language: "en") == "4m 05s")
        #expect(ElapsedFormat.text(seconds: 3725, language: "en") == "1h 02m")
        #expect(ElapsedFormat.text(seconds: -3, language: "en") == "0.0s")
    }
}
