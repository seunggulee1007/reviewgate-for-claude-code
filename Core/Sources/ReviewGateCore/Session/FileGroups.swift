import Foundation

// MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2 (comp-14): the review list "묶기" — none / by folder / by layer
// (controller · service · mapper · resources · webapp · test, a Spring project's web → service → SQL flow) — and the row
// path without the source root and the company package ("…/orders/billing/InvoiceServiceImpl.java"). Client rule, the same as
// Electron's `fileGroups.ts`. Sections keep the incoming order (git or risky first) and ⌘] / ⌘[ follow them
// (`AppState.displayOrderedFiles`); the choice is kept per project. A bulk list (§39.1) folds by folder instead.

public enum FileGroupBy: String, CaseIterable, Sendable {
    case none, folder, layer
    /// MARK: wave4c w4c-review — §41.3: the subagent · Bash command · turn that made the change (`ReviewLeftovers.fileCause`).
    case cause

    public var label: String {
        switch self {
        case .none: String(localized: "No grouping", bundle: .module)
        case .folder: String(localized: "By folder", bundle: .module)
        case .layer: String(localized: "By layer", bundle: .module)
        case .cause: String(localized: "By cause", bundle: .module)
        }
    }
}

public enum FileLayer: String, CaseIterable, Sendable {
    case controller, service, mapper, resources, webapp, test, other

    public var label: String {
        switch self {
        case .controller: String(localized: "Controller", bundle: .module)
        case .service: String(localized: "Service", bundle: .module)
        case .mapper: String(localized: "Mapper / SQL", bundle: .module)
        case .resources: String(localized: "Resources", bundle: .module)
        case .webapp: String(localized: "Web (JSP / JS)", bundle: .module)
        case .test: String(localized: "Test", bundle: .module)
        case .other: String(localized: "Other", bundle: .module)
        }
    }
}

public enum FileGroups {
    public struct Section<F>: Sendable where F: Sendable {
        public var key: String
        public var files: [F]
    }

    private static func matches(_ pattern: String, _ s: String, caseless: Bool = false) -> Bool {
        s.range(of: pattern, options: caseless ? [.regularExpression, .caseInsensitive] : .regularExpression) != nil
    }

    /// The layer a path belongs to (a test first: `FooControllerTest.java` is a test).
    public static func layer(of path: String) -> FileLayer {
        if matches(#"(^|/)(__tests__|__mocks__|tests?|specs?|e2e|[^/]*tests)/"#, path, caseless: true)
            || matches(#"[._-](test|spec)\.[A-Za-z0-9]+$|_(test|spec)\.[A-Za-z0-9]+$|(^|/)test_[^/]+$|(Tests?|IT)\.(swift|kt|kts|java|cs|scala|groovy)$"#, path) {
            return .test
        }
        if matches(#"(^|/)(mappers?|sqlmaps?|dao|repository)/|(Mapper|Dao|Repository)\.(xml|java|kt)$"#, path, caseless: true) { return .mapper }
        if matches(#"(^|/)controllers?/|(Controller|Resource|Endpoint)\.(java|kt)$"#, path) { return .controller }
        if matches(#"(^|/)services?/|(Service|ServiceImpl|Facade)\.(java|kt)$"#, path) { return .service }
        if matches(#"(^|/)(webapp|static|templates|public)/|\.(jsp|jspf|tag)$"#, path, caseless: true) { return .webapp }
        if matches(#"(^|/)resources/"#, path) { return .resources }
        return .other
    }

    private static func folder(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    /// The sections: by folder in the order folders first appear, by layer in `FileLayer` order; empty ones left out.
    /// `cause` (wave4c w4c-review): a file's "원인별" section; without it `.cause` is one section.
    public static func group<F: Sendable>(_ files: [F], by: FileGroupBy, path: (F) -> String, cause: ((F) -> String)? = nil) -> [Section<F>] {
        guard by != .none else { return [Section(key: "", files: files)] }
        var keys: [String] = by == .layer ? FileLayer.allCases.map(\.rawValue) : []
        var lists: [String: [F]] = [:]
        for f in files {
            let key = switch by {
            case .folder: folder(of: path(f))
            case .cause: cause?(f) ?? ""
            default: layer(of: path(f)).rawValue
            }
            if lists[key] == nil, !keys.contains(key) { keys.append(key) }
            lists[key, default: []].append(f)
        }
        return keys.compactMap { key in lists[key].map { Section(key: key, files: $0) } }
    }

    /// The files in section order — what the list draws and ⌘] / ⌘[ step through.
    public static func ordered(_ files: [ChangedFile], by: FileGroupBy) -> [ChangedFile] {
        group(files, by: by, path: \.path).flatMap(\.files)
    }

    /// A section's header: the layer, or the folder without its source root ("…/orders/billing"; "" = the project root).
    public static func sectionLabel(_ by: FileGroupBy, key: String) -> String {
        if by == .layer { return FileLayer(rawValue: key)?.label ?? key }
        if by == .cause { return key.isEmpty ? String(localized: "Main", bundle: .module) : key }   // wave4c w4c-review: the cause's own words
        if key.isEmpty { return String(localized: "Project root", bundle: .module) }
        return compactPath(key)
    }

    private static let companies: Set<String> = ["com", "org", "net", "io", "kr", "jp", "dev", "co", "me", "app"]
    private static let sourceKinds = ["java", "kotlin", "groovy", "scala", "resources", "webapp"]

    /// A path without its source root and the company package, the module kept: "src/main/java/com/acme/orders/billing/X.java" →
    /// "…/orders/billing/X.java", "acme-api/src/main/java/com/acme/orders/Api.java" → "acme-api/…/orders/Api.java",
    /// "src/main/webapp/WEB-INF/jsp/user/a.jsp" → "…/user/a.jsp". Other paths stay as they are.
    public static func compactPath(_ path: String) -> String {
        let segs = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard let i = segs.indices.first(where: { i in
            i + 2 < segs.count && segs[i] == "src" && (segs[i + 1] == "main" || segs[i + 1] == "test") && sourceKinds.contains(segs[i + 2])
        }) else { return path }
        let module = segs[..<i].map { $0 + "/" }.joined()
        let kind = segs[i + 2]
        var rest = Array(segs[(i + 3)...])
        if kind == "webapp" {
            if rest.count > 2, rest[0] == "WEB-INF", ["jsp", "views", "tags"].contains(rest[1]) { rest.removeFirst(2) }
        } else if kind != "resources", rest.count >= 4, companies.contains(rest[0]) {
            rest.removeFirst(2)
        }
        return "\(module)…/\(rest.joined(separator: "/"))"
    }

    // MARK: The choice, per project

    static let defaultsKey = "fileGroupByProject"

    /// The grouping kept for the project at `root` (nil / unknown: none).
    public static func choice(for root: String?, defaults: UserDefaults) -> FileGroupBy {
        guard let root, let map = defaults.dictionary(forKey: defaultsKey) as? [String: String] else { return .none }
        return map[root].flatMap(FileGroupBy.init(rawValue:)) ?? .none
    }

    public static func setChoice(_ by: FileGroupBy, for root: String?, defaults: UserDefaults) {
        guard let root else { return }
        var map = (defaults.dictionary(forKey: defaultsKey) as? [String: String]) ?? [:]
        map[root] = by.rawValue
        defaults.set(map, forKey: defaultsKey)
    }
}
