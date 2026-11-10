import Foundation

// MARK: r2-review-flow — reviewing without extra clicks or modal stops (release 2) on the Mac: the rules both the views and
// the tests read.
// · M29 (§31.5): a stale restored review is the kept orange banner, not a sheet.

// MARK: - M29 the stale review banner

public enum StaleReviewBannerText {
    /// The kept orange banner's line: "오래된 리뷰예요 — 저장 후 HEAD가 바뀌었어요 · 12시간 넘게 지났어요".
    public static func message(_ stale: StaleReview) -> String {
        let reasons = stale.lines().prefix(2).joined(separator: " · ")
        let base = String(localized: "This review is stale", bundle: .module)
        return reasons.isEmpty ? base : "\(base) — \(reasons)"
    }

    /// The banner's tooltip: what the two buttons do (and that sending goes on with it).
    public static var help: String {
        String(localized: "Clean up empties the review list and leaves every file on disk as it is; Keep reviewing goes on with it — so does your next message.", bundle: .module)
    }
}
