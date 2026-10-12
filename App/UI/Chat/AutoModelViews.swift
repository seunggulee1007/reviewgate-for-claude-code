import SwiftUI
import ReviewGateCore

// MARK: wave5 w5-model
// docs/PROTOCOL.md §43.4 auto model on the Mac: the chip menu's "자동" with its three policies, the composer's one-message
// model ("이번엔 opus"), the chat's faint switch line, the turn summary's model line and the cost popover's counts. The
// words are Core's `AutoModelText` (Electron renderer/autoModel.ts says the same).

/// Every window reads the mode from the settings; the window it was picked in tells its engine, the others theirs.
@MainActor enum AutoModelSettings {
    static func apply(_ mode: ModelMode, policy: AutoModelPolicy? = nil, from store: AppState) {
        store.setModelMode(mode, policy: policy)
        for other in WorkbenchRegistry.shared.allStores where other !== store { other.pushModelMode() }
    }
}

/// The top of the model picker: "자동" and, when on, its policy.
struct AutoModelPickerSection: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        let on = store.modelMode == .auto
        VStack(alignment: .leading, spacing: 6) {
            Button {
                AutoModelSettings.apply(on ? .manual : .auto, from: store)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Color.accentColor)
                        .opacity(on ? 1 : 0)
                        .frame(width: 14)
                    Image(systemName: "wand.and.stars").foregroundStyle(on ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: AutoModelText.menuAutoTitle).fontWeight(on ? .semibold : .regular)
                        Text(verbatim: AutoModelText.menuAutoDetail).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(on ? Color.accentColor.wash(colorScheme, light: 0.12, dark: 0.22) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(AutoModelText.menuAutoTitle)
            .accessibilityAddTraits(on ? .isSelected : [])
            .accessibilityIdentifier("Model option auto")
            if on {
                Picker(AutoModelText.menuAutoTitle, selection: Binding(
                    get: { store.autoModelPolicy },
                    set: { AutoModelSettings.apply(.auto, policy: $0, from: store) })) {
                    ForEach(AutoModelPolicy.allCases) { Text(verbatim: $0.displayName).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .accessibilityIdentifier("Auto model policy")
                Text(verbatim: store.autoModelPolicy.detail).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(verbatim: AutoModelText.chipHelp(store.autoModel, policy: store.autoModelPolicy))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(verbatim: AutoModelText.menuAutoNote).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
        }
    }
}

/// The composer's one-message model: a small menu before the send button ("이번엔 opus").
struct NextMessageModelMenu: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        let options = AutoModelText.oneMessageOptions(store.availableModels)
        let picked = store.nextMessageModel
        Menu {
            Section(AutoModelText.nextMessageTitle) {
                Button {
                    store.setNextMessageModel(nil)
                } label: {
                    if picked == nil { Label(AutoModelText.nextMessageNone, systemImage: "checkmark") } else { Text(verbatim: AutoModelText.nextMessageNone) }
                }
                ForEach(options, id: \.value) { option in
                    Button {
                        store.setNextMessageModel(option.value)
                    } label: {
                        if picked == option.value {
                            Label(AutoModelText.nextMessageLabel(option.value), systemImage: "checkmark")
                        } else {
                            Text(verbatim: AutoModelText.nextMessageLabel(option.value))
                        }
                    }
                    .accessibilityIdentifier("Next message model \(option.family)")
                }
            }
        } label: {
            if let picked {
                Label(AutoModelText.nextMessageLabel(picked), systemImage: "cpu")
                    .font(.caption.weight(.semibold))
            } else {
                Image(systemName: "cpu").font(.caption)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(picked == nil ? .hidden : .visible)
        .fixedSize()
        .padding(.horizontal, picked == nil ? 0 : 6).padding(.vertical, 1)
        .background(picked == nil ? Color.clear : Color.accentColor.wash(colorScheme, light: 0.14, dark: 0.24), in: Capsule())
        .disabled(store.projectInfo == nil || options.isEmpty)
        .help(AutoModelText.nextMessageHelp)
        .accessibilityLabel(AutoModelText.nextMessageTitle)
        .accessibilityValue(picked.map(AutoModelText.nextMessageLabel) ?? AutoModelText.nextMessageNone)
        .accessibilityIdentifier("Next message model")
    }
}

/// The chat's faint line under a message whose model changed ("모델을 opus 로 바꿨어요 — 설계 판단").
struct AutoModelSwitchLine: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "arrow.triangle.swap")
            .font(.caption)
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
            .accessibilityIdentifier("Model switch line")
    }
}

/// The turn summary's "모델: opus (자동 · 설계 판단)".
struct TurnAutoModelLine: View {
    let choice: AutoModelChoice

    var body: some View {
        let text = AutoModelText.summaryLine(choice)
        Label(text, systemImage: "cpu")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
            .accessibilityIdentifier("Turn summary model")
    }
}

/// The cost popover's "자동이 고른 모델" line (nothing without auto picks).
struct AutoModelCountsLine: View {
    let counts: [AutoModelCount]

    var body: some View {
        if let line = AutoModelText.countsLine(counts) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: AutoModelText.countsTitle).font(.subheadline.weight(.semibold))
                Text(verbatim: line).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("HUD cost auto picks")
        }
    }
}
