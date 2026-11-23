import SwiftUI
import ReviewGateCore

// MARK: task-start — docs/PROTOCOL.md §63.4: the start screen over a project window's chat area — 1 바로 시작 (a new chat),
// 2 업무로 시작 (the task sheet), 3 대화로 열기 (a recent chat) — with ↑ / ↓ / ↩, and Esc = 바로 시작, so it never blocks.
// Core `StartScreen` decides when it shows and what it lists.

/// Decides once per project open whether the start screen shows, and shows it (with the task sheet) over the chat area.
struct StartScreenOverlay: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        ZStack {
            if model.showStartScreen, store.projectURL != nil {
                StartScreenView()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: model.showStartScreen)
        .task(id: store.projectURL) { await decide() }
        // Work that starts meanwhile (a peer message, a task handed over) puts it away.
        .onChange(of: store.gatePhase) { _, phase in if phase != .idle { model.showStartScreen = false } }
        .onChange(of: store.taskForComposer?.id) { _, id in if id != nil { model.showStartScreen = false } }
    }

    /// Once the project's chats are known: show it unless something says not to (Core `StartScreen.shouldShow`).
    private func decide() async {
        guard let url = store.projectURL else {
            model.showStartScreen = false
            model.startScreenCheckedRoot = nil
            return
        }
        let root = AppSettings.projectKey(url)
        guard model.startScreenCheckedRoot != root else { return }
        model.startScreenCheckedRoot = root
        model.showStartScreen = false
        let suppressed = WorkbenchRegistry.shared.takeStartScreenSuppression(for: url) || model.suppressNextStartScreen
        model.suppressNextStartScreen = false
        for _ in 0..<50 where store.sessionsInfo == nil {
            try? await Task.sleep(for: .milliseconds(100))
            if Task.isCancelled { return }
        }
        guard store.projectURL == url, store.sessionsInfo != nil, !store.needsGitInit else { return }   // a git-init prompt comes first
        model.showStartScreen = StartScreen.shouldShow(skip: AppSettings.skipStartScreen(), suppressed: suppressed, phase: store.gatePhase,
                                                       reviewPending: store.hasPendingReview, composerTask: store.taskForComposer != nil)
    }
}

/// The three choices and the recent chats.
struct StartScreenView: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @AppStorage(AppSettings.Key.skipStartScreen) private var skipNextTime = false
    @State private var cursor = StartScreenCursor()
    @State private var showTaskSheet = false
    @FocusState private var focused: Bool

    private var chats: [SessionMeta] { store.startScreenChats }
    private var chatIds: [String] { chats.map(\.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(store.projectInfo?.name ?? store.projectURL?.lastPathComponent ?? "")
                        .font(.title2.weight(.semibold))
                    Text("How do you want to start?")
                        .foregroundStyle(.secondary)
                }
                HStack(alignment: .top, spacing: 12) {
                    choiceCard(.start, symbol: "bubble.left.and.text.bubble.right", title: "Start now",
                               detail: "Open a new chat")
                    choiceCard(.task, symbol: "checklist", title: "Start from a task",
                               detail: store.isShadowProject ? "From a task, in this folder" : "A task's branch and first prompt")
                    choiceCard(.chat, symbol: "clock.arrow.circlepath", title: "Open a chat",
                               detail: "Continue a recent chat")
                        .disabled(chats.isEmpty)
                        .help(chats.isEmpty ? String(localized: "This project has no earlier chats") : String(localized: "Continue a recent chat (3)"))
                }
                recentList
                HStack {
                    Toggle("Start straight away next time", isOn: $skipNextTime)
                        .toggleStyle(.checkbox)
                        .help("Skips this screen when a project opens — Settings › Tasks › Start screen turns it back on")
                        .accessibilityIdentifier("Skip the start screen")
                    Spacer()
                    Text("1 · 2 · 3, ↑ ↓ ↩ — Esc starts now")
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }
            .padding(28)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(.regularMaterial)
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .task {
            // The chat behind takes the keyboard as it appears; the screen takes it back a moment later.
            focused = true
            try? await Task.sleep(for: .milliseconds(150))
            focused = true
        }
        .onKeyPress(characters: CharacterSet(charactersIn: "123"), phases: .down) { press in
            guard let n = Int(press.characters) else { return .ignored }
            if let action = cursor.press(n, chats: chatIds) { perform(action) }
            return .handled
        }
        .onKeyPress(.upArrow) { cursor.move(-1, chats: chatIds); return .handled }
        .onKeyPress(.downArrow) { cursor.move(1, chats: chatIds); return .handled }
        .onKeyPress(.return) {
            if let action = cursor.activate(chats: chatIds) { perform(action) }
            return .handled
        }
        .onKeyPress(.escape) { perform(.start); return .handled }
        .sheet(isPresented: $showTaskSheet, onDismiss: { focused = true }) {
            TaskStartSheet { outcome in
                switch outcome {
                case .startedHere:
                    finish()
                case let .workbench(url):
                    finish()
                    WorkbenchRegistry.shared.suppressStartScreen(for: url)
                    if !WorkbenchRegistry.shared.focusWindow(for: url) {
                        openWindow(id: "workbench", value: ProjectOpener.newWindowValue(url))
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Start screen")
    }

    private func choiceCard(_ choice: StartChoice, symbol: String, title: LocalizedStringKey, detail: LocalizedStringKey) -> some View {
        let marked = cursor.mark == .choice(choice)
        return Button {
            cursor.mark = .choice(choice)
            if let action = cursor.activate(chats: chatIds) { perform(action) }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: symbol).font(.title2).foregroundStyle(Color.accentColor)
                    Spacer()
                    Text(verbatim: "\(choice.rawValue)")
                        .font(.caption.monospaced().weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                        .accessibilityHidden(true)
                }
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.leading)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(marked ? Color.accentColor : Color.secondary.opacity(0.25), lineWidth: marked ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
        .accessibilityHint(Text(detail))
        .accessibilityIdentifier("Start choice \(choice.rawValue)")
    }

    @ViewBuilder
    private var recentList: some View {
        if !chats.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Recent chats").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                VStack(spacing: 0) {
                    ForEach(Array(chats.enumerated()), id: \.element.id) { index, chat in
                        recentRow(chat, marked: cursor.mark == .chat(index)) {
                            cursor.mark = .chat(index)
                            perform(.openChat(chat.id))
                        }
                        if index < chats.count - 1 { Divider() }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.2)))
            }
        }
    }

    private func recentRow(_ chat: SessionMeta, marked: Bool, open: @escaping () -> Void) -> some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: chat.kind == .terminal ? "terminal" : "bubble.left")
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: SessionMeta.displayTitle(chat.title)).lineLimit(1)
                    Text(chat.kind == .terminal ? "Terminal chat" : "Chat")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if chat.id == store.currentSessionId {
                    Text("Open now").font(.caption).foregroundStyle(.secondary)
                }
                if let date = Self.date(chat.updatedAt) {
                    RelativeTimeText(date).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(marked ? Color.accentColor.opacity(0.15) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(chat.lastUserText.isEmpty ? SessionMeta.displayTitle(chat.title) : chat.lastUserText)
        .accessibilityIdentifier("Start recent chat")
    }

    private func perform(_ action: StartScreenCursor.Action) {
        switch action {
        case .start:
            finish()
            Task { await store.startStraight() }
        case .task:
            showTaskSheet = true
        case let .openChat(id):
            finish()
            Task { if id != store.currentSessionId { await store.openChat(id: id) } }
        }
    }

    /// The screen goes away; the chat takes the keyboard.
    private func finish() {
        model.showStartScreen = false
        if store.shownChatIsTerminal {
            model.terminals.focus(chatId: store.currentSessionId)
        } else {
            model.chatComposer.inputFocused = true
        }
    }

    private static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}
