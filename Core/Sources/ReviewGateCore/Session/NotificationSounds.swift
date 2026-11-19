import Foundation

// MARK: notification-sounds (§39.7)

/// Settings › Notifications › Sounds: each kind of notification has its own sound, so they are told apart by ear without
/// looking. Out of the box every category already differs (`defaultSound`); the user picks a macOS alert sound,
/// "Default" (the alert sound chosen in System Settings › Sound) or "None" per category.
public enum NotificationSoundCategory: String, Sendable, CaseIterable, Identifiable {
    /// A permission request or a plan to approve (Claude waits on it).
    case permission
    /// Claude asked a question (also a message from another session waiting for the user).
    case question
    /// A turn finished — files to review — and the other "done" ones (side answers, subagents).
    case turnFinished
    /// It stopped on a problem: an error that needs the user, a usage limit, a login, an API error.
    case error
    /// The app's own update notices (§48).
    case appUpdate

    public var id: String { rawValue }

    public init(event: AttentionEvent) {
        switch event.kind {
        case .permission, .plan: self = .permission
        case .question, .peerMessage: self = .question
        case .actionNeeded: self = .error
        case .turnFinished: self = event.stopReason == nil ? .turnFinished : .error
        case .sideAnswer, .agentsFinished: self = .turnFinished
        }
    }

    /// The UserDefaults choice (`NotificationSound.stored`; unset → `defaultSound`).
    public var defaultsKey: String { "notificationSound.\(rawValue)" }

    /// Distinct out of the box: a bright chime for what blocks Claude, a soft one for a question, a fanfare for finished
    /// work, the low buzz macOS uses for errors, a light pop for the update.
    public var defaultSound: NotificationSound {
        switch self {
        case .permission: .named("Glass")
        case .question: .named("Purr")
        case .turnFinished: .named("Hero")
        case .error: .named("Basso")
        case .appUpdate: .named("Pop")
        }
    }
}

/// One category's sound.
public enum NotificationSound: Sendable, Hashable {
    /// The alert sound chosen in System Settings › Sound.
    case systemDefault
    case none
    /// A macOS alert sound by name ("Glass" — a file of /System/Library/Sounds without its extension).
    case named(String)

    /// The value kept in UserDefaults: "default", "none" or the sound's name.
    public var stored: String {
        switch self {
        case .systemDefault: "default"
        case .none: "none"
        case .named(let name): name
        }
    }

    /// nil for nothing stored (an empty string too) — the category's default applies.
    public init?(stored: String?) {
        guard let stored, !stored.isEmpty else { return nil }
        switch stored {
        case "default": self = .systemDefault
        case "none": self = .none
        default: self = .named(stored)
        }
    }

    /// Where macOS keeps its alert sounds.
    public static let systemSoundsDirectory = URL(fileURLWithPath: "/System/Library/Sounds", isDirectory: true)

    /// The alert sounds macOS ships (Settings lists what `systemSoundNames(in:)` finds; these when it finds none).
    public static let knownSystemSounds = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping",
                                           "Pop", "Purr", "Sosumi", "Submarine", "Tink"]

    /// The sound files of `directory`, by name without extension, sorted; `knownSystemSounds` when it has none.
    public static func systemSoundNames(in directory: URL = systemSoundsDirectory, fileManager: FileManager = .default) -> [String] {
        let files = (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let names = Set(files.filter { ["aiff", "aif", "caf", "wav", "m4a", "mp3"].contains($0.pathExtension.lowercased()) }
            .map { $0.deletingPathExtension().lastPathComponent }
            .filter { !$0.isEmpty && !$0.hasPrefix(".") })
        return names.isEmpty ? knownSystemSounds : names.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}

public extension AppSettings {
    /// The sound picked for `category` in Settings (its default until one is picked).
    static func soundChoice(for category: NotificationSoundCategory, defaults: UserDefaults = .standard) -> NotificationSound {
        NotificationSound(stored: defaults.string(forKey: category.defaultsKey)) ?? category.defaultSound
    }

    /// What a notification of `category` plays: nil while notifications or "Play a sound" are off, or "None" is picked.
    static func notificationSoundToPlay(for category: NotificationSoundCategory,
                                        defaults: UserDefaults = .standard) -> NotificationSound? {
        guard notificationsEnabled(defaults: defaults), notificationSound(defaults: defaults) else { return nil }
        let sound = soundChoice(for: category, defaults: defaults)
        return sound == .none ? nil : sound
    }
}

/// No sound storms: one sound per category every `minimumInterval`, over every window (the notifications themselves are
/// coalesced per window by `AttentionCoalescer`; five windows finishing together still sound once).
public struct NotificationSoundGate: Sendable {
    public var minimumInterval: TimeInterval
    private var last: [NotificationSoundCategory: Date] = [:]

    public init(minimumInterval: TimeInterval = 2) {
        self.minimumInterval = minimumInterval
    }

    public mutating func admits(_ category: NotificationSoundCategory, now: Date = Date()) -> Bool {
        if let previous = last[category], now.timeIntervalSince(previous) < minimumInterval { return false }
        last[category] = now
        return true
    }
}
