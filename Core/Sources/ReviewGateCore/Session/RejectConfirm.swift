import Foundation

// MARK: wave4 w4-safety

/// Audit daily-11: Review → Reject (⌘⇧R, right next to ⌘R Refresh) puts a file back on disk at once. The shortcut now
/// asks first, in one line that says what happens to the file. Mac and Electron use the same keys.
public enum RejectConfirm {
    public static var title: String { String(localized: "Reject this file?", bundle: .module) }

    /// What the revert does to `file`, in one line.
    public static func message(for file: ChangedFile) -> String {
        let name = (file.path as NSString).lastPathComponent
        switch file.status {
        case .added:
            return String(localized: "\(name) was created in this turn — it will be deleted.", bundle: .module)
        case .deleted:
            return String(localized: "\(name) will be restored as it was before this turn.", bundle: .module)
        case .renamed:
            let old = ((file.oldPath ?? file.path) as NSString).lastPathComponent
            return String(localized: "\(name) goes back to \(old) as it was before this turn.", bundle: .module)
        case .modified, .other:
            return String(localized: "\(name) goes back to how it was before this turn.", bundle: .module)
        }
    }

    public static var rejectButton: String { String(localized: "Reject", bundle: .module) }
}
