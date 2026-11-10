# M7 contract — project switcher, skills/slash commands, HUD

> **Superseded (M9).** Historical contract kept for reference only; the live contract is `docs/PROTOCOL.md` (protocol v2) and `docs/M9-ENGINE.md`. The Swift types/APIs named below were deleted in M9 step 4.

## Sidecar / PROTOCOL additions
- `start_session.loadUserSettings?: boolean` (default true): true → `settingSources: ["user","project"]`, `skills: "all"`; false → `["project"]`.
  In BOTH cases every non-edit tool (anything except Edit|Write|MultiEdit|NotebookEdit and the read-only set Read|Glob|Grep|LS|TodoWrite|Task-less) goes through a PreToolUse hook that returns
  `permissionDecision: "ask"` unless the tool is in `autoAllowTools` → forces canUseTool → app PermissionCard, regardless of user allow rules.
- `session_info` gains: `slashCommands: string[]`, `skills: string[]`, `plugins: [{name, path}]`, `mcpServers: [{name, status}]`, `contextWindow: number?` (tokens; from init/modelUsage if available else nil).
- `turn_end.usage` gains: `cacheReadTokens`, `cacheCreationTokens`, `contextTokens` (= input + cacheRead + cacheCreation of the LAST assistant message in the turn, i.e. current context size), `contextWindow?`.
- New `activity` message: `{type:"activity", kind:"tool_start"|"tool_end"|"subagent_start"|"subagent_end"|"thinking"|"idle", toolName?, detail?}` — emitted from tool_use/tool_result (Agent tool = subagent) and stream_event content_block_start of type thinking. Cheap, best-effort.

## Core (SessionStore) additions
```swift
public struct SessionCapabilities: Sendable { public let slashCommands: [String]; public let skills: [String]; public let plugins: [String]; public let mcpServers: [(name: String, status: String)] }
public var capabilities: SessionCapabilities?
public struct HUDState: Sendable { public var contextTokens: Int; public var contextWindow: Int?; public var sessionCostUSD: Double; public var turnCount: Int; public var lastTurnMs: Int; public var activity: String /* localized short text */; public var activeTool: String?; public var subagentDepth: Int; public var turnStartedAt: Date? }
public var hud: HUDState
public func switchProject(to url: URL)   // shutdown current (even with pending review — caller confirms), then openProject
public var hasPendingReview: Bool         // !pendingFiles.isEmpty
```
AppSettings: `loadUserSettings` (Bool, default true, key `loadUserSettings`).
