import SwiftUI
import AppKit
import ReviewGateCore

/// A user message in the transcript: its text, the files it mentioned and its images (§23 / §24), and on hover / in the
/// context menu 복사 · 수정해서 다시 보내기 · 이 시점으로 되돌리기 (§26).
struct UserMessageRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let text: String
    let meta: UserMessageMeta
    /// The ⌘F highlight, when the row matches.
    var highlighted: AttributedString?

    @State private var hovering = false
    @State private var editing = false
    @State private var showRewind = false
    @State private var copied = false

    private var checkpoint: TurnCheckpoint? { store.checkpoint(forTurn: meta.turn) }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Spacer(minLength: 40)
            if editing {
                EditAndRetryEditor(text: text, meta: meta, checkpoint: checkpoint, onClose: { editing = false })
                    .frame(maxWidth: 560)
            } else {
                VStack(alignment: .trailing, spacing: 6) {
                    if !meta.attachments.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(meta.attachments) { ref in TranscriptImageThumbnail(ref: ref) }
                        }
                    }
                    HStack(alignment: .top, spacing: 6) {
                        if hovering || copied { actionBar.transition(.opacity) }
                        bubble
                    }
                    if !meta.mentions.isEmpty {
                        FlowChips(paths: meta.mentions)
                    }
                    if let line = AutoModelText.switchLine(meta.autoModel) { AutoModelSwitchLine(text: line) }   // wave5 w5-model (§43.4)
                }
            }
        }
        .contextMenu { menuItems }
        // The whole row is the hover region: the action bar sits beyond the bubble (a gap between them, and the Spacer
        // before them, are not hit-testable), so the pointer leaving the bubble ended the hover and removed the bar.
        .contentShape(Rectangle())
        .onHover { inside in withAnimation(.easeOut(duration: 0.12)) { hovering = inside } }
        .sheet(isPresented: $showRewind) {
            if let checkpoint { RewindSheet(checkpoint: checkpoint) }
        }
        .accessibilityIdentifier("User message")
    }

    private var bubble: some View {
        Group {
            if let highlighted { Text(highlighted) } else { Text(text) }
        }
        .textSelection(.enabled)
        .padding(10)
        .background(Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28), in: RoundedRectangle(cornerRadius: 10))
    }

    private var actionBar: some View {
        HStack(spacing: 2) {
            iconButton(copied ? "checkmark" : "doc.on.doc", help: String(localized: "Copy")) { copy() }
                .accessibilityIdentifier("Copy message")
            iconButton("pencil", help: editHelp) { editing = true }
                .disabled(editDisabledReason != nil)
                .accessibilityIdentifier("Edit and resend")
            iconButton("arrow.uturn.backward", help: rewindHelp) { showRewind = true }
                .disabled(checkpoint == nil)
                .accessibilityIdentifier("Rewind to here")
        }
        .padding(3)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.quaternary))
        .padding(.top, 4)
    }

    private func iconButton(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .medium)).frame(width: 22, height: 20)
        }
        .buttonStyle(.borderless)
        .help(help)
        .accessibilityLabel(help)
    }

    @ViewBuilder
    private var menuItems: some View {
        Button("Copy", systemImage: "doc.on.doc") { copy() }
        Button("Edit and resend", systemImage: "pencil") { editing = true }
            .disabled(editDisabledReason != nil)
        Button("Rewind to here…", systemImage: "arrow.uturn.backward") { showRewind = true }
            .disabled(checkpoint == nil)
    }

    /// Why "수정해서 다시 보내기" is off: no checkpoint, or the conversation of this point cannot be rewound.
    private var editDisabledReason: String? {
        guard let checkpoint else { return String(localized: "This message has no rewind point") }
        if !checkpoint.canRewindConversation { return EngineMessages.refusal(error: "rewind_unavailable:conversation") }
        return nil
    }

    private var editHelp: String {
        editDisabledReason ?? String(localized: "Edit this message and send it again from this point")
    }

    private var rewindHelp: String {
        checkpoint == nil ? String(localized: "This message has no rewind point")
            : String(localized: "Rewind the conversation and / or Claude's file changes to before this message")
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            copied = false
        }
    }
}

/// Mention chips under a sent message (read-only, wrapping).
struct FlowChips: View {
    let paths: [String]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(paths.prefix(6), id: \.self) { MentionChip(path: $0) }
            if paths.count > 6 {
                Text("+\(paths.count - 6)")
                    .font(.caption).foregroundStyle(.secondary)
                    .help(paths.dropFirst(6).joined(separator: "\n"))
            }
        }
    }
}

/// A transcript image: loaded lazily through `attachment_get` (cached), click to enlarge.
struct TranscriptImageThumbnail: View {
    @Environment(AppState.self) private var store
    let ref: AttachmentRef
    var size: CGFloat = 72
    @State private var image: NSImage?
    @State private var failed = false
    @State private var preview = false

    var body: some View {
        Button { if image != nil { preview = true } } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.15))
                if let image {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
                } else if failed {
                    Image(systemName: "photo.badge.exclamationmark").foregroundStyle(.secondary)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.white.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .help(failed ? EngineMessages.refusal(error: "unknown_attachment")
              : "\(ref.mediaType) · \(ByteCountFormatter.string(fromByteCount: Int64(ref.bytes), countStyle: .file))")
        .task(id: ref.hash) {
            guard image == nil else { return }
            if let data = await store.attachment(hash: ref.hash), let decoded = NSImage(data: data) {
                image = decoded
            } else {
                failed = true
            }
        }
        .sheet(isPresented: $preview) {
            if let image {
                ImagePreviewSheet(image: image, caption: "\(Int(image.size.width)) × \(Int(image.size.height)) · \(ByteCountFormatter.string(fromByteCount: Int64(ref.bytes), countStyle: .file))")
            }
        }
        .accessibilityIdentifier("Transcript image")
    }
}

/// "수정해서 다시 보내기": the message's text, mentions and images, editable; sending rewinds the conversation (and, when
/// ticked, Claude's file changes) to before it and sends the edit as the new turn (`rewind {mode, editText}`).
struct EditAndRetryEditor: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let text: String
    let meta: UserMessageMeta
    let checkpoint: TurnCheckpoint?
    var onClose: () -> Void

    @State private var draft = ""
    @State private var mentions: [String] = []
    @State private var images: [ComposerImage] = []
    @State private var loadingImages = false
    @State private var rewindFiles = true
    @State private var refusal: String?
    @State private var height: CGFloat = 40
    @State private var focused = true
    @State private var caret = 0
    @State private var caretRequest: Int?

    private var filesPossible: Bool { checkpoint?.canRewindFiles ?? false }
    private var mode: RewindMode { rewindFiles && filesPossible ? .both : .conversation }
    private var canSubmit: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !store.isRewinding && store.rewindBlocker(mode: mode) == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Edit and resend", systemImage: "pencil").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if !mentions.isEmpty || !images.isEmpty || loadingImages {
                HStack {
                    ComposerChipsRow(mentions: $mentions, images: $images)
                    if loadingImages { ProgressView().controlSize(.small) }
                }
            }
            ComposerTextView(text: $draft, isFocused: $focused, caret: $caret, caretRequest: $caretRequest, contentHeight: $height,
                             placeholder: String(localized: "Edited message"),
                             onKey: { key in
                                 if key == .escape { onClose(); return true }
                                 // ⌘↩ sends, as in the composer (only when the Send button could)
                                 if key == .commandEnter {
                                     guard canSubmit else { return false }
                                     Task { await submit() }
                                     return true
                                 }
                                 return false
                             },
                             onDrop: { drop in
                                 let result = ComposerIntake.take(drop, root: store.projectURL, existingImages: images.count)
                                 mentions = ComposerMentions.adding(result.mentions, to: mentions)
                                 images += result.images
                                 refusal = result.problems.isEmpty ? nil : result.problems.joined(separator: "\n")
                                 return true
                             })
                .frame(height: min(max(height, 40), 180))
                .padding(6)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor.opacity(0.6)))
            Toggle(isOn: $rewindFiles) {
                if let checkpoint, filesPossible {
                    Text("Also rewind Claude's file changes (\(checkpoint.filesSince) files)")
                } else {
                    Text("Also rewind Claude's file changes")
                }
            }
            .toggleStyle(.checkbox)
            .disabled(!filesPossible)
            .help(filesPossible ? String(localized: "Files Claude changed from this message on are put back; your own edits elsewhere are never touched")
                  : EngineMessages.refusal(error: "rewind_unavailable:files"))
            .font(.callout)
            if let reason = refusal ?? store.rewindBlocker(mode: mode) {
                Label(reason, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .accessibilityIdentifier("Edit and resend refusal")
            }
            HStack {
                Text("A new chat continues from before this message; the old one is kept as “(되돌리기 전)”.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Cancel") { onClose() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await submit() }
                } label: {
                    if store.isRewinding { ProgressView().controlSize(.small) } else { Text("Send") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
                .help("Sends the edited message as a new turn (⌘↩)")
                .accessibilityIdentifier("Edit and resend send")
            }
        }
        .padding(10)
        .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.opacity(0.35)))
        .task {
            draft = text
            mentions = meta.mentions
            rewindFiles = filesPossible
            guard !meta.attachments.isEmpty else { return }
            loadingImages = true
            images = await store.composerImages(for: meta.attachments)
            loadingImages = false
        }
        .accessibilityIdentifier("Edit and resend editor")
    }

    private func submit() async {
        guard let checkpoint else { return }
        refusal = nil
        let outcome = await store.rewind(toTurn: checkpoint.turn, mode: mode, editText: draft,
                                         mentions: mentions.map(ComposerMentions.normalized), images: images)
        switch outcome {
        case .rewound, .needsConfirmation: onClose()
        case let .refused(text): refusal = text
        }
    }
}

/// "이 시점으로 되돌리기": 대화만 / 파일만 / 둘 다, with what each would restore and why a choice is off.
struct RewindSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var store
    let checkpoint: TurnCheckpoint
    @State private var mode: RewindMode = .both
    @State private var refusal: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Rewind to before this message").font(.title3.weight(.semibold))
                Text(verbatim: "“\(checkpoint.prompt)”")
                    .font(.callout).foregroundStyle(.secondary).lineLimit(2)
            }
            VStack(alignment: .leading, spacing: 8) {
                option(.conversation, title: String(localized: "Conversation only"),
                       detail: String(localized: "A new chat continues from before this message; the files stay as they are."),
                       symbol: "bubble.left.and.bubble.right")
                option(.files, title: String(localized: "Files only"),
                       detail: String(localized: "Puts back the \(checkpoint.filesSince) files Claude changed from this message on; the chat stays."),
                       symbol: "doc.on.doc")
                option(.both, title: String(localized: "Both"),
                       detail: String(localized: "Rewinds the conversation and the \(checkpoint.filesSince) files."),
                       symbol: "arrow.uturn.backward.circle")
            }
            Text("Only files Claude changed are restored — your own work elsewhere is never touched. The old chat is kept as “(되돌리기 전)”.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let reason = refusal ?? store.rewindBlocker(mode: mode) {
                Label(reason, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout).foregroundStyle(.orange)
                    .accessibilityIdentifier("Rewind refusal")
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await submit() }
                } label: {
                    if store.isRewinding { ProgressView().controlSize(.small) } else { Text("Rewind") }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!checkpoint.allows(mode) || store.isRewinding || store.rewindBlocker(mode: mode) != nil)
                .accessibilityIdentifier("Rewind confirm")
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear {
            if !checkpoint.allows(.both) { mode = checkpoint.canRewindConversation ? .conversation : .files }
        }
        .accessibilityIdentifier("Rewind sheet")
    }

    private func reason(_ mode: RewindMode) -> String? {
        if checkpoint.allows(mode) { return nil }
        switch mode {
        case .conversation: return EngineMessages.refusal(error: "rewind_unavailable:conversation")
        case .files: return EngineMessages.refusal(error: "rewind_unavailable:files")
        case .both:
            return checkpoint.canRewindConversation ? EngineMessages.refusal(error: "rewind_unavailable:files")
                : EngineMessages.refusal(error: "rewind_unavailable:conversation")
        }
    }

    private func option(_ value: RewindMode, title: String, detail: String, symbol: String) -> some View {
        let unavailable = reason(value)
        let selected = mode == value
        return Button {
            mode = value
            refusal = nil
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                Image(systemName: symbol).frame(width: 18).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).fontWeight(.medium)
                    Text(unavailable ?? detail).font(.caption).foregroundStyle(unavailable == nil ? Color.secondary : Color.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            .padding(10)
            .background(selected ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.accentColor.opacity(0.6) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(unavailable != nil)
        .opacity(unavailable == nil ? 1 : 0.55)
        .accessibilityIdentifier("Rewind \(value.rawValue)")
    }

    private func submit() async {
        refusal = nil
        switch await store.rewind(toTurn: checkpoint.turn, mode: mode) {
        case .rewound, .needsConfirmation: dismiss()
        case let .refused(text): refusal = text
        }
    }
}
