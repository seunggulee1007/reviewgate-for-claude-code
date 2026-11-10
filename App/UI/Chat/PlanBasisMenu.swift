import SwiftUI
import ReviewGateCore

// MARK: wave5 w5-fixes — docs/PROTOCOL.md §43.5: the basis of "plan vs actual" chosen from the newest turn summary
// (Core `PlanBasis`; Electron `PlanBasisMenu.tsx`).

/// "기준: 자동 · db-migration.md": automatic, then the plan files (the one followed checked) and a note. While a plan
/// approved in ReviewGate decides, the items are off and the reason is the last line.
struct PlanBasisMenuButton: View {
    @Environment(AppState.self) private var store
    let menu: PlanBasisMenu

    var body: some View {
        Menu {
            Section(String(localized: "Plan vs actual basis")) {
                ForEach(menu.items) { item in
                    Button {
                        Task { await store.choosePlanBasis(path: item.path) }
                    } label: {
                        if item.checked {
                            Label(item.title, systemImage: "checkmark")
                        } else {
                            Text(verbatim: item.title)
                        }
                    }
                    .disabled(menu.blocker != nil)
                    .help(item.help)
                    .accessibilityIdentifier(item.path == nil ? "Plan basis automatic" : "Plan basis file")
                }
            }
            Divider()
            Text(verbatim: menu.blocker ?? menu.note)
        } label: {
            Label(menu.label, systemImage: "scope").font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .foregroundStyle(.secondary)
        .help(menu.blocker ?? String(localized: "Choose which plan this chat's turn summaries compare against"))
        .accessibilityLabel(menu.label)
        .accessibilityIdentifier("Plan basis menu")
    }
}

/// The newest summary had no plan to compare against: the section's title and the menu, so a plan file can be chosen
/// for the next one.
struct PlanBasisLine: View {
    @Environment(\.colorScheme) private var colorScheme
    let menu: PlanBasisMenu

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "checklist").foregroundStyle(.blue).accessibilityHidden(true)
            Text("Plan vs actual").font(.caption.weight(.semibold))
            Text("This turn had no plan to compare against").font(.caption).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            PlanBasisMenuButton(menu: menu)
        }
        .padding(8)
        .background(Color.blue.wash(colorScheme, light: 0.05, dark: 0.08), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Plan basis line")
    }
}
