import Foundation

// MARK: wave4b w4b-files
// docs/PROTOCOL.md §40.2 (comp-14): the review list's "묶기" — kept per project in UserDefaults (the list's `@AppStorage`
// reads the same key), applied inside each group (설정·훅 / Claude / 앱 밖), and followed by ⌘] / ⌘[ and the move after a
// verdict (`displayOrderedFiles`). A bulk change (§39.1) folds by folder instead.

public extension AppState {
    /// The project the choice is kept for.
    var fileGroupRoot: String? { projectInfo?.root ?? projectURL?.path }

    /// The list's "묶기" for this project (none until chosen).
    var fileGroupBy: FileGroupBy { FileGroups.choice(for: fileGroupRoot, defaults: settingsDefaults) }

    func setFileGroupBy(_ by: FileGroupBy) {
        FileGroups.setChoice(by, for: fileGroupRoot, defaults: settingsDefaults)
    }

    /// The list's sections: `listSections` without a grouping (or for a bulk change), else each group split into its
    /// "묶기" sections, built from the files `keep` (the §39.3 author filter) keeps — a section counts what it shows and
    /// one with none of them is not listed (as Electron's `GroupedFiles`).
    func groupedListSections(riskOrder: Bool, keep: ((ChangedFile) -> Bool)? = nil, by: FileGroupBy? = nil) -> [ChangedFileSection] {
        let by = by ?? fileGroupBy
        guard by != .none, !isBulkChange else { return listSections(riskOrder: riskOrder, keep: keep) }
        return Self.subgrouped(changedFileSections(riskOrder: riskOrder), by: by, keep: keep, cause: fileCauses(for: by))
    }

    /// What ⌘] / ⌘[ step through: the groups in order and, with a grouping, their sections in order.
    func navigationSections(riskOrder: Bool) -> [ChangedFileSection] {
        let by = fileGroupBy
        guard by != .none, !isBulkChange else { return changedFileSections(riskOrder: riskOrder) }
        return Self.subgrouped(changedFileSections(riskOrder: riskOrder), by: by, keep: nil, cause: fileCauses(for: by))
    }

    /// MARK: wave4c w4c-review — §41.3 "원인별": every changed file's cause, from the running chat's rows (one index); nil
    /// for any other grouping.
    func fileCauses(for by: FileGroupBy) -> ((ChangedFile) -> String)? {
        guard by == .cause else { return nil }
        let index = transcriptIndex   // MARK: wave7 w7-chat — §45.1: the shared index, not one more build per list draw
        let agents = state.hud.agents
        var causes: [String: String] = [:]
        for file in changedFiles where causes[file.path] == nil {
            causes[file.path] = ReviewLeftovers.fileCause(file, index: index, agents: agents)
        }
        return { file in causes[file.path] ?? "" }
    }

    nonisolated static func subgrouped(_ sections: [ChangedFileSection], by: FileGroupBy, keep: ((ChangedFile) -> Bool)?,
                                       cause: ((ChangedFile) -> String)? = nil) -> [ChangedFileSection] {
        sections.flatMap { section -> [ChangedFileSection] in
            let files = keep.map { section.files.filter($0) } ?? section.files
            return FileGroups.group(files, by: by, path: \.path, cause: cause).map { g in
                var s = ChangedFileSection(kind: section.kind, files: g.files)
                s.subgroup = g.key
                let label = FileGroups.sectionLabel(by, key: g.key)
                // The Claude group is the list itself; the other two keep their name in front ("앱 밖 변경 · 서비스").
                s.subgroupTitle = section.kind == .claude || sections.count == 1 ? label : "\(section.kindName) · \(label)"
                return s
            }
        }
    }
}

extension ChangedFileSection {
    /// The group's name without its count ("설정·훅", "앱 밖 변경").
    var kindName: String {
        switch kind {
        case .mods: String(localized: "Settings & hooks", bundle: .module)
        case .claude: String(localized: "Claude changes", bundle: .module)
        case .external: ReviewProvenanceText.externalBadge
        }
    }
}
