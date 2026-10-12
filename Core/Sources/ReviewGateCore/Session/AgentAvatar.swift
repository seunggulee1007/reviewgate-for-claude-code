import Foundation

// MARK: wave5 w5-board
// docs/PROTOCOL.md §43.1 — the agent board's avatars: one round face per agent type (an icon and a pastel tone), the icon of
// the tool an agent runs now, the friendly names of the frequent MCP servers' tools ("두레이 업무 읽기"), and the agent's
// mood (working, waiting for a permission, retrying, done, failed, stopped, idle). Electron's `renderer/agentAvatar.ts`
// follows the same rule; both are checked against `engine/test/fixtures/agentAvatars.json`.

/// The pastel tone of an avatar: its ring and icon color (`light` on a light ground, `dark` on a dark one, both #RRGGBB).
public enum AgentAvatarTone: String, CaseIterable, Sendable {
    case coral, peach, butter, lime, leaf, mint, teal, sky, periwinkle, lavender, grape, pink, rose, sand, slate, claude

    /// (light, dark) as 0xRRGGBB — the light one keeps 3:1 on white, the dark one 8:1 on the dark window.
    public var hex: (light: UInt32, dark: UInt32) {
        switch self {
        case .coral: (0xD2603F, 0xFF9E86)
        case .peach: (0xC2701C, 0xFFBE80)
        case .butter: (0xA07C00, 0xFFD966)
        case .lime: (0x5E8C1A, 0xB5DE76)
        case .leaf: (0x2B8A50, 0x7EDB9F)
        case .mint: (0x13887A, 0x74E0CB)
        case .teal: (0x1580A0, 0x78D3EC)
        case .sky: (0x2F78CC, 0x8EC2FF)
        case .periwinkle: (0x5560CF, 0xA9B1FF)
        case .lavender: (0x7D55C7, 0xC6AEFF)
        case .grape: (0x9B47B8, 0xE2A6F6)
        case .pink: (0xC94B85, 0xFF9FCA)
        case .rose: (0xC24A5E, 0xFF9DAD)
        case .sand: (0x93703F, 0xE2C397)
        case .slate: (0x56708A, 0xA9C1D9)
        case .claude: (0xC96442, 0xF0A285)
        }
    }

    /// Tones for a type the table does not know, by `AgentIdentity.colorIndex` — the families the Mac panel used before
    /// (teal, indigo, pink, purple, mint, cyan, brown, yellow).
    static let byIdentity: [AgentAvatarTone] = [.teal, .periwinkle, .pink, .lavender, .mint, .sky, .sand, .butter]
}

/// What an avatar shows. Every case but `robot` and `claude` is an SF Symbol on the Mac and an inline SVG on Electron;
/// those two are drawn (there is no robot symbol, and the main agent is Claude's own star).
public enum AgentAvatarIcon: String, CaseIterable, Sendable {
    case hammer, compass, binoculars, flask, brush, pencil, glasses, shield, bug, map, scales, atom, stamp, book, branch,
         footprints, checklist, robot, claude

    /// The SF Symbol (nil: drawn by the app).
    public var symbol: String? {
        switch self {
        case .hammer: "hammer.fill"
        case .compass: "compass.drawing"
        case .binoculars: "binoculars.fill"
        case .flask: "flask.fill"
        case .brush: "paintbrush.pointed.fill"
        case .pencil: "pencil"
        case .glasses: "eyeglasses"
        case .shield: "shield.lefthalf.filled"
        case .bug: "ladybug.fill"
        case .map: "map.fill"
        case .scales: "scalemass.fill"
        case .atom: "atom"
        case .stamp: "checkmark.seal.fill"
        case .book: "book.fill"
        case .branch: "arrow.triangle.branch"
        case .footprints: "shoeprints.fill"
        case .checklist: "checklist"
        case .robot, .claude: nil
        }
    }
}

/// One agent's face: icon, tone, the type's name without the plugin and the plugin as a small badge.
public struct AgentAvatar: Sendable, Equatable {
    public var icon: AgentAvatarIcon
    public var tone: AgentAvatarTone
    public var name: String
    public var badge: String?

    /// Known types by their name without the plugin prefix, lowercased.
    static let known: [String: (AgentAvatarIcon, AgentAvatarTone)] = [
        "executor": (.hammer, .coral),
        "architect": (.compass, .sky),
        "explore": (.binoculars, .mint),
        "test-engineer": (.flask, .lavender),
        "designer": (.brush, .pink),
        "writer": (.pencil, .butter),
        "code-reviewer": (.glasses, .teal),
        "security-reviewer": (.shield, .periwinkle),
        "debugger": (.bug, .lime),
        "planner": (.map, .peach),
        "plan": (.map, .peach),
        "critic": (.scales, .rose),
        "scientist": (.atom, .grape),
        "verifier": (.stamp, .leaf),
        "document-specialist": (.book, .sand),
        "git-master": (.branch, .peach),
        "tracer": (.footprints, .slate),
        "qa-tester": (.checklist, .mint),
    ]

    /// The avatar of a subagent type (`AgentNode.type`): a known type's icon and tone, else the sparkle robot in the tone of
    /// its identity color. `oh-my-claudecode:executor` is executor with an "OMC" badge.
    public static func of(type: String) -> AgentAvatar {
        let name = AgentGlance.typeLabel(type)
        let badge = AgentIdentity.pluginBadge(type)
        if let (icon, tone) = known[name.lowercased()] { return AgentAvatar(icon: icon, tone: tone, name: name, badge: badge) }
        let tone = AgentAvatarTone.byIdentity[AgentIdentity.colorIndex(type) % AgentAvatarTone.byIdentity.count]
        return AgentAvatar(icon: .robot, tone: tone, name: name, badge: badge)
    }

    /// The main agent: Claude's star.
    public static let main = AgentAvatar(icon: .claude, tone: .claude, name: "", badge: nil)
}

/// The small icon of the tool an agent runs (its `lastStep.tool`, the main agent's HUD activity).
public enum AgentToolIcon: String, CaseIterable, Sendable {
    case doc, pencil, terminal, magnifier, globe, sparkles, agent, checklist, plug, dooray, database, searchCluster, browser, wrench

    public var symbol: String {
        switch self {
        case .doc: "doc.text"
        case .pencil: "pencil"
        case .terminal: "terminal"
        case .magnifier: "magnifyingglass"
        case .globe: "globe"
        case .sparkles: "sparkles"
        case .agent: "person.2.fill"
        case .checklist: "checklist"
        case .plug: "powerplug.fill"
        case .dooray: "d.square.fill"
        case .database: "cylinder.split.1x2.fill"
        case .searchCluster: "text.magnifyingglass"
        case .browser: "cursorarrow.rays"
        case .wrench: "wrench.and.screwdriver.fill"
        }
    }

    public static func of(tool: String) -> AgentToolIcon {
        switch tool {
        case "Read", "NotebookRead": return .doc
        case "Edit", "MultiEdit", "Write", "NotebookEdit": return .pencil
        case "Bash", "BashOutput", "KillShell", "KillBash", "PowerShell": return .terminal
        case "Grep", "Glob", "LS", "ToolSearch": return .magnifier
        case "WebFetch", "WebSearch": return .globe
        case "Skill": return .sparkles
        case "Agent", "Task", "SendMessage": return .agent
        case "TodoWrite", "TaskCreate", "TaskUpdate": return .checklist
        default: break
        }
        let label = ToolLabel.of(tool)
        guard label.kind == .mcp else { return .wrench }
        switch McpServerKind.of(label.server ?? "") {
        case .dooray?: return .dooray
        case .mysql?: return .database
        case .elasticsearch?: return .searchCluster
        case .chrome?: return .browser
        case nil: return .plug
        }
    }
}

/// The MCP servers the board names in words (matched in the server's name: `mysql-mcp`, `elasticsearch`,
/// `claude-in-chrome` …).
public enum McpServerKind: String, CaseIterable, Sendable {
    case dooray, mysql, elasticsearch, chrome

    public static func of(_ server: String) -> McpServerKind? {
        let s = server.lowercased()
        if s.contains("dooray") { return .dooray }
        if s.contains("mysql") { return .mysql }
        if s.contains("elastic") { return .elasticsearch }
        if s.contains("chrome") { return .chrome }
        return nil
    }

    func displayName(korean: Bool) -> String {
        switch self {
        case .dooray: korean ? "두레이" : "Dooray"
        case .mysql: "MySQL"
        case .elasticsearch: korean ? "엘라스틱서치" : "Elasticsearch"
        case .chrome: korean ? "크롬" : "Chrome"
        }
    }

    /// What a tool of this server does (key: the tool without the server's `<server>_` prefix), Korean and English.
    var actions: [String: (ko: String, en: String)] {
        switch self {
        case .dooray:
            let readTask = ("업무 읽기", "read a task")
            let editTask = ("업무 고치기", "update a task")
            let projects = ("프로젝트 보기", "read projects")
            let wiki = ("위키 읽기", "read the wiki")
            let members = ("멤버 보기", "look up members")
            return [
                "get_posts": ("업무 읽기", "read tasks"),
                "get_post_detail": readTask, "get_post_by_id": readTask,
                "get_post_with_comments": ("업무·댓글 읽기", "read a task and its comments"),
                "get_post_comments": ("댓글 읽기", "read comments"),
                "add_post_comment": ("댓글 달기", "add a comment"),
                "update_post_comment": ("댓글 고치기", "edit a comment"),
                "search_posts": ("업무 찾기", "search tasks"), "find_posts_across_projects": ("업무 찾기", "search tasks"),
                "create_post": ("업무 만들기", "create a task"),
                "update_post": editTask, "update_post_users": editTask, "bulk_update_post_status": editTask,
                "bulk_close_posts": editTask, "add_post_tag": editTask,
                "get_projects": projects, "get_project_detail": projects, "get_project_workflows": projects,
                "get_wiki_page": wiki, "get_wiki_pages": wiki, "get_wikis": wiki,
                "search_wiki_pages": ("위키 찾기", "search the wiki"),
                "create_wiki_page": ("위키 쓰기", "write a wiki page"),
                "update_wiki_page": ("위키 고치기", "edit a wiki page"),
                "get_my_info": members, "get_member": members, "search_members": members, "get_members_by_email": members,
                "download_post_file": ("첨부 받기", "download an attachment"),
            ]
        case .mysql:
            return [
                "execute_query": ("쿼리 실행", "run a query"),
                "describe_table": ("테이블 구조 보기", "describe a table"),
                "list_tables": ("테이블 목록 보기", "list tables"),
                "list_databases": ("DB 목록 보기", "list databases"),
                "connect_prod": ("운영 DB 연결", "connect to production"),
                "disconnect_prod": ("운영 DB 연결 끊기", "disconnect from production"),
            ]
        case .elasticsearch:
            return [
                "esql": ("ES|QL 조회", "ES|QL query"),
                "search": ("검색", "search"),
                "list_indices": ("인덱스 목록 보기", "list indices"),
                "get_mappings": ("매핑 보기", "read mappings"),
                "get_shards": ("샤드 보기", "read shards"),
            ]
        case .chrome:
            let pick = ("브라우저 고르기", "pick a browser")
            let upload = ("파일 올리기", "upload a file")
            return [
                "navigate": ("페이지 이동", "open a page"),
                "computer": ("화면 조작", "click and type"),
                "javascript_tool": ("자바스크립트 실행", "run JavaScript"),
                "browser_batch": ("여러 동작 실행", "run several actions"),
                "read_page": ("페이지 읽기", "read the page"),
                "get_page_text": ("페이지 글 읽기", "read the page text"),
                "find": ("요소 찾기", "find on the page"),
                "form_input": ("입력하기", "fill a form"),
                "file_upload": upload, "upload_image": upload,
                "tabs_context_mcp": ("탭 확인", "check the tabs"),
                "tabs_create_mcp": ("탭 열기", "open a tab"),
                "tabs_close_mcp": ("탭 닫기", "close a tab"),
                "read_console_messages": ("콘솔 보기", "read the console"),
                "read_network_requests": ("네트워크 보기", "read network requests"),
                "switch_browser": pick, "select_browser": pick, "list_connected_browsers": pick,
                "resize_window": ("창 크기 바꾸기", "resize the window"),
                "gif_creator": ("GIF 만들기", "record a GIF"),
                "shortcuts_execute": ("단축키 실행", "run a shortcut"), "shortcuts_list": ("단축키 보기", "list shortcuts"),
            ]
        }
    }
}

public enum AgentToolText {
    /// What an agent runs, in words: "두레이 업무 읽기 · 4821" / "Dooray: read tasks · 4821" for the frequent MCP servers, else
    /// the §39.3 title ("Bash · ./gradlew test", "context7 · query docs", "스킬 acme-tools:smoke").
    public static func text(tool: String, detail: String?, language: String = ElapsedFormat.uiLanguage) -> String {
        let d = detail.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        let label = ToolLabel.of(tool)
        guard label.kind == .mcp, let server = label.server, let kind = McpServerKind.of(server) else {
            return AgentGlance.toolTitle(tool, detail: d)
        }
        let korean = language.lowercased().hasPrefix("ko")
        let raw = rawToolName(tool, server: server)
        let head: String
        if let action = kind.actions[raw] {
            head = korean ? "\(kind.displayName(korean: true)) \(action.ko)" : "\(kind.displayName(korean: false)): \(action.en)"
        } else {
            head = "\(kind.displayName(korean: korean)) · \(label.name)"
        }
        return d.map { "\(head) · \($0)" } ?? head
    }

    /// `mcp__dooray__dooray_get_posts` → `get_posts` (the tool without its server's repeated prefix, underscores kept).
    static func rawToolName(_ tool: String, server: String) -> String {
        var rest = String(tool.dropFirst("mcp__".count + server.count + 2))
        if rest.hasPrefix(server + "_"), rest.count > server.count + 1 { rest = String(rest.dropFirst(server.count + 1)) }
        // `mysql-mcp` names its tools without the prefix; `dooray` repeats it as `dooray_`.
        let short = server.split(separator: "-").first.map(String.init) ?? server
        if short != server, rest.hasPrefix(short + "_"), rest.count > short.count + 1 { rest = String(rest.dropFirst(short.count + 1)) }
        return rest
    }
}

/// How an agent looks on the board right now.
public enum AgentMood: String, Sendable, CaseIterable {
    /// Working: a little bounce and "…".
    case working
    /// Waiting for the user's permission answer: a raised hand that waves.
    case waiting
    /// The CLI retries its API request: a turning arrow.
    case retrying
    /// Finished: a check and a sparkle.
    case done
    /// Failed: a red X and a dizzy face.
    case failed
    /// Stopped (by the user or the engine).
    case stopped
    /// Resting (paused, or the main agent between turns): "z".
    case idle

    public static func of(_ agent: AgentNode, awaitingPermission: Bool) -> AgentMood {
        switch agent.status {
        case .pending, .running:
            if awaitingPermission { return .waiting }
            return agent.retry != nil ? .retrying : .working
        case .paused: return awaitingPermission ? .waiting : .idle
        case .completed: return .done
        case .failed: return .failed
        case .stopped: return .stopped
        }
    }

    /// The main agent: working while a turn runs, waiting on its own permission card, else resting.
    public static func main(running: Bool, awaitingPermission: Bool) -> AgentMood {
        if awaitingPermission { return .waiting }
        return running ? .working : .idle
    }

    /// Whether the face moves (Reduce Motion shows the still picture).
    public var moves: Bool { self == .working || self == .waiting || self == .retrying }
}
