import SwiftUI
import ReviewGateCore

/// §25: the HUD's model chip — opens the model / effort picker; a choice is sent at once (`set_model`).
struct ModelChip: View {
    @Environment(AppState.self) private var store
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: {
            HStack(spacing: 3) {
                Image(systemName: "cpu").foregroundStyle(.tertiary)
                Text(verbatim: store.autoModelChipText ?? store.modelChipText)   // wave5 w5-model: "자동 · sonnet"
                    .fontWeight(.medium)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Color.secondary.opacity(open ? 0.22 : 0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(store.projectInfo == nil)
        .help(store.modelMode == .auto ? AutoModelText.chipHelp(store.autoModel, policy: store.autoModelPolicy)   // wave5 w5-model
              : store.model.map { String(localized: "Model: \($0) — click to change") } ?? String(localized: "Choose the model"))
        .accessibilityLabel("Model")
        .accessibilityIdentifier("HUD model")
        .popover(isPresented: $open, arrowEdge: .top) {
            ModelPickerPopover()
        }
    }
}

struct ModelPickerPopover: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @State private var refusal: String?

    private var current: ModelOption? { store.currentModelOption }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Model").font(.headline)
                Spacer()
                Label("Applies from the next request", systemImage: "clock.arrow.circlepath")
                    .font(.caption).foregroundStyle(.secondary)
            }
            AutoModelPickerSection()   // wave5 w5-model (§43.4)
            VStack(spacing: 2) {
                row(value: "default", title: String(localized: "Default"),
                    detail: String(localized: "The Claude CLI's own default model"), selected: store.selectedModel == nil && current == nil)
                ForEach(store.availableModels) { option in
                    row(value: option.value, title: option.displayName, detail: option.description, selected: current?.value == option.value)
                }
            }
            if let option = current, !option.effortLevels.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Text("Effort").font(.subheadline.weight(.semibold))
                    Picker("Effort", selection: Binding(
                        get: { store.effort?.rawValue ?? "" },
                        set: { raw in Task { refusal = await store.setEffort(EffortLevel(rawValue: raw)) } })) {
                        Text("Default").tag("")
                        ForEach(option.effortLevels) { Text($0.displayName).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityIdentifier("Effort picker")
                    Text("Higher effort thinks longer and costs more.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let refusal {
                Label(refusal, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
            }
            if store.isRunning {
                Text("Claude is working — the current turn keeps its model.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(width: 380)
        .accessibilityIdentifier("Model picker")
    }

    private func row(value: String, title: String, detail: String, selected rawSelected: Bool) -> some View {
        let selected = rawSelected && store.modelMode == .manual   // wave5 w5-model: in auto no model is "the" choice
        return Button {
            if store.modelMode == .auto { AutoModelSettings.apply(.manual, from: store) }   // wave5 w5-model: a model is a manual pick
            Task { refusal = await store.setModel(value) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "checkmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.accentColor)
                    .opacity(selected ? 1 : 0)
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title).fontWeight(selected ? .semibold : .regular)
                    if !detail.isEmpty {
                        Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(selected ? Color.accentColor.wash(colorScheme, light: 0.12, dark: 0.22) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("Model option \(value)")
    }
}

/// §27: what the compact turn keeps in focus, plus the button; shared by the HUD popover and the warning banner.
struct CompactForm: View {
    @Environment(AppState.self) private var store
    var onDone: () -> Void = {}
    @State private var focus = ""
    @State private var refusal: String?
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                TextField("Focus (optional) — e.g. “the checkout API changes”", text: $focus)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await run() } }
                    .accessibilityIdentifier("Compact focus")
                Button {
                    Task { await run() }
                } label: {
                    if sending { ProgressView().controlSize(.small) } else { Text("Compact") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.canSend || sending)
                .help(store.cannotSendReason ?? String(localized: "Summarizes the conversation so far (/compact) to free up context"))
                .accessibilityIdentifier("Compact now")
            }
            if let refusal {
                Label(refusal, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private func run() async {
        guard store.canSend, !sending else { return }
        sending = true
        refusal = await store.compact(focus: focus)
        sending = false
        if refusal == nil { focus = ""; onDone() }
    }
}

/// §27: shown above the composer after `context_warning` until dismissed or compacted.
struct ContextWarningBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let warning: ContextWarning
    @State private var expanded = false

    private var tint: Color { warning.percent >= 95 ? .red : .orange }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "gauge.with.dots.needle.67percent").foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(EngineMessages.contextWarningText(warning)).fontWeight(.semibold)
                    Text("\(HUDStrip.tokens(warning.contextTokens)) / \(HUDStrip.tokens(warning.contextWindow)) tokens — compacting summarizes the conversation so far and frees up space.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Button(expanded ? String(localized: "Hide") : String(localized: "Compact…")) {
                    withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() }
                }
                .controlSize(.small)
                .accessibilityIdentifier("Context compact")
                Button {
                    store.dismissContextWarning()
                } label: {
                    Image(systemName: "xmark").font(.caption.weight(.bold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))
                .help("Dismiss")
                .accessibilityLabel("Dismiss")
                .accessibilityIdentifier("Context warning dismiss")
            }
            if expanded {
                CompactForm()
            }
        }
        .font(.callout)
        .padding(8)
        .background(tint.wash(colorScheme, light: 0.12, dark: 0.18), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tint.opacity(0.35)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Context warning")
    }
}
