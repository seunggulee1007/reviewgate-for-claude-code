import Foundation

// MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2 (comp-11): what a diff without lines is — a pure move, a rename, a mode
// change, a binary's sizes — from `FileDiff.meta` (an engine since §40.2). The same lines as Electron's `fileMeta.ts`; an
// older engine sends nothing and nothing is added.

public enum FileMetaText {
    private static let exec = "100755"
    private static let plain = "100644"

    /// 12 288 → "12KB", 500 → "500B", 5.3 MB → "5.3MB" (1024 steps; KB whole, MB one decimal).
    public static func formatBytes(_ n: Int64) -> String {
        if n < 1024 { return "\(n)B" }
        if n < 1024 * 1024 { return "\(Int((Double(n) / 1024).rounded()))KB" }
        return String(format: "%.1fMB", Double(n) / (1024 * 1024))
    }

    /// "644" for a regular file's mode, the raw mode otherwise.
    private static func short(_ mode: String) -> String { mode.hasPrefix("100") ? String(mode.dropFirst(3)) : mode }

    /// One line per thing the diff's lines cannot show, in this order: the move, the mode, the binary's sizes.
    public static func lines(_ diff: FileDiff) -> [String] {
        var out: [String] = []
        let meta = diff.meta
        if let similarity = meta.similarity {
            out.append(similarity >= 100
                ? String(localized: "Moved without a content change (similarity \(similarity)%)", bundle: .module)
                : String(localized: "Renamed (similarity \(similarity)%)", bundle: .module))
        }
        if let old = meta.oldMode, let new = meta.newMode, old != new {
            let a = short(old), b = short(new)
            if old == plain, new == exec {
                out.append(String(localized: "Executable permission added \(a)→\(b)", bundle: .module))
            } else if old == exec, new == plain {
                out.append(String(localized: "Executable permission removed \(a)→\(b)", bundle: .module))
            } else {
                out.append(String(localized: "File mode changed \(old)→\(new)", bundle: .module))
            }
        } else if meta.oldMode == nil, let new = meta.newMode, new == exec {
            let b = short(new)
            out.append(String(localized: "New executable file (\(b))", bundle: .module))
        }
        if diff.isBinary, let size = meta.binarySize {
            if let old = size.old, let new = size.new {
                let a = formatBytes(old), b = formatBytes(new)
                out.append(String(localized: "Binary · \(a) → \(b)", bundle: .module))
            } else if let new = size.new {
                let b = formatBytes(new)
                out.append(String(localized: "Binary · new file \(b)", bundle: .module))
            } else if let old = size.old {
                let a = formatBytes(old)
                out.append(String(localized: "Binary · deleted \(a)", bundle: .module))
            }
        }
        return out
    }

    /// Under the first line when a diff has no lines at all.
    public static var noLineChanged: String { String(localized: "No line of the file changed.", bundle: .module) }
}
