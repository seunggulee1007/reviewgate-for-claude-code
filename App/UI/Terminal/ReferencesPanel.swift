import SwiftUI
import ReviewGateCore

// MARK: ide-nav — docs/PROTOCOL.md §65.8 on the Mac: the bottom panel's 참조 tab (beside 터미널 · 출력 · 실행). Find
// References (⇧F12) fills it: the hits by file on the left, the picked hit in its lines on the right. A click picks a hit,
// ↩ / a double-click opens it (Back returns), F4 / ⇧F4 open the next / previous one. The rules are Core `CodeNavStore`
// (tested in `IdeNavTests`).

/// The 참조 tab's controls in the panel's bar: what was found, ⇧F4 / F4, run again, the earlier searches.
struct ReferencesPanelControls: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let nav = store.codeNav
        let hasHits = !nav.referenceHits.isEmpty
        HStack(spacing: 6) {
            if !nav.referencesSymbol.isEmpty {
                Text(verbatim: nav.referencesSymbol).font(.caption.weight(.semibold)).lineLimit(1)
                if let reply = nav.references {
                    Text(verbatim: CodeNavText.summary(reply)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            if nav.referencesLoading { ProgressView().controlSize(.mini) }
            Spacer(minLength: 4)
            Button { Task { await store.stepReference(-1) } } label: { Image(systemName: "chevron.up") }
                .buttonStyle(.icon)
                .controlSize(.small)
                .disabled(!hasHits)
                .help(hasHits ? Text("Previous reference (⇧F4)") : Text("No references to step through — Find References (⇧F12) on a name first"))
                .accessibilityLabel(Text("Previous reference"))
                .accessibilityIdentifier("References previous")
            Button { Task { await store.stepReference(1) } } label: { Image(systemName: "chevron.down") }
                .buttonStyle(.icon)
                .controlSize(.small)
                .disabled(!hasHits)
                .help(hasHits ? Text("Next reference (F4)") : Text("No references to step through — Find References (⇧F12) on a name first"))
                .accessibilityLabel(Text("Next reference"))
                .accessibilityIdentifier("References next")
            Button {
                let symbol = nav.referencesSymbol
                let from = nav.referencesFrom
                Task { await store.findReferences(symbol, from: from) }
            } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.icon)
                .controlSize(.small)
                .disabled(nav.referencesSymbol.isEmpty || nav.referencesLoading)
                .help(nav.referencesSymbol.isEmpty ? Text("Nothing to search again yet")
                      : nav.referencesLoading ? Text("Still searching…") : Text("Search again (the files may have changed)"))
                .accessibilityLabel(Text("Search again"))
                .accessibilityIdentifier("References refresh")
            Menu {
                ForEach(nav.referenceSearches) { search in
                    Button {
                        Task { await store.findReferences(search.symbol, from: search.from) }
                    } label: {
                        Text(verbatim: search.from.map { "\(search.symbol) — \(($0.path as NSString).lastPathComponent)" } ?? search.symbol)
                    }
                }
            } label: { Image(systemName: "clock.arrow.circlepath") }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .disabled(nav.referenceSearches.count < 2)
                .help(nav.referenceSearches.count < 2 ? Text("Your earlier searches show here") : Text("Earlier searches of this window"))
                .accessibilityLabel(Text("Earlier searches"))
                .accessibilityIdentifier("References history")
        }
    }
}

/// The 참조 tab: the hits by file (the definition marked), and the picked one in its lines.
struct ReferencesPanelView: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let nav = store.codeNav
        HSplitView {
            list(nav)
                .frame(minWidth: 260, idealWidth: 460, maxWidth: .infinity, maxHeight: .infinity)
            preview(nav)
                .frame(minWidth: 240, maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("References panel")
    }

    // MARK: The list

    @ViewBuilder
    private func list(_ nav: CodeNavStore) -> some View {
        let word = IdeNavText.bare(nav.referencesSymbol)
        if let error = nav.referencesError {
            ContentUnavailableView("Could not find references", systemImage: "exclamationmark.triangle", description: Text(verbatim: error))
        } else if nav.referencesLoading, nav.references == nil {
            VStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Looking for references…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if nav.referencesSymbol.isEmpty {
            Text("Find References (⇧F12) on a name lists every line that uses it here — F4 / ⇧F4 step through them, ↩ opens one.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                .padding(20)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if nav.referenceGroups.isEmpty {
            ContentUnavailableView("No references", systemImage: "magnifyingglass")
        } else {
            let offsets = Self.offsets(nav.referenceGroups)
            ScrollViewReader { proxy in
                List(selection: Binding(get: { nav.referenceSelection }, set: { index in
                    if let index { Task { await store.selectReference(index) } }
                })) {
                    ForEach(Array(nav.referenceGroups.enumerated()), id: \.element.id) { g, group in
                        Section {
                            ForEach(Array(group.hits.enumerated()), id: \.offset) { i, hit in
                                row(hit, word: word)
                                    .tag(offsets[g] + i)
                                    .id(offsets[g] + i)
                            }
                        } header: {
                            header(group)
                        }
                    }
                }
                .listStyle(.inset)
                .contextMenu(forSelectionType: Int.self) { indices in
                    if let index = indices.first {
                        Button("Open") { store.openReference(index) }
                    }
                } primaryAction: { indices in
                    if let index = indices.first { store.openReference(index) }
                }
                .onChange(of: nav.referenceSelection) { _, index in
                    if let index { proxy.scrollTo(index) }
                }
            }
        }
    }

    /// Where each file's hits start in `referenceHits`.
    private static func offsets(_ groups: [ReferenceGroup]) -> [Int] {
        var out: [Int] = []
        var n = 0
        for group in groups {
            out.append(n)
            n += group.hits.count
        }
        return out
    }

    private func header(_ group: ReferenceGroup) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.text").font(.caption).foregroundStyle(.secondary)
            Text(verbatim: (group.path as NSString).lastPathComponent).font(.callout.weight(.semibold))
            Text(verbatim: (group.path as NSString).deletingLastPathComponent)
                .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            Spacer()
            Text(verbatim: String(group.hits.count)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
        .help(group.path)
    }

    private func row(_ hit: ReferenceHit, word: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: String(hit.line))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 40, alignment: .trailing)
            Text(CodeNavPeekText.marked(hit.preview, word: word))
                .font(.body.monospaced())
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            if hit.kind != nil {
                Text("definition")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.accentColor.opacity(0.18), in: Capsule())
            }
        }
        .help(hit.kind != nil ? Text("The definition, at line \(hit.line) — double-click or ↩ to open") : Text("Line \(hit.line) — double-click or ↩ to open"))
        .accessibilityIdentifier("Reference \(hit.path):\(hit.line)")
    }

    // MARK: The preview

    @ViewBuilder
    private func preview(_ nav: CodeNavStore) -> some View {
        let hits = nav.referenceHits
        if let index = nav.referenceSelection, hits.indices.contains(index) {
            let hit = hits[index]
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Text(verbatim: "\((hit.path as NSString).lastPathComponent):\(hit.line)").font(.callout.weight(.semibold))
                    Text(verbatim: (hit.path as NSString).deletingLastPathComponent)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                    Spacer(minLength: 4)
                    Text(verbatim: "\(index + 1) / \(hits.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Button("Open") { store.openReference(index) }
                        .controlSize(.small)
                        .help("Open it there — Back (⌃-) returns (↩)")
                        .accessibilityIdentifier("References open")
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .help(hit.path)
                Divider()
                if let p = nav.referencePreview, p.path == hit.path, p.line == hit.line {
                    CodeNavPreviewLines(preview: p, marked: hit.line, visible: nil)
                } else if let error = nav.referencePreviewError {
                    Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.secondary).padding(10)
                    Spacer()
                } else {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        } else {
            Text("Pick a reference to see it in its lines")
                .font(.callout).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
