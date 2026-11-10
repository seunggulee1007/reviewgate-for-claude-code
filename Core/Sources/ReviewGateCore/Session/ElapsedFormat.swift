import Foundation

/// wave4 w4-input (polish-14): an elapsed time in the UI language — "12.3s · 4m 05s · 1h 02m" in English as before,
/// "12.3초 · 4분 5초 · 1시간 2분" in Korean. Electron's `formatElapsed` (src/renderer/elapsed.ts) follows the same rule.
public enum ElapsedFormat {
    /// The app's UI language ("ko", "en", …), as the catalogs resolve it.
    public static var uiLanguage: String { Bundle.main.preferredLocalizations.first ?? "en" }

    public static func text(seconds raw: Double, language: String = uiLanguage) -> String {
        let s = max(0, raw)
        let korean = language.lowercased().hasPrefix("ko")
        if s < 60 { return String(format: korean ? "%.1f초" : "%.1fs", s) }
        let whole = Int(s)
        if whole < 3600 {
            return korean ? "\(whole / 60)분 \(whole % 60)초" : String(format: "%dm %02ds", whole / 60, whole % 60)
        }
        return korean ? "\(whole / 3600)시간 \((whole % 3600) / 60)분" : String(format: "%dh %02dm", whole / 3600, (whole % 3600) / 60)
    }
}
