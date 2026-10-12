import Foundation

// MARK: wave4c w4c-trust
// docs/PROTOCOL.md §41.2 (Mac; Electron `src/renderer/trust.ts` says the same words): the auto-accept rules' names, what
// [모두 대기로 되돌리기] and the reject banner's [거절 취소] can do right now and why not. The engine decides what a rule
// accepts (engine/src/review/trust.ts); this only names it.

public enum TrustRules {
    /// Settings order.
    public static let rules: [AutoAcceptRule] = AutoAcceptRule.allCases

    /// The rule's short name ("규칙으로 수락 · 공백만 바뀜"); nil for a rule this client does not know (a newer engine).
    public static func name(_ rule: String?) -> String? {
        switch rule.flatMap(AutoAcceptRule.init(rawValue:)) {
        case .whitespace: String(localized: "Whitespace only", bundle: .module)
        case .lockfile: String(localized: "Lockfile with its manifest", bundle: .module)
        case .tests: String(localized: "Test passed after the edit", bundle: .module)
        case nil: nil
        }
    }

    /// One line under the rule's switch (Settings › Project).
    public static func help(_ rule: AutoAcceptRule) -> String {
        switch rule {
        case .whitespace: String(localized: "Files whose every change is whitespace — not Python, YAML or Makefiles, where whitespace is code.", bundle: .module)
        case .lockfile: String(localized: "A lockfile (package-lock.json, yarn.lock, gradle.lockfile …) when you accept the manifest next to it.", bundle: .module)
        case .tests: String(localized: "Test files (*Test.java, *.test.ts …) when the turn's last test passed after its last edit.", bundle: .module)
        }
    }

    public static var sectionTitle: String { String(localized: "Auto-accept rules", bundle: .module) }
    public static var sectionCaption: String {
        String(localized: "Off by default. A rule accepts a file when a turn ends (a lockfile also when you accept its manifest), and the list marks it. Every worktree of this repository uses them.", bundle: .module)
    }
    public static var neverText: String {
        String(localized: "Never accepted by a rule: files with a risk badge (settings, SQL, schema, CI, permissions), changes made by Bash, an MCP tool or outside Claude, large files, files with notes and files you rejected.", bundle: .module)
    }

    /// The file badge ("규칙으로 수락") and its tooltip / accessibility label.
    public static var badge: String { String(localized: "By rule", bundle: .module) }
    public static func badgeLabel(_ rule: String?) -> String {
        guard let name = name(rule) else { return badge }
        return "\(badge) · \(name)"
    }
    public static func badgeHelp(_ rule: String?) -> String {
        guard let name = name(rule) else { return String(localized: "Accepted by a rule — not reviewed by you.", bundle: .module) }
        return String(localized: "Accepted by the rule “\(name)” — not reviewed by you. [Back to pending (all)] on the turn summary puts it back.", bundle: .module)
    }

    // MARK: Turn summary — "규칙으로 수락 N개 [모두 대기로 되돌리기]"

    public static func summaryLine(count: Int) -> String { String(localized: "Accepted by a rule: \(count) file(s)", bundle: .module) }
    public static var undoAllButton: String { String(localized: "Back to pending (all)", bundle: .module) }
    public static var undoAllHelp: String { String(localized: "Puts these files back to pending — nothing on disk changes", bundle: .module) }

    public struct AutoUndoView: Equatable, Sendable {
        /// The summary's files a rule still holds accepted.
        public var paths: [String]
        /// Why the button waits; nil: ready.
        public var blocked: String?
    }

    /// The files of `paths` a rule still holds accepted.
    public static func ruleAccepted(_ files: [ChangedFile], paths: [String]? = nil) -> [String] {
        let want = paths.map(Set.init)
        return files.filter { $0.state == .accepted && $0.autoAccepted != nil && (want?.contains($0.path) ?? true) }.map(\.path)
    }

    public static func autoUndo(state: ReviewState, paths: [String]) -> AutoUndoView {
        autoUndo(files: state.changedFiles, phase: state.gate.phase, paths: paths)
    }

    /// wave7 w7-state (§45.2): from the store's slices (a view reading it never depends on the whole snapshot).
    public static func autoUndo(files: [ChangedFile], phase: GatePhase, paths: [String]) -> AutoUndoView {
        let held = ruleAccepted(files, paths: paths)
        if held.isEmpty { return AutoUndoView(paths: held, blocked: String(localized: "Already back to pending or out of the review", bundle: .module)) }
        if busy(phase) { return AutoUndoView(paths: held, blocked: workingText) }
        return AutoUndoView(paths: held, blocked: nil)
    }

    // MARK: "거절했어요 — [거절 취소]"

    public struct RejectUndoView: Equatable, Sendable {
        public var path: String
        public var blocked: String?
    }

    public static func rejectUndo(state: ReviewState) -> RejectUndoView? { rejectUndo(gate: state.gate) }

    public static func rejectUndo(gate: GateInfo) -> RejectUndoView? {
        guard let u = gate.rejectUndo, !u.path.isEmpty else { return nil }
        if !u.available {
            let text = u.reason == "changed_on_disk"
                ? String(localized: "The file changed after the reject — it can no longer be put back", bundle: .module)
                : String(localized: "The review changed after the reject — it can no longer be put back", bundle: .module)
            return RejectUndoView(path: u.path, blocked: text)
        }
        if busy(gate.phase) { return RejectUndoView(path: u.path, blocked: workingText) }
        return RejectUndoView(path: u.path, blocked: nil)
    }

    public static func rejectedText(_ path: String) -> String { String(localized: "Rejected — \(path)", bundle: .module) }
    public static var undoRejectButton: String { String(localized: "Undo the reject", bundle: .module) }
    public static var undoRejectHelp: String { String(localized: "Puts the proposal back on disk and in the review, pending", bundle: .module) }

    static var workingText: String { String(localized: "Claude is working — wait for the turn to end", bundle: .module) }
    static func busy(_ phase: GatePhase) -> Bool { phase == .running || phase == .collecting || phase == .reverting }
}

// MARK: - AppState

extension AppState {
    // §41.2: `autoAcceptRules` is a slice of the store (wave7 w7-state, AppState.swift).

    /// Turns one rule on / off for the repository (the engine keeps them; every worktree of it uses them).
    public func setAutoAcceptRule(_ rule: AutoAcceptRule, on: Bool) {
        guard projectInfo != nil else { return }
        fireReviewAction(.setAutoAccept(rules: autoAcceptRules.with(rule, on: on)))
    }

    /// [모두 대기로 되돌리기] of a turn summary: its files a rule still holds go back to pending.
    public func undoAutoAccept(paths: [String]) {
        let view = TrustRules.autoUndo(files: changedFiles, phase: gatePhase, paths: paths)
        guard view.blocked == nil, !view.paths.isEmpty else { return }
        fireReviewAction(.autoAcceptUndo(paths: view.paths))
    }

    /// The "거절했어요 — [거절 취소]" banner (nil: nothing to put back).
    public var rejectUndoOffer: TrustRules.RejectUndoView? { TrustRules.rejectUndo(gate: gate) }

    /// [거절 취소]: the last reject comes back. A `reject_undo_*` refusal needs no row — the banner shows the engine's reason.
    public func undoLastReject() {
        guard let view = rejectUndoOffer, view.blocked == nil else { return }
        if let commandSink { commandSink(.rejectUndo(path: view.path)); return }
        Task {
            do {
                try await request(.rejectUndo(path: view.path))
            } catch let error as EngineClientError {
                if error.refusalCode?.hasPrefix("reject_undo_") != true { fail(error.userMessage, fatal: false) }
            } catch {
                fail(error.localizedDescription, fatal: false)
            }
        }
    }
}
