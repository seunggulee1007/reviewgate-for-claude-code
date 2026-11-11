# ReviewGate Engine Protocol (v2)

The engine (`engine/`, `ReviewEngine`) is the single business-logic core: session lifecycle, the
review gate, HUD accounting, branches and PR browsing. Clients (the Mac app, the Electron client, the
`driver-v2.mjs` conformance script) are thin: they render `state`, append streaming events to a
transcript, and send commands. Every reason code and message text originates in the engine; clients
only localize.

Transport: NDJSON over stdio (`sidecar/dist/sidecar.mjs`: commands on **stdin**, events on **stdout**,
free-form logs on **stderr**; stdout never carries anything but JSON) or the same objects over Electron
IPC (`ReviewEngine.handle` / `ReviewEngine.on` in-process). `type` is the discriminator on both
directions. TypeScript source of truth: `engine/src/protocol.ts`.

**Replies.** Commands may carry `id: string`. Every command with an `id` gets exactly one reply carrying
that `id`: the typed reply listed for it (`ready`, `file_diff`, `full_file_content`), else
`result{ok:true}` / `result{ok:false, error}`. Commands without an `id` get no `result` (typed replies are
still emitted); state changes arrive via `state` either way. Commands run in order on one lane; PR
commands (`pr_*`, `accounts`, `login_in_terminal`) run on their own lane so a slow `gh` call never delays
`send` / `interrupt`.

**First message.** In stdio mode the first line must be `hello`; anything else is answered with
`error{fatal:true, scope:"engine"}` and the sidecar exits with code 2 (protocol v1 was removed in M9).

## 1. App → Engine commands

```ts
type Cmd<T extends string, P = {}> = { type: T; id?: string } & P;

type Budget = { maxFiles: number; maxLines: number; hardMultiplier?: number /* 1.5 when absent */ };   // 0 = no limit on that count; the engine defaults to {0, 0, 2.0}: no change budget (§54)

type Settings = {
  budget: Budget;
  ignorePatterns: string[];       // parsed, one entry per pattern (prefix match, or `*` glob; see §4)
  autoAllowTools: string[];       // e.g. ["Bash"]; edit tools are always auto-allowed
  loadUserSettings: boolean;      // see §4 Settings
  systemPromptAppend: string;     // already rendered ({maxFiles}/{maxLines} substituted by the client)
  claudePath?: string; ghPath?: string; gitPath?: string;   // toolchain overrides (claudePath also pins a CLI version, §36.8)
  ghHost: string;                 // PR browser host
  model?: string;
  worktreeRoot?: string;          // base folder for managed workbenches (default ~/.reviewgate/worktrees; §6)
  commitPushByDefault?: boolean;  // default of commit.push when the command omits it (default false; §7)
  commitTrailer?: string;         // appended to every commit message as a trailer line when non-empty (§7)
  autoRestartSession?: boolean;   // restart the session once (2 s backoff, ≤ 1 per turn) when it dies unexpectedly (default true; §8)
  autoAllowReadOnlyBash?: boolean; // read-only Bash commands run without a permission_request (default true; §10)
  bashAllowPatterns?: string[];   // Claude-style allow patterns, e.g. ["Bash(npm test:*)", "Bash(git *)"] (default []; §10); also "mcp__server__*", "WebFetch(domain:x)", … (§33.6)
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto";  // mode a NEW session starts in (default "default"; §11)
  extensionsInitTimeoutMs?: number; // with user settings: restart without them when the CLI has not initialized after N ms (default 20000; 0 = off; §16) — §36.7: a stall limit and a floor under the adaptive one
  disabledPlugins?: string[];     // plugins kept off: "name@marketplace" (or a bare name of a plugin seen before); next session start (§16)
  disableUserHooks?: boolean;     // settings-file + plugin hooks off, ReviewGate's own hooks keep running; next session start (§16)
  sideModel?: string;             // model of side-question sessions (default: model; §21)
  sideAllowWeb?: boolean;         // side sessions may use WebFetch / WebSearch (default true; §21)
  effort?: "low" | "medium" | "high" | "xhigh" | "max";   // effort a NEW session starts with when the project stored none (§25)
  peerInbound?: "ask" | "auto" | "off";   // messages from the user's other Claude sessions (default "auto" since r2-peers, "ask" before; a project's peer_set wins; §29)
  allowWorktreeIsolation?: boolean; // agents with isolation / a cwd elsewhere (and a Workflow whose agents use isolation) run — a card outside auto mode — instead of a deny (M05b: default true; next session start; §33.4)
  chatMoveFollowUp?: string;      // what is sent once the engine moved the chat by itself (EnterWorktree / ExitWorktree in auto mode); "{name}" = the worktree folder (M05b; §39.4)
  applyUserAllowRules?: boolean;  // the user's Claude Code permissions.allow rules apply to tools that cannot change files (default true; live; §33.5)
  applyUserBashRules?: boolean;   // with applyUserAllowRules: the user's / project's Bash(…) allow rules count like bashAllowPatterns (default true; live; §33.5)
  persistSessionAllows?: boolean; // remember-allows are kept per repository (its git common dir, every worktree's) and restored on open_project (default true; §33.7)
  testCommandPatterns?: string[]; // extra test commands (glob per simple command, e.g. "./mvn-ci.sh*test*"); live (default []; §34.9)
  loadLocalSettings?: boolean;    // .claude/settings.local.json + local MCP servers (default true; per project; next session start; §36.6)
  commitTemplate?: string;        // commit_draft's format; {issue} / {branch} (per project; live; §36.11)
  workbenchSetup?: WorkbenchSetup; // copy / .worktreeinclude / setup command / fetch / location of new workbenches (per project; live; §36.12)
};

type EngineCommand =
  | Cmd<"hello", { protocolVersion: 2; client: "mac" | "windows" | "test"; env?: Record<string,string>; settings: Settings }>  // → ready, then state
  | Cmd<"set_settings", { settings: Partial<Settings> }>   // budget, ignorePatterns, ghHost apply live; the rest on the next open_project
  | Cmd<"open_project", { path: string; takeover?: boolean }>   // closes the current project if any → state (project | gitInit | lockConflict); takeover overrides another session's lock (§6)
  | Cmd<"switch_project", { path: string; takeover?: boolean }> // alias of open_project (the client confirmed a pending review)
  | Cmd<"close_project">
  | Cmd<"init_repo">                                       // when state.gitInit != null: git init, then start the session
  | Cmd<"cancel_git_init">
  | Cmd<"restart_session">                                 // new Claude session for the open project WITHOUT resetting the gate; resumes the stored session id (§8)
  | Cmd<"send", { text: string; acceptPending?: boolean; mentions?: string[]; attachments?: SendAttachment[] }>  // guarded by gate.canSend; engine prefixes gate.lastReviewSummary; acceptPending accepts every pending file first (§10); mentions §23, attachments §24
  | Cmd<"request_changes", { extra?: string; noteIds?: string[] }>   // guarded by gate.canRequestChanges (bypasses canSend by design); noteIds: only these unsent notes go, the others stay unsent
  | Cmd<"interrupt">                                       // replies once the turn ended and was collected (≤ 15 s; §28)
  | Cmd<"permission_response", { requestId: string; allow: boolean; message?: string; updatedInput?: object; remember?: boolean }>   // answers exactly that open request (§33; else unknown_permission_request); remember: auto-allow the same tool + command prefix for the rest of the session (§10)
  | Cmd<"forget_allows">                                   // clears state.session.rememberedAllows (§10)
  | Cmd<"set_permission_mode", { mode: "default" | "acceptEdits" | "plan" | "auto" }>  // live switch; refused session_busy / no_session (§11)
  | Cmd<"plan_response", { approve: boolean; mode?: "default" | "acceptEdits" | "plan" | "auto"; message?: string }>  // answers plan_proposed; refused no_plan / session_busy / no_session (§11)
  | Cmd<"accept", { paths: string[] }> | Cmd<"accept_all"> | Cmd<"unaccept", { paths: string[] }>   // unaccept: accepted → pending again, disk untouched; refused with session_running while a turn runs or collects
  | Cmd<"reject", { paths: string[]; force?: boolean }> | Cmd<"reject_all", { force?: boolean; includeExternal?: boolean }>  // reverts on disk, re-snapshots B after every file; refused file_changed_since_review unless force (§19.1); reject_all leaves origin "external" files alone unless includeExternal (§31)
  | Cmd<"reject_hunks", { path: string; hunks: number[]; expectedEndTree?: string; expectedBaseTree?: string }>   // revert only these hunk ids of a pending modified file (§17); expectedBaseTree §34.1
  | Cmd<"retry_collect">                                   // after gate.phase == "collect_failed"
  | Cmd<"add_note", { path: string; line: number | null; side: "old" | "new"; excerpt: string; body: string }>
  | Cmd<"remove_note", { noteId: string }>
  | Cmd<"edit_note", { noteId: string; body: string }>   // an unsent note's text; a sent or blank one is refused
  | Cmd<"select_file", { path: string; since?: DiffSince }>   // → file_diff {scope:"turn"} (cached per gate.reviewEndTree); since / while running: §34.1–34.2
  | Cmd<"full_file", { path: string; since?: DiffSince }>     // → full_file_content (§34.1–34.2)
  | Cmd<"live_changes">                                    // → live_changes: the running turn's changes so far (§34.6)
  | Cmd<"live_diff", { path: string }>                     // → file_diff {scope:"live"} (§34.6)
  | Cmd<"tool_output", { toolUseId: string }>              // → tool_output: the kept output of a Bash tool_result (§12)
  | Cmd<"branches">                                        // refresh → state.branches
  | Cmd<"switch_branch", { name: string }> | Cmd<"create_branch", { name: string; from?: string }>
  | Cmd<"pr_list">                                         // refresh mine + reviewRequested
  | Cmd<"pr_open", { summaryId: string }>                  // "host/owner/repo#N"
  | Cmd<"pr_close">
  | Cmd<"pr_select_file", { filename: string }>            // → file_diff {scope:"pr"}
  | Cmd<"pr_add_draft", { path: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; body: string }>
  | Cmd<"pr_remove_draft", { draftId: string }>
  | Cmd<"pr_submit", { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string }>
  | Cmd<"pr_reply", { commentId: number; body: string }>
  | Cmd<"pr_reload_comments">
  | Cmd<"accounts">                                        // gh auth status → state.pr.accounts
  | Cmd<"login_in_terminal", { host: string }>
  | Cmd<"workbench_list">                                  // refresh (with per-worktree dirty) → state.workbenches (§6)
  | Cmd<"workbench_create", { branch: string; from?: string; path?: string;
        fetch?: boolean; setup?: boolean; location?: "managed" | "sibling"; fromPr?: { number: number; headRef: string } }>   // git worktree add → state.workbenches; §36.12 fetch / copy / setup (+ workbench_progress), §36.14 fromPr
  | Cmd<"workbench_remove", { path: string; force?: boolean }>                  // git worktree remove [--force]
  | Cmd<"workbench_prune">                                 // git worktree prune
  | Cmd<"pr_create", { base: string; title?: string; body?: string; draft?: boolean }>   // → pr_created {url, branch} (§6; PR lane)
  | Cmd<"commit", { message: string; paths?: string[]; push?: boolean }>   // → committed {sha, shortSha, pushed, branch} (§7)
  | Cmd<"push">                                            // git push of the last commit → committed (§7)
  | Cmd<"refresh", { scope?: ("review" | "branches" | "workbenches" | "pr" | "accounts")[] }>   // re-read (§9); default = every applicable scope
  | Cmd<"session_list">                                    // → state.sessions (§9)
  | Cmd<"session_new">                                     // stop the current Claude session, start a fresh "New chat" → transcript_restore {items: []} (§9)
  | Cmd<"session_open", { sessionId: string }>             // resume that session → transcript_restore with its rows (§9)
  | Cmd<"session_rename", { sessionId: string; title: string }>
  | Cmd<"session_archive", { sessionId: string; archived: boolean }>
  | Cmd<"session_delete", { sessionId: string }>           // refused for the current one (session_current)
  | Cmd<"tabs_set", { openTabIds: string[] }>              // the client's open chat tabs; persisted per worktree (§9)
  | Cmd<"review_history", { sessionId?: string; all?: boolean }>   // → review_history (§14); default = the current session's rounds
  | Cmd<"history_diff", { entryId: string; path: string }>  // → history_diff: one file of a past round between its pinned trees (§14)
  | Cmd<"side_ask", { threadId?: string; anchor?: SideAnchor; question: string }>   // → side_thread (§21)
  | Cmd<"side_list">                                       // → side_threads (§21)
  | Cmd<"side_close", { threadId: string }> | Cmd<"side_cancel", { threadId: string }>
  | Cmd<"side_promote_draft", { threadId: string }>        // → side_promote_draft (§21)
  | Cmd<"side_promote", { threadId: string; as: "message" | "note"; text?: string; acceptPending?: boolean }>   // no text → side_promote_draft
  | Cmd<"mcp_status"> | Cmd<"mcp_reconnect", { name: string }> | Cmd<"mcp_toggle", { name: string; enabled: boolean }>   // → mcp_status (§22)
  | Cmd<"mcp_add", { name: string; scope: "session" | "project" | "user" | "local"; config: McpAddConfig }>         // → mcp_status (local: §36.6)
  | Cmd<"mcp_remove", { name: string; scope: "session" | "project" | "user" | "local" }>                            // → mcp_status
  | Cmd<"mcp_auth", { name: string }>                      // opens a terminal running `claude /mcp` (§22)
  | Cmd<"list_files", { query: string; limit?: number }>   // → files (§23)
  | Cmd<"attachment_get", { hash: string }>                // → attachment (§24)
  | Cmd<"set_model", { model: string; effort?: EffortLevel | null }>   // live model / effort switch, persisted per project (§25)
  | Cmd<"rewind", { toTurn: number; mode: "conversation" | "files" | "both"; editText?: string; mentions?: string[]; attachments?: SendAttachment[]; force?: boolean }>   // → rewound (§26)
  | Cmd<"compact", { focus?: string }>                     // the CLI's /compact as a turn (§27)
  | Cmd<"peer_accept", { ids?: string[] }>                 // run every held peer message as one review turn (send gate rules; §29)
  | Cmd<"peer_dismiss", { ids?: string[] }>                // refuse every held peer message (§29)
  | Cmd<"peer_set", { mode: "ask" | "auto" | "off" }>      // this project's peer mode, live + persisted (§29)
  | Cmd<"finish_review">                                   // empties the review list (and notes) without touching any file (§31)
  | Cmd<"keep_review">                                     // dismisses state.gate.stale ("이어서 리뷰", §31)
  | Cmd<"permission_rules">                                // → permission_rules: the user's Claude Code allow rules, applied / ignored, importable (§33.8)
  | Cmd<"agent_report", { toolUseId: string }>             // → agent_report: a subagent's whole cleaned report (§36.1)
  | Cmd<"stop_agent", { toolUseId: string }>               // stop that one subagent (§36.2)
  | Cmd<"retry_extensions">                                // restart with the user's extensions after an init-timeout fallback (§36.7)
  | Cmd<"cli_versions">                                    // → cli_versions (§36.8)
  | Cmd<"cli_sessions">                                    // → cli_sessions: other Claude sessions of this repository (§36.9)
  | Cmd<"cli_session_import", { sessionId: string }>       // resume a terminal session as a new chat (§36.9)
  | Cmd<"commit_draft", { paths?: string[] }>              // → commit_draft: a message from a read-only fork (§36.11)
  | Cmd<"workbench_preview", { branch: string; from?: string; location?: "managed" | "sibling" }>   // → workbench_preview (§36.12)
  | Cmd<"prereview_start", { scope: "round" | "files"; paths?: string[]; effort: "low" | "medium" | "high" }>   // → prereview (§36.13)
  | Cmd<"prereview_cancel", { prereviewId: string }> | Cmd<"prereview_dismiss", { prereviewId: string; findingId: string }>
  | Cmd<"shutdown">;                                       // result (if id) → dispose → in stdio mode the process exits 0
```

The session commands name the session with `sessionId` (docs/M15-POLISH.md writes `{ id }`) because `id` on a command is
the reply-correlation field and would be overwritten by any `request()` helper.

## 2. Engine → App

One **snapshot** message (`state`) plus streaming events.

```ts
type ReviewState = {
  seq: number;                                   // monotonic; clients drop out-of-order snapshots
  project: null | { path: string; root: string; name: string; branch: string | null; remoteURL: string | null };
  gitInit: null | { path: string; candidates: string[]; looksUnsafe: boolean };
  session: {
    open: boolean; starting: boolean;
    sessionId: string | null; model: string | null;
    capabilities: { slashCommands: string[]; skills: string[]; plugins: string[]; mcpServers: {name: string; status: string}[];
                    pluginDetails?: { name: string; path: string; id: string | null; version?: string }[];   // pluginDetails: §16
                    commands?: SlashCommandInfo[]; state?: "starting" | "ready" } | null;                    // §36.5
    capabilitiesCached: boolean;                 // capabilities were replayed from <gitdir>/reviewgate/capabilities.json; false once the CLI reported fresh ones (§10)
    pendingPermission: PermissionRequest | null; // the request that has waited longest (= pendingPermissions[0]; §33)
    pendingPermissions: PermissionRequest[];     // §33: every open permission request, oldest first
    canRestart: boolean;                         // restart_session is available: project open ∧ no session start in flight (§8)
    rememberedAllows: string[];                  // permission_response{remember:true} keys, e.g. "Bash:echo hi", "WebFetch:WebFetch" (§10)
    permissionMode: "default" | "acceptEdits" | "plan" | "auto";  // mode of the running session; persisted per project (§11)
    pendingPlan: { path: string; plan: string; at: string /* ISO-8601 */ } | null;  // plan awaiting plan_response; a plain send clears it (§11)
    extensions: SessionExtensions | null;        // what the session applied from the user's extensions (§16)
    effort?: EffortLevel | null;                 // §25: effort of the session (null = the model's default)
    selectedModel?: string | null;               // §25: what set_model / settings.model asked for (alias or id); `model` is what the CLI reports
    availableModels?: ModelOption[];             // §25
    checkpoints?: TurnCheckpointView[];          // §26: the current chat's user turns, oldest first (≤ 50)
    ready?: boolean;                             // §30: the CLI answered initialize (accepted the start); false while starting / after a death
    peerInbound?: "ask" | "auto" | "off";        // §29: the effective peer mode of the project
    peerInbox?: PeerMessage[];                   // §29: held / delivering peer messages, oldest first
    externalTurn?: ExternalTurn | null;          // §29: a turn the CLI runs that is not ours (canSend false meanwhile)
    peerTurn?: { messageIds: string[]; fromNames: string[] } | null;   // §29: the running review turn is accepted peer messages
    cli?: CliInfo | null;                        // §36.8: the running CLI's version, verified, the previous one
    extensionsWaitingOn?: { kind: "hook" | "mcp" | "plugin" | "unknown"; name: string | null } | null;   // §36.7
  };
  toolchain: { claude: string | null; gh: string | null; git: string | null; claudeVersion: string | null; ghVersion: string | null };
  gate: {
    phase: "idle" | "starting" | "running" | "collecting" | "collect_failed" | "reverting" | "reviewing";
    canSend: boolean; canRequestChanges: boolean;
    blockedReason: null | "git_init_needed" | "no_session" | "starting" | "running" | "awaiting_permission"
                 | "collecting" | "reverting" | "collect_failed" | "pending_review" | "changes_requested";   // collect_failed: before M30 (§3)
    collectError: string | null;
    pendingCount: number; changesRequestedCount: number;
    isRequestingChanges: boolean;
    turnStartTree: string | null; turnEndTree: string | null;   // snapshot A / B (git tree SHAs)
    lastReviewSummary: string | null;            // the "[Review gate] Accepted: …" prefix that the next send will use
    changedOutside: string[];                    // absolute paths of edits outside the checkpoint root — or inside a nested repository under it (§33.3) — the user approved this turn (§8; not in changedFiles)
    ignoredTouched: string[];                    // repo-relative paths the turn's edit tools wrote that are gitignored (invisible to the snapshot; §8)
    filteredByPattern: string[];                 // repo-relative changed paths hidden from changedFiles by settings.ignorePatterns (§8)
    restored: boolean;                           // true after open_project restored a persisted review; cleared by the next turn (§8)
    reviewSummary: { files: number; added: number; deleted: number };   // totals over changedFiles (every state) for the composer label (§10)
    externalPendingCount: number;                // §31: pending files with origin "external" (reject_all leaves them out)
    headMoved: { from: HeadInfo; to: HeadInfo } | null;     // §31: HEAD / branch moved while the last turn ran
    concurrentClaude: ConcurrentClaude[];        // §31: other Claude processes in this worktree (open / last send)
    stale: StaleReview | null;                   // §31: the restored review is stale ("정리 / 이어서 리뷰")
    localSettingsChanged: LocalSettingsChange | null;   // §32: .claude/settings.local.json changed (hash only)
    nestedChanges: NestedChange[];               // §32: nested repositories the last turn changed (outside the review)
    snapshotSkipped: { path: string; reason: "unreadable" }[];   // §32: files the turn's snapshots had to leave out
    prereviews?: PreReviewRun[];                 // §36.13: AI pre-reviews of the review in progress
  };
  changedFiles: ChangedFile[];   // {path, oldPath, status:"A"|"M"|"D"|"R"|"X", added, deleted, isBinary, tools[], toolUseIds[], state:"pending"|"accepted"|"rejected"|"changesRequested", noteCount,
                                 //  partial?: true, rejectedHunks?: number,   (partial / rejectedHunks: §17)
                                 //  origin: "tool"|"bash"|"external",   (§31)
                                 //  group?: "mods", risk?: ("hook"|"script"|"mcp"|"permissions"|"env")[], uncaptured?: true, ignored?: true}   (§32)
                                 // toolUseIds: the tool_use ids that touched the file (§12)
  reviewNotes: ReviewNote[];     // {id, path, line, side, excerpt, body}
  budget: Budget; budgetUsage: { files: number; lines: number; denied: boolean };
  hud: { contextTokens: number; contextWindow: number | null; sessionCostUSD: number; turnCount: number; lastTurnMs: number;
         activity: { kind: "idle" | "working" | "thinking" | "tool" | "subagent"; toolName?: string; detail?: string };
         subagentDepth: number;                  // foreground subagents still running (derived from agents, §13)
         agents: AgentNode[];                    // subagents of the session (§13; §36.1–36.3 fields)
         waitingOnAgents?: { count: number; longest: { toolUseId: string; type: string; startedAt: number } } | null;   // §36.4
         turnStartedAt: number | null /* epoch ms */;
         sideCostUSD: number };                  // side-question sessions since this session started; never in sessionCostUSD (§21)
  branches: { list: BranchInfo[]; isWorktreeDirty: boolean;
              switchBlocker: null | { kind: "pendingReview"; count: number } | { kind: "dirtyWorktree" } | { kind: "running" };
              remotes?: (BranchInfo & { remote: true })[] };   // §36.12: remote-tracking bases, never in list
  pr: {
    host: string;
    mine: PRSummary[]; reviewRequested: PRSummary[];
    selectedSummary: PRSummary | null; selected: PRDetail | null;
    files: PRFileMeta[];         // PRFile WITHOUT `patch` (the engine keeps patches; see pr_select_file)
    comments: PRComment[]; reviews: PRReview[];
    draftComments: DraftComment[];   // id: string
    accounts: GHAccount[];
    isLoading: boolean; isSubmitting: boolean; errorText: string | null;
    lastSubmitResult: { reviewURL: string; inlineCount: number; event: ReviewEvent; submittedAt: string } | null;
    lastCreatedPR: { url: string; branch: string } | null;   // last successful pr_create of this engine
  };
  lastError: string | null;
  workbenches: {                                 // §6; empty ({list:[], current:"", managedRoot:""}) without a project
    list: WorkbenchInfo[];
    current: string;                             // path of this engine's worktree
    managedRoot: string;                         // where workbench_create puts worktrees by default
  };
  lockConflict: null | { path: string; pid: number; since: string; client: string };   // set when open_project was refused by another session's lock
  commit: {                                      // §7
    lastCommit: null | { sha: string; shortSha: string; message: string; branch: string | null; pushed: boolean;
                         pushError: string | null; files: string[]; at: string /* ISO-8601 */ };
    canCommit: boolean;                          // accepted files exist ∧ gate not running/collecting/reverting
    acceptedPaths: string[];                     // files with state "accepted" (the default commit.paths)
    suggestedMessage: string;                    // first line of the last user instruction (≤ 72 chars) + blank line + "Files:\n- a\n- b"
    identity: { name: string | null; email: string | null };   // git user.name / user.email (open_project, re-read on commit)
  };
  sessions: {                                    // §9; {list:[], currentId:null, openTabIds:[]} without a project
    list: SessionMeta[];                         // newest first (updatedAt)
    currentId: string | null;                    // the session the engine runs / is starting
    openTabIds: string[];                        // tabs_set
  };
};

type SessionMeta = {
  id: string;                                    // the Claude session id (what `resume` uses)
  title: string;                                 // "New chat" until the first user message → its first line (≤ 60 chars) unless renamed
  createdAt: string; updatedAt: string;          // ISO-8601; updatedAt bumps on every user message / turn end
  turns: number; costUSD: number;                // accumulated at every turn end (normal or abnormal)
  lastUserText: string | null;
  archived?: boolean;
  resumeFailed?: boolean;                        // the CLI could not resume it; a fresh chat was started instead (transcript still readable)
  forkedFrom?: { sessionId: string; turn: number };   // §26: made by rewind from that chat, right before its turn `turn`
  cliKnown?: boolean;                            // §30: the CLI has a record of it (it reported the id — also for a turn it ran on its own): always resumed
  imported?: { at: string; cwd: string | null }; // §36.9: imported from a terminal session (the gate applies from `at`)
};

type WorkbenchInfo = {
  path: string; branch: string | null; head: string;
  isMain: boolean;                               // the original checkout (first row of `git worktree list`)
  isCurrent: boolean;                            // == workbenches.current
  locked: { pid: number; since: string; client: string } | null;   // ReviewGate session lock with a live pid (not git's `worktree lock`)
  dirty: boolean | null;                         // null = not computed yet, or `git status` did not answer within 2 s
};

type EngineEvent =
  | { type: "ready"; id?: string; engineVersion: string; platform: "darwin" | "win32" | "linux"; protocolVersion: 2 }
  | { type: "state"; state: ReviewState }
  | { type: "result"; id: string; ok: true } | { type: "result"; id: string; ok: false; error: string; code?: string; paths?: string[] }   // code / paths: §19
  | { type: "file_diff"; id?: string; scope: "turn" | "pr" | "live"; path: string; diff: FileDiff; truncated: boolean;
      endTree?: string; since?: DiffSince; baseTree?: string; stale?: true }   // endTree §17; scope live / since / baseTree / stale §34
  | { type: "full_file_content"; id?: string; path: string; lines: string[]; changedNewLines: number[];
      deletedAfterNewLine: Record<string, string[]>; isBinary: boolean; isTooLarge: boolean;
      oldText: string | null; newText: string | null }      // old/new for a side-by-side editor; null when binary/too large
  | { type: "pr_created"; id?: string; url: string; branch: string }   // reply to pr_create
  | { type: "committed"; id?: string; sha: string; shortSha: string; pushed: boolean; branch: string | null }   // reply to commit / push (§7)
  | { type: "user_message"; text: string; turn: number; mentions?: string[]; attachments?: AttachmentRef[] }    // transcript row (see §3); §23 / §24
  | { type: "text_delta"; text: string }                    // streamed text; assistant text the CLI does not stream (built-in slash
                                                            // commands such as /help, /context, /compact answer with a synthetic message)
                                                            // arrives as one text_delta with the whole block, never duplicated
  | { type: "tool_use"; id: string; name: string; input: object; file?: string;
      parentToolUseId?: string;                             // the Agent/Task tool_use a subagent's inner call runs under (§12)
      rationale?: string;                                   // assistant text right before the call, same API message, ≤ 400 chars (§12)
      continues?: { agentToolUseId: string; agentType: string } }   // §36.3: a SendMessage continuing a known subagent
  | { type: "tool_result"; toolUseId: string; isError: boolean; preview: string;   // preview ≤ 500 chars
      parentToolUseId?: string;
      truncated?: true;                                     // the result is longer than preview
      testOutcome?: "pass" | "fail";                        // Bash running a recognizable test command (§12)
      agentUsage?: { tokens: number; toolUses: number; durationMs: number }; cliAgentId?: string; stoppedBy?: "user" }   // Agent / Task results (§36.1–36.2)
  | { type: "tool_output"; id?: string; toolUseId: string; output: string | null; truncated: boolean }   // reply to tool_output (§12)
  | { type: "review_history"; id?: string; sessionId: string | null; entries: ReviewHistoryEntry[]; current?: ReviewHistoryEntry | null }   // reply to review_history, newest first (§14); current §34.4
  | { type: "history_diff"; id?: string; entryId: string; path: string; diff: FileDiff; truncated: boolean }   // reply to history_diff (§14)
  | { type: "permission_request"; requestId: string; toolName: string; input: object; file?: string;
      toolUseId?: string; agent?: PermissionAgent;         // §33.1
      reason?: PermissionReason;                           // §33.3 (claude_config: §33.9)
      allowPatterns?: string[] }                           // §33.6; also queued in state.session.pendingPermissions (§33)
  | { type: "budget_event"; kind: "warn" | "deny"; toolName: string; file?: string; files: number; lines: number; budget: Budget }
  | { type: "activity"; kind: "tool_start" | "tool_end" | "subagent_start" | "subagent_end" | "thinking" | "idle"; toolName?: string; detail?: string }
  | { type: "turn_end"; stopReason: string; usage: TurnUsage; files: number; added: number; deleted: number;
      changedOutside: string[]; external?: number }         // transcript summary row; the review list arrives via state (changedOutside: §8; external: §31)
      // §34.3: files / added / deleted / external count THIS turn; + review?: ChangeTotals (the whole list), merged?: true
  | { type: "turn_summary"; turn: number; files: TurnSummaryFile[]; commands: TurnSummaryCommand[]; plan: PlanVsActual | null;
      review?: ChangeTotals; merged?: true; lastTest?: LastTest | null }   // after turn_end when THIS turn changed files (§15, §34.3)
  | { type: "live_changes"; id?: string; running: boolean; turn: number | null; baseTree: string | null; liveTree: string | null;
      at: string; files: LiveChangedFile[]; truncated?: true }   // reply to live_changes (§34.6)
  | { type: "extensions_fallback"; reason: "init_timeout"; timeoutMs: number; message: string }   // restarted without user settings (§16)
  | { type: "plan_proposed"; path: string; plan: string }     // plan-mode turn wrote <home>/.claude/plans/<slug>.md; ≤ 200 KB (§11)
  | { type: "plan_approved"; mode: "default" | "acceptEdits" | "plan" | "auto"; path: string }   // plan_response{approve:true}; the follow-up send follows (§11)
  | { type: "transcript_restore"; items: TranscriptItem[] }  // after open_project / session_new / session_open: the last ≤ 200 rows of the current session's transcript, oldest first (§8, §9)
  | { type: "error"; message: string; fatal: boolean; scope: "engine" | "session" | "git" | "pr";
      code?: string; resetAt?: string; attempt?: number; maxRetries?: number; retryDelayMs?: number; status?: number | null;   // code + details: §19.6
      detail?: string; exitCode?: number | null; signal?: string | null; sessionId?: string;   // §30
      toolName?: string; path?: string; branch?: string }   // §33.4
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
  | { type: "side_thread"; id?: string; thread: SideThread }                 // §21; also the reply to side_ask
  | { type: "side_threads"; id?: string; mainSessionId: string | null; threads: SideThread[] }   // reply to side_list
  | { type: "side_thread_closed"; threadId: string }
  | { type: "side_text_delta"; threadId: string; text: string }
  | { type: "side_tool_use"; threadId: string; id: string; name: string; input: object }
  | { type: "side_tool_result"; threadId: string; toolUseId: string; isError: boolean; preview: string; denied?: true }
  | { type: "side_turn_end"; threadId: string; costUSD: number; durationMs: number; stopReason: string }
  | { type: "side_promote_draft"; id?: string; threadId: string; text: string }
  | { type: "mcp_status"; id?: string; servers: McpServerInfo[]; restartRequired: boolean }   // §22
  | { type: "files"; id?: string; query: string; items: FileItem[] }                           // reply to list_files (§23)
  | { type: "attachment"; id?: string; hash: string; mediaType: ImageMediaType; dataBase64: string }   // reply to attachment_get (§24)
  | { type: "rewound"; id?: string; toTurn: number; mode: RewindMode; restoredFiles: string[]; sessionId: string | null }   // reply to rewind (§26)
  | { type: "context_warning"; percent: number; contextTokens: number; contextWindow: number }   // §27
  | { type: "peer_message"; message: PeerMessage }                                               // §29
  | { type: "head_moved"; turn: number; from: HeadInfo; to: HeadInfo }                            // §31
  | { type: "concurrent_claude"; at: "open" | "send"; sessions: ConcurrentClaude[] }              // §31
  | { type: "local_settings_changed"; turn: number } & LocalSettingsChange                        // §32
  | { type: "nested_changes"; turn: number; repos: NestedChange[] }                               // §32
  | { type: "permission_rules"; id?: string; sources: PermissionRuleSource[]; rules: UserPermissionRule[];
      defaultMode: string | null; defaultModeSupported: boolean; applyUserAllowRules: boolean; loadUserSettings: boolean }   // reply to permission_rules (§33.8)
  | { type: "agent_report"; id?: string; toolUseId: string; text: string; truncated: boolean;
      usage: { tokens: number; toolUses: number; durationMs: number } | null; model: string | null; prompt: string | null }   // reply to agent_report (§36.1)
  | { type: "cli_versions"; id?: string; versions: { version: string; path: string; verified: boolean }[]; current: string | null; pinnedPath: string | null }   // §36.8
  | { type: "cli_sessions"; id?: string; running: CliRunningSession[]; resumable: CliResumableSession[] }   // reply to cli_sessions (§36.9)
  | { type: "commit_draft"; id?: string; message: string }                                      // reply to commit_draft (§36.11)
  | { type: "workbench_preview"; id?: string; path: string; copy: { path: string; bytes: number }[]; totalBytes: number; count?: number; truncated?: true }   // §36.12
  | { type: "workbench_progress"; path: string; branch: string; step: "fetch" | "create" | "copy" | "setup" | "done"; logTail?: string; exitCode?: number | null }   // §36.12
  | ({ type: "prereview"; id?: string } & PreReviewRun);                                        // §36.13; also the reply to prereview_start

type TurnUsage = { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number;
                   cacheReadTokens: number; cacheCreationTokens: number; contextTokens: number; contextWindow?: number };

type TranscriptItem = { at: string /* ISO-8601 */; turn: number } & (      // §8; one NDJSON row each
  | { kind: "user_message"; text: string; mentions?: string[]; attachments?: AttachmentRef[] }   // §23 / §24: never any base64
  | { kind: "assistant_text"; text: string }                              // the turn's streamed text, stored once at turn end
  | { kind: "tool_use"; id: string; name: string; input: object; file?: string; parentToolUseId?: string; rationale?: string }   // + continues? (§36.3)
  | { kind: "tool_result"; toolUseId: string; isError: boolean; preview: string; parentToolUseId?: string; truncated?: true; testOutcome?: "pass" | "fail" }
      // + agentUsage?, cliAgentId?, stoppedBy?; report?, reportTruncated? stay in the file (never in transcript_restore; §36.1)
  | { kind: "permission"; requestId: string; toolName: string; allow: boolean; file?: string }   // the user's permission_response
  | { kind: "budget_event"; event: "warn" | "deny"; toolName: string; file?: string; files: number; lines: number }
  | { kind: "turn_end"; stopReason: string; usage: TurnUsage; files: number; added: number; deleted: number; changedOutside: string[]; external?: number }   // external: §31
      // §34.3: like the event — this turn's numbers, + review?: ChangeTotals, merged?: true
  | { kind: "error"; message: string; fatal: boolean; scope: "engine" | "session" | "git"; code?: string; detail?: string;   // §30
      toolName?: string; path?: string; branch?: string; exitCode?: number | null; signal?: string | null;
      sessionId?: string; resetAt?: string; status?: number | null }                       // what the event carried (§35.3)
  | { kind: "peer_message"; id: string; from: string; fromName?: string; verifiedPeerPid?: number;                           // §29
      state: "delivered" | "dropped"; outcome?: string; body?: string; unprompted?: true });
```

`FileDiff` = `{ oldPath, newPath, isBinary, hunks: [{ id, header, lines: [{ id, kind: "context"|"add"|"del"|"hunkHeader", oldNo, newNo, text }] }] }`
(`engine/src/diff/parse.ts`; line numbers 1-based). `BranchInfo` = `{ name, isCurrent, upstream, ahead, behind, lastCommitDate }`
(`lastCommitDate` epoch seconds or null). PR models: `engine/src/pr/models.ts`. Wire dates are ISO-8601 strings.
Golden samples of `state`, `file_diff` and `full_file_content` live in `engine/test/fixtures/wire/`.

## 3. Semantics

- `hello` must be first; the engine answers `ready`, then the initial `state` (`seq` 1). A `hello` without an `id` still gets `ready`.
- `state` is emitted after every mutation, coalesced per macrotask (a burst such as turn_end → collect → branch refresh yields a handful of snapshots, not dozens); `seq` strictly increases. Size grows with the changed files (no budget bounds them by default, §54) and PR metadata (files without patches, comments): 5–80 KB expected (`driver-v2.mjs` measured 6 KB max on a two-turn review). `state_patch` (RFC 6902) is deferred; add only if measured > 200 KB or > 20 msg/s.
- `select_file` and `full_file` are pure reads; the diff cache is invalidated whenever `gate.turnEndTree` changes (after collection and after every reject), so clients re-request on that change. `file_diff` carries at most 20 000 hunk lines (`truncated: true` beyond). `full_file_content` is empty (`isTooLarge`) above 20 000 lines / 2 MB; `lines` are split on `\r?\n`. (§34.1–34.2: they take `since`, answer from `gate.reviewEndTree` — also while a turn runs, `stale` — and clients key on that.)
- Gate: `canSend` = session open ∧ not starting ∧ no turn running ∧ not collecting/reverting ∧ no external turn (a turn the CLI runs that is not ours, `session.externalTurn`, §29 — `blockedReason` is then `running`, a refused `send` says `gate_closed:external_turn`). **A pending / changes-requested file does NOT close the input**: sending a message never changes review state, so a question can always be asked while files await review (§10, "Question during a review"). Nor does a failed collection (M30, below). `blockedReason` is the first failing condition in the order `git_init_needed`, `running`/`awaiting_permission` (the latter while `session.pendingPermission` is set), `collecting`, `reverting`, then — only while the session is gone or starting — `pending_review`, `changes_requested`, and finally `no_session`, `starting`: a review outranks a dead session there, so a client shows "review first" and offers `restart_session` (§8) rather than "open a project" (audit 1.4). `blockedReason` is therefore non-null exactly when `canSend` is false (`collect_failed` comes only from an engine before M30). `canRequestChanges` = notes exist (§34.4: unsent ones) ∧ session open ∧ not starting/running/collecting/reverting ∧ no collect error.
- `send`: text is trimmed; empty → `result{ok:false, error:"empty message"}`; gate closed → `result{ok:false, error:"gate_closed:<blockedReason>"}` (no `error` event). **A plain `send` never changes review state** — no file is accepted, rejected or dropped by it; `acceptPending: true` (only ever sent when the user explicitly picks "Accept N & Send") first accepts every pending file (§10). The engine takes snapshot A first (a failure refuses the send, §35.1), then emits `user_message{text: <trimmed>}` (snapshot A = `gate.turnStartTree`; the previous A is **kept** while `gate.isRequestingChanges` **or while files still await review** — the answer turn's diff accumulates onto the same A), prefixes `gate.lastReviewSummary` + `"\n\n"` to the outgoing text (and clears it), clears the notes (**kept** while files await review: they belong to the review the answer leaves standing), and queues the message. `hud.turnStartedAt` is set, `hud.activity` = `working`.
- `turn_end` (transcript event) fires after the collection succeeded, so `files/added/deleted` are known (§34.3: what that turn itself changed; `review` = the whole list); the review list itself arrives via `state` (`changedFiles`, `gate.phase = "reviewing"`, or `idle` when nothing changed). Collection: snapshot B → `git diff-tree A B` → ignore patterns applied to `path` and `oldPath` → `tools[]` attributed from the session's tool/file bookkeeping. On failure `gate.phase = "collect_failed"`, `gate.collectError` is set, `error{scope:"git"}` is emitted and no `turn_end` until `retry_collect` succeeds. **M30:** the engine retries it once by itself `collectRetryMs` (2 s) later, on the main lane like the user's `retry_collect` (a manual retry first cancels it). When that fails too the phase stays `collect_failed` but the input is open: the turn that starts next — a `send`, an accepted peer message (§29), a turn Claude starts itself (§52.1) — folds the failed one in. A is kept (an answer turn's review with it: its held B, accepted patch hashes and notes), the failed turn's tool files and MCP windows are carried into the next collection (its files keep their causes, §31.1), and that collection (A → its B) holds both turns' changes; `retry_collect` then has nothing to do (`nothing_to_retry`). A send that never reached Claude (its snapshot or the session failed) puts the failure back exactly as it was, retry included. `request_changes` still waits for the retry (`request_changes_unavailable:collect_failed`), and so does everything that moves B (§37.1). `send {acceptPending}` after a failed answer turn accepts against the held B (§34.2). The failed turn's §26 record keeps no files of its own (a rewind to it restores nothing it changed; the next turn's record has them). Clients: the composer's notice line says the next message collects the failed turn's changes, with [다시 시도] and the error to copy (not only in the review list a narrow window hides); a message queues for any closed gate of an open project, and ↩ / ⌘↩ with text always does something — it sends, goes into the turn, queues, or (the session ended) queues while `restart_session` runs; when nothing can take it the composer says why (never a silent no-op). HUD accounting (`turnCount`, `lastTurnMs`, `sessionCostUSD += costUsd`, `contextTokens`, `contextWindow`) is applied when the session's turn ends, before collection.
- `reject_all` reverts the pending files Claude changed — `origin` `tool` / `bash` (§31) — and leaves the `external` ones (an IDE save, another session, a `git pull` during the turn) pending unless `includeExternal: true`; a `reject` naming a file is honored whatever its origin (clients confirm an external one first). `accept_all` accepts every pending file (it writes nothing).
- `accept` / `accept_all` / `reject` / `reject_all` are refused with `session_running` (`result ok:false`, no `error` event) while a turn is running or its changes are being collected — an answer turn or a change request included: a revert mid-turn re-snapshots B, after which the turn's own collection would be skipped and its changes never reach the review. (§34.2: `accept` / `accept_all` are now applied during a turn on a standing review, by the answer-turn patch rule; only while collecting — or in a fresh turn — they are refused. M32: `reject` / `reject_all` there wait for the turn's end instead — `rejectScheduled`, reverted right after its collection.) `reject*` during a revert stays `reverting`. `add_note` / `remove_note` / `edit_note` are refused with `session_running` while a change request (`gate.isRequestingChanges`) is running or collecting, because its collection replaces the notes it sent. Clients disable these actions in those phases and show the refusal if it still happens. `accept`/`reject` on a non-pending path is a no-op (`result ok:true`). `reject` runs sequentially; each success reverts the file to A on disk (`git restore --source A`, blob fallback), re-snapshots B and drops the file from the list; the first failure stops the batch and surfaces `error{scope:"git"}` (`result ok:false`), `gate.phase` returns to `reviewing`. Accepted files stay on disk. Both feed `gate.lastReviewSummary` (`"[Review gate] Accepted: a, b. Rejected (reverted on disk, do not redo unless asked): c."`).
- `request_changes`: only `canRequestChanges` is checked. The engine builds the message (`engine/src/review/notes.ts`, byte-identical to the former Swift `requestChangesMessage`): `"[Review gate] Requested changes on this turn's diff. Keep the other changes as they are."` + one `"\n- path[:line] (side) [`excerpt`] — body"` per note + optional `"\n\n" + extra`; records the patch hash of every accepted file; marks noted files `changesRequested`; keeps A and sends the message with A as the checkpoint. After the follow-up turn the list is rebuilt from the ORIGINAL A: accepted files whose patch is byte-identical are pre-marked `accepted`, everything else is `pending` again; notes are cleared (§34.4: no longer — only unsent notes are sent, and they stay as `sent`). A send failure undoes the marking (notes kept) and emits `error{scope:"session"}`.
- **Question during a review** (`send` while `gate.phase = "reviewing"`): A is kept and, after the turn, the list is rebuilt from that same A and **merged** into the standing review — every file keeps the state (`pending` / `changesRequested`) and the `tools[]` it already had, files the answer touched are added `pending`, and an `accepted` file goes back to `pending` only when the answer actually changed its patch (the same patch-hash rule as `request_changes`; `gate.isAnsweringReview` in the persisted review marks the turn so a crash mid-answer re-verifies the same way). A turn that changes nothing leaves `changedFiles` byte-identical (but for the §34.3 per-turn marks it clears). `request_changes` is unaffected: files marked `changesRequested` still go back through it. The message Claude gets ends with the unsent notes (`unsentNotesContext`: "[Review gate] Notes the user left on the diff, not sent yet (act on them only if the message above asks):" + one `- path[:line] (side) [`excerpt`] — body` per note), so "메모 반영해줘" in the chat reaches them; they stay unsent and the transcript row shows only the user's text. Edits into Claude's own memory folder (`~/.claude/projects/<project>/memory/`) are outside the per-turn budget: never counted, never denied by it (they keep the outside-the-project card).
- `user_message.text` is the transcript text: the trimmed user text for `send` (the review-summary prefix is *not* included), the full generated message for `request_changes`.
- Permission `ask`-hook semantics, auto-allowed edit tools, the read-only set, `stopReason: "interrupted"`, `loadUserSettings` — carried over verbatim from v1 (§4). `permission_request` blocks the tool until `permission_response` with the same `requestId`. Several can be open at once (parallel subagents): `state.session.pendingPermissions` lists them oldest first, `state.session.pendingPermission` is the oldest, and `blockedReason` is `awaiting_permission` while any is open (§33). Read-only Bash commands, `bashAllowPatterns` matches and session-remembered allows never produce a `permission_request` (§10).
- Activity folding (`state.hud.activity`): `tool_start` → `{kind:"tool", toolName, detail?}`; `tool_end` → `subagent` if `subagentDepth > 0` else `working`; `subagent_start` → `{kind:"subagent", toolName?, detail?}`; `subagent_end` → `subagent`/`working` (`subagentDepth` itself is the number of running foreground `hud.agents`, §13); `thinking` → `{kind:"thinking", detail?}` (also emitted for the CLI's `status` system messages — `detail` = `"compacting"` during `/compact` / auto-compaction, `"requesting"` while waiting for the model — and `"compacted"` at a compact boundary); `idle` → `{kind:"idle"}`. The raw `activity` events are still emitted for finer HUD use.
- Branches: `state.branches` is refreshed after `open_project`/`init_repo`, after every collection (success or failure), after `switch_branch`/`create_branch`, and on `branches`. `switch_branch`/`create_branch` are refused with `result{ok:false, error:"switch_blocked:<kind>"}` while `switchBlocker` is set (`running` while starting/running/collecting/reverting; `pendingReview{count}` while files are pending or changes-requested; `dirtyWorktree` when `git status --porcelain` is non-empty — ignore patterns are not applied there). A git failure emits `error{scope:"git"}` ("Failed to switch to branch X: …" / "Failed to create branch X: …") and `result{ok:false}`.
- Projects: `open_project` stops the current session, clears all project-bound state, opens the checkpoint; a non-repository yields `state.gitInit = {path, candidates, looksUnsafe}` (`candidates`: immediate subfolders containing `.git`, sorted; `looksUnsafe`: `/`, `$HOME`, ~/Desktop/Documents/Downloads or > 200 entries) and `blockedReason = "git_init_needed"` until `init_repo` / `cancel_git_init` / another `open_project`. The session starts once the toolchain is located (`state.toolchain`); a missing `claude` yields `error{fatal:true, scope:"engine"}` with the project open and `session.open = false`.
- `error{fatal:true, scope:"session"}` = the Claude session died; the engine keeps running, `session.open = false`, a running turn is closed (`stopReason: "error"` / `"session closed"`) and collected so the review list (if any) is preserved. The engine restarts the session by itself once per turn (§8 auto-restart) — not when it died before initialize, and a refused start is recovered without an error (§30) — `restart_session` restarts it on demand, and `open_project` of the same path restores the persisted review (§8) — none of them loses the pending list. Non-fatal `error`s only set `lastError` (transcript row). Every `error` of scope session / git / engine is also kept as a `kind: "error"` row of the chat's transcript (§30).
- `set_settings`: `budget`, `autoAllowReadOnlyBash`, `bashAllowPatterns`, `applyUserAllowRules` and `applyUserBashRules` (§33.5) reach the running session immediately (queued permission requests they now cover are answered, §33.1); `persistSessionAllows` saves / removes the repository's remembered allows at once (§33.7); `ignorePatterns` apply at the next collection; `ghHost` switches the PR store host; `claudePath`/`ghPath`/`gitPath` re-locate the toolchain lazily; `autoAllowTools`/`loadUserSettings`/`systemPromptAppend`/`model`/`allowWorktreeIsolation` apply on the next `open_project` (session start); `chatMoveFollowUp` (§39.4) is read when the engine moves a chat. Fields a client omits (or sends as `undefined`) keep the engine defaults — a `hello` without `budget` runs with `{maxFiles: 0, maxLines: 0, hardMultiplier: 2.0}`: no change budget (§54).
- `pr_create` (PR lane): refused with `empty base` / `detached_head` / `no_remote` / `unsupported_remote:<url>` / `no_project`. The repository is derived from the `origin` fetch URL (`git@host:o/r.git`, `ssh://…`, `https://host/o/r`) → `--repo host/o/r`. When the current branch has no upstream the engine first runs `git push -u origin <branch>` (no confirmation; a push failure is `result{ok:false}` with git's message). Then `gh pr create --repo … --head <branch> --base <base> [--title T --body B | --fill] [--draft]`; the reply is `pr_created{url, branch}` and `state.pr.lastCreatedPR` mirrors it. A `gh` failure is `result{ok:false, error:<gh stderr>}` + `error{scope:"pr"}`.
- `shutdown` (or stdin EOF in stdio mode): the engine replies (if `id`), disposes the session (abort → SIGKILL after 1 s if the CLI is still alive, ≤ 2.5 s total), emits one final `state` (`session.open = false`), then no more events; the sidecar process exits 0 once stdout is flushed. Parent-death watchdog (darwin/linux, `ppid == 1`) and EPIPE on stdout trigger the same path. Unknown commands → `result{ok:false, error:"unknown command: …"}`.

## 4. Settings and permissions (carried over from v1)

- `loadUserSettings` (default true) starts the CLI with `settingSources: ["user","project"]` and `skills: "all"`, so the user's `~/.claude` skills, plugins, slash commands and MCP servers are available in app sessions (`state.session.capabilities` lists them). `false` → `settingSources: ["project"]`: only the project's own `.claude/settings.json`, built-in skills only. `.claude/settings.local.json` is never loaded by the CLI; the engine only reads its `permissions` (§33.5) and compares hashes of its parts across a turn (§32, never its content).
- The CLI runs in `permissionMode: "default"`. `Edit|Write|MultiEdit|NotebookEdit` are auto-allowed **inside the checkpoint root** (the PreToolUse budget hook still gates them) — except inside a nested repository (§33.3) and on Claude Code's own settings files `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json` (§33.9), which always get the card; an edit whose `file_path`/`notebook_path` resolves — through symlinks, for files that do not exist yet via their nearest existing ancestor — outside the root gets `permissionDecision: "ask"` with the reason `ReviewGate: edit outside the project — needs approval` and reaches the permission card like any other tool (§8 `changedOutside`); an edit into git's own data or ReviewGate's state — a path in a git dir (any path component `.git`, case-insensitive, also through symlinks; covers a linked worktree's `.git` file; on Windows also `.git.`, `.git ` , `.git::$INDEX_ALLOCATION` and the 8.3 name `GIT~1`, §20; or a path under `git rev-parse --git-dir` / `--git-common-dir`) other than its `hooks/…`, `info/exclude`, `info/sparse-checkout` and `description` — is always denied (`ReviewGate: this is git's own data or ReviewGate's state inside the git directory (objects, refs, index, HEAD, logs, reviewgate/, …) or its configuration (config, info/attributes) …`) by the hook and by `canUseTool`, never offered on the card; read as named and through symlinks, either one being git's own data denies it. Release-2 review: `config`, `config.worktree` and the rest of `info/` (`attributes`, `grafts`) are denied again — M23 had let them through as edits outside the review, and a `[filter "x"] clean = …` written there with `* filter=x` in `info/attributes` ran in the engine's own `git add -A` (the next snapshot, outside Claude Code's permissions, before any review); the config changes through `git config` in Bash, which is judged like any command. Those four (M23, 2026-11: "install a pre-push hook", "add AGENTS.md to .git/info/exclude" were denied outright) are edits outside the review like one outside the project: the default mode asks (`ReviewGate: edit outside the project — needs approval`, card reason `outside_project`), auto mode leaves them to the CLI and lists the file in `changedOutside` (§8, §39.5). A hook Claude writes runs at the next commit, as in the terminal. Every git call the engine makes runs with `-c core.fsmonitor=` (no fsmonitor command) and, except the user-initiated `commit` / `push` (and `pr_create`'s `push -u`), `-c core.hooksPath=<null device>`, so hooks or fsmonitor planted in the repository config never run during snapshots, revert or worktree management; read-only tools (Read, Glob, Grep, LS, TodoWrite, TodoRead, NotebookRead, BashOutput, KillShell, ToolSearch, ListAgents — §33.2) and `Skill` never prompt. Every other tool (Bash, WebFetch, WebSearch, Agent/Task, MCP tools, …) produces a `permission_request` unless listed in `settings.autoAllowTools` — or, for Bash, unless the command is read-only / matches `bashAllowPatterns` / was remembered for the session (§10): the PreToolUse hooks return `permissionDecision: "ask"` (or `"allow"` with a `ReviewGate: …` reason for those three cases), which the CLI evaluates *before* its `permissions.allow` rules, so no settings file can bypass the app's permission card. The one exception is decided by the engine itself (§33.5): the user's `permissions.allow` rules (user / project / local settings files) allow tools that **cannot change files** — WebSearch, WebFetch, Agent/Task, read-only MCP tools, … — never edit tools, Bash or SendMessage; app allow patterns may also name MCP / WebFetch / WebSearch / Agent calls (§33.6). Deny decisions (budget, plan mode) are returned by the same hook before `ask`/`allow`, so deny always wins; a git command that throws away uncommitted work or rewrites the remote always gets the card with the reason `git_command` (§46; any other git command is an ordinary one).
- Budget (opt-in, §54: only while the client set a limit — 0 is none, and none is the default): per-turn `files`/`lines` from the pre-edit estimate and the post-Bash worktree numstat against the turn's own start tree (§34.1 — not A, which a request-changes turn or a question keeps for the review; paths matching `ignorePatterns` excluded) — counting only the files the turn's edit tools and Bash calls changed (§31: a change nothing of Claude's explains is not charged); `warn` at 100 %, `deny` above `hardMultiplier × budget`; after a deny the rest of the turn's edits and the Bash commands that write files are refused with the same reason, nothing else is, and the turn is never interrupted (§54).
- Ignore patterns: a repo-relative path is ignored when it has the pattern as a prefix, or — when the pattern contains `*` — when the glob matches the full path or (patterns without `/`) the last component; `*` matches any run of characters including `/`. Applied to the review list (the hidden paths are listed in `gate.filteredByPattern`) and to the budget numstat; not to `isWorktreeDirty`, and never to the mods paths (`.claude/**`, `.mcp.json`, `CLAUDE*.md`, §32).
- With user settings loaded the user's own hooks/plugins run inside app sessions too (e.g. oh-my-claudecode writes `.omc/` into the project) — the app's default ignore list hides `.omc/` from review.

## 5. Conformance

`sidecar/test/driver-v2.mjs` (checked in) is the engine-level E2E and the script the Windows machine runs: spawns the
sidecar, `hello` → `open_project` → `send` (auto-allowing every `permission_request`; the prompt also asks Claude to remember
the word "pineapple") → waits for `reviewing` → `shutdown` WITHOUT resolving → a second sidecar: `hello` → `open_project`
(asserts `gate.restored`, the pending files, `transcript_restore`, the pinned refs and the resumed `session.sessionId`) →
`restart_session` (asserts the review is kept) → `select_file`/`full_file` → `reject` → `add_note` + `request_changes` → `accept_all`
→ `commit {push:false}` of the accepted README (asserts `git log -1` and `state.commit.lastCommit`) → `send "What word did I ask you
to remember…"` (asserts "pineapple": the conversation survived process death + `restart_session`) → `session_new` → `send "Reply pong only"`
→ `session_list` (two entries with titles) → `session_open` of the first → `send "What word…"` again (asserts "pineapple": resume across
sessions in one process) → `session_rename`/`session_archive`/`session_delete`/`tabs_set` → `refresh` → `branches`/`create_branch`/`switch_branch`
→ `workbench_create rg-wb` / `workbench_list` / `workbench_remove` (managed root under the OS temp dir) → `shutdown`; asserts no
orphaned `claude`/sidecar processes, that the review file and `refs/reviewgate/main/turn-*` are gone (the review history and its `refs/reviewgate/main/history/*` stay, §14), and prints the max `state` size and count.
`engine/test/review.gate.test.ts` drives the same semantics through `ReviewEngine` with a fake session on a temp repo;
`engine/test/engine.persist.test.ts` covers §8 (persistence/restore, `restart_session`, auto-restart, resume fallback, the
outside/ignored/filtered signals, the transcript file); `engine/test/session.hooks.test.ts` drives `buildHooks()` directly (path containment, transcript rotation);
`engine/test/engine.workbenches.test.ts` runs two engines (main + workbench), the lock conflict/takeover and `pr_create` with a fake `gh`;
`engine/test/engine.commit.test.ts` covers `commit`/`push` (refusals, renames/deletions, trailer, a local bare origin with and
without upstream, missing identity, `push {}` after a failed push); `engine/test/engine.sessions.test.ts` covers §9 (session
lifecycle, guards, title / meta accumulation, tabs, the legacy-transcript migration, the resume fallback) and
`engine/test/engine.refresh.test.ts` the `refresh` re-diff (external edit / external revert) and the idle branch refresh;
`engine/test/session.bashClass.test.ts` the read-only classifier / allow patterns / remember keys, `engine/test/session.hooks.test.ts`
the hook decisions for them and `engine/test/engine.friction.test.ts` `send{acceptPending}`, the question-during-a-review rules (§3: nothing accepted, the same A,
the merged list, a byte-identical list after a no-op turn), the budget defaults, `gate.reviewSummary`,
the capabilities cache and `forget_allows` (§10). The driver also covers §10: `send "Run: git status"` (no `permission_request`),
`send "Run: echo hi > x.txt"` answered with `{allow: true, remember: true}`, a plain `send` while reviewing (a question: the file
list and A are unchanged afterwards), then `send{acceptPending: true}` of an `echo … >> x.txt`
while reviewing (accepted, no prompt), `forget_allows`, the budget defaults of a `hello` without `budget`, `gate.reviewSummary`
and `session.capabilitiesCached` on the second `open_project`.
§23–28 (mentions, attachments, model / effort, checkpoints + rewind, compact, interrupt) are covered by
`engine/test/engine.m23.test.ts` / `engine/test/session.m23.test.ts` and, against the real CLI, `sidecar/test/driver-m23.mjs`
(re-creates its scratch repo; `RG_MODEL=haiku`).
§29 (peer messages) is covered by `engine/test/session.peer.test.ts` / `engine/test/engine.peer.test.ts` and, against the real
CLI, `sidecar/test/driver-peer.mjs` (a scratch receiver sidecar and a scratch `claude -p` sender; haiku); §30 (session start and
recovery) by `engine/test/session.cliRecords.test.ts` / `session.recovery.test.ts` / `engine.recovery.test.ts` and
`sidecar/test/driver-crash.mjs` (no model call: an isolated `CLAUDE_CONFIG_DIR`, conversations written by the CLI's local `/cost`).
§31 (provenance) is covered by `engine/test/session.provenance.test.ts` (execution windows, budget), `engine/test/engine.provenance.test.ts`
(origins, `reject_all`, HEAD moved, other Claude processes, the request-changes merge), `engine/test/review.concurrent.test.ts`
(the session registry) and `engine/test/engine.staleReview.test.ts` (stale restore, `finish_review`, `keep_review`, shutdown);
§32 by `engine/test/git.mods.test.ts` / `engine/test/engine.mods.test.ts` (mods paths), `engine/test/engine.nested.test.ts`
(nested repositories) and `engine/test/git.robust.test.ts` (skipped files, sparse checkout, git-lfs); §31–32 against the real CLI
by `sidecar/test/driver-gate.mjs` (another Claude in the repo, origins tool / bash / external, a gitignored hook, edits in a nested
clone and a linked worktree the driver made beforehand, `reject_all`, `finish_review`; haiku). §33 is covered by the tests listed
there and, against the real CLI, `sidecar/test/driver-perms.mjs` (`RG_STEPS`: parallel subagents' cards, nested repository,
EnterWorktree, `git worktree add`, the user's allow rule, Claude Code's own settings file; haiku). Both re-create their scratch
repo (`[scratchDir] [sidecar.mjs]`, default `$TMPDIR/rg-gate` / `rg-perms` and `sidecar/dist/sidecar.mjs`).
§34.1–34.5 (the review half of round 2) are covered by `engine/test/engine.review2.test.ts` (the held B while a turn runs, accept
during a turn, this turn's numbers, `since` ranges and their refusals, notes after `request_changes`, blob, range pins and their
restore) and `engine/test/review.ranges.test.ts` (`since` parsing, note anchors, tree entries, pins) and, against the real CLI,
`sidecar/test/driver-review2.mjs` (a question over a standing review read stale and accepted mid-turn, an accept the turn then
undoes, `since` accepted / turn / request, a sent note across its follow-up, `review_history.current`; haiku; default scratch
`$TMPDIR/rg-review2`).
§36.10–36.14 (wave 3 engine-flow) are covered by `engine/test/engine.sideTurn.test.ts`, `side.runningTurn.test.ts`,
`engine.sidePr.test.ts`, `side.detached.test.ts`, `engine.commitDraft.test.ts`, `review.commitDraft.test.ts`,
`engine.prereview.test.ts`, `review.prereview.test.ts`, `session.reportFindings.test.ts`, `engine.workbenchSetup.test.ts`,
`git.workbenchSetup.test.ts` and `engine.slashSend.test.ts` and, against the real CLI, `sidecar/test/driver-flow.mjs` (a side
question asked while turn 2 waits on its card knows that turn's codeword — fork_at, atTurn 1, runningTurn 2; a files
pre-review of the off-by-one that turn planted reports a calc.js finding and the main chat's `/code-review low` reports
through ReportFindings without a card; `commit_draft` follows the template with nothing committed; `workbench_preview` /
`workbench_create` copy the untracked / ignored files and run the setup; haiku; the scratch repo is re-created
(`[scratchDir] [sidecar.mjs]`, default `/tmp/rg-flow`) and the CLI's project folder of it removed at the end).

## 6. Workbenches and the session lock (M10)

A **workbench** is one git worktree (own directory + branch) opened by its own engine instance (docs/M10-WORKBENCHES.md).
All `workbench_*` commands need an open project (`no_project` otherwise) and act on the project's *main* repository
(`git rev-parse --git-common-dir`), so they work from any workbench.

- `state.workbenches.list` = `git worktree list --porcelain` (bare entries dropped; the first row is the main worktree →
  `isMain`), each with our lock (`locked`, live pid only — stale locks read as `null`) and `dirty`. It is refreshed on
  `open_project`/`init_repo`, after `workbench_create`/`workbench_remove`/`workbench_prune`, and after every turn
  collection — cheaply: `dirty` is carried over (the current worktree's from `branches.isWorktreeDirty`, new rows `null`).
  `workbench_list` recomputes `dirty` for every worktree (`git status --porcelain`, 2 s per worktree, `null` on timeout).
- `workbench_create{branch, from?, path?}`: `branch` is validated with `git check-ref-format --branch`
  (`invalid_branch_name:<b>`); a branch checked out in any worktree is refused (`branch_in_use:<path>`); `path` defaults
  to `<managedRoot>/<slug(branch)>` (`slug`: `feature/x y` → `feature-x-y`) and must not exist (`path_exists:<path>`). An
  existing branch is checked out as is (`git worktree add <path> <branch>`, `from` ignored); otherwise
  `git worktree add -b <branch> <path> [<from>]` (`from` defaults to this workbench's HEAD). git failures →
  `error{scope:"git"}` + `result{ok:false}`. `state.branches` and `state.workbenches` are refreshed.
- `managedRoot` = `<worktreeRoot | ~/.reviewgate/worktrees>/<repo-name>-<sha256(commonDir)[0:8]>/` — never inside the
  repository, so workbenches never show up in each other's `git status`.
- `workbench_remove{path, force?}`: `unknown_worktree:<path>`, `cannot_remove_main`, `cannot_remove_current` (the
  engine's own worktree); without `force` also `worktree_locked:<pid>` (another live session has it open) and
  `worktree_dirty`. Runs `git worktree remove [--force] <path>`; the branch survives.
- `workbench_prune`: `git worktree prune` (drops entries whose directory was deleted by hand).
- **Lock.** On `open_project`/`init_repo` the engine writes `<gitdir>/reviewgate.lock`
  (`gitdir` = `git rev-parse --git-dir`; for a linked worktree that is `<common>/worktrees/<name>/`, never next to the
  `.git` *file*) as JSON `{pid, since, client, host, token}`; it is removed on `close_project`, `open_project` of another
  path, `shutdown`/dispose. A lock whose pid is dead (`kill(pid, 0)` → ESRCH) is stale and overwritten; EPERM counts as
  alive. A live lock by another session (other pid, or same pid with another `token` — several engines in one process)
  refuses the open with `result{ok:false, error:"locked_by_other_session:<pid>"}`, leaves `project`/`session` closed
  and sets `state.lockConflict = {path, pid, since, client}` (cleared by the next `open_project`/`close_project`).
  `open_project{takeover:true}` overwrites the lock. The lock is **advisory**: the engine that was taken over keeps
  running (its session, turns and review are unaffected) and never touches a lock it does not own — clients decide what
  to do with the conflict (the Mac app asks "Take over?"). A crashed engine leaves a stale lock that the pid check clears.

## 7. Commit & push (M12)

`commit{message, paths?, push?}` turns the accepted part of the current review into one git commit (docs/M12-COMMIT.md);
`state.commit` carries what a client needs to offer it (`canCommit`, `acceptedPaths`, `suggestedMessage`, `identity`) and
what happened (`lastCommit`).

- Refused with `result{ok:false}` (no `error` event): `no_project`; `session_running` while a turn is running or the
  collection / a revert is in flight; `nothing_to_commit` when no file is accepted, `paths` is empty or names a file that is
  not accepted; `empty_message` (the message is trimmed); `git_identity_missing:<detail>` when `git config user.name` /
  `user.email` resolve to nothing (`state.commit.identity` is re-read at that point). `paths` defaults to
  `state.commit.acceptedPaths`; `push` defaults to `settings.commitPushByDefault` (false).
- Runs `git add -A -- <paths>` (a rename stages its old path too, so the deletion side lands in the same commit; deletions
  are staged as such), then `git commit --only -F - -- <those paths>` with the message on stdin (multi-line safe;
  `settings.commitTrailer` is appended after a blank line unless the message already contains that line). A git failure
  there is `error{scope:"git"}` + `result{ok:false, error:<git message>}`. Files that are pending / changes-requested are
  neither staged nor committed. `--only` keeps the commit to exactly those paths: anything else the user had staged
  beforehand stays staged with its staged content (a partly staged file keeps its staged blob) and is **not** part of
  the commit (§19.2).
- After the commit the committed files leave `changedFiles` (with their notes, diff cache and accepted-patch hashes):
  `gate.turnStartTree` (A) is rebuilt with their committed content and `gate.turnEndTree` (B) is re-snapshotted, so the
  remaining diffs — and a later `request_changes` follow-up, whose list is rebuilt from A — no longer include them. When
  nothing pending remains, `gate.phase` becomes `idle` and the gate opens. `gate.lastReviewSummary` still lists the files
  as accepted for the next `send`. `state.branches` and `state.workbenches` are refreshed (`isWorktreeDirty`, `ahead`).
- `state.commit.lastCommit = {sha, shortSha (7), message (as committed), branch, pushed, pushError, files, at}`; the reply is
  `committed{sha, shortSha, pushed, branch}`.
- Push (`commit{push:true}` or `push{}`): `git push`, or `git push -u origin <branch>` when the branch has no upstream.
  Refused with `no_remote` (no `origin`), `detached_head` (no upstream and no branch) or `push_failed:<first stderr line>`;
  the commit stays and `lastCommit.pushed = false`, `lastCommit.pushError = <code>` — so a `commit{push:true}` whose push
  fails answers `result{ok:false}` although the commit was made (`state.commit.lastCommit` tells). `push{}` retries the
  push of `lastCommit` (`nothing_to_push` without one) and replies `committed` with `pushed: true`.
- `suggestedMessage` = the first non-empty line of the last `send` text that does not start with `[Review gate]`
  (cut to 72 chars with `…`; `Apply accepted changes` without one) + `\n\nFiles:\n- a\n- b` over `acceptedPaths`
  (subject only when nothing is accepted). The trailer is not part of it.
- `close_project` / `open_project` reset `state.commit` (`identity` is read again for the new project).

## 8. Persistence, restart & resume (audit 2026-09-14 §1.1–1.4, 3.1)

The review boundary is path-aware and the gate outlives the engine process. Everything lives in the worktree's gitdir
(`git rev-parse --git-dir`; `<common>/worktrees/<name>` for a workbench), next to `reviewgate.lock`:

| File / ref | Written | Content |
|---|---|---|
| `reviewgate-review.json` | after every gate mutation (send, collection, accept, reject, note, request_changes, commit); atomic temp + rename | `{version:1, turnStartTree, turnEndTree, changedFiles[], reviewNotes[], acceptedPatchHashes{}, acceptedPaths[], rejectedPaths[], lastReviewSummary, isRequestingChanges, isAnsweringReview, lastUserText, sessionId, savedAt, head?: {sha, branch} (§31: HEAD at save time), modsCaptured?: true (§32: A / B include the mods paths), ranges?: {turnBaseTree, heldEndTree, requestTree, lastRequest, lastTurnChanges, acceptedTrees{}} (§34.1)}` |
| `refs/reviewgate/<ns>/turn-start`, `refs/reviewgate/<ns>/turn-end` | with the review file, whenever A / B change | pin snapshot A / B so `git gc` cannot prune the trees (they are visible in `git for-each-ref`). `<ns>` = `main` for the main worktree, `wt-<name>` for a linked one (§14) |
| `refs/reviewgate/<ns>/range/<tree>` | with the review file, whenever a range tree is referenced or dropped | §34.1: one pin per tree a `since` range starts from (turn base, request tree, accepted trees) and the held B; deleted with the review, leftovers pruned on `open_project` |
| `reviewgate/history.json`, `refs/reviewgate/<ns>/history/<id>/…` | when a review round ends (§14) | `{version:1, entries: ReviewHistoryEntry[]}` oldest first, ≤ 50; the refs pin each entry's trees |
| `reviewgate-session.json` | on every `session_info` / `turn_end` that names a session id, and on every session switch / `tabs_set` (§9) | `{version:1, sessionId, openTabIds, savedAt}` — the current session (`resume`) + the client's open tabs (+ `permissionMode` §11, `model` / `effort` §25, `peerInbound` §29) |
| `reviewgate/sessions/index.json` | with the session file | `{version:1, sessions: SessionMeta[]}` (§9); `cliKnown` once the CLI reported the id (§30) |
| `reviewgate/sessions/<id>.ndjson` | one row per transcript event (`TranscriptItem`, §2) of that session | capped at 2 MB: when an append would cross it the oldest rows are dropped and the newest half kept. The pre-M15 `reviewgate-transcript.ndjson` is migrated into the first session on first open (§9) |

- **Path containment (`changedOutside`).** The PreToolUse hook answers `ask` for `Edit|Write|MultiEdit|NotebookEdit` whose
  target resolves outside the checkpoint root (§4) — or inside a nested repository under it (§33.3); `canUseTool` no
  longer auto-allows such a call, so it becomes a `permission_request` with `file` and `reason` set. Approved paths are
  collected per turn and reported in `turn_end.changedOutside` and `state.gate.changedOutside` (absolute paths; they are
  not in `changedFiles` because the snapshot never sees them). Denied ones are simply not written. Cleared when the next
  turn starts. An approved edit of one of Claude Code's own settings files (card reason `claude_config`, §33.9) is not
  listed: the review shows it (mods group), `.claude/settings.local.json` through `local_settings_changed` (§32).
  **In auto mode** (2026-11; §39.5: the engine's mode and the hook input's `permission_mode` are `auto`) such an edit — and
  one into Claude's own memory (`~/.claude/projects/<key>/memory/…`, which asked in every mode before) — gets no card: the
  hook returns no decision and the CLI's own rules decide, as in the terminal. Claude Code's own settings files still ask
  (`~/.claude/settings.json`, `~/.claude.json` and an installed plugin's `hooks.json` / `plugin.json` included, checked
  first — a settings file through a symlink in the memory folder too; §33.9), and git's own state stays denied. Every such edit that ran is
  listed in `changedOutside` all the same: a PostToolUse hook records it (in default mode the approved card did). Memory
  files are listed by their path; clients recognise them and label them (`메모리에 기록`).
- **Ignored writes (`ignoredTouched`, `filteredByPattern`).** After the collection the turn's tool-touched paths under the
  root are run through `git check-ignore --stdin`; the gitignored ones (`.env`, `build/`, `*.log`, …) are listed in
  `state.gate.ignoredTouched` — written on disk, invisible to the review by construction. Paths hidden by
  `settings.ignorePatterns` are listed in `state.gate.filteredByPattern`. Both are cleared when the next turn starts.
  Mods paths (§32) are in the review whether gitignored or pattern-matched, so they are in neither list.
- **Restore.** `open_project` (and `init_repo`) reads the review file before the session starts. When
  `refs/reviewgate/<ns>/turn-start` (or the pre-§14 shared `refs/reviewgate/turn-start`) still resolves to the saved A, B is re-snapshotted and every saved file is re-verified
  against `diff-tree A B`: files whose diff is empty now are dropped (their notes too), files that appeared since — e.g.
  the turn that was running when the engine died, or work done while the app was closed — are added as `pending` with
  `origin: "external"` (§31: no tool explains them, so `reject_all` leaves them alone), `tools[]` / `state` / notes /
  `lastReviewSummary` / `lastUserText` (→ `commit.suggestedMessage`) are restored, `changesRequested` files become
  `pending` again and an interrupted request-changes round applies the accepted-patch-hash rule of §3. `gate.phase` is
  `reviewing` when pending files exist, `state.gate.restored = true` until the next turn; a review whose HEAD moved
  since it was saved or that is older than 12 h also gets `state.gate.stale` (§31). A file whose refs are gone or
  whose files all vanished is ignored and deleted. The file and both refs are removed once the review is **fully
  resolved** (no changed file — accepted ones leave via `commit` or a later turn — no note, no request-changes in
  flight), by `finish_review` (§31), on `close_project` when nothing is pending or noted, and on `shutdown` when only
  accepted files are left and no turn was running (§31); otherwise `shutdown` keeps them (that is the crash path).
- **`restart_session`.** Starts a new Claude session for the open project without `resetProjectState`: `changedFiles`,
  notes, accepted files, `hud` and `turn` stay; a running turn is closed (`stopReason: "session restarted"`) and
  collected first. Refused with `no_project` / `starting`. The stored session id is passed as `resume`, so the
  conversation continues (`session.sessionId` stays the same). `state.session.canRestart` tells when it is available.
- **Auto-restart.** When the session ends on its own (`closed` without `shutdown` / `open_project`) after it initialized
  (`session.ready`, §30) the engine issues one `restart_session` after a 2 s backoff, at most once per turn (the counter
  resets on every `send` / `request_changes`); `settings.autoRestartSession: false` disables it. A start the CLI refuses is
  recovered right away instead (§30): "already in use" resumes the conversation, a resume the CLI cannot find / load is
  replaced by a fresh chat (§9: new `SessionMeta`, the failed one is flagged `resumeFailed`, a `resume_not_found` /
  `resume_failed` notice in the new chat) — a stale or deleted CLI session never wedges the project. Any other death
  before initialize is **not** restarted automatically (the same arguments would fail the same way).
- **Resume.** `open_project` passes the current id from `reviewgate-session.json` as `resume` whenever the CLI knows that
  conversation (§30: `turns > 0`, `lastUserText`, `cliKnown`, or its record file exists), otherwise it starts fresh with
  that id pre-chosen (`--session-id`); `restart_session` prefers the live `session.sessionId`. A resume counts as
  successful once the CLI answered initialize (not at the first `session_info`). Verified with the real CLI by
  `driver-v2.mjs` (§5): the word remembered before `shutdown` is answered after a new sidecar, `open_project`,
  `restart_session` and `session_open`; `driver-crash.mjs` covers the §30 cases.
- **Transcript.** `user_message`, the turn's assistant text (accumulated `text_delta`, one row at turn end — also when
  the turn ends abnormally), `tool_use`, `tool_result`, the user's permission decisions, `budget_event`, the `turn_end`
  summary, the `error`s the user saw (§30) and peer messages (§29) are appended as `TranscriptItem` rows of the current
  session (`reviewgate/sessions/<id>.ndjson`, §9).
  `open_project` emits `transcript_restore{items}` with the last ≤ 200 rows of the current session (oldest first; `[]`
  when there is none) before the session starts, so a client can pre-fill its transcript. Rows are never rewritten;
  `close_project` keeps the files. (§38.3: plus `start` / `sessionId`; older rows come with `transcript_page`.)

## 9. Refresh and chat sessions (M15)

`refresh{scope?}` re-reads what may have changed outside the engine (docs/M15-POLISH.md). `review` — only while
`gate.phase == "reviewing"` — re-snapshots B and re-diffs against the same A: external edits show up in the existing
diffs, files whose diff became empty are dropped (with their notes; the gate opens when nothing is left), files that
appeared are added `pending`; reviewed states and `tools[]` are kept and the diff cache is invalidated
(`gate.turnEndTree` changes). The gate stays turn-based: an idle `refresh` never turns worktree changes into a review. **HEAD moved outside the app** (a pull, a merge, the user's commit, a checkout — while the review stands or the app was closed): the gate keeps `baseHead`, HEAD when A was snapshotted (persisted as `baseHead`), and before a review `refresh`, a `send` / `request_changes` / `peer_accept` on the standing review and after `open_project` restores one — and at every turn's collection (§46) — the commits' changes (`git diff baseHead HEAD`) are applied to A in a temporary index (`git apply --cached --3way`) — the list keeps only what Claude changed and `turnStartTree` changes; so is the incoming side of a merge still in progress (§46). When they do not apply on A (they overlap what A held uncommitted) A stays and `gate.headMoved` reports the move. A restored review with `baseHead` no longer gets the §31 `head_moved` stale reason; one saved before it (no `baseHead`) still does.
`branches` / `workbenches` (with per-worktree `dirty`, like `workbench_list`) and the git identity are re-read while a
project is open; `pr` re-runs `pr_list` (+ `pr_reload_comments` when a PR is open) and `accounts` re-runs `accounts` —
both on the PR lane, so the `result` of `refresh` does not wait for `gh`. Without `scope` every applicable scope runs;
`pr` / `accounts` count as applicable only when the PR browser was used before (a list or account was loaded). A git
failure of the review re-diff is `error{scope:"git"}` + `result{ok:false}`; everything else only logs.

**Chat sessions.** Exactly one live Claude session per engine (worktree); every chat is a `SessionMeta` in
`<gitdir>/reviewgate/sessions/index.json` with its own transcript file, `state.sessions` mirrors the index (newest
first), the current id and the open tabs. `open_project` picks the current session from `reviewgate-session.json`
(a fresh "New chat" when there is none), migrates a pre-M15 `reviewgate-transcript.ndjson` into that session (meta
derived from its rows: title from the first `user_message`, `turns` / `costUSD` from the `turn_end` rows) and deletes the
legacy file. A new session is started with a pre-chosen uuid (`--session-id`), so `SessionMeta.id` is stable from the
start; should the CLI report another id (`session_info` / `turn_end`) the meta, its file and the tab follow that id.

- `session_new`: refused with `session_busy` while `starting` / `running` / `collecting` / `reverting` (the clients hold
  such a switch and send it once that is over — below), and with `collect_failed` when a collection failed (the retry
  belongs to this chat). **The review never holds a switch** (r2-chats-cards M31): pending and accepted-but-uncommitted
  files, review notes — unsent ones too — and files sent back with notes are worktree state that outlives the chat, and
  they survive the switch untouched (a `send` in the new chat is a question, so §10's answer rule keeps snapshot A and
  merges the list; [변경 요청] there sends the notes to that chat's Claude). Engines before M31 also refused
  `review_pending` (a file changes-requested) and `notes_pending` (unsent notes). Stops the current Claude session,
  creates a "New chat" meta (appended to `openTabIds`), resets the HUD, emits `transcript_restore{items: []}` and starts
  a fresh session.
- `session_open{sessionId}`: same guards, `unknown_session:<id>` otherwise. Opening the current session only replays
  its rows. Otherwise the current session is stopped, the meta becomes current (tab added), `transcript_restore` carries
  its rows, and the session is resumed (`resume: id`) when the CLI knows the conversation (§30), else started fresh with
  that id. When the CLI cannot find / load it (§30: `resume_not_found` / `resume_failed`) the meta is flagged
  `resumeFailed: true`, its transcript stays readable, and a fresh "New chat" takes over (`transcript_restore{items: []}`,
  then the notice).
- `session_rename{sessionId, title}` (`empty_title` after trimming), `session_archive{sessionId, archived}`,
  `session_delete{sessionId}` (`session_current` for the running one; removes the meta, the transcript file and the tab),
  `tabs_set{openTabIds}` (unknown ids are dropped; `no_project` without a project), `session_list` (a `state` refresh).
- Meta updates: `send` sets `lastUserText`, bumps `updatedAt` and replaces the title while it is still "New chat"
  (first non-empty line, ≤ 60 chars, cut with `…`; a user-set title is never replaced); every turn end — normal or
  abnormal — adds `turns += 1`, `costUSD += usage.costUsd` and bumps `updatedAt`. Transcript rows continue the
  session's `turn` numbering across resumes; `hud` counts the turns of this engine's live session and resets on a switch.
- `restart_session` restarts the *current* session (resume when the CLI knows it, §30, else fresh with the same id) and
  leaves the history untouched.
- **Held switches (client rule, r2-chats-cards M31 / M33).** A new chat ([+], ⌘T, the banners' "새 채팅") or a switch to a
  chat shown read-only ([이 채팅으로 이어가기], a message sent from it, §39.2) asked for while the engine would answer
  `session_busy` — a start, a turn, its collection or a revert — or while the live chat's queue still holds messages is
  never refused: the client holds it (the last one wins) and sends `session_new` / `session_open` once the live chat is
  done — its turn ended and its queued messages went out, so turns stay one at a time per worktree and a queued message
  stays with the chat it was typed in; a message held with a switch then joins that chat's queue. The tab strip shows a
  chip ("새 채팅 대기 중", "대기: <제목>") whose tooltip says what it waits for and whose × calls it off (a held message goes
  back to the composer). No held message is lost: another message sent from the same chat, or its [이 채팅으로
  이어가기], keeps the ones held for it and they join its queue in order; a switch elsewhere (the last one wins) or × gives
  them all back to the composer — text one after another, mentions and images too (at most 5 images in the box, the rest
  refused with the usual notice). A failed collection drops it with its reason; only `collect_failed` disables [+] / ⌘T now.
  ⌘1…⌘9 only show a chat (§39.2), so they are never disabled either. Mac: Core `AppState+ChatSwitch.swift`
  (`PendingChatSwitch`, `newChatBlocker`, `chatSwitchWaits`), `PendingChatSwitchChip` in `ChatTabs.swift`; test
  `PendingChatSwitchTests`. Electron: the same (`src/renderer/pendingSwitch.ts`: `switchWaits`, `holdSwitch`,
  `drainPendingSwitch`, run after every snapshot by `pendingSwitchDrain.ts`; `sessions.ts` `newChatRefusal`; `viewedChat.ts`
  `viewingSendWait`; the chip in `ChatTabs.tsx`, the line and [취소] in `ViewingChat.tsx`). The history's [열기] never waits
  either: while a switch would, it shows the chat read-only in a tab, as a tab click does (both clients). Tests
  `pendingSwitch.test.ts`, `viewedChat.test.ts`, `reviewRoundStore.test.ts`.

### 9.1 The chat left keeps its Claude Code process a while (r2-chats-cards M33)

A switch used to stop the CLI and start (resume) another one — 2–3 s without plugins, more with MCP servers — every time,
also back to the chat just left. No wire change; still one *live* session per engine:

- **Parked.** On `session_new` / `session_open` (and every other switch: rewind's fork, "implement in a new chat", a CLI
  session import) the chat left keeps its CLI process, idle and detached — none of its events show, it answers nothing —
  when nothing of it runs: no turn, start, collection or revert, no card, plan or held peer message, no background task
  or subagent, not a record (§35.4) or a rewind fork the CLI has not made yet. Otherwise it is stopped as before.
- **Taken back.** Switching back to that chat while its process waits takes it again — no start: `state.session` comes
  back `open` at once with the id, model, capabilities and extensions it had, and the next `send` goes to it — when
  everything a start depends on is unchanged (the settings, the model choice, the permission mode, the extensions
  fallback, the peer mode and name, the client env; `launchKey`). Else it ends and the chat resumes in a new CLI, which
  starts only once the old process is gone (two processes on one conversation would corrupt it).
- **At most one parked, five minutes.** Parking another chat ends the one parked before; a parked process ends after
  5 minutes idle (`EngineOptions.parkIdleMs`, 0 = never park), and with the project, the engine and its chat
  (`session_delete`). One that reports anything but quiet info (a turn of its own, a task's result, a peer message, a
  card, its exit) ends at once — nothing it would do may escape the review; the chat then resumes as before.
- **Turns stay one at a time per worktree**: only the live CLI ever runs one. A parked CLI is this window's own for §31.4
  ("other Claude processes") and §36.9 (`cli_sessions`).
- Engine: `engine/src/engine.ts` (`parkOrStopSession`, `takeParked`, `unpark`, `disposeParked`, `launchKey`); test
  `engine/test/engine.parkedSession.test.ts` (two fake sessions). Measured with the real CLI 2.1.318 (haiku, without the
  user's settings; `sidecar/test/driver-chatswitch.mjs`, from the command to the CLI's initialize answer): back to the chat
  just left 1.1–1.2 s → 1–3 ms; a new chat 1.3 s → 0.3 s (the chat left is no longer stopped first). More with plugins and
  MCP servers before, the same after.

## 10. Friction fixes (M16)

docs/M16-FRICTION.md, engine part. Everything here is additive: new optional settings / command fields, new state fields.

- **Read-only Bash auto-allow** (`settings.autoAllowReadOnlyBash`, default true; `engine/src/session/bashClass.ts`).
  `isReadOnlyCommand(cmd)` tokenizes the command with quote awareness (single quotes literal, double quotes literal except that
  `` ` `` and `$(` inside them still reject) and splits it on `|`, `||`, `&&`, `;` and newlines. It is read-only when every
  segment's first word — after leading `NAME=value` assignments, which must be harmless locale/terminal names (`LC_*`, `LANG`,
  `LANGUAGE`, `TZ`, `NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `COLUMNS`, `LINES`, `TERM`; `NODE_OPTIONS=`, `PAGER=`, `GIT_*=`,
  `LD_*=` … reject); a `/abs/path/git` counts by its basename only from `/bin`, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`,
  `/sbin`, `/usr/sbin`, `./x` never (a path with `\` is one too: `"C:\Program Files\Git\cmd\git.exe" status` is from none of
  them); git and gh count by their name as well (§20 `programName`: `git.exe status`, `GIT log`, `gh.exe pr view 42`, with
  git's and gh's checks) — is in `ls cat head tail wc pwd which type echo printf grep rg find fd stat file env date
  whoami tree du df ps id uname sort uniq cut sed tr jq node npm python3 git test [ true false gh xargs` (§19.3; `awk` is NOT: its programs can write, pipe, run
  commands and load files) and its arguments pass the per-command check: `sed` needs `-n`/`--quiet`/`--silent`, no
  `-i`/`-I`/`--in-place`/`-f`/`--file`, and every script (`-e`, `--expression`, or the first operand) must parse as addresses +
  simple commands (`p P l q Q = d D n N g G h H x z { }`) and `s`/`y` with only `g p i I m M <n>` flags — `w`/`W`/`r`/`R`/`e`
  commands, `s///w`/`s///e`, labels and text commands reject; `find` without `-exec*`/`-ok*`/`-delete`/`-fprint*`/`-fls`; `fd`
  without any `-…x`/`-…X` cluster or `--exec*`; `rg` without `--pre`/`--pre-glob`/`--hostname-bin`; `sort` without `-…o…`,
  `--output`, `--compress-program` (GNU long-option prefixes like `--comp`, `--out` count); `uniq` with < 2 positionals; `tree`
  without `-o`; `file` without `-C`/`--compile`; `date` without `-s`/`--set` and with only `+format` positionals; `env` with only
  `-i`/`-0`/`-u NAME`/assignments (no `-S`/`--split-string` or other options) — followed by nothing, or by safe assignments and a
  command that is itself read-only; `node --version|-v`; `npm ls|view|-v|--version`; `python3 --version|-V`; `git [--no-pager|-P|
  --no-optional-locks|--literal-pathspecs|--no-replace-objects] status|log|diff|show|branch|rev-parse|remote|ls-files|blame|describe|tag`
  — any other global option (`-c`, `-C`, `--git-dir`, `--work-tree`, `--exec-path`, `--config-env`, …) rejects — without `-o`,
  `--output`, `--ext-diff`, `--textconv` (or their prefixes), where `branch`/`tag` must be listing (no positional unless
  `--list`/`-l`/`--contains`/`--merged`/`--points-at`; no `-d`/`-D`/`-m`/`-c`/`-f`/`-u`/`-a`/`-s`/`--set-upstream-to`/…) and
  `remote` only bare, `show` or `get-url` (§19.3 adds more git reads, `config` reads, `gh` reads, `test`, `xargs`, and `cd` /
  `git -C` into the repository). A word with an unquoted glob (`*`, `?`, `[`) or `$` is only allowed as an argument of
  `ls cat head tail wc pwd which type echo printf grep stat du df ps id uname cut tr jq whoami` (a planted file named `--pre=x`
  matched by `*` must never reach `rg`/`sort`/`git`/…), never as the command name. Any `>`, `<`
  (so `<(…)`, heredocs too — but not a redirection into /dev/null or onto another stream such as `2>&1`, §19.3), `(`, `)`,
  `{`/`}` at a word start, backtick, `$(`, background `&`, `|&`, an unterminated quote,
  an empty line, or a segment starting with anything else (`sudo`, `rm`, `mv`, `cp`, `tee`, `eval`, `exec`, `npm test`,
  `node script.js`, …) makes the command NOT read-only. The PreToolUse Bash hook then answers `permissionDecision: "allow"`
  (reason `ReviewGate: read-only command`) instead of `ask`, and `canUseTool` applies the same rule should it still be reached;
  the budget deny is checked first, and a git command that throws away uncommitted work or rewrites the remote
  (`git reset --hard`, `clean -f`, a force push, …) always gets the card with the reason `git_command` (§46). `false` turns
  the rule off.
- **Allow patterns** (`settings.bashAllowPatterns`, default `[]`; live via `set_settings`). Claude-style entries: `Bash(npm test:*)`
  (prefix `npm test` at a word boundary: `npm test`, `npm test -- --watch`, not `npm testing`), `Bash(git *)` (glob over the whole
  command; `*` any run, `?` one char), `Bash(make)` (exact). Whitespace runs are collapsed on both sides; a bare pattern without
  the `Bash(…)` wrapper is accepted; patterns for other tools never match. Evaluated in the Bash hook after the read-only rule and
  before `ask` (reason `ReviewGate: matches an allow pattern`); deny still wins.
- **Session remember.** `permission_response{allow: true, remember: true}` stores `rememberKeys(tool, input)` in
  `state.session.rememberedAllows`: for Bash one `"Bash:<program> <verb>"` per simple command (§19.3, 2026-11: `./mvnw -q -pl api
  test` → `Bash:./mvnw test`; it was the first two words), `"<tool>:<tool>"` for every other tool (`WebFetch:WebFetch`). A
  later call whose key is in the set is allowed by the hooks (reason `ReviewGate: allowed for this session`) — no
  `permission_request`. A deny with `remember`, or an allow without it, stores nothing — nor does an allow with it on a
  request with a `reason` (§33.3, §33.9), `SendMessage` (§33.2 — except `SendMessage:<session id>` for a card whose
  `toSession` names its conversation), an edit, worktree or plan tool, or `AskUserQuestion`; a key
  an older client stored for one of those tools (state, `allows.json`) allows nothing either. The set lives with the engine's project:
  it survives `restart_session`, `session_new` / `session_open` and set_settings, and is cleared by `forget_allows`,
  `close_project` and `open_project` — unless `settings.persistSessionAllows` (default on) keeps it per repository (§33.7). The transcript
  row for the decision is unchanged (`permission{allow: true}`); other queued requests the new key covers are answered too (§33.1).
- **Accept-and-send.** `send{text, acceptPending: true}`: while the gate is `reviewing` with only pending files the engine runs
  `accept_all` and then sends as usual — the outgoing text gets the `[Review gate] Accepted: …` prefix, `changedFiles` show
  `accepted`, the turn starts. Refused like a plain send while `running` / `collecting` / `reverting`
  (`gate_closed:<reason>`, nothing accepted; M30, §3: after a failed collection it accepts against the held B and sends) and with `gate_closed:changes_requested` when any file is `changesRequested` (use
  `request_changes`; nothing accepted). `acceptPending` on an open gate is a plain send. It is **never** the default: clients
  send it only from a separate, explicitly labelled "Accept N & Send" action (Mac: menu button next to Send, ⌘⇧↩; Electron:
  split-button dropdown, Ctrl/⌘+Shift+Enter) — M28: at once, no confirmation (a toast says what was accepted). The plain Send button (AX "Send") leaves the
  review exactly as it is — a message sent while files await review is a question, answered against the same snapshot A
  ("Question during a review", §3).
- **Budget defaults.** `DEFAULT_SETTINGS.budget = {maxFiles: 0, maxLines: 0, hardMultiplier: 2.0}` — no change budget (§54; it was
  10 / 400 until then); a `hello` / `set_settings` that omits `budget` (or any other field) keeps the defaults. With a limit set the
  soft warning stays at 100 %.
- **`state.gate.reviewSummary`** = `{files: changedFiles.length, added: Σ added, deleted: Σ deleted}` over every changed file
  regardless of its state (`{0, 0, 0}` when nothing is under review); recomputed with every snapshot (accept keeps a file
  counted, reject / commit drop it).
- **Capabilities cache.** Every `session_info` writes `<gitdir>/reviewgate/capabilities.json`
  (`{version: 1, capabilities: {slashCommands, skills, plugins, mcpServers}, savedAt}`, atomic, behind the persist chain).
  `open_project` / `init_repo` read it before the session starts: when present the first project `state` already carries it as
  `session.capabilities` with `session.capabilitiesCached: true` (also after `session_new` / `session_open` / `restart_session`
  until the CLI answers), so a client can populate its slash palette before the first turn; the next `session_info` replaces it
  (`capabilitiesCached: false`) and rewrites the file. A missing, corrupt or foreign-version file is ignored (`capabilities: null`).

## 11. Permission modes (M20)

docs/M20-MODES.md, engine part. Additive: one optional setting, one command, one state field.

- **The four modes.** `default` (ask for every non-read-only tool — the behavior of §10), `auto` (the CLI's classifier answers
  the prompts), `plan` (read-only planning), `acceptEdits` (edit tools auto-approved; Bash and friends still asked). The SDK's
  `bypassPermissions` / `dontAsk` are **not** exposed — they would defeat the approval flow; any value outside the four refuses
  with `invalid_mode` (`set_settings`/`hello` as well as `set_permission_mode`).
- **Start.** `settings.permissionMode` (default `"default"`) is passed to the CLI as `query({options: {permissionMode}})` when a
  session starts. Changing it through `set_settings` takes effect at the next session start; the mode of a *live* session only
  changes through `set_permission_mode`.
- **`set_permission_mode { mode }`** calls `query.setPermissionMode(mode)` on the running session, mirrors it into
  `state.session.permissionMode` and persists it. It is refused with `no_session` when no session is open and with
  `session_busy` while a session start, a collection or a revert is in flight — and while a turn runs only for a switch into
  or out of `plan`: default / acceptEdits / auto switch during a turn too, from the CLI's next tool call (§39.5).
- **Persistence.** The mode is stored in `<gitdir>/reviewgate-session.json` (`permissionMode`, next to `sessionId`/`openTabIds`)
  and restored by `open_project` **as-is, `plan` included** — a project parked in plan mode reopens in plan mode. A missing or
  unknown value falls back to the mode the repository's other worktrees ran in last — the most recently saved
  `reviewgate-session.json` of the main worktree (`<common>/`) and the linked ones (`<common>/worktrees/<name>/`), plan mode
  skipped — so a new workbench of a repository worked in auto mode starts in auto mode instead of asking for every
  command; then to `settings.permissionMode`, then `"default"`. `session_new` / `session_open` keep the project's mode.
  (A task's or an approved plan's mode, §49 / §42.1, still wins: it is applied after the restore.)
- **Deny still wins.** The mode never reaches the PreToolUse hooks: the budget returns `deny` before the CLI evaluates any
  mode, so `auto` and `acceptEdits` cannot bypass the review gate, and a git command that throws away uncommitted work or
  rewrites the remote gets the card (`git_command`, §46) in those modes too (§10, engine/test/engine.modes.test.ts).

### The plan proposal flow

Plan mode makes Claude work read-only and write the plan to `<home>/.claude/plans/<slug>.md`, then announce it in the reply.
The engine turns that into a proposal. Two CLI behaviors, both handled centrally — a client never answers a plan itself:
- **CLI 2.1.275+ has an `ExitPlanMode` tool** (it carries `plan` + `planFilePath`, and is offered *after* the plan file is
  written). It reaches `canUseTool`, and allowing it would let the very same turn leave plan mode and implement. The engine
  therefore **never surfaces a permission card for it**: it takes `input.plan` (capped at `MAX_PLAN_BYTES`), emits
  `plan_proposed` right away and resolves the tool as `deny` with *"Plan received. The user approves plans in ReviewGate; stay
  in plan mode and wait."*, so the turn ends with the plan pending. Cosmetic: this deny still arrives on the wire as an
  ordinary `tool_result { isError: true }`, which would otherwise render as a red "tool error" transcript row right under the
  plan card. The engine remembers the tool_use id of the intercepted call when the assistant message carrying it is
  translated and swallows both that `tool_use` and its matching `tool_result` — neither reaches the client nor the transcript
  log; `plan_exit`/`plan_proposed`, the deny sent to the CLI and the HUD activity events are unchanged.
- **CLI 2.1.273 has no such tool** (checked the init tool list). There the plan file written during the turn is the proposal:
  it is read back at `turn_end`. This path stays as the fallback; when both fire in one turn the plan is proposed only **once**
  (deduped per turn by plan-file path and by the plan's hash).

- **Plan files.** While `session.permissionMode === "plan"`, a `Write`/`Edit` whose resolved path is inside `<home>/.claude/plans/`
  is auto-allowed by the PreToolUse hook (`permissionDecision: "allow"`) instead of raising the containment ask — those paths are
  outside the repository and would otherwise prompt. They are recorded as **plan files** and are bookkeeping, not work: they never
  appear in `state.gate.changedOutside`, never in `changedFiles` / the review, and are never charged to the per-turn budget.
  Outside plan mode the same path prompts as any other outside edit.
- **No edits in plan mode (§19.4).** Every other edit-tool call (in the repo too) and every Bash command that is not read-only is
  denied while `session.permissionMode === "plan"`, with a reason telling Claude to propose the change via `ExitPlanMode`.
- **`plan_proposed { path, plan }`** carries the plan: from `ExitPlanMode` as soon as the tool is called, otherwise at `turn_end`
  from the last plan file the turn wrote, read back (capped at 200 KB, `MAX_PLAN_BYTES`). `path` is the plan file, or **`null`**
  when the plan only came through `ExitPlanMode` and no plan file was written this turn. The same value is mirrored into
  `state.session.pendingPlan = { path, plan, at }` (`at` is ISO-8601) so a client that reconnects still sees the open card.
- **`plan_response { approve, mode?, message? }`** answers it.
  - `approve: true` → `setPermissionMode(mode ?? "default")` (§44.1: without `mode`, back to `auto` when the chat came from
    auto mode), clears `pendingPlan`, emits **`plan_approved { mode, path }`** (the
    same nullable `path`) and then issues the follow-up instruction as a normal `send` (`message ?? "Implement the approved plan
    at <path>."`, or `"Implement the plan you just proposed."` when `path` is `null`) — a normal send, so the review gate
    applies to the implementation turn. §54: it no longer adds "Work in small units and stop after each unit for review.",
    which made Claude stop after the first step of a plan.
  - `approve: false` → stays in plan mode, clears `pendingPlan` and sends `message ?? "Keep planning — revise the plan; do not
    implement yet."`.
  - Refusals: `no_session`, `session_busy` (a turn / start / collection / revert in flight), `no_plan` (nothing pending),
    `invalid_mode` for a `mode` outside the four and `gate_closed:<reason>` when the follow-up `send` could not go out
    (nothing is switched and the card stays up). A follow-up that fails after the switch is rolled back:
    `plan_followup_failed:<reason>` (§19.5).
- **A plain `send` supersedes the plan**: `pendingPlan` is cleared by the user's own message; clients should say so in the card.
- Covered by engine/test/engine.plan.test.ts and, against the real CLI, by the M20 block of sidecar/test/driver-v2.mjs.

## 12. Change → cause linkage

Data for "why did this change" next to a diff; every field is optional on the wire, so older clients ignore it.

- **Subagent calls.** Tool calls a subagent makes are emitted like top-level ones (`tool_use` / `tool_result`, persisted in the
  transcript), with `parentToolUseId` = the id of the `Agent`/`Task` `tool_use` that spawned the subagent (the SDK's
  `parent_tool_use_id`). Top-level calls carry no `parentToolUseId`. Nested subagents chain: the inner `Agent` call itself has
  the outer one as parent. (A subagent's own text is still not streamed into the transcript.)
- **`rationale`** on `tool_use`: the last non-empty text block that preceded the call in the same API message (the CLI splits a
  message into one `assistant` per block, sharing `message.id`), trimmed; longer than 400 chars → `"…"` + its last 399.
  Parallel calls after one text block share it. A call in a message without text gets the same agent's latest text of the
  turn instead (real CLIs explain, `Read`, then `Edit` in a separate message — CLI 2.1.303 observed); none before the agent's
  first text. Subagent calls get their own subagent's text, never the main agent's. Persisted in the transcript row.
- **`changedFiles[].toolUseIds`**: the tool_use ids that changed the file this turn, in order — edit tools (`Edit`, `Write`,
  `MultiEdit`, `NotebookEdit`) by their `file_path` (a `Read` of the file is listed in `tools` but is not a cause, and neither is
  an edit whose `tool_result` is an error — denied, `old_string` not found: its id is dropped, its tool name stays), and **Bash**
  through the post-Bash snapshot: before the turn's first Bash call the engine snapshots the worktree, after every Bash call —
  PostToolUse, or PostToolUseFailure for a command that exited non-zero — it snapshots again and attributes to that call the
  files that changed since the previous snapshot **and** whose change time falls inside the call's execution window (§31; a
  change made between two calls is nobody's), except files an edit tool touched in between (the edit explains them); `tools`
  then lists `"Bash"`. An MCP call's window attributes the files nothing else explains (§31). An answer / request-changes turn
  merges the ids into the existing review like `tools` (files the follow-up did not touch keep theirs). Restored reviews
  persisted before this field read `[]`.
- **Bash output.** `preview` stays the first 500 chars; `truncated: true` says there is more. For a Bash result longer than the
  preview the engine keeps up to ~20 000 chars (the first 4 000 + `… [N chars omitted] …` + the last 16 000 — test verdicts sit at
  the end) in memory, at most 100 results / 2 M chars, oldest evicted, never persisted. `tool_output { toolUseId }` replies
  `tool_output { toolUseId, output, truncated }` (`truncated`: the kept text is cut); `output: null` when nothing is kept (not
  Bash, short enough for `preview`, evicted, or from before an engine restart).
- **`testOutcome`** on a Bash `tool_result` whose command runs vitest / jest / `npm|pnpm|yarn|bun [run] test` / pytest /
  `swift test` / `go test` / `cargo test` / `xcodebuild … test` (anywhere in the command line, not backgrounded): `"fail"` when the
  result is an error (non-zero exit) or the output shows a non-zero failure count / `FAIL` / `test result: FAILED` /
  `** TEST FAILED **`; otherwise `"pass"`. Absent for any other command. A heuristic for a badge, not a verdict.

## 13. Subagent activity (`state.hud.agents`)

```ts
type AgentNode = {
  id: string;                    // SDK task id once task_started arrived, else the spawning tool_use id (older CLIs) — key on toolUseId
  toolUseId: string;             // the Agent/Task tool_use; the subagent's own calls carry it as parentToolUseId (§12)
  parentToolUseId?: string;      // tool_use of the agent that spawned this one (nested); absent for top-level spawns
  type: string;                  // subagent_type ("general-purpose" when none was named)
  description: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "stopped";   // SDK "killed" → "stopped"
  isBackground: boolean;
  depth: number;                 // 1 for a top-level spawn, N+1 inside a depth-N agent
  lastTool?: string;
  summary?: string;              // task_progress summary (agentProgressSummaries) / final task_notification summary
  tokens?: number; toolUses?: number; durationMs?: number;   // task usage
  startedAt: number;             // epoch ms
  endedAt?: number;              // epoch ms, once completed / failed / stopped
  error?: string;
  files: string[];               // files its edit tools — and its Bash calls via the post-Bash snapshot (§12) — changed, nested agents included;
                                 // repo-relative inside the repository, absolute outside
};
```

- Carried in the snapshot (no separate event): lifecycle changes go out with the next coalesced `state`; `task_progress` /
  `tool_progress` changes at most every 250 ms (≤ 4/s, the trailing update is never dropped). The main agent is implicit.
- **Sources.** The session runs with `agentProgressSummaries: true`. The SDK's `system/task_started` (only `task_type:
  "local_agent"`, or untyped with a subagent type / known tool_use; `ambient` / `skip_transcript` tasks are ignored, as are
  `local_bash` / MCP / workflow tasks), `task_progress` (usage, `last_tool_name`, `summary`), `task_updated` (`patch.status`,
  `end_time`, `error`, `is_backgrounded`), `task_notification` (final status, summary, usage — it overrides anything earlier)
  and `tool_progress` (a running subagent's current tool) update the node. **Fallback** for CLIs without task messages: a node
  is created from the `Agent`/`Task` `tool_use` (`description`, `subagent_type`, `run_in_background`) and closed by its
  `tool_result` (`completed`, or `failed` when `isError`), so the list works either way. Once task messages were seen, a
  background agent's `tool_result` (the "launched" placeholder) does not close it.
- **Lifetime.** Agents are not cleared at turn end: a background agent can finish later, and finished ones stay visible
  until the next user turn starts (`send`, `request_changes`, plan follow-up), which drops every agent that is no longer
  pending / running / paused. At turn end foreground agents still marked live are set `stopped` (interrupt, lost
  notification). When the CLI goes away (`restart_session`, session switch, close) every live agent is `stopped`; a new
  project / session starts with an empty list.
- **Background tasks are off.** CLI 2.1.303 runs every `Agent` call as a background task in an SDK (streaming-input)
  session (`task_started.is_backgrounded: true` without `run_in_background`): the main turn could end while the subagent
  still edited, the CLI then continued on its own with an extra `result`, and those edits missed the review (the next
  send's snapshot A swallowed them). The engine starts the CLI with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (unless the
  environment sets it), so subagents and Bash finish inside the turn the gate collects; `isBackground` stays false in
  practice. Should a turn still run without a send (the user's environment sets the variable to a falsy value), the
  unprompted-turn guard of §18 keeps it from changing anything. Observed with it: `task_started` → `task_progress` (usage, `last_tool_name`; `description` becomes
  "Running …" — no `summary` for short tasks even with `agentProgressSummaries`) → `task_updated{status:"completed"}` →
  `task_notification` (final `summary`, usage) → the Agent `tool_result`.
- **`subagentDepth`** = number of live foreground agents (background ones do not count), replacing the old
  subagent_start/end counter; the raw `activity` events are unchanged.

## 14. Review history

Every completed review round is kept per worktree, so past verdicts and diffs stay viewable after the review list moved on.
Additive: two commands, two reply events, an optional `round` in the review file.

```ts
type ReviewHistoryEntry = {
  id: string;                    // "<epoch36>-<8 hex>"
  sessionId: string | null;      // the chat the round's first turn ran in
  turns: number[];               // transcript turn numbers: first turn + answer / request-changes follow-ups
  startedAt: string; endedAt: string;   // ISO-8601 (first turn's send → round end)
  prompt: string;                // the first turn's user text, ≤ 200 chars ("…" when cut)
  files: {
    path: string; oldPath: string | null; status: "A" | "M" | "D" | "R" | "X";
    verdict: "accepted" | "rejected" | "changes_requested" | "pending";   // "pending" only if the round ended unresolved
    adds: number; dels: number;
    toolUseIds: string[];        // §12, accumulated over the round's turns
    changesRequested?: number;   // times sent back with notes
    rejectedHunks?: number;      // hunks reverted with reject_hunks (§17)
    endTree?: string;            // rejected / partially reverted file: the turn-end tree that still held the whole proposal
    committed?: true;            // left the review through `commit`
  }[];
  notes: { path: string; line: number | null; side: "old" | "new"; body: string }[];   // every note sent with request_changes
  turnStartTree: string;         // snapshot A of the round
  turnEndTree: string;           // the last B of the round
  finished?: true;               // §31: closed by finish_review — its "pending" files were left on disk unreviewed
};
```

- **Round.** Starts with the first collection that lists changed files after a *fresh* snapshot A; question turns and
  `request_changes` follow-ups (A kept, §3) extend it (`turns` grows, numbers / tool ids follow the latest list). It ends
  when the next fresh `send` takes a new A (accepted files simply stay on disk), when nothing is left to review (every
  file rejected and/or committed), or on `close_project` of a review without pending files / notes. A round without any
  file is never recorded. The round in progress is saved in `reviewgate-review.json` (`round`) and survives a restart;
  reviews restored from files written before it start a round with `prompt = lastUserText`, `turns: []`.
- **Verdicts.** `accept` → `accepted`; `reject` → `rejected` (the file record keeps its numbers and gets `endTree` = the B
  before the revert); `reject_hunks` that leaves the file pending sets `endTree` = the B before its *first* partial
  revert (the whole proposal; kept by later partial reverts and a later whole `reject`, dropped when a request-changes
  rebuild proposes the file anew), while `adds` / `dels` describe what was kept; `request_changes` → `changes_requested` (+ `changesRequested`), re-evaluated after the follow-up turn
  (pending again, then the user's next decision); `commit` keeps `accepted` and sets `committed`. Files whose diff became
  empty (Claude or the user reverted them) are dropped from the round.
- **Storage.** `<gitdir>/reviewgate/history.json` (`{version: 1, entries}`, oldest first, atomic, behind the persist chain),
  capped at the newest **50** entries. Each entry's trees are pinned by `refs/reviewgate/<ns>/history/<id>/start`, `…/end`
  and `…/end-<n>` (one per distinct rejected-file `endTree`); dropping an entry over the cap deletes its refs, and refs of
  ids that are neither in the history nor the round in progress are pruned on `open_project`.
- **`review_history { sessionId?, all? }`** replies `review_history { sessionId, entries }`, newest first: the given
  session's entries, by default the current session's; `all: true` lists every session of the worktree (`sessionId: null`).
  `no_project` without a project. (§34.4: plus `current`, the round in progress, whatever the session filter.)
- **`history_diff { entryId, path, final? }`** replies `history_diff { entryId, path, diff, truncated, final? }` — the same
  `FileDiff` / `truncated` (≤ 20 000 hunk lines) as `file_diff`, computed `git diff-tree -M -p <turnStartTree> <endTree ??
  turnEndTree>` for the file (binary: `isBinary: true`, no hunks): the proposal, reverted hunks included. `final: true`
  diffs against the round's last `turnEndTree` instead (what was left on disk; empty for a rejected file) and echoes
  `final: true`. Refusals: `unknown_history_entry:<id>`, `not_in_history_entry:<path>`,
  `history_trees_gone` (a tree was pruned anyway). It is a separate event type — not `file_diff` — so a client never
  mistakes it for the current review's diff.
- **Ref namespace (fixes the shared-ref issue of M10).** A / B used to be pinned by `refs/reviewgate/turn-start|end`, one
  pair for the whole repository, so two workbenches overwrote each other's pins (and `git gc` could prune the other
  review's trees). They now live under `refs/reviewgate/<ns>/` with `<ns>` = `main` (gitdir = common dir) or `wt-<name>`
  (`<common>/worktrees/<name>`, sanitized to `[A-Za-z0-9._-]`). `refs/worktree/…` was evaluated and rejected: those refs
  are per-worktree, but `git gc` run in *another* worktree does not treat them as roots and prunes their trees (git
  2.50.1, verified). Migration: `open_project` still restores a review pinned only by the old shared refs (when they hold
  the saved A), re-pins it under the namespace and deletes the old refs — only when they point at its own trees.
- **Removed worktrees.** A `wt-<name>` namespace whose `<common>/worktrees/<name>` admin dir is gone is deleted whole
  (review pins + history pins): after `workbench_remove` / `workbench_prune`, and on `open_project` of the main
  worktree (a worktree deleted outside the app, then `git worktree prune`d). Live worktrees' namespaces are never touched.

## 15. Turn summary and plan vs actual

`turn_summary` follows `turn_end` (same macrotask burst) after every collection that leaves at least one file in
`changedFiles` — a fresh turn, a question during a review (the merged list) or a request-changes follow-up. A turn that
changed nothing emits none. Not persisted; a client that wants it later rebuilds it from `state` + the transcript. (§38.3: now also kept as a bounded `turn_summary` transcript row.)
(§34.3: only when the turn itself changed a file, and `files` are exactly those — with this turn's `adds` / `dels` and the
review's `reviewAdds` / `reviewDels`.)

```ts
type TurnSummaryEvent = {
  type: "turn_summary";
  turn: number;                                  // transcript turn number (= user_message.turn)
  files: {                                       // = changedFiles after the collection, same order
    path: string; status: "A" | "M" | "D" | "R" | "X"; state: "pending" | "accepted" | "rejected" | "changesRequested";
    adds: number; dels: number;
    why: string | null;                          // rationale (§12) of the first touching call that has one
    whyToolUseId: string | null;
    tools: string[]; toolUseIds: string[];
    origin: "tool" | "bash" | "external";        // §31
  }[];
  commands: { toolUseId: string; command: string; isError: boolean; testOutcome?: "pass" | "fail"; parentToolUseId?: string }[];   // the turn's Bash calls, in order
  plan: null | {                                 // only after plan_response{approve:true} in this session
    path: string | null;                         // the approved plan file (null: ExitPlanMode only)
    steps: { index: number; text: string; done?: boolean; files: string[] }[];
    unplannedFiles: string[];                    // changed files no step mentions
  };
};
```

- **why.** The engine remembers the session's last 2 000 tool calls (`tool_use` rationale / parent, Bash command, the
  `tool_result`'s `isError` / `testOutcome`); a file's `why` is the rationale of the first id in its `toolUseIds` that
  has one (ids of an earlier turn of the same review count too).
- **Plan vs actual.** The plan approved with `plan_response{approve:true}` is kept for the session (cleared by
  `session_new` / `session_open` / a project switch; a later approval replaces it) and mapped on every summary.
  Steps (`engine/src/review/summary.ts parsePlanSteps`): checklist items `- [ ] …` / `- [x] …` (`done`), numbered items
  `1. …` / `1) …`, step headings `## Step 2: …` / `### 3. …`; items nested deeper than the item above them and fenced code
  are not steps; without any of these, top-level bullets are the steps. `text` is the item line without inline markdown.
  A step "mentions" a changed file when its line or the lines under it (up to the next step / heading) contain the full
  path, a trailing sub-path (`src/a.ts` for `pkg/src/a.ts`), the basename with extension as a token (`gate.ts`, not
  `gate.tsx`), or a distinctive stem as a whole word (≥ 5 chars, not `index`/`main`/`utils`/`types`/`config`/`test`/…);
  case-insensitive. A heuristic for a checklist view, not a verdict.

## 16. User extensions: init fallback, applied extensions, per-item disable

With `loadUserSettings` (default true) the CLI runs with `settingSources: ["user","project"]` and `skills: "all"` (§4), so
the user's plugins, skills, MCP servers, hooks and `~/.claude/CLAUDE.md` take part in app sessions. Additive: three
optional settings, one state field, one event, an optional `capabilities.pluginDetails`.

```ts
type SessionExtensions = {
  settingSources: ("user" | "project")[];        // what the CLI was started with
  fallback: { reason: "init_timeout"; timeoutMs: number; at: string } | null;
  plugins: { name: string; id: string | null; path: string | null; version?: string; enabled: boolean }[];
  disabledPlugins: string[];                     // ids passed as enabledPlugins:{id:false}
  unresolvedDisabledPlugins: string[];           // bare names no known plugin matched (ignored, logged)
  userHooksDisabled: boolean;
  skills: string[]; slashCommands: string[];
  mcpServers: { name: string; status: string }[];   // "connected" | "failed" | "needs-auth" | "pending" | …
  memoryFiles: { path: string; type: string; tokens?: number }[] | null;   // CLAUDE.md / auto-memory the CLI loaded; null until reported
  claudeMd: { user: boolean; project: boolean; source: "cli" | "files" };
  hooks: { source: "user" | "project" | "plugin"; plugin?: string; path: string; events: string[]; active: boolean }[];
};
```

- **Init timeout → fallback.** The SDK's `system/init` message only arrives with the first user message, so the
  watchdog is the SDK's initialize handshake (`query.initializationResult()`, answered once the CLI loaded settings,
  plugins and MCP config — ~1 s normally). When user settings are loaded and it has not resolved after
  `settings.extensionsInitTimeoutMs` (default **20 000**; `0` turns the watchdog off), the engine marks the project
  `fallback`, emits a non-fatal `error{scope:"session"}` (the client's existing banner; message *"Claude Code did not
  start within 20 s with your user settings (plugins, MCP servers, hooks); restarted without them."*) plus
  `extensions_fallback{reason, timeoutMs, message}`, and issues `restart_session`: the same conversation is **resumed**
  (or started fresh with the same id when it never had a message — the one about to be sent again does not count, §35.5)
  with `settingSources: ["project"]`. The fallback
  sticks for the project — `restart_session`, `session_new`/`session_open` and auto-restarts keep it — until the next
  `open_project`, which tries the user settings again. A second timeout never cascades.
- **A message sent before init** (the turn is running, but the hung CLI produced nothing for it — no `session_info`,
  text, tool call, permission request, …) is not lost: the turn stays open across the fallback restart (no `turn_end`,
  same `user_message`, same snapshot A) and the same message is sent **once** to the new CLI; the message gets
  *" Your message was sent again."* and `extensions_fallback` carries `resent: true`. If the CLI had already answered
  anything, the turn is closed and collected as before (`restart_session` semantics); if the new CLI cannot take the
  message, the turn is closed with the error.
- **What was applied** (`state.session.extensions`, set at every session start, refreshed by `session_info` and by a
  post-initialize probe): `plugins` — the CLI's `system/init` plugin list (until then the cached one), each with
  `id = name@marketplace` derived from the install path `…/plugins/cache/<marketplace>/<name>/<version>`
  (`name@builtin` for built-ins, `null` for `--plugin-dir` plugins), plus every configured-disabled plugin as
  `enabled: false`; `skills` / `slashCommands` / `mcpServers` from the capabilities (MCP status from
  `query.mcpServerStatus()` right after initialization, then from `system/init`); `memoryFiles` from
  `query.getContextUsage({detail:"summary"}).memoryFiles` (≤ 5 s, best effort), which also decides `claudeMd`
  (`user`: `<CLAUDE_CONFIG_DIR | ~/.claude>/CLAUDE.md` loaded; `project`: a `CLAUDE.md` / `CLAUDE.local.md` under the
  project) — without that report, `claudeMd` is file existence (`source: "files"`). `hooks` lists the hook sources
  besides ReviewGate's own: the `hooks` keys of `<config>/settings.json` (only when user settings load),
  `<root>/.claude/settings.json` and each enabled plugin's `hooks/hooks.json`. Note: the CLI loads
  `~/.claude/CLAUDE.md` even with `settingSources: ["project"]` (CLI 2.1.303, observed).
- **Per-plugin disable** (`settings.disabledPlugins`, next session start — `restart_session` applies it): every entry
  becomes `enabledPlugins: { "<name>@<marketplace>": false }` in the SDK's `settings` option, the **flag settings layer**,
  which outranks user and project settings. Verified against CLI 2.1.303: with `{"oh-my-claudecode@omc": false}` the
  plugin is gone from the session while the other user plugins stay. A bare name is resolved through the plugins seen
  before (this session or `capabilities.pluginDetails` in the cache); unresolvable ones are reported in
  `unresolvedDisabledPlugins` and ignored. Plugins without an id (`--plugin-dir`) cannot be disabled this way.
- **User hooks off** (`settings.disableUserHooks: true`, next session start): `settings: { disableAllHooks: true }` in
  the flag layer. Verified against CLI 2.1.303: user / project settings-file hooks and plugin hooks no longer run, while
  the SDK callback hooks ReviewGate registers (`hooks` option: budget, git guard, containment, post-Bash snapshot) still
  fire — so the review gate is unaffected. It also turns off the user's `statusLine` (§44.2: the engine runs it for the
  chat, and treats this flag as the CLI treats `disableAllHooks`). Not
  possible per source: settings hooks merge across layers, a flag `hooks` entry cannot remove a user one.
- **Rejected alternative.** `settingSources: ["project"]` + explicit `plugins: [{type:"local", path}]` for the enabled
  plugins works for plugins (they load as `name@inline`) but drops the user's MCP servers, permissions and other
  settings with them, so the flag-layer overrides above are used instead.

## 17. Hunk-level reject

`reject_hunks { path, hunks, expectedEndTree? }` reverts only some hunks of a pending file to the turn-start content
and leaves the rest under review. Accept semantics are unchanged (`accept` takes whatever is left).

- **Hunk ids** are `FileDiff.hunks[].id` of the file's current `select_file` diff (A → B, git's default 3 lines of
  context). Pass `expectedEndTree` = the tree that diff was computed for — the `file_diff` reply's **`endTree`**
  (scope `turn`), not the `gate.turnEndTree` of the latest snapshot, which can already be newer than the diff on
  screen: if B moved since (another reject, a refresh, a turn), the command is refused with `stale_diff` instead of
  reverting different hunks. (A diff is never cached under a B that moved while git computed it.) §34.1: pass
  `expectedBaseTree` = that reply's `baseTree` too — hunk ids of another range (`since`) are refused `stale_diff`.
- **Refusals** (`result{ok:false}`, no `error` event, nothing written): `session_running` while a turn runs or its
  collection is in flight (the same lock as `accept`/`reject`, §3), `reverting`, `no_review`, `stale_diff`,
  `not_a_changed_file:<path>`, `not_pending:<path>` (accepted / changes-requested files), `binary_file`,
  `partial_reject_unsupported:<A|D|R|X>` (added, deleted, renamed or copied files — use the whole-file `reject`),
  `partial_reject_unsupported:symlink` / `:submodule` (mode `120000` / `160000` in A or B, by `git ls-tree`: the splice
  would turn the link / gitlink into a regular file), `partial_reject_unsupported:mode` (mode-only change, same blob),
  `no_hunks`, `unknown_hunk:<id>`, `file_changed_since_review:<path>` (the worktree file no longer hashes — with the
  repository's clean / eol filters, `git hash-object --path` — to the reviewed blob `B:<path>`: the user edited it; the
  edit is never overwritten, `refresh{scope:["review"]}` re-diffs), `diff_mismatch:<detail>` (the diff does not describe
  the A / B contents; safety net). A git failure while writing is `error{scope:"git"}` + `result{ok:false}`.
- **Every hunk selected** = a whole-file `reject` (file reverted to A, dropped from the list, listed as rejected in
  `gate.lastReviewSummary`). Likewise when the kept hunks cancel out and the file's diff becomes empty.
- **Otherwise** the new content is built from the raw bytes: B's lines with each selected hunk's new-side range
  replaced by the hunk's old-side range from A (each side checked against the hunk's lines first). Lines keep their
  own endings, so CRLF files, a missing final newline and non-UTF-8 bytes survive byte for byte. The result is stored
  as a blob and smudged back with `git cat-file --filters --path=<path>` (so `core.autocrlf` / eol attributes give the
  worktree the same line endings a checkout would), written atomically with the file's mode kept (only ever over a regular
  file). A whole-file `reject` restores a symlink as a symlink (also in the direct-blob fallback). Then B is
  re-snapshotted (`gate.turnEndTree` changes → clients re-request diffs), the file's `added` / `deleted` are
  recomputed, and it stays `state: "pending"` with **`partial: true`** and `rejectedHunks` (running count). The file
  state enum is deliberately not extended with `"partial"`: the Swift client decodes `state` as a closed enum, so a
  new value would make the whole snapshot undecodable — `partial` is an additive flag instead.
- `gate.lastReviewSummary` gets `Partially rejected (some hunks reverted on disk, do not redo them unless asked): a, b.`
  (after the Accepted / Rejected parts; persisted as `partiallyRejectedPaths`). `partial` / `rejectedHunks` survive
  `refresh`, a question turn's merge and a restart; a request-changes rebuild starts the file fresh. Notes on the file
  are kept as they are. The review-history round (§14) records `rejectedHunks` on the file.

## 18. Unprompted turns (review-gate bypass guard)

Claude Code can run a turn by itself — e.g. a background subagent finishes after the main turn's `result` and the CLI
continues without a user message. (§52: with background work on — the default since 0.5.9 — such a turn is taken as a review
turn; this guard is what applies when it cannot be, and when background work is off. §52.2: a subagent working in the
background is not guarded — what it changes reaches the next review.) Nothing collects such a turn: its edits would land outside any A → B window and the
next `send`'s snapshot A would absorb them unreviewed. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (§13) avoids the known
trigger; this guard is the defense in depth, and the only protection when the user's environment explicitly sets the
variable to a falsy value (`??=` keeps their value).

- **"Turn active"** = from the engine's `sendUser` (`send`, `request_changes`, plan follow-up) — or a §29 `peer_accept`
  release — until that turn's `result` (or the query loop ending), **minus** any stretch in which the CLI runs a command
  that is not ours (§29: every message we send carries a uuid; `command_lifecycle` `started` of another uuid = an external
  command, and the `result` echoes `user_message_uuid`). Outside it, the session denies every tool call except the read-only tools (`Read`,
  `Glob`, `Grep`, `LS`, `TodoWrite`, …) and a read-only Bash command that the read-only rule auto-allows anyway
  (`autoAllowReadOnlyBash`, §10). Denied: edit tools (`Edit` / `Write` / `MultiEdit` / `NotebookEdit`), any other Bash
  (allow patterns and remembered allows do not apply), `Agent` / `Task`, MCP / web tools — even ones in
  `autoAllowTools` — and `ExitPlanMode`. The PreToolUse hooks deny first (before budget, git guard and permission
  rules, so in every permission mode; nothing is counted in the budget); `canUseTool` repeats the check as a safety
  net. The deny reason tells Claude that no request is running and to stop and wait for the user's next message —
  r2-peers: except a subagent's call (its hook input carries an `agent_id`; canUseTool's `agentID`): "stop and wait"
  ended the subagent's whole run, so it is told the call was not run and to finish without it and report what was left
  undone (`UNPROMPTED_AGENT_REASON`).
- **Notice.** Each denied call is logged (`log{level:"warn"}`); the first one of an episode raises a non-fatal
  `error{fatal:false, scope:"session"}` with the message `Claude가 요청 없이 작업을 시도해 차단했습니다. (…)` — the
  client's existing error banner. The episode ends with the CLI's own `result` or the next send; a later unprompted
  turn raises the banner again. Exception (§29): an unprompted turn that is a peer message the CLI delivered by itself
  raises no banner — its `peer_message{unprompted: true}` card says what happened (the denials are still logged).
  r2-peers: the banner offers [이어서 계속] — the tool-call limit's action (§38.2: "Please continue." to this chat, queued
  while Claude is busy) — so what Claude went on with by itself becomes a reviewed turn with one click (Mac
  `SessionNotices.bannerActions`; test `PeerAutoTests`). Electron: `ErrorBanner` shows it for `unprompted_blocked` too (test
  `unpromptedContinue.test.ts`).
- **The CLI's own `result`** is not a turn end: no `turn_end` event, no collection, `hud.turnCount` / `lastTurnMs` /
  `sessionCostUSD` unchanged (the turn's cost is part of the CLI's cumulative `total_cost_usd`, so it shows up in the
  next turn's `costUsd` delta). Its assistant text is kept as an `assistant_text` transcript row marked
  **`unprompted: true`** (its own row, never merged with a user turn's text), `hud.activity` returns to `idle`, and the
  session id is still adopted.
- **Unprompted text.** Every `text_delta` that arrives while no turn of ours runs carries `unprompted: true`, so clients
  render it as its own assistant message with a muted "요청 없이 실행됨" / "Ran without a request" badge (live and from
  `transcript_restore`). Likewise a session `turn_end` that reaches the engine while
  no turn is running is ignored (logged) instead of counting a turn.
- **Limits.** With `command_lifecycle` frames (CLI 2.1.30x) an unprompted turn is known while it runs:
  `session.externalTurn` is set and `send` is refused `gate_closed:external_turn` (the client keeps the message in its
  queue), so the old race is gone — a send that still slips in (sent the instant the external command started) does not
  lift the guard for that command (its edits are denied) and its `result` does not close the user's turn (§29); only its
  text / tool rows still show inside the user's turn. A turn the CLI starts without
  a lifecycle frame (a background task's continuation; an older CLI) is only recognized by its `result`, as before: a
  send queued while it runs makes it "active" (its later edits happen after snapshot A, so they are collected), and its
  `result` closes the user's turn early; the rest of the user's turn is then guarded like an unprompted one (§52.2: not
  with lifecycle frames — the turn waits for the queued message's own command). Tool calls
  the CLI starts on its own still appear in the transcript (`tool_use` / a denied `tool_result`).

## 19. Release-review hardening

All additions are optional fields / new values; older clients keep working.

### 19.1 Whole-file reject keeps the user's own edits

`reject` / `reject_all` (and a `reject_hunks` that selects every hunk) first check **every** file of the batch, before
anything is written: the worktree entry (and a rename's old path) must still be the reviewed post-turn content B
(regular files hashed through the clean filters — `git hash-object --path`, the same check `reject_hunks` uses — a
symlink by its target, a submodule is not compared) or already the turn-start content A the revert would restore.
Otherwise the file counts as edited by the user since the review: changed content, a modified/added file the user
deleted (M: deleted on disk), a file the user (re)created where B has none (a deleted file re-created, a rename's old
path re-used).

- Refused with `result{ok:false, error:"file_changed_since_review:<p1>, <p2>", code:"file_changed_since_review",
  paths:[<p1>, <p2>]}` (no `error` event, **nothing reverted** — also for the files that were not edited). `paths` lists
  every such file in batch order.
- Re-sending the same command with **`force: true`** reverts them anyway (the client confirms first: "직접 수정한 내용이
  사라집니다").

### 19.2 Commit holds only the accepted paths

`commit` used to run a plain `git commit` after `git add -A -- <paths>`, so entries the user had staged for other files
rode along. It now runs `git commit --only -- <paths>` (renames: both paths; deletions: the removed path), which commits
just those paths on top of HEAD and leaves the rest of the user's index as it was. No wire change.
M28 (clients): the commit sheet lists the pending files after the accepted ones; a ticked pending file is accepted first
(`accept {paths}`, awaited) and then committed with the rest — "검토 완료로 표시하고 커밋", one action instead of accept → sheet →
commit. With no accepted file every pending one is ticked. "Push after commit" is kept per project (the global default until
the user chose). Still accepted paths only on the wire: `commit` refuses anything else `nothing_to_commit`.

### 19.3 Allow patterns and remembered allows cover whole simple commands only

`bashAllowPatterns` and `permission_response{remember:true}` keys used to compare a prefix of the raw line, so
`npm test && rm -rf x` rode on `Bash(npm test:*)` / `Bash:npm test`. Now the command is tokenized (quotes honoured, the
same scanner as the read-only classifier) and:

- A line with a redirection into a file (`>`, `<`, `2> err.txt`), `$(…)`, backticks, a subshell / brace group, a background
  `&`, `|&` or an unterminated quote **never** matches a pattern nor a remembered key (it gets a `permission_request`).
- A chain / pipeline (`;`, `&&`, `||`, `|`, newline) matches only when **every** simple command matches on its own
  (`npm test -- a && npm test -- b` ✓; `git status | sh` ✗ for `Bash(git *)`) — since 2026-11 (r2 M21) any pattern of the
  list, each command its own (`npm run lint && npm test` with `Bash(npm run lint:*)` and `Bash(npm test:*)` ✓), as the
  terminal checks each command of a chain against all of its rules. A remembered Bash key covers a segment when the
  segment's key (below) is remembered (`Bash:npm test` covers `npm test --watch`).
- A quoted command name holding whitespace (`"npm test" x`) never matches. A line that does not tokenize keys its raw
  words (`echo hi > x.txt` → `Bash:echo hi`), and that redirected line itself is never auto-allowed by the key.

**Keys and patterns fit the commands Claude runs (2026-11, r2 M21).** "세션 동안 허용" on `cd /work/acme && ./mvnw -q test 2>&1
| tail -30` used to store `Bash:cd /work/acme`, which never matched again, and no pattern ever matched a line with `2>&1` or
`| tail`. Patterns and keys now see the line as `allowSegments(command, context?)` (`engine/src/session/bashClass.ts`) gives
it — what decides nothing the user allowed is left out:

- a redirection that writes no file (`2>&1`, `>/dev/null`, `2>/dev/null`, `&>/dev/null` — the classifier's list above);
- the leading `cd <dir>` / `pushd <dir>` segments into the repository, followed by `&&`, `;` or a newline — only with the
  context (the read-only rules: an existing folder in the root or one of the repository's worktrees, not inside a nested
  repository; a `cd` elsewhere stays a segment that must match on its own);
- the read-only filters a pipeline ends with (`| tail -30`, `| grep FAIL | head`: `tail head grep egrep fgrep sort wc uniq`
  whose own arguments are read-only — `sort -o x` is not; never the first command).

A **key** is per simple command: `Bash:<program> <verb>` (`segmentKey`) — the program as written and its first word that is no
option; an option that takes a value skips it for the programs that have one (`git -C dir`, `-c`, `--git-dir`, `--work-tree`;
`mvn` / `mvnw` `-pl`, `-P`, `-f`, `-s`, `-T`, `-rf`, `-D`, …; `gradle` / `gradlew` `-p`, `-b`, `-x`, `-P`, `-D`, …; `npm --prefix`
/ `-w`, `pnpm -C` / `-F`, `yarn --cwd`, `make -C` / `-f` / `-j`, `docker`, `kubectl -n` / `--context`, `go -C`, `cargo -Z`,
`uv` / `poetry --directory`, `just -f`); an empty word, a bare number and a `+toolchain` are skipped; after `--` the next word;
no such word: `Bash:<program>`. So `git -C x status` → `Bash:git status` (it covered any `git -C …` before), `./mvnw -q -pl api
test` → `Bash:./mvnw test`, `npm run lint` → `Bash:npm run`, `rm -rf build` → `Bash:rm build` (`rm -rf src` asks again),
`pytest -x` → `Bash:pytest`. Release-2 review: a command carrying an option that changes what runs keys as **all its
words** (`hasRiskyOption`), so the plain key never covers it and remembering it covers only that very command — git's
global `-c`, `--config-env`, `--exec-path`, `--git-dir`, `--work-tree`, `--super-prefix` and `--upload-pack` /
`--receive-pack` / `--exec` after the verb; `npm --script-shell`, `--node-options`, `--userconfig`, `--globalconfig`,
`--registry`; `npx -p` / `--package` / `-c`; `make -E` / `--eval` and `SHELL=` / `MAKEFLAGS=` / `MAKEFILES=` / `.SHELLFLAGS=`;
`docker -H` / `--host` / `--context` / `-c`; `kubectl --kubeconfig` / `--context` / `--cluster` / `-s` / `--server` / `--user`
/ `--token` / `--as`; `cargo --config` / `-Z`; `go -exec` / `-toolexec` / `-overlay`; `uv --config-file` / `--index-url` —
and an option naming a folder or file outside the repository (or one only the run decides: `$`, `~`, a glob): `git -C`,
`npm --prefix` / `-w` / `-C`, `pnpm -C`, `yarn --cwd`, `make -f` / `-I` / `-C` (also `-f/tmp/x.mk`), `mvn -f` / `-s` / `-gs`
/ `-t`, `gradle -p` / `-b` / `-c` / `-I` / `-g` / `--include-build`, `docker-compose -f`, `cargo -C` / `--manifest-path`,
`go -C`, `uv` / `poetry --directory` / `--project`, `just -f` / `-d` (inside it — `git -C api`, `npm -w api`, `./mvnw -f
api/pom.xml` — the repository's own files run under any key anyway; git's into a nested repository counts as outside).
Every other program's options count anywhere before `--`. Before, `Bash:git push` (remembered once, and kept across
restarts by §33.7) covered `git -c core.sshCommand='…' push` and `git --exec-path=/tmp/x push`, `Bash:npm test` covered
`npm --prefix /tmp/evil test` and `Bash:make test` covered `make -f /tmp/evil.mk test`.
`permission_response {remember: true}` stores the key of **every** simple command of the line
(`npm run lint && npm test` → `Bash:npm run`, `Bash:npm test`). Keys of the old form (the first two words) that are no valid
key now (`Bash:git -C`, `Bash:cd x`) answer nothing any more. Who judges with the context: the Bash hook and `canUseTool` (as
for the read-only check), and the engine for the queue it answers after a new pattern / remembered key (§33.1) and for the
keys it stores — the project's folder, no other worktree.

**Read-only commands, wider (2026-11; the list of §10).** The terminal ran `grep -rn X src 2>/dev/null | head`,
`find . | xargs grep -l X`, `git config --get user.email`, `test -f x`, `gh pr view 42` or `cd ../acme-42 && git log` without
asking; ReviewGate put each of them on a card — and on every guard that lets reads through (the §33.4 scope cards, plan
mode §19.4, side questions §21, the unprompted-turn guard §18). `isReadOnlyCommand(command, context?)`
(`engine/src/session/bashClass.ts`) now also accepts:

- A redirection that writes no file: `2>&1`, `1>&2`, `>&2`, `>/dev/null`, `2>/dev/null`, `&>/dev/null` (and the `>>` forms).
  Any other `>` / `<` still makes the line not read-only. Allow patterns and remembered keys still never cover a redirected
  line (above): only the classifier drops these.
- `test` / `[ … ]` — never with `-v` / `-R`, where bash evaluates an array subscript (`a[$(cmd)]`) — `true`, `false`.
- git reads: `grep` (not `-O` / `--open-files-in-pager`, which runs a program), `ls-tree`, `merge-base`, `rev-list`,
  `show-ref`, `for-each-ref`, `cat-file -p|-t|-s|-e` (no `--batch*`, `--textconv`, `--filters`), `stash list|show`,
  `worktree list`, and the `config` read forms: `--get`, `--get-all`, `--get-regexp`, `--list` / `-l`, `get <key>`, `list`,
  or exactly one positional key — never with `--add`, `--unset*`, `--replace-all`, `--edit` / `-e`, `--rename-section`,
  `--remove-section` (or a prefix git would take for one), the subcommands `set` / `unset` / `edit` / `rename-section` /
  `remove-section`, or a short option other than `-l`, `-z`, `-f <file>`, `-t <type>`.
- `gh pr view|list|diff|checks|status`, `gh issue view|list`, `gh repo view`, `gh run view|list`, and `gh api <path>` as a
  GET: no `-X` / `--method` other than `GET`, none of `-f` / `-F` / `--field` / `--raw-field` / `--input` (they make it a POST).
- `xargs [-0] [-r] [-n N] [-I R] [-P N] [-L N] <command> …` when `<command>` is one of the commands whose every option is
  harmless (the glob-safe list of §10: what `xargs` reads becomes its arguments, so a planted file named `--pre=x` stays a
  file name) and read-only with its own arguments; no command is `echo`. `xargs rm`, `xargs sed -n p`, `xargs git log` are not.
  A lone `{}` word (`xargs -I {} cat {}`) is literal to the shell and accepted.
- **Where it runs (the context).** `{cwd, root, sameRepoDirs}`: the shell's directory, the checkpoint root and the
  repository's other worktrees (they share its git config). A `cd <dir>` / `cd -P|-L <dir>` / `pushd <dir>` is neutral
  when `<dir>` (no `$`, glob or backtick; an unquoted `~` / `~/…` is the home folder) is an existing folder inside the root
  or one of those worktrees and not inside a nested repository of its own (a clone, a submodule): it moves where the
  following segments may run — a `cd` that fails, or runs in a pipeline's subshell, leaves the shell where it was, so a
  later relative path must be safe from every place the shell may be. `git -C <dir>` may name such a folder the same way.
  Any other `cd` — elsewhere, bare `cd`, `cd -`, `cd ~user`, `pushd +N`, a folder that is not there (CDPATH would decide where
  the shell goes) — makes the line not read-only: a foreign repository's config can run an fsmonitor or a pager on
  `git status`. Without a context neither `cd` nor `git -C` is read-only, as before.
- **Who judges with the context.** The Bash hook (the hook input's `cwd`, the checkpoint root, `git worktree list` minus
  the root, cached per turn), `canUseTool` (the session's folder), the plan-mode and unprompted-turn guards (§19.4, §18), the
  settings-file check (§33.9) and side questions (§21: the project folder, no other worktrees). So `cd ../acme-42 && git log`
  or `git -C ../acme-42 status` runs without the §33.4 card (a read-only command never got it), in plan mode and in a side
  question. The queue the engine answers after a remembered allow (§33.1) still judges without it.

### 19.4 Plan mode does not edit

Before, an in-repo `Edit`/`Write` in plan mode was auto-allowed like in `default` (the hook and `canUseTool` allow edit tools
inside the root), so a plan turn could implement. Now, while the session's mode is `plan`, the PreToolUse hooks deny — before
the budget (nothing counted), allow patterns, remembered allows and `autoAllowTools`; `canUseTool` repeats it — :

- `Edit` / `Write` / `MultiEdit` / `NotebookEdit` anywhere except the CLI's plan file under `<home>/.claude/plans/` (still
  allowed and kept out of the review, §11), reason `ReviewGate: plan mode — files may not be edited yet. Investigate with
  read-only tools, then propose the change with ExitPlanMode; …`;
- Bash when the command clearly writes (M19, 2026-11; `shellWrites.clearlyWrites`): a redirection into a file (not
  `/dev/null` or another device), `sed -i` / `perl -i`, `tee`, `rm` / `mv` / `cp` / `ln` / `install` / `rsync` / `touch` /
  `mkdir` / `chmod` / `chown` / `truncate` / `dd of=` / `find -delete` (also what `xargs` / `find -exec` hand them),
  `patch`, a package manager installing, removing or publishing (`npm install`, `yarn`, `pip install`, `brew install`, …),
  a git command that changes the repository or a remote (`commit`, `add`, `checkout`, `switch`, `reset`, `restore`,
  `stash`, `merge`, `rebase`, `pull`, `push`, `apply`, `worktree add`, …) and `gh pr checkout` / `merge` — also in a script
  a shell runs (`bash -c`). A file in a temporary folder outside any repository does not count (`mvn dependency:tree >
  /tmp/tree.txt`). Reason `ReviewGate: plan mode — this command changes files, packages or the repository, and nothing may
  change yet. …`. Every other command goes the usual way: a read-only one (§10, §19.3) runs per `autoAllowReadOnlyBash`;
  anything else (`./mvnw -q dependency:tree`, `awk …`, `npm test`, `curl …`) gets the card in plan mode from the default
  mode and is the CLI's call (its classifier) in plan mode from auto (§44.1). Before, every command that was not
  read-only was denied — also in plan mode Claude entered by itself from auto mode, where CLI 2.1.318 (no Grep / Glob tool)
  plans with Bash; a build tool may now write its outputs there (usually ignored), and a source file a command changes is
  still caught by the post-Bash snapshot and reviewed.

Other tools are unaffected. The rule follows the live mode (`set_permission_mode`, plan approval). No wire change.

### 19.5 `plan_response` is atomic

Everything the follow-up `send` checks (`canSend`) is validated before the mode switches; a blank `message` falls back to the
default text. When the follow-up still does not reach Claude (snapshot A or the session refused it), the engine puts
everything back: `state.session.pendingPlan` is the same plan again, `state.session.permissionMode` (and the CLI's mode) is
the previous one, the plan's dedupe keys are restored. It emits `error{fatal:false, scope:"session",
code:"plan_followup_failed", message:"The plan answer could not be sent to Claude (…); the plan is still pending."}` and
answers `result{ok:false, error:"plan_followup_failed:<reason>", code:"plan_followup_failed"}`. A `plan_approved` event
may already have gone out for it — clients re-show the card from `pendingPlan`. Answering again retries.

### 19.6 Error and refusal codes

Every `result{ok:false}` from the engine carries **`code`** (the stable id; `error` stays the English / legacy text clients
used to parse — unchanged), and `error` events carry **`code`** wherever the engine knows one. Clients localize on `code`
and fall back to `message` / `error`. All fields are optional on the wire (older engines omit them); `scope` keeps its four
values.

**Claude CLI / API failures** (`error{scope:"session"}`; the session classifies the SDK's assistant `error` value, an
`is_error` result's text / `api_error_status`, `error_during_execution` `errors[]`, `rate_limit_event`, `auth_status`, and on
a crash the exception text and the CLI's stderr):

| code | fatal | when | extra fields |
| --- | --- | --- | --- |
| `auth_required` | false (true when the CLI died of it) | not logged in / login expired: `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error`, "Invalid API key · Please run /login", HTTP 401/403, `auth_status.error` | `status?` |
| `usage_limit` | false | subscription / credit limit: `rate_limit_event{status:"rejected"}`, `billing_error`, "usage limit reached", "hit your limit", "credit balance is too low" | `resetAt?` (ISO-8601, from `resetsAt`) |
| `rate_limited` | false | API rate limit: `rate_limit`, HTTP 429 | `status?` |
| `api_error` | false | other API failure ending the turn: `overloaded`, `server_error`, `invalid_request`, `model_not_found`, 5xx, an `is_error` result nothing else matched | `status?` |
| `api_retrying` | false | `system/api_retry`: the CLI retries by itself (one event per attempt; does **not** set `state.lastError`) | `attempt`, `maxRetries`, `retryDelayMs`, `status` (null = no HTTP response) |
| `cli_start_slow` | false | the CLI has not finished initializing ~8 s after the session start (`SessionSettings.startSlowHintMs`); a hint about VPN / proxy / plugin marketplace / MCP start-up, the session keeps waiting (`init_timeout`, §16, is what restarts); not `state.lastError` | — |
| `session_start_failed` | true | the CLI died **before it answered initialize** and nothing above matched (§30): never restarted automatically | `detail`, `exitCode`, `signal` |
| `session_crashed` | true | the query loop threw after initialize and nothing above matched | `detail`, `exitCode`, `signal` |
| `resume_not_found` / `resume_failed` | false | §30 notice: the CLI has no record of the chat's conversation / could not load it; a new chat was started (emitted in it, after its `transcript_restore`); not `state.lastError` | `sessionId` (the chat that could not be continued), `detail` |

`detail` (§30) is the CLI's first stderr line (home folder as `~` — the folder itself, §35.14 —, API keys / bearer tokens / `…TOKEN=` values / long opaque runs
masked, ≤ 300 chars) and rides on every fatal session error the CLI died of (also the API codes above when fatal), with
`exitCode` / `signal` of the CLI process; for the same failure it is the same text, so clients merge repeats on `code` +
`detail`. `session_id_in_use` (the CLI refusing `--session-id` of a conversation it already has) never reaches clients:
the engine resumes instead (§30).

Each of `auth_required` / `usage_limit` / `rate_limited` / `api_error` is reported at most once per turn (a new
`rate_limit_event` rejection window is reported again). `message` is an English sentence plus the CLI's own first line in
parentheses. The turn itself still ends as usual (`turn_end`, collection).

**Other engine `error` codes:** `cli_not_found` (fatal, scope engine), `cli_not_executable` (fatal, scope engine; Windows: `claude`
resolves to a `.cmd` / `.bat` shim with no `claude.exe` / `cli.js` behind it, which cannot be spawned without a shell), `session_start_failed` (fatal; or one of the API codes
above when the start error text matches), `send_failed` (the session refused a send, request-changes or the
init-timeout resend; a `send` whose snapshot A fails is refused instead, §35.1), `plan_followup_failed` (§19.5), `extensions_init_timeout` (§16 fallback), `unprompted_blocked` (§18),
`project_open_failed`, `git_init_failed`, `collect_failed`, `refresh_failed`, `revert_failed` (reject / reject_hunks git
failure), `branch_failed`, `workbench_failed`, `commit_failed`, `command_failed` (any other unexpected failure of a command),
`side_failed` (+ `threadId`, §21), `mcp_auth_required` / `mcp_failed` (+ `server`, §22), `peer_release_failed` (non-fatal, §29:
the CLI did not let the held messages through; they are still held), `lfs_missing` (§32: instead of
`send_failed` / `collect_failed` when the snapshot failed because the repository's LFS filter cannot run — git-lfs missing),
`worktree_blocked` / `worktree_outside_review` (+ `toolName`, `path?`, `branch?`; §33.4), `cli_version_changed` (non-fatal
notice + `cli {from, to, verified}`; §36.8), `git_stashed` (non-fatal notice, a gray row; `detail`: the files a `git stash`
of Claude's took out of the working tree; §46), `claude_committed` / `claude_moved_head` (non-fatal notices, gray rows;
`detail`: the short shas / "from → to"; a HEAD move Claude's own git commands made, §31.3), `reject_committed` (non-fatal
notice; `detail`: "path (sha)" of rejected files a commit of Claude's still holds; §46), `reject_scheduled` / `reject_applied`
(non-fatal notices, gray rows; `detail`: the files — up to 10, then "(+N)" — a reject during a turn waits for / reverted after
its collection; M32, §34.2), `reject_changed_again` (non-fatal notice, a gray row with [되돌리기]; `detail`: the one file the
turn changed again after the user rejected it, so it was not reverted; M32, §34.2).

**Refusal codes** (`result{ok:false, code}`; the leading word of `error`, or the listed explicit code where `error` is
English): `binary_file`, `branch_in_use`, `cannot_remove_current`, `cannot_remove_main`, `collect_failed`, `commit_failed`,
`detached_head`, `diff_mismatch`, `empty_base` ("empty base"), `empty_message` ("empty message" / `empty_message`),
`empty_note` ("empty note"), `empty_title`, `engine_disposed` ("engine disposed"), `file_changed_since_review` (+ `paths`,
§19.1), `gate_closed`, `git_identity_missing`, `git_init_not_needed`, `history_trees_gone`, `invalid_branch_name`,
`invalid_mode`, `locked_by_other_session`, `no_hunks`, `no_plan`, `no_project`, `no_remote`, `no_review`, `no_session`,
`not_a_changed_file`, `not_in_history_entry`, `not_pending`, `notes_pending`, `nothing_to_commit`, `nothing_to_push`,
`nothing_to_retry`, `partial_reject_unsupported`, `path_exists`, `plan_followup_failed`, `push_failed`,
`request_changes_unavailable`, `refresh_failed`, `revert_failed`, `branch_failed`, `workbench_failed`, `reverting`,
`review_pending`, `session_busy`, `session_current`, `session_running`, `stale_diff`, `starting`, `switch_blocked`,
`unknown_command` ("unknown command: …"), `unknown_history_entry`, `unknown_hunk`, `unknown_pr_file` ("Unknown PR file: …"),
`unknown_worktree`, `unsupported_remote`, `worktree_dirty`, `worktree_locked`; §21: `empty_question`, `question_too_long`,
`unknown_side_thread`, `side_busy`, `side_limit`, `side_no_answer`, `side_no_anchor`, `side_draft_failed`, `invalid_promote`,
`send_failed`, `cli_not_found`, `cli_not_executable`; §22: `invalid_mcp_name`, `invalid_mcp_scope`, `invalid_mcp_config`,
`unknown_mcp_server`, `mcp_unsupported`, `mcp_failed`, `mcp_cli_failed`, `terminal_failed`; §23–27: `invalid_mention`, `too_many_mentions`,
`list_files_failed`, `too_many_attachments`, `attachment_type`, `attachment_too_large`, `attachment_invalid`, `unknown_attachment`,
`invalid_model`, `invalid_effort`, `set_model_failed`, `invalid_rewind_mode`, `unknown_turn`, `rewind_unavailable`, `focus_too_long`
(plus `session_busy`, `collect_failed`, `file_changed_since_review` + `paths`, `revert_failed`, `send_failed` reused by `rewind`);
§35.1: `send_failed` / `lfs_missing` (`send`, `compact`: snapshot A failed, nothing was sent); §29: `peer_none`,
`peer_inbox_changed`, `peer_unsupported`, `peer_release_failed`, `peer_dismiss_failed`, `invalid_peer_mode`, and the reason
`external_turn` of `gate_closed` (`send`, `peer_accept`, `plan_response`, …); §31–32:
`not_captured` (+ `paths`: `reject` of a file whose content a snapshot did not capture — a mods stub or a
skipped file; `reject_all` only when nothing else is revertible, it skips them otherwise, §35.2; `reject_hunks` says
`partial_reject_unsupported:uncaptured`), and `session_running` / `reverting` /
`collect_failed` reused by `finish_review`; §33: `unknown_permission_request` (plus `no_project` for `permission_rules`);
§36: `unknown_agent`, `no_report`, `not_running`, `not_supported`, `extensions_on`, `unknown_session`,
`cli_session_running`, `commit_draft_failed`, `fetch_failed`, `prereview_running`, `invalid_prereview`,
`unknown_prereview`, `unknown_finding`, `invalid_pr_number` (reused there: `no_project`, `no_session`, `session_busy`, `side_limit`,
`cli_not_found`, `cli_not_executable`, `nothing_to_commit`, `invalid_branch_name`, `branch_in_use`, `no_review`,
`not_a_changed_file`, `invalid_mcp_scope`); `command_failed` for a non-refusal failure
(its text is the underlying error). A refusal whose text has no code word and no explicit code reports `refused`.

## 20. Paths (all platforms; engine/src/platform/paths.ts)

- **Repo-relative paths** on the wire (`changedFiles[].path`, `reviewNotes[].path`, `hud.agents[].files` inside the
  repository, every `path` a command takes for a changed file) are always POSIX-style (`src/a.ts`), on Windows too.
- **Absolute paths** on the wire (`project.path` / `root`, `workbenches.list[].path` / `current` / `managedRoot`,
  `lockConflict.path`, `gitInit.path`, `changedOutside`, `toolFiles`, plan files, absolute `hud.agents[].files` outside the
  repository) are the host's **native** form: `/Users/x/repo` on macOS / Linux, `C:\Users\x\repo` on Windows (drive
  letter uppercased, as Node's `path.resolve` gives it). Git prints `C:/Users/x/repo` (and could print MSYS `/c/Users/x`);
  the engine converts every path it takes from git (`--show-toplevel`, `--git-dir`, `--git-common-dir`,
  `worktree list`, a `.git` file's `gitdir:`) with `toNativeAbs`. Clients must not assume `/` in an absolute path and,
  on Windows, compare absolute paths case-insensitively with both separators.
- **Comparisons** inside the engine never use string prefixes. `realpathLenient` resolves symlinks (on Windows also 8.3
  short names and the on-disk case, via `realpathSync.native`; on macOS the on-disk case too, §35.10) of the nearest existing ancestor; `isInside` /
  `toRepoRelative` / `compareKey` then compare component by component — case-insensitively on Windows, `\\?\`,
  `\\.\` and `\??\` prefixes mapped to the plain drive form, trailing dots and spaces dropped (`.git.` is `.git`).
- **Paths in a Bash command** (a `cd` / `pushd` target, `git -C`, a `git worktree add` path, an absolute pathspec of a
  `git checkout` / `restore`, a settings file or a nested repository's file a command names — §19.3, §32, §33.4, §33.9,
  §46) are read as the shell reads them and resolved against the shell's folder with `resolveShellPath`; the §46 probe
  hands git an absolute pathspec in that native form, as Git Bash hands git `/c/…` as `C:/…`. On Windows the Bash tool runs Git Bash: an unquoted backslash escapes the next character
  (`cd C:\Users\me` goes to `C:Usersme`; quoted, `"C:\Users\me"` keeps it), `C:\…` and `C:/…` are absolute, and the
  MSYS form `/c/…` (`/cygdrive/c/…`, what Git Bash's `pwd` prints) is drive `C:` — `C:\…`, not `C:\c\…`. `/tmp` is Git
  Bash's mount of the Windows temp folder (`%TEMP%`, `os.tmpdir()`): `/tmp/x` → `C:\Users\me\AppData\Local\Temp\x`, so
  `mvn dependency:tree > /tmp/tree.txt` writes into a temporary folder there too (§19.4, §33.3; before, it was
  `C:\tmp\tree.txt`, and plan mode denied it). Other rooted paths (`/usr`, `/etc`) are the Git installation's, which the
  engine does not read; they resolve on the shell folder's drive (`/usr/x` → `C:\usr\x`). For §46 (a `cd` / `pushd` / `git -C` folder, a `checkout` / `restore` target) the home
  folder goes in first, as the shell puts it there: `~`, `~/…`, `~<your user name>/…`, `$HOME` and `${HOME}` (`homedir()`:
  `$HOME`, on Windows `%USERPROFILE%`); another user's `~bob/…`, `~+` / `~-` and any other variable are what only the run
  knows — as a target, the whole working tree.
- **Programs in a Bash command** (`programName`): a command word names its program by its last component — after `/` or
  `\`, as Git Bash reads a quoted `"C:\Program Files\Git\cmd\git.exe"` — in any case and without `.exe`, on every host:
  Git Bash runs `git.exe` for `git`, and the macOS and Windows file systems find `GIT`. So `git.exe`, `GIT.EXE`,
  `/c/Program Files/Git/cmd/git.exe` and `"C:\…\git.exe"` are git, and `gh.exe` is gh, for §46 — the card, the HEAD
  and stash reads around a call, and which commands' file changes are git's (`GIT_MUTATING_RE`, the same names in its
  pattern) — and the scanner it shares with §40.1 also knows its shells and wrappers that way
  (`bash.exe -c …`, `env.exe`, `xargs.exe`, `find.exe -exec`). Before, on Windows `git.exe reset --hard` was no git
  command and got no card. The read-only judgement (§10, §19.3) knows git and gh by their name too (`git.exe status`
  reads), every other read-only command as written; so do the §33.4 / §39.4 scope cards (`git.exe worktree add`,
  `git.exe -C <dir>`) and the test-run detection (§37.7: `git.exe log --grep=jest` runs no test, `pytest.exe` is pytest).
  A spelling a host does not find (`GIT` on Linux) only fails to run.
- **Unsafe on Windows** (never "inside" the project, so an edit there gets the outside-the-project `ask`, never an
  auto-allow, a plan-file allow or a repo-relative attribution): an alternate data stream (`a.txt:s`,
  `dir::$INDEX_ALLOCATION` — invisible to git, so it would bypass the review), a reserved device name (`NUL`, `CON`,
  `COM1.txt`, `LPT1`, …), a device namespace (`\\.\pipe\…`, `\\?\Volume{…}\…`, `\\.\GLOBALROOT\…`) and a
  drive-relative or rooted-without-drive path. The git-dir deny list still matches such a path (`gd::$INDEX_ALLOCATION\hooks\x`
  is inside the git dir `gd`) and never reads it as an editable hook (§4, M23: a git-dir name it cannot read past — `.git.`,
  `GIT~1`, a stream — is git's own data).
- **App data** (§36.8): the engine's app-wide records live in `REVIEWGATE_DATA_DIR` when set (the engine's environment),
  else `~/.reviewgate/` — the folder of the managed workbenches (§6), shared by every engine (window) and both clients:
  `cli-versions.json`. Per-repository records stay in the git dir (`<gitdir>/reviewgate/…`, and the repository-wide
  `<git common dir>/reviewgate/capabilities.json` / `extensions-start.json` of §36.5 / §36.7).

## 21. Side questions ("곁질문")

The user asks about a change in a **side thread** without affecting the main conversation, then optionally sends a
conclusion to it. Additive: six commands, eight events, two optional settings, `hud.sideCostUSD`, `error.threadId`.
Engine: `engine/src/side/` (`sideQuery.ts` one CLI process per question, `threads.ts` threads + persistence,
`context.ts` the anchor prompt); tests `engine/test/engine.side.test.ts`; real CLI `sidecar/test/driver-m22.mjs`.

```ts
type SideAnchor = { path?: string; hunkId?: number; line?: number; side?: "old" | "new"; toolUseId?: string;
                    entryId?: string /* a review_history entry (§14) instead of the current review */ };
type SideThread = {
  id: string; mainSessionId: string | null;      // the chat (SessionMeta.id) it belongs to
  anchor: SideAnchor | null; createdAt: string; updatedAt: string;
  title: string;                                 // first line of the first question, ≤ 60 chars
  messages: { role: "user" | "assistant"; text: string; at: string;
              toolCalls?: { id: string; name: string; input: object; isError?: boolean; preview?: string; denied?: true }[];
              costUSD?: number; durationMs?: number; stopReason?: string }[];   // user text = the question as typed (no context prefix)
  status: "idle" | "running" | "error"; error: string | null;
  sessionId: string | null;                      // the side Claude session; null until the CLI started one
  fork: { mode: "fork_at" | "fork_full" | "fresh"; fromSessionId: string | null; at: string | null } | null;
  costUSD: number;                               // every question + promote drafts
  promotions?: { as: "message" | "note"; at: string }[];
};
```

- **`side_ask {threadId?, anchor?, question}`** (own lane: never waits behind — or holds up — the main conversation)
  creates a thread (no `threadId`) or continues one, replies `side_thread` (`status: "running"`) as soon as the question
  started; the answer streams as `side_text_delta` / `side_tool_use` / `side_tool_result`, then `side_turn_end
  {threadId, costUSD, durationMs, stopReason}` and a final `side_thread`. Works while the main turn is idle **or
  running**, during a review and with a permission card open — it is a separate CLI process. Refusals: `no_project`,
  `empty_question`, `question_too_long` (> 20 000 chars), `unknown_side_thread:<id>`, `side_busy` (that thread is
  answering), `side_limit` (3 questions running at once), `cli_not_found` / `cli_not_executable`, and (2026-11, r2 M18)
  `side_command:<name>` — the question starts with a slash command the session lists (`capabilities` commands, skills or
  an alias; never "any /word" while no list is known: `/tmp 지워도 돼?` is a question): a skill runs in the main
  conversation only, so the clients offer [메인 대화로 보내기], which sends the text as typed (no side prefix) as a main `send`
  — put in the composer queue while a turn runs. A failure of the CLI is
  `error{fatal:false, scope:"session", code:"side_failed", threadId}` and `thread.status = "error"` (`thread.error`); the
  thread stays usable.
- **Fork point (first question).** The side session is a fork of the main Claude session: `resume: <main session id>,
  forkSession: true, sessionId: <new uuid>`. While the main turn **runs**, `resumeSessionAt` = the chain uuid of the last
  top-level assistant message of the last **completed** turn (`ClaudeSession` reports it with `turn_end`), so the side
  model sees everything up to the last finished turn and none of the half-done one (`fork.mode: "fork_at"`). When the main
  session is **idle** its latest point is a completed turn: the whole session is forked (`fork_full`). When that uuid is
  unknown (the engine restarted mid-chat) a running main turn forks `fork_full` (its partial turn may be included); when
  a fork at the uuid fails before any output the engine retries once with `fork_full`. A chat that never completed a turn
  starts the side session `fresh` (no history; the anchor context still says what changed). The main session's own CLI
  transcript is never written (a fork copies into a new session file), the engine transcript, `hud.turnCount`,
  `hud.sessionCostUSD` and `SessionMeta` are untouched.
- **Anchor context.** The first question is prefixed (`buildSidePrompt`) with `[Side question (곁질문) — read-only …]`, the
  anchored file (`path`, status, +/−, review state), `line`/`side`, the hunk (`hunkId`, else the hunk containing `line`,
  else the whole diff ≤ 160 lines; ≤ 200 lines per hunk) of the current `select_file` diff — or, with `entryId`, of the
  history entry's proposal and its round prompt — and up to 3 tool calls that produced it (`toolUseId`, else the file's
  `toolUseIds`): name, Bash command or a compact input preview, and the §12 `rationale`; calls from before an engine
  restart are read back from the transcript. Follow-ups send the question alone (the side session already has it).
- **Read-only.** Side sessions run with their own PreToolUse hook + `canUseTool` (deny wins in every mode, never a
  permission card): allowed `Read Glob Grep LS NotebookRead TodoRead TodoWrite ToolSearch ListMcpResourcesTool
  ReadMcpResourceTool ReadMcpResourceDirTool`, `WebFetch` / `WebSearch` (§40.3: `settings.sideWeb`), Bash only when
  `isReadOnlyCommand` (§10, §19.3 — with the project folder as context: `cd sub && git log`, `gh pr view 42`,
  `git log 2>/dev/null`) holds and it is not backgrounded, and (2026-11, r2 M18) **the MCP tools that only read** — release-2
  review: those whose server says so (`readOnly: true` and not `destructive` in the main session's `mcpServerStatus()`
  annotations), or a tool that reads by its name (`isReadMcpTool`, §33.5) **and** that the user allows without a card (their
  Claude Code allow rule, §33.5, or the app's "always allow" pattern, §33.6). A read verb in the name alone no longer
  lets a tool run here: `query`, `fetch`, `check`, `validate` are read verbs, and a SQL server's `mcp__db__query
  {"sql":"DELETE FROM orders"}` ran in a question promised read-only (the main session gives such a tool a card) — and
  **agents that only read**
  (`Agent` / `Task` with `subagent_type: "Explore"`, no `isolation`; each of its own calls goes through this same hook and
  `canUseTool`, so it stays read-only). Everything else — `Edit Write MultiEdit NotebookEdit`, mutating Bash, other agents,
  MCP tools that write, `ExitPlanMode`, `KillShell` — is denied with *"ReviewGate: this is a side question (곁질문) — a
  read-only Q&A next to the main conversation. … propose any change in text …"* (the `side_tool_result` carries `denied:
  true`). **`Skill`** is denied too (r2 M18; it was allowed: a skill typed there loaded but could not run, and its
  `!`command`` lines would run without a hook) with *"ReviewGate: this is a side question (곁질문) — skills and slash commands
  run in the main conversation, never here. …"* — it starts like the read-only reason, so the call is `denied`; the clients
  offer [메인 대화로 보내기] (the thread's question as typed, as for `side_command`) on an answer with a denied `Skill` call.
  Also: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (as §13), **the user's MCP servers** (r2 M18; before, `strictMcpConfig` +
  `mcpServers: {}` started none): the CLI loads them from the same `settingSources` as the main session, the session-added
  ones (`mcp_add {scope:"session"}`, §22) are passed as `mcpServers`, and the ones the user turned off (`mcp_toggle`, §42.3)
  stay off through the flag setting `deniedMcpServers` (a side question may start slower while they connect); the flag
  settings `disableAllHooks: true` (user / plugin hooks may write — a side question changes nothing) plus the same
  `disabledPlugins`, the same `settingSources` as the main session (CLAUDE.md, skills), `permissionMode: "default"`, a
  system-prompt append explaining the thread, `cwd` = the main session's (the CLI keys session files by it), model
  `settings.sideModel ?? settings.model`. The one-shot forks (commit draft §36.11, pre-review §36.13) start **no** MCP
  server (`strictMcpConfig` + `mcpServers: {}`; no MCP tool runs): they read an untrusted patch, and a read tool could carry
  what it read out — as the web (§40.3).
- **Cost.** Each question's `total_cost_usd` goes to `side_turn_end.costUSD`, the message, `thread.costUSD` and
  `state.hud.sideCostUSD` (reset with the HUD on a chat switch). It is **not** part of `hud.sessionCostUSD` /
  `SessionMeta.costUSD`, and the per-turn change budget (files / lines, §4) does not apply: side sessions cannot change
  files.
- **`side_list`** → `side_threads {mainSessionId, threads}` (the current chat's, newest first). **`side_cancel`**
  interrupts a running question (`side_turn_end.stopReason: "interrupted"`, the thread stays). **`side_close`** removes
  the thread (interrupting it) → `side_thread_closed {threadId}`.
- **Persistence.** `<gitdir>/reviewgate/side/<mainSessionId>.json` (`{version: 1, threads}`, atomic), at most 30 threads
  per chat (oldest idle ones dropped), 200 messages per thread, 20 000 chars per message; long tool inputs are reduced to a
  preview. `open_project` / `session_open` / `session_new` load the chat's threads (a question that was running when the
  engine went away comes back `status: "error"`, `error: "interrupted …"`); switching chats, closing the project and
  shutdown interrupt running questions first. `session_delete` removes the chat's file; files of chats no longer in the
  index are pruned on open. The side Claude sessions themselves are ordinary CLI sessions (they show up in
  `claude --resume` of that directory).
- **Promote.** `side_promote_draft {threadId}` resumes the side session with *"Summarize what should change, as an
  instruction to the coding agent … referencing files and lines …"* and replies `side_promote_draft {threadId, text}`
  (nothing streams, not added to `messages`; cost counted like a question). Refused `side_busy`, `side_no_answer` (no
  answer yet), `side_draft_failed:<why>`. `side_promote {threadId, as, text}` then sends the (user-edited) text:
  - `as: "message"` → the normal `send` of the main session with `text + "\n\n(곁질문에서 정리됨)"` (and
    `acceptPending` passed through): every §3 / §10 rule applies — while files await review it is a question turn, while a
    turn runs it is refused `gate_closed:running` (likewise every other `gate_closed:<reason>`), `send_failed` when
    snapshot A / the session refused it.
  - `as: "note"` → a review note on the anchor (`path`, `line` or null, `side` default `new`, `excerpt` = the anchored line
    of the current diff) with body `text + "\n(곁질문에서 정리됨)"`, for the request-changes flow. Refused `side_no_anchor`
    (no `anchor.path`), `not_a_changed_file:<path>`, `session_running` (as `add_note`), `empty_note`.
  - Without `text` the command answers with a draft (`side_promote_draft`) and promotes nothing. Each promotion is
    recorded in `thread.promotions`.

## 22. MCP servers

```ts
type McpAddConfig = { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
                  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };
type McpServerInfo = {
  name: string; status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  scope: string | null;                          // the SDK's raw scope (user, project, local, claudeai, managed, dynamic, …)
  source: "user" | "project" | "local" | "plugin" | "claude.ai" | "managed" | "session" | "unknown";
  transport: "stdio" | "http" | "sse" | "sdk" | "claudeai-proxy" | "unknown";
  toolCount: number | null; tools: string[];     // tool names when connected
  error: string | null; serverInfo: { name: string; version: string } | null;
  config: { command?: string; args?: string[]; url?: string; envKeys?: string[]; headerKeys?: string[] } | null;
  disabledByUser: boolean;                       // mcp_toggle {enabled:false}, persisted per project
  sessionAdded: boolean;                         // mcp_add {scope:"session"}
};
```

Engine: `engine/src/mcp/mcp.ts` + `ReviewEngine`; tests `engine/test/engine.mcp.test.ts`; real CLI `driver-m22.mjs`.
MCP commands run on their own lane. Every one but `mcp_auth` replies `mcp_status {servers, restartRequired}`.

- **`mcp_status`** = `Query.mcpServerStatus()` of the live main session, redacted: env and header **values never leave the
  engine** (`envKeys` / `headerKeys` only), args after a secret-looking flag (`--token`, `--api-key`, …), `KEY=value` with a
  secret-looking key and long opaque tokens read `***`, URLs lose userinfo and secret / long query values. Refused
  `no_session` without a session (the last list is returned when one was seen) and `mcp_unsupported` for a session
  without MCP control. **Polling:** right after every session start (the first answer comes once the CLI initialized)
  and every 10 s while the session lives (`EngineOptions.mcpPollMs`), one call at a time (≤ 8 s); an unsolicited
  `mcp_status` is emitted only when the list changed; `state.session.extensions.mcpServers` follows it. A server that
  turns `needs-auth` raises `error{fatal:false, scope:"session", code:"mcp_auth_required", server}` once per session.
- **`mcp_reconnect {name}`** → `Query.reconnectMcpServer`. **`mcp_toggle {name, enabled}`** → `Query.toggleMcpServer`
  (session-level) and the choice is persisted in `<gitdir>/reviewgate/mcp.json` (`{version: 1, disabled: string[]}`); at
  every later session start of the project the engine disables those servers again after the first status answer
  (`disabledByUser: true`). A failing call is `mcp_failed:<message>`. Names of existing servers may be any string ≤ 200
  chars without control characters (`plugin:x:y`, `claude.ai Gmail`).
- **`mcp_add {name, scope, config}`** / **`mcp_remove {name, scope}`**: `name` must match `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`
  (`invalid_mcp_name`), `scope` one of the three (`invalid_mcp_scope`), `config` is checked (`invalid_mcp_config:<what>`:
  non-empty command not starting with `-`, ≤ 100 string args, env keys `[A-Za-z_][A-Za-z0-9_]*`, `http(s)` URLs, header
  token names, no CR / LF / NUL anywhere).
  - `scope: "session"` → `Query.setMcpServers({...every session server})` (the SDK's dynamic set); kept by the engine for
    the open project and re-applied when a new session starts (restart, chat switch); `mcp_remove` of an unknown one is
    `unknown_mcp_server:<name>`. A connect error is `error{code:"mcp_failed", server}`.
  - `scope: "project" | "user"` → the real CLI, `claude mcp add --scope <s> --transport <t> <name> …` (stdio: `--env K=V …
    -- <command> <args…>`; http/sse: `<url> --header "K: V" …`) / `claude mcp remove --scope <s> <name>`, spawned with
    `execFile` (no shell), cwd = the project, 30 s timeout; its argv is never logged (secrets). A non-zero exit is
    `mcp_cli_failed:<first stderr line>`. The user's normal config is updated (`~/.claude.json` for user, the project's
    `.mcp.json` for project); the running session does not pick it up, so `mcp_status.restartRequired` is true until the
    next session start (`restart_session`). Project scope writes `.mcp.json` into the worktree: it is **not** put under
    review (the gate is turn-based, §9) — it shows as a normal working-tree change (`branches.isWorktreeDirty`, refreshed
    right away), is part of the next turn's snapshot A, and is committed like any other file by the user. A new
    project-scope server may still need the CLI's one-time project approval before it loads.
- **needs-auth.** The SDK offers no OAuth flow for MCP servers. `mcp_auth {name}` opens a terminal (the platform's
  `openTerminal`, `claude` is allow-listed on Windows) running `cd '<project>' && claude /mcp` (Windows: `claude /mcp`),
  the CLI's server dialog where the user authenticates; afterwards `mcp_reconnect` / the next poll shows the new status.
  `terminal_failed:<why>` when no terminal could be opened.

## 23. File mentions (@)

Additive: one command, one reply, `send.mentions`, `user_message.mentions`. Engine: `engine/src/files/fileIndex.ts`,
`platform/paths.ts repoRelativeInside`; tests `engine/test/engine.m23.test.ts`; real CLI `sidecar/test/driver-m23.mjs` step 1.

```ts
type FileItem = { path: string; kind: "file" | "dir"; changed?: true };   // path: repo-relative, POSIX; `changed`: in the current review
```

- **`list_files { query, limit? }`** → `files { query, items }` (own lane `query`: never waits behind the main lane).
  The index is `git ls-files --cached --others --exclude-standard` (gitignored files are not offered) plus every
  directory above those files (`kind: "dir"`), read once per project and cached; it is re-read after every turn's
  collection, `refresh` (review scope / no scope), a file `rewind`, `switch_branch` / `create_branch`. Matching is a
  case-insensitive **subsequence** of the query (whitespace and a leading `@` ignored) — inside the basename it scores
  far higher than spread over the directories; exact basename / stem, a basename prefix and a contiguous run score
  higher still, as do matches right after `/ . _ -`; long paths slightly lower. Files of the current review
  (`changedFiles`, deleted ones excepted) rank **first** and carry `changed: true`. An empty query lists the review files,
  then the shallowest entries. `limit` defaults to and is capped at **50**. Refused `no_project`, `list_files_failed:<git>`.
- **`send { text, mentions?: string[] }`**: repo-relative paths (files or directories, at most 20, duplicates dropped).
  Each must stay inside the repository after resolving `..` and symlinks and must not name anything inside `.git`
  (`invalid_mention:<path>`; absolute paths, control characters and empty entries too), `too_many_mentions:<n>`. Nothing
  is sent on a refusal.
- **Native expansion.** The CLI expands `@path` in a prompt by itself: the file's content is attached as context, Claude
  answers without a `Read` call (verified, CLI 2.1.305 — driver-m23 step 1). The engine therefore appends one line to the
  outgoing text: `"\n\nReferenced files: @src/a.ts @docs/ @\"my notes.txt\""` (directories end in `/`; paths holding
  whitespace or `"` are quoted). `user_message.text` / the transcript keep the user's own text; the mentions travel as
  `user_message.mentions` / the `user_message` row's `mentions` (the normalized repo-relative paths, without `/`).

## 24. Image attachments

```ts
type SendAttachment = { kind: "image"; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; dataBase64: string };
type AttachmentRef  = { kind: "image"; hash: string /* sha-256 hex of the bytes */; mediaType: SendAttachment["mediaType"]; bytes: number };
```

- **`send { …, attachments?: SendAttachment[] }`** (also `rewind.attachments` with `editText`, §26): at most **5** images,
  each at most **5 MiB** decoded (5 242 880 bytes). `dataBase64` is plain base64 (a `data:…;base64,` prefix and
  whitespace are tolerated). Refusals, checked before anything is sent: `too_many_attachments:<n> > 5`,
  `attachment_type:#<i> …` (not `kind: "image"`, another media type, or bytes whose magic number is not the declared type),
  `attachment_too_large:#<i> …`, `attachment_invalid:#<i> …` (not base64, empty). `file` attachments are not supported
  (mention the file instead, §23).
- The session sends the images as Messages API image content blocks (`{type:"image", source:{type:"base64", media_type,
  data}}`) **before** the text block; a message without images stays a plain string. Verified with the real CLI: a 5.9 MB
  base64 PNG goes through (the CLI downsizes it).
- **Storage.** Each image is written once to `<gitdir>/reviewgate/attachments/<hash>.<png|jpg|gif|webp>` (content
  addressed, atomic). The `user_message` event and transcript row carry `attachments: AttachmentRef[]` — **never** base64
  (transcript files stay small). Not garbage-collected (shared by hash across chats and forks).
- **`attachment_get { hash }`** (lane `query`) → `attachment { hash, mediaType, dataBase64 }` for thumbnails in a restored
  transcript; `unknown_attachment:<hash>` (unknown or not a sha-256), `no_project`.
- **A big image is scaled down, not refused (client rule, r2-chats-cards M34).** An image over 5 MiB — a pasted Retina
  screenshot — is scaled down to at most 2000 px on its long edge and re-encoded: PNG while that fits (transparency
  kept), else JPEG (quality 0.85 → 0.7 → 0.55, transparency flattened on white), then at 1600 and 1200 px; it is attached
  under its new type's extension with a note ("크기를 줄여 첨부했어요: 8.2 MB → 1.3 MB"), and only an image that still does not
  fit is refused. The engine's limit is unchanged. Mac: Core `ComposerImageFit` (`ComposerImage.validated`); test
  `CardAnswersTests`. Electron: the same tries (`src/shared/attachments.ts` `fitTries`, `fitSize`, `fitWith`) for a paste or
  a drop (`composerAttach.ts` `fitImage`, drawn on a canvas) and the attach dialog (main `readPickedImage`, Electron's
  `nativeImage`); the chip's tooltip says it was scaled down and a toast says it once; test `composerAttachFit.test.ts`.
- **⌘V of an image (Mac, composer).** Pasting a screenshot or an image copied in Preview did nothing: ⌘V beeped. The
  message box is a plain-text `NSTextView`, and AppKit turns Edit › Paste on only for the types such a view reads
  (`readablePasteboardTypes`: text, RTF, URLs, file names; no PNG or TIFF). The box's own paste, which attaches images,
  never ran. Paste is now on when the pasteboard holds text or something the box attaches: a file URL, PNG, TIFF, JPEG,
  GIF or WebP (`ComposerNSTextView.canPaste`, `validateMenuItem` / `validateUserInterfaceItem`). Proof: the quiet
  check `SHOTS_LAYOUT=composer` pastes through the app's own Edit menu (⌘V as a key equivalent) from a private pasteboard
  handed to the box, never the user's clipboard. It covers what a screenshot (PNG + TIFF), Preview (TIFF), a browser's
  Copy Image (TIFF + HTML) and a Finder copy of an image file (file URL + name) put there. Before: "Edit › Paste off —
  LOST" for a pasteboard of image types only: a screenshot, a copy in Preview. A browser's copy usually carries HTML or a URL
  and a Finder copy a file name, which the view reads, so those pasted. After: an image is attached for each of the four.
- Tool results that hold image blocks (a `Read` of a `.png`, an MCP screenshot) are previewed as `[image/png, N bytes]`
  instead of their JSON — no base64 in `tool_result.preview` or the transcript either (the CLI keeps a pasted image on disk
  and Claude may `Read` it back; observed with CLI 2.1.305).

## 25. Model and effort

- **`set_model { model, effort? }`**: `model` is an alias or id the CLI knows (`sonnet`, `claude-sonnet-5-5`, …;
  `[A-Za-z0-9][A-Za-z0-9._:\-[\]]*`, ≤ 100 chars, else `invalid_model`), `"default"` = the CLI's own default (stored as
  `null`). `effort`: `"low" | "medium" | "high" | "xhigh" | "max"`, `null` = the model's default, absent = unchanged
  (`invalid_effort`). The live session switches **without a restart**: `Query.setModel(model)` and
  `Query.applyFlagSettings({ effortLevel })` (the flag settings layer). **Allowed while a turn runs**: the CLI applies it
  from its next model request — in practice the next turn (a running turn may pick it up for its remaining requests). The
  CLI re-reports `system/init`, so `state.session.model` becomes the resolved id (`claude-sonnet-5-5`) with the next
  message. A failing SDK call is `set_model_failed:<why>`; `no_project` without a project. With no live session the choice
  is only stored.
- **Persistence.** `<gitdir>/reviewgate-session.json` gets `model` / `effort` (next to `permissionMode`); every later session
  of the project starts with `model` / `effort` (the SDK's `effort` option) — the stored choice wins over
  `settings.model` / `settings.effort`, which apply while the project has none. `session_new` / `session_open` /
  `restart_session` keep it; side sessions keep using `settings.sideModel ?? settings.model`.
- **State.** `state.session.selectedModel` (the choice or `settings.model`, `null` = CLI default), `state.session.effort`
  (`null` = the model's default), `state.session.availableModels: ModelOption[]` =
  `{ value, displayName, description, resolvedModel?, supportsEffort?, supportedEffortLevels? }[]` — the CLI's
  `supportedModels()` (asked right after initialization; aliases such as `default`, `opus`, `sonnet`, `haiku`, `fable` plus
  full ids), until then / without it the static list `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`,
  `claude-fable-5-1`. Clients send `value` back as `set_model.model`.

## 26. Turn checkpoints and rewind (edit & retry)

```ts
type TurnCheckpointView = {
  turn: number;                  // transcript turn number (= user_message.turn)
  prompt: string;                // the turn's user text, ≤ 120 chars
  startedAt: string; endedAt: string | null;   // ISO-8601; endedAt null while running / never collected
  filesChanged: number;          // files the turn itself changed (its start tree → its end tree)
  filesSince: number;            // files rewind{files} to this turn would restore (this turn and every later one)
  canRewindFiles: boolean;       // its start tree and every later end tree are known
  canRewindConversation: boolean;// the point right before it is known (or it is the chat's first turn)
};
```

- **Timeline.** Per chat, `<gitdir>/reviewgate/checkpoints/<chatId>.json` keeps one record per user turn (`send`,
  `request_changes`, plan follow-ups, `compact`): its **own start tree** (snapshot A when the send took a fresh one; a
  separate snapshot when A is kept for a question / change request), its end tree (B after the collection), the files that
  changed between them, the CLI session id + last top-level assistant chain uuid at its end, and the fork point right
  before it (the previous turn's end uuid; the chat's beginning for its first turn; unknown after a turn that ended
  abnormally without one). A file rewind adds a record of its own (what it restored, the tree afterwards). Trees are
  pinned by `refs/reviewgate/<ns>/turns/<recordId>/start|end`; ≤ 60 records per chat; refs no chat references any more are
  pruned on `open_project` and `session_delete`. `state.session.checkpoints` lists the current chat's turns (≤ 50).
- **`rewind { toTurn, mode, editText?, mentions?, attachments?, force? }`** → `rewound { toTurn, mode, restoredFiles, sessionId, keptFiles? }` (`keptFiles`: §35.11).
  Refused — nothing changed — `no_project`, `invalid_rewind_mode`, `unknown_turn:<n>` (not a listed turn of the current
  chat), **`session_busy`** while a session start, a turn, a collection or a revert is in flight (the H3 lock: also
  `reject`'s `reverting`), `collect_failed`, and for `conversation` / `both` the `session_new` guards (since M31 notes and
  a change request no longer hold it, §9) plus `rewind_unavailable:conversation`; for `files` / `both` `rewind_unavailable:files`
  (`canRewindFiles` false). `mentions` / `attachments` are validated like `send` (only with `editText`).
- **`mode: "files"`** — every path any record from `toTurn` on changed is put back to `toTurn`'s start tree (`git restore
  --source`, a path absent there is deleted; submodules skipped; a mods stub, §32, is never written). **Only those paths**:
  files nobody's turn touched (the user's own work) are never written — nor files nothing of Claude's changed in those
  turns (origin `external`, §31: the user's save while Claude worked), which stay as they are (`keptFiles`, §35.11). A record written by an engine before §32 has no
  mods paths in its trees: rewinding to it leaves the mods paths (`.claude/**`, `.mcp.json`, `CLAUDE*.md`) alone. First, for **every** path, the worktree must still hold what the last record that
  changed it left (or already the target content): otherwise `file_changed_since_review:<p1>, <p2>` with `code` /
  `paths` (§19.1) and nothing is written — unless `force: true`. During the restore `gate.phase` is `reverting`. Then the
  review follows the worktree like `refresh`: when files are under review, B is re-snapshotted and re-diffed against the
  same A — files back at A drop out, a file whose accepted content the rewind replaced is `pending` again; without a
  standing review nothing becomes one (the gate stays turn-based; the restored files show as worktree changes, and are in
  the next turn's A). `restoredFiles` lists what was actually written. Committed changes are restored as uncommitted
  modifications.
- **`mode: "conversation"`** — a new chat becomes current: the CLI session is forked at the fork point
  (`resume: <CLI session of that point>, resumeSessionAt: <uuid>, forkSession: true, sessionId: <new chat id>`), or — for the
  chat's first turn — a fresh session. The new `SessionMeta` keeps the title, `forkedFrom { sessionId, turn }`,
  `turns = toTurn − 1` (the redo is numbered `toTurn` again), the cost / last user text of the kept rows; the transcript
  rows before `toTurn` and the checkpoint timeline are copied (later turns stay in the file timeline, unlisted, so a later
  file rewind still knows what they changed). The old chat stays in the list as **`<title> (되돌리기 전)`** with its own
  transcript, side threads and CLI session (openable with `session_open`); its tab is replaced by the new one. The usual
  switch follows (`transcript_restore` with the kept rows, HUD reset, side threads of the new chat). Until the CLI
  reported the fork (first message), every start of that chat — `restart_session`, `open_project`, an auto restart —
  starts it as the fork again; a fork that dies before reporting in is a failed resume (§8: a fresh chat).
- **`both`** = `files`, then `conversation`. **`editText`** (any mode) is then sent as the new turn (a normal `send`, every
  §3 rule; `send_failed` if it could not go out — the rewind itself already happened). The client's "이 시점으로
  되돌리기" = `rewind {toTurn, mode: "both"}`; "편집 후 재시도" = the same with `editText` (`mode: "conversation"` when the
  files should stay).
- Verified with the real CLI (driver-m23 step 4): after `rewind {files}` the turn-A content is back and turn B's new file is
  gone; after `rewind {conversation, editText}` the forked chat remembers turn A's word and not turn B's.

## 27. Context management

- **`compact { focus? }`** sends the CLI's own `/compact [focus]` as a turn (verified, CLI 2.1.305: `system/status
  compacting` → `compact_boundary` → a `result`). It is a turn like `send` (gate rules, `gate_closed:<reason>`,
  `turn_end`, a checkpoint) but a slash command: the outgoing text starts with `/` — the review summary prefix is **not**
  added and stays for the next real message — and it changes neither the chat title nor `lastUserText` /
  `commit.suggestedMessage`. `focus` is collapsed to one line, ≤ 2000 chars (`focus_too_long`). The turn's
  `usage.contextTokens` (→ `hud.contextTokens`) is the CLI's `compact_metadata.post_tokens` (driver-m23: 41 348 → 10 577).
  HUD activity shows `thinking/compacting`, then `thinking/compacted` (§3).
- **`context_warning { percent, contextTokens, contextWindow }`** is emitted once when a turn end leaves
  `hud.contextTokens / hud.contextWindow` at or above **80 %** (`percent` with one decimal); it re-arms when a later turn
  end is below 80 % (after `compact`, or in a new chat — the HUD reset re-arms it too). Clients offer `compact` there.

## 28. Interrupt

`interrupt` existed (`Query.interrupt()`); it now also answers an open permission card (deny, `interrupt: true`) and its
reply waits until the turn ended (`turn_end{stopReason:"interrupted"}`) **and** its changes were collected (≤ 15 s,
`EngineOptions.interruptWaitMs`), so a `send` queued right behind it on the main lane goes out instead of being refused
`gate_closed:running` — "중단하고 보내기" = `interrupt` then `send`. Without a running turn it is a no-op. What the turn
wrote before the interrupt is reviewed like any turn's. Verified with the real CLI (driver-m23 step 6: interrupt with a
Bash permission card open, the queued message answered, the command never ran).

## 29. Peer messages

Claude Code (2.1.30x) opens a messaging socket per session (`/tmp/cc-socks/<pid>.sock`) and lists it in the user's session
registry; the user's other Claude sessions (terminals, IDEs, other apps) can `SendMessage` to it. Such a message used to run
in ReviewGate as an unrequested turn — blocked by §18, invisible, unanswerable — and its CLI record made the chat
unstartable (§30). Now the CLI **holds** every peer message and the engine runs it once Claude is free (`auto`, the default
since r2-peers, for a sender the user's registry lists) or the user decides (`ask`); an accepted one runs as an ordinary
review turn. Additive: three commands, one event, one setting, four `state.session` fields, one transcript row kind.
Engine: `engine/src/session/claude.ts` (frames), `ReviewEngine` (inbox, commands); tests `engine/test/session.peer.test.ts`,
`engine/test/engine.peer.test.ts`; real CLI `sidecar/test/driver-peer.mjs`.

```ts
type PeerMessage = {
  id: string;                      // the CLI's message uuid (peer_accept.ids / peer_dismiss.ids)
  from: string;                    // reply address the SENDER gave ("uds:/tmp/cc-socks/<pid>.sock") — its claim, not proof
  fromName: string | null;         // the sender's display name (normalized by the CLI) — its claim, not proof
  verifiedPeerPid: number | null;  // kernel-verified pid of the connecting process; null while held / when unverifiable
  cause: string | null;            // why the CLI held it: "explicit-setting" (ReviewGate's hold), "mode-mismatch", …
  receivedAt: string;              // ISO-8601
  state: "held" | "delivering" | "delivered" | "dropped";
  outcome?: string;                // dropped: "refused" (peer_dismiss / off), "expired", "discarded" (the session ended first), …
  body?: string;                   // what the peer wrote (envelope stripped) — only known once delivered
  turn?: number;                   // the transcript turn it runs in, once accepted
  unprompted?: true;               // delivered without being held (an older CLI / a policy that accepts): it ran outside the review (§18 blocked its changes)
  sender?: PeerSessionInfo;        // r2-peers: the live session of the user's registry `from` names (§42.2's lookup); absent while unknown / none
};
type ExternalTurn = { commandUuid: string | null; since: string; peer: { from: string; fromName: string | null; verifiedPeerPid: number | null } | null };
```

- **Session options.** Every main session starts with the flag setting `crossSessionInbound: "hold"` (`"refuse"` when the
  project's mode is `off`) — an explicit value outranks the user's settings files, only a managed policy beats it — plus
  `--replay-user-messages` (the CLI echoes each user message: a peer's carries `origin {kind:"peer", from, name,
  verifiedPeerPid, body}`) and `--name "ReviewGate · <project>"` (`/<branch>` added for a linked worktree whose branch
  differs; ≤ 64 chars) so the user's other sessions see it is ReviewGate's (registry `name`, `nameSource: "user"`; also the
  `/resume` picker title; resume with it verified). Side-question CLIs (§21) run with `crossSessionInbound: "refuse"`.
- **`settings.peerInbound`** `"auto"` (default since r2-peers; `"ask"` before) | `"ask"` | `"off"` — the default of every project; **`peer_set {mode}`**
  sets this project's own (persisted in `reviewgate-session.json` `peerInbound`, applied live: `off` → refuse, which drops
  what is held with `outcome: "refused"`; `ask` / `auto` → hold). `state.session.peerInbound` is the effective mode.
  Refused `invalid_peer_mode`, `no_project` (also `set_settings` with an invalid value: `invalid_peer_mode`).
- **Held.** The CLI's `system/peer_message_hold {state:"held", message_uuid, from, from_name, cause}` (no body) →
  `peer_message {message: {state: "held", …}}` and `state.session.peerInbox` (held + delivering ones, oldest first). Nothing
  runs; the gate is untouched. With the explicit hold the CLI keeps it without a timer (headless parity holds used to
  expire after 5 min unseen); a dropped frame (`expired`, buffer over 100, …) becomes `state: "dropped"` + `outcome` and a row.
- **`peer_accept {ids?}`** — the `send` gate: refused `gate_closed:<reason>` (also `external_turn`), `no_session`,
  `peer_unsupported`, `peer_none` (nothing held), `peer_inbox_changed:<held ids>` (code `peer_inbox_changed`: `ids` must name
  exactly the held messages — the user decides on what the card showed; checked again after snapshot A, §35.8). Then, in
  order (snapshot A first since §35.8): a pending plan is cleared, an
  answer to a standing review keeps snapshot A (§10), the review-round bookkeeping of `send` — **but no text of ours goes out
  and no `user_message`**: the review-summary prefix waits for the user's next real message — `state.session.peerTurn =
  {messageIds, fromNames}`, every held message → `peer_message{state:"delivering", turn}`, snapshot A, the §31 / §32
  turn-start state of `send` (HEAD, `.claude/settings.local.json` hashes, nested worktree HEADs — so `head_moved`,
  `local_settings_changed` and `nested_changes` cover a peer turn too), a §26 checkpoint
  (prompt `"[peer message] <names>"`, also the §14 round prompt), and the CLI lets them through: `crossSessionInbound`
  `accept`, straight back to `hold` (the window in which a new message would be let through unasked is that call's ~40 ms
  round trip; one arriving then joins the turn). The CLI answers with `released` + `command_lifecycle queued → started`;
  its echo brings the body → `peer_message{state:"delivered", body, verifiedPeerPid, turn}` and a `peer_message`
  transcript row that opens the turn (before its first tool call; without an echo the turn's `result.origin` supplies it).
  From there it is a normal turn: `text_delta`, `tool_use`, permission cards, budget, `turn_end` + collection + review
  (`turn_summary`), `peerTurn` back to null. No `released` frame within 3 s → refused `peer_release_failed:<why>` plus
  `error{code:"peer_release_failed", fatal:false}` (`code:"lfs_missing"` when snapshot A failed for want of git-lfs, §32);
  the turn is undone (gate open, checkpoint dropped) and the messages are `held` again. Several held messages run as
  **one** review turn: it ends with the `result` after the last released command started (the CLI may also batch them
  into one CLI turn).
- **`peer_dismiss {ids?}`** — refused `no_session`, `peer_unsupported`, `peer_none`, `peer_inbox_changed`,
  `peer_dismiss_failed` (no `dropped` frame within 3 s). The CLI refuses (flag `refuse`, then back): every held message →
  `peer_message{state:"dropped", outcome:"refused"}` + a row; the sender gets a "not delivered" receipt. Release and refusal
  are all-or-nothing (the CLI has no per-message switch).
- **`auto`** (the default since r2-peers: in the terminal a message from another session runs as soon as Claude is free).
  While `canSend` holds with no permission card and no pending plan, the engine issues `peer_accept {ids: <every held
  id>}` itself (main lane) — a running turn, a collection or an open card make it wait; a review waiting does not any
  more (the turn is an answer to it and keeps its A, like a `send`). Only when every held message has a **`sender`**: when
  a message is held the engine looks its `from` up in the user's session registry (§42.2's lookup — a `uds:` address
  whose socket a live session lists, pid alive — read in the same tick, so the first `peer_message {held}` already
  carries it) and puts that entry on the message; `from` is the sender's claim, so a
  message no live session of the user's vouches for — a bare name, a Remote Control relay, a dead process — waits for the
  user's answer, and so does everything held with it (the CLI releases all held messages at once). A message whose
  release failed once is left to the user; one held while snapshot A is taken refuses the attempt (`peer_inbox_changed`,
  logged only) and the next state decides again. The turn it starts opens with the delivered `peer_message` row, as an
  accepted one does; clients show no card for what will run by itself (r2-peers).
- **Clients in `auto`** (r2-peers). While the effective mode is `auto`, every held message has a `sender` and no refusal
  notice stands, the card above the composer is one line instead: "<names> 세션 메시지 — 지금 작업이 끝나면 Claude가
  처리해요" (`sender.name`, else the sender's own name; each once), with [거절] and ⋯ (이 프로젝트는 받지 않기) still at
  hand — nothing to decide, so no notification and no "waiting" mark. A held message without `sender` brings the card
  back for all of them and is announced as before. The delivered row of a message that started its turn says "다른 세션
  메시지로 시작한 턴". The settings read "오는 대로 처리하기(기본)" / "먼저 물어보기" / "받지 않기"; an absent setting is
  `auto`. Mac: `PeerInboxCard`, `AppState.peerInboxRunsByItself`, `PeerText.runsByItself` / `senderNames` (tests
  `PeerAutoTests`, `PeerInboxTests`). Windows: `PeerCard` (`peer-card compact`), `peerRunsByItself` / `peerSenderNames`
  (`peer.ts`), the notification in `attention.ts` and the Changes tab's mark in `tabAttention.ts` (tests `peer.test.ts`,
  `peerCardView.test.ts`, `tabAttention.test.ts`).
- **The session ends** (restart, chat switch, close, a crash): held / delivering messages become `dropped` /
  `outcome: "discarded"` (rows); the CLI dropped them with its process (the sender gets an "expired" receipt).
- **Turn ownership.** Every message the engine sends carries a uuid; the CLI echoes it in `command_lifecycle
  {command_uuid, state: queued | started | completed | cancelled}` and `result.user_message_uuid(s)`. A `started` of any
  other uuid is an **external turn**: `state.session.externalTurn = {commandUuid, since, peer: null}` (`peer` filled once its
  echo shows a peer origin), `canSend` false with `blockedReason: "running"` (the closed enum is unchanged), refusals
  `gate_closed:external_turn` — clients keep the message in their queue and send it when `externalTurn` is null again (its
  terminal lifecycle frame or the CLI turn's `result`). Its tool calls stay under §18's guard even if a send slipped in; its
  `result` never ends our turn.
- **No hold (fallback).** A CLI without hold support — or a managed policy that accepts — delivers a peer message by itself:
  its echo → `peer_message{state:"delivered", unprompted:true, body, …}` + row, before its first tool call; §18 still denies
  its changes, but **no** `unprompted_blocked` banner (so no paused queue) — clients show the card with "이 메시지
  처리하기", which sends the body as a normal `send`. Its text is the usual `unprompted` assistant row.
- **Security.** An accepted peer turn is an ordinary turn: the same permission rules (cards for Bash / MCP / web …,
  remembered allows and patterns included), budget, git guard, plan mode, snapshot A → B review — nothing it changes
  bypasses the review. `from` / `fromName` are what the sender claims; `verifiedPeerPid` (kernel-verified, delivered
  messages only) is the identity to show. The CLI itself frames the body for the model as another session's request that
  cannot grant permissions.
- Verified with the real CLI (2.1.307 audit probes; driver-peer, 2.1.308 + haiku): held (`explicit-setting`, no turn) →
  `peer_accept` → `released` → `command_lifecycle started` → the echo with the body and a verified pid → the requested file
  in the review → `turn_end`; a second message dismissed → `refused`; `restart_session` resumes under the same `--name`.
  A uuid-stamped message of ours gets `command_lifecycle queued / started / completed` and `result.user_message_uuid`
  (no model call: a local `/cost`).
- Verified with the real CLI (r2-peers; `driver-peer.mjs` `RG_ONLY=auto`, CLI 2.1.318): two ReviewGate sessions — A in
  auto mode (sonnet) was asked to SendMessage B's `uds:` address: no permission card in A, the call's result
  `success: true`; B (the default mode, now `auto`) held it (`explicit-setting`), found A's CLI in the registry (`sender`:
  pid = A's CLI, `ReviewGate · auto-a`, `sdk-cli`), released it by itself and ran it as a review turn — the delivered
  body, `verifiedPeerPid` = A's CLI, `peer-auto.txt` pending in B's review, no unprompted banner.

## 30. Session start and recovery

How the engine starts the CLI for a chat and what it does when the start fails (audit crash-1 / robustness-01, crash-2,
crash-4, crash-5, robustness-02, robustness-03). Engine: `engine/src/session/cliRecords.ts`, `ClaudeSession` (start /
death reporting), `ReviewEngine` (`isResumable`, `onSessionDied`); tests `engine/test/session.cliRecords.test.ts`,
`session.recovery.test.ts`, `engine.recovery.test.ts`; real CLI `sidecar/test/driver-crash.mjs` (no model call).

- **Resume or fresh.** A chat is started with `--resume <id>` whenever the CLI knows the conversation, else fresh with the
  pre-chosen id (`--session-id <id>`). "Knows" = `turns > 0`, `lastUserText`, **`SessionMeta.cliKnown`** (persisted as soon
  as the CLI reports the id: `session_info`, `turn_end`, and a turn it ran on its own — a peer message's turn included), the
  id reported in this process, or the CLI's own record file
  `<CLAUDE_CONFIG_DIR | ~/.claude>/projects/<key>/<id>.jsonl` for the project path or its real path (the key: the NFC path
  with every non-alphanumeric character replaced by `-`; longer than 200 chars → the first 200 + `-` + base-36 of the Java
  string hash of the path; with `CLAUDE_CONFIG_DIR` set, a safe `CLAUDE_CODE_PROJECT_DIR_NAME` replaces it — read from the
  CLI binary, verified with 2.1.308 on a 224-char Hangul path). The file is a positive signal only; the CLI's answer decides.
- **Start outcomes** (the CLI's own words, 2.1.301–2.1.308):

  | The CLI | The engine | The client sees |
  | --- | --- | --- |
  | answers initialize | `state.session.ready = true`; a resume counts as successful from here (not at the first `session_info`, which needs a message) | — |
  | `Error: Session ID <id> is already in use.` (`--session-id` of a conversation it has; exit 1) | the chat becomes `cliKnown` and is resumed **at once** (no backoff, not counted as the turn's auto-restart); a message sent meanwhile is sent again | nothing (`log` only). A second refusal for the same chat is shown: `error{code:"session_id_in_use", fatal:true, detail}` |
  | `No conversation found with session ID: <id>` (its 30-day cleanup, deleted, another machine; preceded by an `error_during_execution` result that is **not** an unprompted turn) | the chat is flagged `resumeFailed`, a new "New chat" becomes current (`transcript_restore{items: []}`) | then `error{code:"resume_not_found", fatal:false, sessionId:<old chat>, detail}` — a notice, kept as the new chat's first row; not `state.lastError` |
  | `Failed to resume session …` / `Unable to load transcript …` | the same | `error{code:"resume_failed", …}` |
  | dies before initialize otherwise (an unknown option, broken settings, a missing binary, …) | **no automatic restart** — the same arguments would fail the same way | `error{code:"session_start_failed", fatal:true, detail, exitCode, signal}`; `restart_session` retries with the same arguments (the same `code` + `detail` again — clients merge repeats), `session_new` starts a fresh chat |
  | dies after initialize | one automatic restart per turn (2 s backoff, §8) — resumed when the CLI knows the chat | `error{code:"session_crashed" \| <API code>, fatal:true, detail, exitCode, signal}` |

- **A chat flagged `resumeFailed` is a record** (§35.4): opening it again never resumes it — its rows are replayed, the CLI
  starts fresh, and the first turn started there goes to one new chat.
- **`detail`** = the CLI's first stderr line (home folder as `~`, §35.14; `sk-ant-…`, `Bearer …`, `…TOKEN=` / `api_key:` values and
  long opaque runs masked; ≤ 300 chars), `exitCode` / `signal` = how the process ended. Before this, the only text was
  "Claude Code process exited with code 1" and the cause sat in the sidecar log.
- **Errors in the transcript.** Every `error` event of scope `session` / `git` / `engine` — fatal or not, notices
  included, hints (`api_retrying`, `cli_start_slow`) and PR-browser errors excepted — is also a row
  `{kind: "error", message, fatal, scope, code?, detail?}` of the current chat, so `transcript_restore` shows it after a
  restart (never written into a git dir that has gone away); with the details its banner reads (§35.3).
- **`state.session.ready`** — true once the CLI answered initialize; false while starting, after a death and without a
  session. Clients clear a crash banner / "restarting" indicator on it.
- Verified with the real CLI (driver-crash, 2.1.307 and 2.1.308, an isolated `CLAUDE_CONFIG_DIR`): a chat with `turns: 0`
  whose CLI record exists (as after a peer message) is resumed with no error and stays up past the auto-restart window
  (before: "already in use" ×2 at launch and once per restart click); a chat whose record is gone falls back to a new
  chat with one `resume_not_found`; a CLI dying before initialize gives one `session_start_failed` with its stderr line as
  `detail`, no automatic restart, and the same `code` + `detail` on a manual retry.

## 31. Review provenance

The review is the worktree diff A → B, and the worktree is not Claude's alone: the IDE saves, a terminal Claude session
works in the same folder, `git pull` moves HEAD, the app was closed for two weeks. Every changed file therefore says who
changed it, "Reject all" only reverts Claude's changes, HEAD moves and other Claude processes are reported, and a review
restored long after it was saved is offered for cleanup. Additive: fields, events, one command field, two commands.
Engine: `engine/src/session/provenance.ts`, `session/hooks.ts`, `review/gate.ts`, `review/concurrent.ts`.

```ts
type FileOrigin = "tool" | "bash" | "skill" | "external";   // skill: r2 M35 (§31.1)
type HeadInfo = { sha: string | null /* null: unborn */; branch: string | null /* null: detached */ };
type ConcurrentClaude = {
  pid: number; sessionId: string | null; cwd: string;
  name: string | null;           // the CLI's session name ("acme-b4")
  kind: string | null;           // "interactive", …
  entrypoint: string | null;     // "cli" (a terminal), "sdk-cli" / "sdk-ts" (an app or script on the SDK), …
  status: string | null;         // "busy" / "idle" / … as the CLI last wrote it
  startedAt: string | null;      // ISO-8601
};
type StaleReview = {
  reasons: ("head_moved" | "old")[];
  savedAt: string;               // ISO-8601, when the review was last saved
  savedHead: HeadInfo | null;    // HEAD then (null: a file written before §31)
  head: HeadInfo | null;         // HEAD now
  externalFiles: number;         // restored files with origin "external"
};
// state.gate: externalPendingCount: number; headMoved: { from: HeadInfo; to: HeadInfo } | null;
//             concurrentClaude: ConcurrentClaude[]; stale: StaleReview | null
// state.changedFiles[].origin: FileOrigin;  turn_summary.files[].origin: FileOrigin;  turn_end.external: number
// state.changedFiles[].committedIn?: string   // r1-git: the short sha of Claude's own commit holding the change (§46)
// events: { type: "head_moved"; turn; from; to; explainedBy?: "claude_git"; commits?: string[] }   // explainedBy: r1-git, §31.3
//       | { type: "concurrent_claude"; at: "open" | "send"; sessions }
// commands: reject_all { force?, includeExternal? } | finish_review | keep_review
```

### 31.1 Origin of a changed file

`origin` is derived from the file's causes (`tools` / `toolUseIds`, §12) whenever the state is built — never stored:

- **`tool`** — an edit tool (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) changed it by its `file_path` (subagents included), or
  an MCP tool (`mcp__*`) did (below). An edit whose `tool_result` is an error changed nothing: its id is not a cause.
- **`bash`** — a Bash call changed it. After each call (PostToolUse, or PostToolUseFailure when the command exited non-zero —
  CLI 2.1.308 reports those only there) the worktree is snapshotted and diffed against the previous snapshot; a file of that
  diff is the call's only when its **change time** (`ctime`, which `touch -t` / `cp -p` cannot set back; a deleted file: its
  nearest existing parent directory) falls inside the call's **execution window**: from the PreToolUse hook — moved up to
  `PostToolUse − duration_ms` (tool execution only, so a permission card the user thought about is not part of it) — minus
  1.5 s, to the PostToolUse hook plus 0.1 s. A change made between two calls is nobody's. **Not after a read-only command**
  (§10, §19.3 — judged at its PreToolUse, where it runs; not one run in the background): it changes nothing, so it takes no
  snapshot and no diff (0.2–0.6 s each on a large repository, before Claude got its result) and leaves the previous
  snapshot as the base; the turn's first snapshot is taken before its first command that may write. A file such a command
  wrote all the same still reaches the review at the turn's end (snapshot B, §34.1) as `external` — only its cause is lost.
- **`skill`** (2026-11, r2 M35) — a skill's own work: a `!`command`` line of a SKILL.md / command .md runs while the CLI
  expands it — no tool_use, no hook — so what it wrote read `external` and "Reject all" left it. Now a **slash command's
  turn** (a `send` of one of the session's commands, §36.13) has a window from the message to its first tool call (the
  first `tool_use` the session sees; the turn's end when it makes none), its id `skill:<name>`; a **`Skill` call** has one
  from its PreToolUse to its PostToolUse / PostToolUseFailure (its tool_use id). After the collection a file with no other
  cause whose change time falls inside such a window gets `tools += "Skill"`, `toolUseIds += <the window's id>`, as an MCP
  call's (below): its origin is `skill` (a Bash or edit cause wins). `reject_all` reverts it with Claude's changes, its
  risk badges include `bash` (§40.2: a shell command wrote it) and no auto-accept rule takes it (§41.2). `turn_end.toolWindows`
  carries the windows (`name: "Skill"`). Both clients name it: "Why it changed" lists a `skill:<name>` cause as `/<name>`
  — "명령을 불러오는 동안 실행된 !`…` 줄이 바꿨어요", a row to read (no tool call, so no chat row to open; the Mac's "왜?" on
  it asks about the file), where any other cause missing from the rows reads "이 채팅 기록에 없음" / "불러온 대화에 이 호출이
  없습니다" — and a Skill call with its skill; the review list's "원인별" sections read `/<name>` and `Skill · <name>`, and
  the Windows client counts `skill` as Claude's (never "앱 밖 변경"). Clients that do not know `skill` show the file as an
  ordinary Claude change.
- **`external`** — nothing of Claude's explains it: an IDE save, another Claude session, a `git pull` / checkout, a file
  Claude only read, a failed edit, work done while the app was closed (restore), an edit found by `refresh`.

An **MCP call** records its window the same way (PreToolUse → PostToolUse / PostToolUseFailure; no snapshot per call):
after the collection, a file with no other cause whose change time falls inside a finished MCP window gets that call
(`tools` += its name, `toolUseIds` += its id) — the IDE's own MCP server (`mcp__idea__*`) edits files with no `file_path` the
session could see. A call that never finished (denied, interrupted) has no window. `turn_end.toolWindows` (session → engine)
carries the finished windows. A turn that ends without the session's `turn_end` (the CLI died, `restart_session` mid-turn)
is attributed from the turn's own events instead: edit `tool_use.file` (failed calls dropped) and the post-Bash `tool_files`.
A symlink a Bash call created is attributed to itself, not to its target. A question / request-changes follow-up adds its
causes to the files' existing ones (a file the follow-up did not touch keeps its origin; an external file Claude then edits
becomes `tool`).

**Limits.** Another writer active *during* a Bash call's window (IDE save while `mvn test` runs) is attributed to that call;
a background process a command left running writes outside its window (`external`). Hosts whose file systems keep only
1–2 s timestamps (FAT) blur the windows.

### 31.2 What origin changes

- **Budget** (§4): only the turn's edit-tool and Bash files count (files and lines); external changes are never charged,
  so another session's work cannot exhaust Claude's budget and get its edits denied.
- **`reject_all`** reverts the pending files with origin `tool` / `bash` / `skill`; the `external` ones stay pending unless
  `includeExternal: true` — clients send that only after confirming with the list of files (they are the user's or another
  session's work). `reject {paths}` is an explicit choice and is honored for any origin; clients confirm external ones first.
  Uncaptured files among the targets are skipped (§35.2).
  `accept` / `accept_all` are unchanged (accepting writes nothing).
- **Counts:** `state.gate.externalPendingCount` (pending external files — what "Reject all" leaves), `turn_end.external`
  (external files among `files`), `turn_summary.files[].origin`. `gate.pendingCount` still counts every pending file.

### 31.3 HEAD moved during a turn

HEAD (commit + branch) is read when every turn starts (`send`, `request_changes`, plan follow-up, `compact`) and again after
its collection. When it differs — a commit, pull, checkout or rebase outside the app, or one Claude ran with the user's approval
(§46) — `state.gate.headMoved = {from, to}` until the next turn starts and `head_moved {turn, from, to}` follows the
turn's `turn_end` (never before it: `interrupt` replies once `turn_end` is out). The collection first carries the commits
into A (§46), so what moved in with the new HEAD is not in the list; only when they do not apply on A is it there, `external`.
MARK: r1-git — a move Claude's own git commands made is no warning: the session reports every HEAD move of a git command
(`git_result {from, to, ownCommits?, foreign?}`, §46), and when those moves chain from the turn's start to its end (each one
starts where the one before ended; none with a move from before its command ran in it) `head_moved` carries
`explainedBy: "claude_git"` (+ `commits`: the short shas of the commits Claude made, oldest first), `state.gate.headMoved`
stays unset (a carry that failed still sets it, as before) and a gray row follows: `claude_committed` (`detail`: the short
shas; "Claude가 커밋함 <sha> — 파일은 리뷰에 그대로") or, with no commit (a branch, a pull, a checkout), `claude_moved_head`
(`detail`: "main@abc1234 → feature/acme-7@abc1234"). Any other move keeps the bar — and so does a chain of Claude's own
moves in which one of Claude's commits (made in the turn, or in HEAD's history when it began) left HEAD's history with no
copy there while a file it changed is no longer in the review (a squash, a checkout elsewhere: `ReviewGate.ownCommitsLost`);
then no `claude_committed` row says its files stayed. A commit a rebase rewrote is named by its copy (§46).

### 31.4 Other Claude processes in this worktree

Every Claude Code CLI (2.1.30x) registers itself in `<CLAUDE_CONFIG_DIR | ~/.claude>/sessions/<pid>.json`
(`{pid, sessionId, cwd, startedAt (epoch ms), procStart (ps lstart, UTC), kind, entrypoint, name, status, …}`, checked against
CLI 2.1.308) and removes the file when it exits. When the project opens (before its session starts: `open_project` awaits
nothing after the start, so a restart the start queued — the §16 init-timeout fallback — runs before the next snapshot)
and on every `send` the engine reads the
`<digits>.json` files only — the `<pid>.<hash>.key` files next to them hold a token and are never opened — and keeps the
entries whose process is alive (`kill(pid, 0)`), whose `cwd` is this worktree's root or a folder below it that is not inside
another repository / worktree (no `.git` on the way up — `.claude/worktrees/wf_*` sessions are not reported), that are not the
engine's own CLIs (parent pid = the engine, via `ps -o ppid=,lstart=`; the main session's pid always) and whose `procStart`
matches the process's start (a reused pid). The result is `state.gate.concurrentClaude` (refreshed at open / every send) and,
while non-empty, `concurrent_claude {at: "open" | "send", sessions}`. Nothing is refused — the warning is the point
("이 worktree 에서 다른 Claude 세션이 실행 중 — 워크벤치로 분리 권장"). Windows has no `ps`: only the main session's pid is
excluded there, so a running side question (§21) may show up briefly.

### 31.5 A review restored after work outside the app

- **Saved with it:** `head` (HEAD at every save), next to the existing B (`turnEndTree`) and `savedAt`.
- **Restore** (§8): files that changed since and are not in the saved list come back `pending` with origin `external` (no
  tool explains them — "Reject all" never reverts them). A file of the saved list that changed since is compared with the
  B the review was saved with: `reject` / `reject_all` refuse it `file_changed_since_review` like a live edit (§35.9). The review is **stale** when HEAD moved since the save (`head_moved`)
  and/or it was saved 12 h or more ago (`old`, `STALE_REVIEW_MS`): `state.gate.stale` — clients show "오래된 리뷰 — 정리 / 이어서
  리뷰". `keep_review` dismisses the flag (nothing else changes); the next turn and `finish_review` clear it too. M29: clients
  show it as the restored review's kept orange banner (the reasons on hover) with [정리…] (asked first) and [이어서 리뷰] — never a
  sheet that blocks the window; sending a message goes on with the review (the next turn clears the flag).
- **`finish_review`**: the review list and its notes are emptied; **no file is touched**. Files still pending simply stay in
  the worktree as they are (uncommitted, unreviewed) and become part of the next turn's snapshot A — the baseline, no longer a
  review. The round goes to the history (§14) with those files `pending` and `finished: true`; A / B, the review file and its
  refs go. The accept / reject verdicts given so far still prefix the next message (`lastReviewSummary`) — except for a stale
  review, whose verdicts belong to an old conversation and are dropped. Refused `session_running` while a turn runs or is
  collected, `reverting`, `collect_failed` (retry first). With nothing under review it is a no-op.
- **Shutdown** (`dispose`): a review with only accepted files left (nothing pending / changes-requested, no notes, no turn
  running) is completed and removed like `close_project` does — it no longer comes back days later.

## 32. Nested repositories and mods paths

### 32.1 Mods paths

The files that change how Claude Code itself behaves in the project — `.claude/**` (hooks, skills, agents, commands, rules,
settings), `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` — are often gitignored (`.claude/` in many repositories), so `git add -A` never put
them in a snapshot: a turn that rewrote a hook left no diff (a Bash `sed -i` no trace at all) while the hook ran in every
session from the next prompt on. Engine: `engine/src/git/mods.ts`, `GitCheckpoint.addMods`.

- **Every snapshot** (A, B, post-Bash, refresh, checkpoints) adds them after `git add -A` with `git update-index --add
  --remove` — plumbing: no ignore rules, no pathspec globbing, a file that vanished meanwhile drops out — whatever .gitignore
  **or the app's ignore patterns** say (ignore patterns hide noise; executable configuration is not noise). Path rules only,
  so A and B always agree on which paths are in the tree. Excluded: `.claude/worktrees/` (Claude Code's worktrees — §32.2),
  `node_modules/` and `.git/` folders, any folder holding a `.git` (another repository), symlinked directories (a symlink is
  captured as a link), and `.claude/settings.local.json` (below). Nested `CLAUDE.md` files are reviewed like any file when git
  sees them; a gitignored nested one is not captured.
- **Not captured** — larger than 256 KiB, binary (a known binary extension, or a NUL in the first 8000 bytes), or every file
  when there are more than 1000: the tree holds a stub text instead (`[ReviewGate] mods file not captured (<reason>): <size>
  bytes, modified <mtime>`), so the file's presence is always recorded (no phantom add / delete) and a size / mtime change still
  shows. A stub is never written to disk: `reject` refuses the batch with `not_captured` (+ `paths`), force or
  not, and `reject_all` skips such files (`skipped`, §35.2); `reject_hunks` says `partial_reject_unsupported:uncaptured`; a file rewind (§26) fails with `revert_failed`.
- **In the list** such a file carries `group: "mods"` (also nested `CLAUDE.md` / `CLAUDE.local.md` and
  `.claude/settings.local.json` paths), `risk` — what the change makes run or lets through: `hook` (`hooks.json`, anything
  under `.claude/hooks/`, a `settings*.json` whose `hooks` / `statusLine` changed), `script` (executable bit or a script
  extension under `.claude/`), `mcp` (`.mcp.json`; settings `mcpServers` / `enabledMcpjsonServers` /
  `enableAllProjectMcpServers`), `permissions` (settings `permissions`), `env` (settings `env` / `apiKeyHelper`); an
  unparsable settings file counts as `hook` — `uncaptured: true` for a stub, and `ignored: true` when it is gitignored: such a
  file is reviewed, accepted and rejected like any other but **not committable** (`commit.acceptedPaths` / `canCommit` skip
  it; naming it in `commit.paths` is `nothing_to_commit`).
- **`.claude/settings.local.json` is never captured.** It is per-user and may hold secrets (`env` API keys); snapshot trees are
  git objects that `git push --mirror`, bundles or backups could carry. Instead its parts are compared by hash (sha-256 of the
  whole file and of `hooks`+`statusLine`, `permissions`, `env`+`apiKeyHelper`, `mcpServers`+…; an unparsable file counts as
  changed in every part) between the start and the end of every turn: `state.gate.localSettingsChanged = {path, hooks,
  permissions, env, mcp}` until the next turn plus `local_settings_changed {turn, …}`. There is no diff and no revert — clients
  say what changed and offer to open the file.
- **Older data.** A review saved before mods were captured (no `modsCaptured` in the file) gets today's mods entries added to
  its A on restore (no phantom additions; their earlier changes are simply not part of it). A checkpoint record (§26) of an
  older engine has no `modsCaptured`: a file rewind to it leaves the mods paths alone.

### 32.2 Nested repositories

A linked worktree under the project (`.claude/worktrees/*` — `EnterWorktree`, the Workflow tool, `isolation: "worktree"`
subagents), a submodule or a clone inside it is one gitlink line in a snapshot at most (nothing at all when ignored): what
changes inside it never reaches the review. What **this session** did inside one is reported instead. Engine:
`engine/src/review/nested.ts`.

```ts
type NestedChange = {
  path: string;                  // repo-relative (POSIX) path of the nested repository
  kind: "worktree" | "submodule" | "repo";   // .git file → <common>/worktrees/… | <common>/modules/… ; .git directory / other → repo
  branch: string | null;         // its branch now
  head: { from: string; to: string } | null; // its HEAD moved during the turn
  dirtyFiles: number | null;     // `git status --porcelain` entries in it now; null when git did not answer within 3 s
  touchedFiles: string[];        // project-relative files the turn's edit tools changed in it (≤ 20)
  via: ("edit" | "bash" | "mcp")[];
};
// state.gate.nestedChanges: NestedChange[] (cleared when the next turn starts); event { type: "nested_changes"; turn; repos }
```

- **Found from the turn itself:** the files its edit tools changed (`toolFiles` with a tool_use id), the `cwd` of its Bash /
  MCP calls — the PreToolUse hook's and, when the call moved it (`cd x && …`), the PostToolUse hook's — and the path-like words
  of its Bash commands plus any linked worktree / submodule path a command names. For each, the nearest folder below the root
  holding a `.git` is the nested repository. Another session busy in its own worktree is never reported.
- **Reported** when the turn's edit tools changed files in it, or — for a repository it only ran a call in or named — when it
  is dirty or its HEAD moved (HEAD at the turn's start: one `git worktree list` for linked worktrees, the gitlink in the turn's
  start tree for submodules / clones git sees). `nested_changes` follows the turn's `turn_end`.
- **Cost:** one `git worktree list` per turn start, `stat`s up the touched paths, `git status` (≤ 3 s) and `rev-parse` only in
  the nested repositories the turn touched — a repository with 17 worktrees never has them all scanned.
- **That status runs nothing of the nested repository's configuration** (release 1 review, 2026-11; as §33.4's): no
  fsmonitor, no hooks (every engine git call, §4), every filter driver it defines off (`-c filter.<driver>.clean=` /
  `smudge=` / `process=` / `required=false`; a driver name git cannot be told about leaves `dirtyFiles` null) and its own
  submodules counted by commit only (`--ignore-submodules=dirty`), plus (release-2 review) the entries of each checked-out
  one, read the same way on its own (one level, at most 20). Before, a repository the turn only named in a read
  (`ls vendor/lib`) had its clean filter run at the turn's end.
- Clients show it as a red banner: "리뷰 밖 변경 — <path> (<kind>, N files): 이 창에서 리뷰되지 않음", with "워크벤치로 열기"
  for a `worktree`.

### 32.3 One odd file never fails a snapshot (robustness-09)

- A file `git add` cannot read (`error: open("x"): Permission denied` / `unable to index file 'x'` — a root-owned log a container
  wrote) is left out of that snapshot and listed in `state.gate.snapshotSkipped: {path, reason: "unreadable"}[]` (A's and B's,
  until the next turn): an untracked one is excluded (`:(exclude,literal)` pathspec — the user's global excludes stay), a
  tracked one keeps its index version (`assume-unchanged` in the temporary index). Its review entry, if any, is
  `uncaptured: true` (never reverted: `not_captured`; `reject_all` skips it, §35.2). More than 500 such files still fail the snapshot.
- A new file outside the sparse-checkout definition (`… outside of your sparse-checkout definition …`) is added with
  `git add -A --sparse` instead of failing; skip-worktree entries stay as they are.
- A repository whose `.gitattributes` uses Git LFS while git-lfs cannot run (not installed / not on the app's PATH) fails with
  a clear message ("git-lfs is not installed … install it (brew install git-lfs && git lfs install) and retry") and the code
  `lfs_missing` instead of `send_failed` / `collect_failed` (for `send` the refusal's code, §35.1; and as the `error` code of a `peer_accept` whose snapshot A
  failed so, §29 — its refusal stays `peer_release_failed:<why>`).

## 33. Permission requests (queue, attribution, persistence) and worktree tools

Audit 2026-10 (agents-01, market-01, robustness-06, daily-04, SME-04, market-14, peer-07), engine part. Everything is
additive — new optional fields, a new command / reply, new settings, new `error` codes; a client that ignores them keeps
working (it shows one card at a time and answers `pendingPermission`, as before). Engine: `engine/src/session/claude.ts`
(`canUseTool`), `engine/src/session/hooks.ts`, `engine/src/session/reviewScope.ts`, `engine/src/session/permissionRules.ts`,
`engine/src/session/allowsStore.ts`, `ReviewEngine`; tests `engine/test/{engine,session}.permqueue.test.ts`,
`session.toolPolicy`, `session.reviewScope`, `session.worktreeGuard`, `engine.worktreeNotice`,
`{session,engine}.permissionRules`, `session.claudeConfig` (§33.9). Checked against the real CLI 2.1.308 (haiku) through the
engine: two parallel subagents' cards answered out of order, a nested-repository edit and `cd`, EnterWorktree, `git worktree
add`, a user rule allowing WebFetch, an edit of `.claude/settings.local.json` (§33.9).

### 33.1 Queue and attribution

```ts
type PermissionAgent = {
  agentId: string;               // the SDK's agentID = the subagent's task id (task_started.task_id = AgentNode.id)
  agentToolUseId?: string;       // the Agent/Task tool_use that spawned it (AgentNode.toolUseId)
  subagentType?: string;         // its subagent_type
  description?: string;
};
type PermissionRequest = {
  requestId: string; toolName: string; input: object; file?: string;   // as before
  toolUseId?: string;            // the call's own tool_use id (tool_use.id)
  agent?: PermissionAgent;       // set when a subagent asks; absent for the main agent
};
```

- **Several requests at once.** Parallel subagents each hold a `can_use_tool` request at the same time (verified, CLI
  2.1.307 / 2.1.308 + SDK 0.3.270: two subagents running `touch a.txt` / `touch b.txt`, two outstanding requests, each with
  its own `agentID` and `toolUseID`; answering the older one ran only that command, the other waited for its own answer). `state.session.pendingPermissions` lists every open request **oldest first** (one
  `permission_request` event each, in that order); `state.session.pendingPermission` is always the first of them — the
  request that has waited longest — so a client that shows one card at a time keeps working. `blockedReason` is
  `awaiting_permission` while any request is open.
- **`permission_response {requestId}`** answers exactly the request it names, wherever it sits in the queue: only that
  request leaves `pendingPermissions`, the others keep waiting. A `requestId` that is not open (already answered,
  withdrawn, a stale card) is refused with `unknown_permission_request` and nothing reaches the CLI — except one the engine
  answered itself this turn (a remembered key / a pattern saved for it, below and §33.6): that is a no-op `ok`. Each
  answered request gets its own `permission` transcript row.
- **Attribution.** `toolUseId` is the call's id (the same id as its `tool_use` event, which arrives first). For a
  subagent's call `agent.agentId` is the SDK's agent id; the engine fills `agentToolUseId` / `subagentType` /
  `description` from `state.hud.agents` (by task id; for CLIs without task messages through the asking call's
  `parentToolUseId`). When the engine has not seen the agent the request carries `agent: {agentId}` only. Clients match
  `agent.agentToolUseId` with `hud.agents[].toolUseId` (that agent is waiting for permission) and label the card with it.
- **Withdrawn requests.** A request the CLI aborts (its call was cancelled, e.g. the subagent was stopped) and every open
  request `interrupt` answers (§28) leave the queue right away; a turn end and a session stop clear it.
- **Remember answers the queue.** `permission_response {allow: true, remember: true}` (§10) also answers every other
  queued request the hooks would now allow without asking (the new remembered key, an allow pattern, the read-only rule,
  the user's rules with the MCP servers' annotations — §35.7), each with its own `permission` row (`allow: true`). Edit tools (they only reach a card for a path outside the review or
  for one of Claude Code's own settings files, §33.9) and requests with a `reason` (§33.3, §33.9) are never answered this way.
- **Several cards at once** (r2-peers; clients only). With two or more open requests that may go together — not a
  question, a plan, a SendMessage, a card whose reason is red (a git command that throws away work or rewrites the
  remote, Claude Code's settings, a worktree command or isolation) or one whose reason the client does not know — the
  first of them offers [대기 중 N개 모두 허용], and a subagent's card offers [이 에이전트의 요청은 이번 턴 동안 허용]: its
  open requests are allowed now and the ones it raises until `turn_end` are answered as they arrive (no card left open,
  no notification). Each is one `permission_response {allow: true}` per request; nothing changes in the engine, and what
  the calls change is reviewed as always. Mac: `PermissionCardOptions.bundles` / `bundle` / `agentBundle`,
  `AppState.allowWaitingPermissions` / `allowAgentForTurn`, `PermissionBulkRow` (test `PeerAutoTests`).
  Electron: the same — `bundles` / `permissionBundle` / `agentBundle` (permissionQueue.ts), the store's
  `allowWaitingPermissions` / `allowAgentForTurn` / `turnAllowedAgents` (storePeer.ts), `PermissionBulkRow` under
  `PermissionCard` (tests `permissionBundle.test.ts`, `permissionCards.test.ts`).

### 33.2 Cross-session tools

`ListAgents` (lists the subagents and local Claude sessions a message could go to) is a read-only tool: it never produces
a `permission_request` and also runs outside a turn (§18). `SendMessage` keeps its card — a message can make
another session act, so it is never auto-allowed by the user's rules (§33.5) nor by a remembered key (`remember: true` on
its card stores nothing, §10 — r2-peers: except for a live session's known conversation, below) and no "always allow" pattern is offered for it; its `input` carries `to` (the receiving session / agent name), `message` and `summary` for the card.

- **A verified recipient in auto mode** (r2-peers). When the engine and the CLI both run auto mode (§39.5), a SendMessage
  whose `to` the session can verify gets no card: the PreToolUse hook leaves it to the CLI (no decision), which sends a
  message to a local session or to a subagent without asking — as in the terminal (CLI 2.1.318's own check asks only for
  a Remote Control / cloud recipient, or with `isolatePeerMachines`; its deny rules still apply). Verified means a
  subagent this CLI process started (its task id, the agent id `to` names — §36.3: the message continues it), or a live
  session of the user's registry (§42.2: the address names a `messagingSocketPath` whose pid is alive; the same lookup
  as the card's `toSession`, bounded at 400 ms). Anything else keeps the card in auto mode too: a bare name (a teammate,
  a session the CLI would route to another machine), an address no live session lists, a lookup that failed or took
  too long. The default, acceptEdits and plan modes keep the card for every recipient. The call stays in the chat as
  its tool row. Engine: `hooks.ts` (`sendMessageDecision`, `HookContext.sendTarget`), `session/peerSend.ts`,
  `ClaudeSession.sendTarget`; tests `engine/test/session.peerSend.test.ts`, `autoMode.test.ts`.
- **"이 세션으로 보내는 메시지는 세션 동안 허용"** (r2-peers). A card whose `toSession` carries the conversation its
  registry entry names (`toSession.sessionId`, §42.2) can be answered `permission_response {allow: true, remember: true}`:
  the engine stores `SendMessage:<session id>` in `state.session.rememberedAllows` (with `persistSessionAllows`, in
  `allows.json` too, §33.7) and answers the other queued SendMessage cards to that conversation (`permission` rows, as
  §33.1's remember does). From then on the PreToolUse hook allows a message to it in every mode (reason `ReviewGate:
  allowed for this session`) once the lookup finds the same conversation live — never a message by name, to another
  session, or to a new conversation of that terminal (`/clear` gives it a new id). Without `sessionId` (no live entry, an
  older registry) `remember` stores nothing, as before; the key an older client stored for every SendMessage
  (`SendMessage:SendMessage`) still allows nothing. Tests `engine.permqueue.test.ts`, `session.peerSend.test.ts`,
  `review.peerAddress.test.ts`. Clients: such a card has a third button, "이 세션으로 보내는 메시지는 세션 동안 허용"
  (⌥⌘↩ / Ctrl+Alt+Enter, as "세션 동안 허용" elsewhere), which answers `remember: true`; a card without
  `toSession.sessionId` or with a `reason` keeps only 보내기 / 거절, and its ⌥⌘↩ does nothing. Mac:
  `PermissionCardOptions.allowsRemember`, `PermissionCard` (test `PeerAutoTests`). Electron: `SendMessageCard`,
  `remembersSession` / `canRemember` in permissionQueue.ts, the store's `respondPermission` (tests
  `sendMessageRemember.test.ts`, `permissionCards.test.ts`).

### 33.3 Locations the review does not see: `reason`

```ts
type PermissionReason = {
  code: "outside_project" | "nested_repository" | "other_worktree" | "worktree_command" | "worktree_isolation"
      | "claude_config"          // §33.9
      | "git_command";           // §46
  message: string;               // English fallback; clients localize on code — and show it as is for a code they do not know
  path?: string;                 // the nested repository / worktree root concerned (absolute, native); claude_config: the settings file
};
```

`permission_request.reason` is set when ReviewGate puts a call on a card *because* it works somewhere this window's review
does not see — or, `claude_config`, because it changes Claude Code's own settings (§33.9); clients show it as a warning line
on the card ("리뷰에 잡히지 않는 위치"). Requests with a `reason` are never answered by a remembered key or an allow pattern
(§33.1), and no "always allow" pattern is offered for them. More codes may come: a client shows `message` for a code it does
not know and treats the card like the others (no "always allow" / "세션 동안 허용").

- **`outside_project`** — an edit tool's target resolves outside the checkpoint root (§4, §8; unchanged behavior, the
  card now says so), or (M23, 2026-11) is a hook, `info/exclude` / `info/sparse-checkout` or `description` in a git dir
  (§4: git's own data and, release-2 review, its configuration there stay denied) — no snapshot of any worktree sees it. Not for a throwaway file: a target in a temporary folder (`os.tmpdir()`, /tmp, /private/tmp,
  /var/tmp, /private/var/folders — where Claude Code keeps its scratchpad) with no `.git` between that folder and the file
  passes without a card and outside the budget (`isScratchPath`, `HookContext.scratchDirs`); a clone or worktree made
  there still asks (`outside_project` / `other_worktree`).
- **`nested_repository`** (audit robustness-06) — the target is inside the root but in a **nested repository**: a
  directory between the root and the file holds a `.git` entry (a clone, a submodule, a linked worktree such as
  `.claude/worktrees/<name>`) or is a submodule `path` in `.gitmodules` (also uninitialized). The snapshot records such a
  directory as one gitlink line, so the edit would never reach the review. Before, it was auto-allowed like any in-root
  edit; now the PreToolUse hook answers `ask` (reason `ReviewGate: edit inside a nested repository …`) and `canUseTool`
  raises the card with `reason.path` = the nested repository's root (the outermost one). Approved edits are listed in
  `changedOutside` like outside edits (§8); the git-dir deny and the budget still come first.
- **`other_worktree`** — an edit outside the root that lands in another worktree of the repository (`git worktree list`;
  e.g. a sibling `../acme-1800`, or the main checkout from a workbench), or a Bash command that runs there (§33.4);
  `reason.path` = that worktree.
- **`worktree_command`** / **`worktree_isolation`** — §33.4.
- **Auto mode** (2026-11, §39.5): an edit that would get `outside_project`, `nested_repository` or `other_worktree` gets no
  card — the CLI decides, and the file is listed in `changedOutside` (§8); `claude_config` keeps its card. A Bash command:
  §33.4.
- **`claude_config`** — an edit tool, a Bash command or a writing MCP call changes `.claude/settings.json`,
  `.claude/settings.local.json` or `.mcp.json` (§33.9); `reason.path` = that file. The location codes above come first.
- **`git_command`** — a Bash command that changes the repository (`git commit`, `merge`, `pull`, `checkout`, `reset`, …;
  §46). The location and settings codes come first.

### 33.4 Worktree tools (audit market-01)

Claude Code's own isolation — `EnterWorktree` (creates `.claude/worktrees/<name>` and moves the session into it), the
`Workflow` tool (its agents run in worktrees), `Agent` / `Task` with `isolation: "worktree"` (a temporary worktree) or
`"remote"`, an `Agent` `cwd` outside the project — and a Bash `git worktree add` / `cd` into another worktree all put
Claude's edits where this window's review never sees them (verified: an edit in `.claude/worktrees/wt1` leaves
`diff-tree A B` empty, the tree only holds the `160000` gitlink). ReviewGate's way to work in parallel is a workbench (§6).

- **`EnterWorktree` runs and the chat follows it** (M05b, 2026-11; §39.4). The PreToolUse hook reads the repository's
  worktrees before it runs (whether this chat made the worktree decides the review baseline there). In auto mode it is the
  CLI's call — no card — and once it ran the engine moves the chat into that worktree's window at once. In the other modes
  it gets the card with `reason = {code: "worktree_command", path: <where it goes>}` — `<root>/.claude/worktrees/<name>`
  for a `name`, the existing worktree its `path` names; no `path` for a random name — so the card offers **"허용하고
  따라가기"**; a plain allow leaves the chat here and its row offers the move. Once it ran, the notice carries the tool
  result's `worktreePath` / `worktreeBranch`. A subagent's `EnterWorktree` moves only that agent: it follows the
  isolated-agent rules below (`worktree_isolation`: a card outside auto mode, the row after it ran; denied with
  `worktree_blocked`, `toolName: "Agent"`, while the user turned isolated agents off — the hook and `canUseTool` alike) and
  the chat never follows it. `ExitWorktree` takes the CLI back; the chat follows it back (§39.4). Before,
  EnterWorktree was always denied ("not available in ReviewGate"), and a worktree-first skill (EnterWorktree, work, commit,
  ExitWorktree) skipped that step or switched this checkout's branch instead.
- **Isolated agents** (`isolation` other than `"none"`, or a `cwd` outside the project / in a nested repository) run
  unless the user turned **`settings.allowWorktreeIsolation`** off (M05b, 2026-11: default true; off, they are denied with
  a reason telling Claude to run the agent without `isolation` / `cwd`). In auto mode they are the CLI's call — no card
  (M05b); in the other modes the card with `permission_request.reason = {code: "worktree_isolation"}` — `autoAllowTools`,
  patterns, remembered keys and the user's rules do not apply. Once such a call ran the warning stays (`worktree_outside_review`
  below; `path` / `branch` from the agent result's `worktreePath` / `worktreeBranch` when the CLI reports them; §39.3's agent
  card says where it worked), and its own edits there are edits in a nested repository (§33.3: listed in `changedOutside`).
  A plain subagent (also one pinned to a folder inside the project) is unaffected. Clients: Settings › Permissions'
  switch reads "다른 워크트리에서 일하는 에이전트 허용 (isolation)" — on unless turned off (before: "격리 worktree 에이전트
  허용 (Workflow, isolation)", off). **The `Workflow` tool** runs in this
  folder like an Agent (M05b: before, it was always an isolated call — denied by default, a card when allowed): what its
  agents change here reaches the review by the turn's snapshot or §52's carry; only a Workflow that may give its agents
  `isolation` is an isolated call. Release-2 review: that is every Workflow whose inline `script` does not provably leave
  it out — the word `isolation` anywhere in its input (a quoted key `"isolation": "worktree"`, `const iso = "worktree";
  agent({isolation: iso})`, spread options, its `args`), or a script that builds code or keys at run time (`\u` / `\x`
  escapes, `eval(`, `Function(`, `import(`, `require(`, `fromCharCode`, a computed key `{[k]: …}`) — and every named or
  file workflow (its file is not read). Before, only `isolation: "worktree"` written out counted, so the others got past
  the user's off switch and, in auto mode, left no worked-outside row for their agents' changes in other worktrees.
- **Bash.** A command containing `git … worktree add …` gets the card with `reason = {code: "worktree_command", path: <the
  new worktree>}`; a command that runs in — or `cd` / `pushd` / `git -C` into — a nested repository or another worktree
  gets `nested_repository` / `other_worktree` with that path (git by its name, §20: `git.exe worktree add`, `GIT -C x`;
  before, Git Bash's `git.exe` reached neither card). "Runs in" uses the CLI's current directory from the hook
  input (the Bash shell's directory after an earlier `cd`). These never ride on `bashAllowPatterns`, a remembered key or
  the user's rules; a read-only command (§10, §19.3: a `cd` / `git -C` into a worktree of this repository included) still
  runs without a card. After one ran:
  `worktree_outside_review` (for a command in another worktree or a nested repository: only when it changed something
  there, with `files`, below). The worktree list is re-read after any command mentioning `worktree`.
  **In auto mode** (2026-11; §39.5: the engine's mode and the hook input's `permission_mode` are `auto`) a command in another
  worktree of the repository or in a nested repository gets **no card**: the hook reads those folders' state for the
  after-notice and goes on to the settings-file (§33.9) and git (§46) checks — a command there that changes Claude Code's
  settings, or throws away uncommitted work or rewrites the remote (`cd ../<wt> && git reset --hard`, `git -C ../<wt>
  clean -f`), keeps that card — and then leaves it to the CLI's own rules and classifier, as in the terminal.
  Those files were never in this window's review; the row after the call lists what changed, and that worktree's own window
  reviews it. So does a `git worktree add` of this repository (not of another one: no chat can follow there): no card, and
  once the worktree is there the engine lists it and says so in a `worktree_outside_review` row whose action moves this chat
  into it (§39.4).
- **Notices.** `error{fatal: false, scope: "session", code, toolName, path?, branch?, files?}` with an English `message`:
  `worktree_blocked` (a deny above: `toolName` = `Workflow` / `Agent` / `Task` — M05b: no longer `EnterWorktree`; a
  subagent's EnterWorktree is `Agent` —, `path` = the agent's `cwd` or the worktree it was entering; at most once per turn
  per tool, path and branch; it sets `state.lastError` like any error) and
  `worktree_outside_review`:
  - an approved worktree command or isolated agent ran (`path` = the new worktree / the agent's): once per turn per tool,
    path and branch; M05b: also an isolated agent in auto mode (no card), and an `EnterWorktree` the chat did not follow
    (`toolName: "EnterWorktree"`, `path` = the worktree it entered — made or already there —, `branch`) or an
    `ExitWorktree` back to another worktree the chat did not follow (`toolName: "ExitWorktree"`, `path` = that worktree,
    §39.4) — rows whose action moves this chat there;
  - a command ran in another worktree or a nested repository (`path` = that worktree / repository root) **and changed
    something there** (2026-11). The Bash hook reads that folder's `git status --porcelain` before the call, with each
    entry's file size and times, and its HEAD, and again after it; `files` (new, optional) lists the paths that differ — a
    new, changed, removed or committed file — and, when HEAD moved there (a commit, a reset, a checkout), the paths the two
    commits differ in (`git diff --name-only <before> <after>`): an edit committed in the same call (`cd ../acme-42 && sed
    -i … && git commit -qam fix`) leaves the status as clean as before and raised no row at all — nothing reviewed it, since
    that worktree's own window takes the move for someone else's commit —, relative to `path`, POSIX, sorted, at most
    100. A call that changed nothing there raises none (before, every approved one did, a `make` that wrote nothing too).
    One notice per call; a file a notice of this turn named already is not named again. Without `files` (git could not
    tell) it only says where. That status runs before any card, so it runs nothing of that folder's configuration: no
    fsmonitor, no hooks (every engine git call, §4), every filter driver it defines off (`-c filter.<driver>.clean=` /
    `smudge=` / `process=` / `required=false`; before, a nested clone's clean filter ran on its `git status`) and its
    submodules compared by commit only (`--ignore-submodules=dirty`: git would run a status inside each one) — release-2
    review: each checked-out one (`git ls-files --stage`, mode 160000) is read the same way on its own, its filter drivers
    off, and its entries count under its path (`inner/x.txt`; two levels, at most 20 per folder). Before, a change inside a
    nested repository's own submodule was not listed.

  `worktree_outside_review` is a row, not a failure: it never sets `state.lastError` (before, it did) and never stops a
  queue; its transcript row keeps `files` (§35.3). Clients show `worktree_blocked` as a banner with **"워크벤치로 열기"**:
  `workbench_create {branch}` for a blocked EnterWorktree (prefilled with `branch`). `worktree_outside_review` is a chat
  row only (2026-11; before, an orange banner), an information row (blue) live and restored alike: *"이 창의 리뷰에 잡히지
  않는 곳에서 바뀌었어요: <path>"* with the files on its second line (the first 8, then *"외 N개"*) — without `files` the
  earlier sentence — and the actions the banner had: **[이 채팅을 거기로 옮기기]** and **[워크벤치로 열기]** when `path` is a
  worktree of this repository (`state.workbenches.list`, §39.4), else **[폴더 열기]**; none on another chat's rows (viewing).
  Two rows naming other files never fold into one ×N.
- **System instruction.** The engine appends its own paragraph after `settings.systemPromptAppend` (separated by a blank
  line): *"ReviewGate reviews every change you make in this folder (<cwd>). …"* — the current wording is in §39.4 — plus
  whether isolated agents may run (M05b: *"Agents with `isolation` and the Workflow tool may run; what they change in other
  worktrees is listed after they ran, and that worktree's own window reviews it."*) or are turned off by the user.

### 33.5 The user's Claude Code allow rules (audit daily-04, SME-04, market-14)

The ask hook runs before the CLI's own `permissions.allow`, so before this every rule the user built up in the terminal
(`mcp__github`, `WebFetch(domain:…)`, `WebSearch`, …) was dead in app sessions and the same read-only lookups raised a card
in every new chat. Now the engine reads the rules itself and applies them to the tools that **cannot change files**; the
review gate keeps priority for everything that can.

- **Files** (re-read at every session start and by `permission_rules`): `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`
  (user — only while user settings load, `loadUserSettings` and no §16 fallback), `<root>/.claude/settings.json`
  (project) and `<root>/.claude/settings.local.json` (local; read for its `permissions` only). `permissions.allow` are the
  rules; `permissions.deny` + `permissions.ask` of the same files block them (a call one of those matches is never
  allowed this way). A missing or broken file is skipped (reported by `permission_rules`).
- **Tools they may allow**: `WebSearch`, `WebFetch` (any URL for a bare rule; `WebFetch(domain:host)` the host,
  case-insensitive; `domain:*.x.com` its subdomains; `domain:*` all), `Agent` / `Task` (one tool for the matcher;
  `Agent(type)` / `Task(type)` = that `subagent_type`; the agent's own calls are gated one by one, isolated agents stay
  blocked, §33.4), `ListAgents`, `ToolSearch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ReadMcpResourceDirTool`,
  `CronList`, and **MCP tools that only read**: `mcp__server` / `mcp__server__*` (every tool of the server, any `*` glob
  over the name) / `mcp__server__tool` (that tool) — a tool counts as a read when the server's annotations say so
  (`readOnly: true`; `destructive: true` or `readOnly: false` never), else when its name has a read verb (`get`, `list`,
  `search`, `read`, `query`, `find`, `fetch`, `describe`, `show`, `view`, `lookup`, `count`, `retrieve`, `resolve`, …) and no
  write verb (`create`, `update`, `delete`, `write`, `set`, `add`, `send`, `execute`, `run`, `drop`, `upload`, `push`, …).
  MCP names are the CLI's (`mcp__<server>__<tool>`, characters outside `[A-Za-z0-9_-]` → `_`; annotations come from the
  live `mcpServerStatus()`, §22).
- **Never**: edit tools (inside the project they are allowed anyway and reviewed; outside it they must ask), `SendMessage`
  (§33.2), the worktree / plan tools, and anything else.
- **`Bash(…)` rules** (2026-11, r2 M20; before, they only could be imported as app patterns, §33.8): with
  **`settings.applyUserBashRules`** (default true; live; only while `applyUserAllowRules` is on) the user's / project's
  `Bash(mvn:*)` allow rules count like the app's allow patterns (`matchesAllowPatterns`, §19.3 — every simple command must
  match one of them; a harmless redirection, a leading `cd` into the repository and trailing read-only filters left out); a
  deny / ask `Bash(…)` rule matching any simple command of the line — a bare `Bash` one: every line — keeps the card, and a
  bare `Bash` allow rule (every command) never applies. Release-2 review: nor does one that covers every command written
  another way (`bashClass.isBroadBashPattern`: no program or a glob where it goes — `Bash(*)`, `Bash(:*)`, `Bash(* *)`,
  `Bash(?*)` — or a program that runs whatever follows it — `Bash(sh:*)`, `Bash(bash -c:*)`, `Bash(env:*)`, `Bash(sudo:*)`,
  `Bash(xargs:*)`, `Bash(eval:*)`, …; `permission_rules` lists it `ignored`, `why: "bash"`, `importAs: null`), and the
  rules of the project's shared `.claude/settings.json` never apply this way: that file comes with the repository — a cloned
  one's `"allow": ["Bash(curl:*)"]` ran every such line with no card, where the terminal applies it only after its
  workspace-trust question. They are listed `ignored` with `why: "bash"` and import as app patterns (§33.8), as before M20;
  the user's (`~/.claude/settings.json`) and the local file's (`.claude/settings.local.json`, where the terminal's "don't ask
  again" writes) apply. Reason `ReviewGate: allowed by your Claude Code settings`; the reason
  cards (§33.3–33.4, §33.9, §46) are decided before any rule, and files the command changes are reviewed as always.
  `UserRules.bash` carries the switch into the session; `permission_rules` lists such a rule `applied` with
  `why: "bash_rule"` (nothing to import) and replies `applyUserBashRules`; with the switch off it reads `bash` as before.
  Both clients show the switch under the terminal allow rules ("터미널의 Bash 허용 규칙도 적용"; off, saying why, while those
  are off). A call allowed this way gets the hook answer `allow` with the reason `ReviewGate: allowed by your Claude Code
  settings` (no card; `canUseTool` applies the same rule). The unprompted guard (§18), plan mode (§19.4) and §33.3–33.4
  come first.
- **`settings.applyUserAllowRules`** (default true) turns this off — live: the running session drops (or re-reads) the
  rules at once.
- **A running skill's `allowed-tools`** (2026-11, r2 M20; `engine/src/session/skillTools.ts`). A SKILL.md / command .md may
  pre-allow what it runs (`allowed-tools: Bash(git add:*), Bash(git status:*), mcp__tracker__get_issue` — a comma or space
  list, a `[…]` flow list or a YAML list under the key; `allowed_tools` too). The terminal runs those calls without asking
  while the skill runs; in default mode the app put each on a card (auto mode had it from release 1: the CLI judges there).
  Now the engine reads the list when a skill starts — a `Skill` call (its `skill` input; release-2 review: once the call
  succeeded, in its PostToolUse hook — before, in its PreToolUse) or a message
  that runs a slash command (`send` of one of the session's commands, §36.13: `/acme-verify --fast`) — from the first file
  that exists of `<project>/.claude/skills/<name>/SKILL.md`, `<project>/.claude/commands/<name>.md` (`a:b` →
  `commands/a/b.md`), the same under `<CLAUDE_CONFIG_DIR or ~/.claude>` (while user settings load) and, for `plugin:name`,
  the session's plugin of that name (`skills/<name>/SKILL.md`, `commands/<name>.md`). The entries are the **turn's** allow
  patterns (`HookContext.turnAllowPatterns`, reset when the turn ends): a Bash call that `matchesAllowPattern` one of them
  (§19.3: a leading `cd` into the repository, `2>&1`, a trailing `| tail` left out) or another call that `matchesToolPattern`
  one (§33.6 forms) is allowed by the hooks and `canUseTool` with the reason `ReviewGate: allowed by the running skill's
  allowed-tools` — in every mode, after the read-only rule and the app's patterns, before remembered keys and the user's
  rules. Never an edit tool, `SendMessage`, a worktree / plan tool (no pattern names those) nor a call with a reason card
  (§33.3–33.4, §33.9, the destructive git card of §46 — decided before any pattern). A name with a path separator or `..` is
  never looked up. Release-2 review: a file Claude may have written gives nothing — one changed at or after the turn's start
  (its content or its inode: the later of mtime and ctime of the file and of a symlink in its place; ctime no command can
  set back; a slash command's file: changed before its message) or one of this project's files still under review
  (pending / changes requested). In default mode an edit inside the project runs without a card, so `.claude/skills/x/
  SKILL.md` with `allowed-tools: Bash(*)` and then `Skill x` pre-allowed every later command of the turn, subagents' too.
  And a pattern that covers every command is never taken from a skill (`isBroadBashPattern`, as for the user's rules:
  `Bash(*)`, `Bash(:*)`, `Bash(sh:*)`, `Bash(env:*)`, a bare `Bash`).

### 33.6 "Always allow in this project" beyond Bash

The clients' per-project "always allow" list travels as `settings.bashAllowPatterns` (merged with the global one). Besides
the Bash forms (§10, §19.3) an entry may now name another call: `mcp__server__tool`, `mcp__server__*` / `mcp__server`
(the whole server, writes included — the user chose it in the app), `WebFetch(domain:host)` / `WebFetch`, `WebSearch`,
`Agent` / `Task` (`(type)` optional) and the other non-mutating tools of §33.5 by name. Never edit tools, `SendMessage` or the
worktree / plan tools; a request with a `reason` (§33.3) is never covered. Matched in the PreToolUse hook (reason
`ReviewGate: matches an allow pattern`) and in `canUseTool`, live with `set_settings`.

- **Per repository (2026-11, r2 M21).** `state.project.commonDir?: string` is the repository's `git rev-parse --git-common-dir`
  (absolute; the same for every worktree of it). The clients keep their "이 프로젝트에서 항상 허용" list by it — one list for the
  repository and all its worktrees and workbenches (a list kept by a worktree's own path before still applies to that worktree,
  merged in) — and the card also offers "모든 프로젝트에서 허용" (the global list). Either way the engine gets one merged
  `settings.bashAllowPatterns`, and the repository's other open windows get the new list at once (the Mac sends every
  window's engine its merged list; the Windows client's main merges it into every window of that repository).
- **`permission_request.allowPatterns`**: what the card's "이 프로젝트에서 항상 허용" may store, most specific first —
  `["mcp__github__get_issue", "mcp__github__*"]`, `["WebFetch(domain:docs.spring.io)"]` (host lower-cased),
  `["WebSearch"]`, `["Agent"]` — then (2026-11, r2 M21) the CLI's own "don't ask again" rules for the call (`canUseTool`'s
  `options.suggestions`: `addRules` with `behavior: "allow"`, rules of this very tool, as `Tool(content)` / `Tool`, in the
  CLI's order; `cliSuggestionPatterns`). So for **Bash** the list holds the CLI's suggestions only (`["Bash(./mvnw test:*)"]` for
  `cd /work/acme && ./mvnw -q test 2>&1 | tail -30`, which no client derived anything for); clients offer the pattern they
  derive themselves first and these after it. Never a bare `Bash`, a Bash rule holding a shell operator, an edit tool,
  `SendMessage` or a worktree / plan tool; absent when nothing is left, and for any request with a `reason`. The client saves the chosen pattern, sends `set_settings
  {bashAllowPatterns}`, then answers the card; queued requests the new pattern covers are answered by the engine
  (§33.1), and a `permission_response` that arrives for one of those afterwards is a no-op `ok` (not
  `unknown_permission_request`).

### 33.7 Remembered allows per repository

`settings.persistSessionAllows` (**default true** since 2026-11, r2 M21; it was false — what the user allowed for a session
vanished on project close and app restart): every `permission_response {allow: true, remember: true}` key (§10, §19.3) is
also written to `<git common dir>/reviewgate/allows.json` (`{version: 1, keys: string[], savedAt}`, atomic) and `open_project`
starts with them (`state.session.rememberedAllows`) — after an app restart, a new chat or reopening the project. Every
worktree of the repository (a workbench too) shares the file: a save adds the engine's keys to what the file holds (another
worktree's window may have stored some meanwhile); an engine that is open already learns them at its next `open_project`.
A set an older engine kept in a worktree's own gitdir (`<gitdir>/reviewgate/allows.json`) is read too on open and moves into
the shared file at the next save. `forget_allows` empties the set (the repository's set is gone for every worktree) —
release-2 review: by writing the shared file empty with `clearedAt` (`{version: 1, keys: [], savedAt, clearedAt}`) and
deleting a worktree's own older file. A window open on another worktree of the repository drops every key it learned
before that clear — when its next turn starts (`send` reads the file) and before its next save (which used to merge its
whole set back into the file, so A's next `open_project` brought the cleared `Bash:git push` back) —; keys remembered there
since stay. Turning the setting on writes the current set at once, turning it off deletes the files. With
`persistSessionAllows: false` nothing is read or written (the §10 behavior). Clients send the setting on by default (Mac
`AppSettings.persistSessionAllows` unset → true, Electron `persistSessionAllows !== false`). Electron's `settings.json` holds
every default it was saved with, so the `false` a file saved before the change carries (the old default, not a choice) is
read as unset once: a file without `defaultsVersion` (main's `DEFAULTS_VERSION` 1, written with the next save) drops it,
and a choice saved since stays. The same goes for the two other defaults release 2 changed: `allowWorktreeIsolation`
`false` (now on, §33.4) and `peerInbound` `"ask"` (now `"auto"`, §29).

### 33.8 `permission_rules`: what the app applies, what it ignores, what can be imported

```ts
type PermissionRuleSource = { scope: "user" | "project" | "local"; path: string; exists: boolean; error?: string };
type UserPermissionRule = {
  rule: string;                  // as written: "mcp__github", "Bash(./gradlew:*)", "WebFetch(domain:docs.spring.io)"
  source: "user" | "project" | "local";
  status: "applied" | "ignored";
  why: "non_mutating_tool" | "read_mcp_tool" | "read_mcp_tools" | "already_allowed"            // applied
     | "bash_rule"                                                                              // applied (r2 M20)
     | "mutating_mcp_tool" | "bash" | "edit_tool" | "send_message" | "unsupported" | "invalid"   // ignored
     | "rules_off" | "user_settings_off" | "local_settings_off";                                  // ignored by a switch (local: §36.6)
  importAs: string | null;       // the app allow pattern (§33.6) importing it adds; null = cannot / need not be imported
};
```

`permission_rules` (lane `query`; `no_project` without a project) → `permission_rules {sources, rules, defaultMode,
defaultModeSupported, applyUserAllowRules, applyUserBashRules, loadUserSettings}`: every `permissions.allow` entry of the three files (user →
project → local; user rules skipped because user settings are off come last with `why: "user_settings_off"`), and
`defaultMode` = `permissions.defaultMode` of the most specific file that sets it (`defaultModeSupported` when it is one of
the four modes of §11 — `bypassPermissions` / `dontAsk` are not).

- `applied`: `non_mutating_tool` (§33.5 tools), `read_mcp_tool` (one MCP tool judged a read), `read_mcp_tools` (a server /
  glob rule: applied to its read tools; `importAs: "mcp__server__*"` covers its writes too), `already_allowed` (Read, Grep,
  … never ask anyway).
- `applied` `bash_rule` (r2 M20): a `Bash(…)` rule while `applyUserBashRules` is on (`importAs` null).
- `ignored`: `mutating_mcp_tool` (`importAs` = the rule), `bash` (with `applyUserBashRules: false`; `importAs` = the rule, e.g.
  `Bash(./gradlew:*)`; a bare `Bash` has none — nor is it ever applied), `edit_tool`, `send_message`, `unsupported` (another tool, or a content form the matcher does not know),
  `invalid`; with `applyUserAllowRules: false` every rule that would apply reads `rules_off` (`importAs` = what makes it apply
  as an app pattern instead).
- **Import** is the client's: it shows the rows (preview), the user ticks the ones to take over, and the client appends their
  `importAs` to its global or this project's allow list and sends `set_settings {bashAllowPatterns}`. Nothing is written to
  the Claude Code settings files. The client may also offer `defaultMode` (when supported) as `settings.permissionMode` on
  first run ("터미널처럼 auto 모드로 시작할까요?").

### 33.9 Claude Code's own settings files: `claude_config`

Follow-up of the first integration (the §32 / §33.5 interplay). `.claude/settings.json`, `.claude/settings.local.json` and
`.mcp.json` decide which hooks run, which tools Claude may use and which MCP servers start. A hook added there runs from the
next tool call or session on; the local file's `permissions.allow` rules reach app sessions from the next session start
(§33.5 — a prompt-injected `WebFetch(domain:attacker)` would then send without a card); and `.claude/settings.local.json` is
not even in the review (§32: never captured, a change is reported by hash only and cannot be reverted). Before this, an edit
to one was auto-allowed like any edit inside the root. Now every change Claude makes to them goes on the card — M22
(2026-11): in auto mode only a change to the keys that take effect before the review could reject it (below):

```ts
// PermissionReason (§33.3) with
code: "claude_config";
path: string;      // the settings file (absolute, native): an edit tool's target as named, or what a symlink there points at
message: string;   // "Changes Claude Code's own settings (<path, project-relative / ~/…>[: <keys>]) — hooks, permissions and MCP
                   //  servers there change how Claude runs; .claude/settings.local.json is not kept in the review and cannot be reverted."
keys?: string[];   // M22, new, optional: what an edit tool's change to settings.json / settings.local.json changes that takes
                   //  effect first — top-level keys ("hooks", "permissions", "mcpServers", …) and "env.<NAME>"; absent when it
                   //  cannot be told (a Bash command, .mcp.json, a file that is no JSON, an edit whose text is not there)
```

- **Which files.** A path whose last component is `.mcp.json`, or `settings.json` / `settings.local.json` in a folder named
  `.claude` — at the project root or anywhere below it (`modules/api/.claude/settings.json`: the CLI may be started there) —
  compared case-insensitively (on Windows trailing dots / spaces dropped). Also the CLI's own `.claude.json`
  (`~/.claude.json`, `$CLAUDE_CONFIG_DIR/.claude.json`: user and local MCP servers, a project's enabled `.mcp.json`
  servers) and an installed plugin's `hooks/hooks.json` / `.claude-plugin/plugin.json` (its hooks and MCP servers) under
  Claude Code's plugins folder (`~/.claude/plugins/…`, `$CLAUDE_CONFIG_DIR/plugins/…`; a plugin written in a project is
  not one) — before, in auto mode an `Edit` of `~/.claude.json`'s `mcpServers` or a plugin's `hooks.json` ran without a
  card (§39.5 left edits outside the project to the CLI), to start a server or a hook at the next session that no review
  can undo. A Bash word that resolves to one of them counts too (`jq … ~/.claude.json > x && mv x ~/.claude.json`). The
  edit hook looks for a settings file before Claude's memory folder (§8), so one reached through a symlink there asks too.
  Other mods paths (§32: hook scripts, agents, commands, skills, `CLAUDE.md`) keep today's flow: auto-allowed, reviewed,
  revertible.
- **Edit tools** (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) on such a file: the PreToolUse hook answers `ask` (reason
  `ReviewGate: changes Claude Code's own settings (hooks, permissions, MCP servers) — needs approval`) and `canUseTool` raises
  the card with the reason — for `settings.json` / `settings.local.json` in a `.claude` folder with `keys`: the hook applies
  the call (`Write`'s content; `Edit` / `MultiEdit` to the file as it is) and compares the JSON key by key.
  **In auto mode** (M22, 2026-11; the engine's mode and the hook input's `permission_mode`, §39.5) a change limited to keys
  that neither run code nor widen what Claude may do gets no card: the CLI decides, as in the terminal, and the change is
  reviewed afterwards (`.claude/settings.json` in the mods group, §32; `settings.local.json` by `local_settings_changed`; a
  settings file outside the project in `changedOutside`; `canUseTool` allows it like any edit in the project should the CLI
  ask). Harmless: `env` — except a variable that runs code in what the CLI starts or sends its traffic elsewhere (`PATH`,
  `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `SHELL`, `PYTHONSTARTUP` / `PYTHONPATH`, `PERL5OPT`,
  `RUBYOPT`, `JAVA_TOOL_OPTIONS`, `GIT_*`, `*ASKPASS`, `*_PROXY`, TLS / certificate variables, `ANTHROPIC_*`, `*_BASE_URL`,
  `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_SHELL*`, `CLAUDE_CODE_USE_*`; release-2 review, also every `CLAUDE_*` but a few that only
  limit or quiet the CLI (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`,
  `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`, `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`) —
  `CLAUDE_ENV_FILE` is sourced before every Bash command, `CLAUDE_CODE_GIT_BASH_PATH` is Windows' shell,
  `CLAUDE_CODE_ENABLE_TELEMETRY` with `OTEL_*` sends the prompts elsewhere —, `HOME`, `XDG_*`, `TMPDIR` / `TMP` / `TEMP`,
  `AWS_*`, `GOOGLE_*`, `CLOUDSDK_*`, `AZURE_*` (a `credential_process` or an executable-sourced credential runs when the CLI
  starts on Bedrock / Vertex), `OTEL_*`, `EDITOR`, `VISUAL`, `PAGER`, `MANPAGER`, `BROWSER`, `NPM_CONFIG_*`, `YARN_*`,
  `PIP_*`, `UV_*`, `GEM_*`, `SSH_*`, every `PYTHON*` / `PERL*` / `RUBY*`, `IFS`, `CDPATH`, `SHELLOPTS`, `BASHOPTS`,
  `GCONV_PATH`, `LUA_INIT*`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`: the engine starts a new CLI for every new chat or
  project switch, so these took effect before the review) —, `model`, `effortLevel`, `alwaysThinkingEnabled`,
  `outputStyle`, `language`, `theme`, `attribution`, `includeCoAuthoredBy`, `includeGitInstructions`, `respectGitignore`
  and the display settings (`verbose`, `spinnerTipsEnabled`, `showTurnDuration`, `timeFormat`, …).
  Every other key keeps the card with `keys` — `hooks`, `permissions`, `mcpServers` / `enabledMcpjsonServers` /
  `enableAllProjectMcpServers`, `apiKeyHelper`, `statusLine`, `awsAuthRefresh`, `otelHeadersHelper`, `sandbox`,
  `enabledPlugins`, `disableAllHooks`, `plansDirectory`, `cleanupPeriodDays` (the CLI deletes older chat transcripts by it
  when it next starts — every one at 0 —, a start that may come before the review) and any key not named here (an allow
  list) —, and so does a call
  whose change cannot be told (`.mcp.json`, `~/.claude.json` and a plugin's files are all servers and hooks; a file that is no
  JSON before or after; an edit whose text is not there). Taking a risky key away is a change of it too. In the other modes
  every change keeps the card (with `keys` when they can be told). Before, an env line in `.claude/settings.json` was a red
  card in auto mode too, and setting-up skills (permissions clean-up, MCP servers, schedulers) stopped at every step. A location reason comes first: a settings file outside the root is `outside_project` /
  `other_worktree`, one in a nested repository `nested_repository` (the same protection; they keep their §8 / §33.4
  behaviors). The git-dir deny, plan mode (§19.4), the unprompted guard (§18) and the budget still come before the card.
- **Bash.** A command that writes one gets the card with the reason even when `bashAllowPatterns`, a remembered key or
  `autoAllowTools` would allow it — M22 (2026-11): only as a write target. A file the command writes (`shellWrites.
  writtenFiles`: a redirection's file, the operands of `rm` / `mv` / `tee` / `truncate`, the target of `cp` / `ln` /
  `install`, `dd of=`, the files of `sed -i` / `perl -i`, also in a script a shell runs) that resolves — against the folder
  its command runs in, after the line's own `cd` / `pushd` (also one inside a subshell or a brace group, §35.6) — to such a
  file (`> .mcp.json`, `cd .claude && sed -i … settings.json`, `cp x modules/api/.claude/settings.json`, `mv /tmp/c.json
  ~/.claude.json`, `echo x >> ~/.claude/settings.json`, a name split by quotes), or one named in the command of an
  interpreter whose inline script writes (`python3 -c "…open('.claude/settings.local.json','w')…"`, a here-document given to
  `python3 -`, `node -e "…writeFileSync(process.argv[1], …)" settings.local.json`: a word of that command, else a mention of
  `settings.local.json`, `.claude/settings.json` or `.mcp.json` there — `path` = the project's own file then). A command
  that only reads or names one — `python3 -c "…json.load(open('.claude/settings.json'))…"`, `cp .mcp.json /tmp/x`, `grep
  hooks .claude/settings.json`, an `echo` mentioning one — gets no such card: like any command, the default mode's ordinary
  card or auto mode's classifier decides (before, any mention did; read-only commands — §10: `cat`, `jq`, `git diff` — never
  did). Release-2 review: a command whose writes its words do not tell keeps the rule from before M22 — it gets the card
  when it names such a file (`shellWrites.opaqueWriters`): any program the scanner does not model (`curl -o`, `wget -O`,
  `yq -i`, `jq … | sponge <file>`, `unzip`, `tar`, `sed` / `perl` without `-i`, a script file such as `python3
  fix_settings.py .claude/settings.local.json`), a git verb that writes the paths it is given (`checkout … -- <file>`,
  `restore`, `stash push`, `apply`, `rm` without `--cached`, `mv`, `clean`, …, and any one with `--output`), and an inline
  script that copies, appends, links or starts a program (`fs.cpSync`, `appendFileSync`, `symlinkSync`, `os.system(…)`,
  `subprocess`, `child_process`). Only the readers (`cat`, `grep`, `jq`, `diff`, `ls`, `echo`, …), the writers whose targets
  it reads (`cp`, `mv`, `rm`, `tee`, `ln`, `dd`, `sed -i`, `touch`, …: the file is a read source unless it is their target),
  an inline script that only reads and git's other verbs (`diff`, `log`, `show`, `add`, `commit`, `rm --cached`, …) name one
  without the card. A line that writes files it does not name — a written path only the run decides (`> "$out"`, `cp x
  "$(…)"`) or a writing command handed more arguments at run time (`echo .claude/settings.json | xargs rm`, `find -exec`) —
  gets the card for any such file it names. (Before this, M22 let `curl -so .claude/settings.local.json …` or `git checkout
  origin/x -- .claude/settings.json` run on a matching pattern, a remembered key or a user rule with no card.) A
  `settings.json` outside a `.claude` folder (`.vscode/settings.json`) is not one. The match is textual: a command that
  assembles the name at run time (`$VAR`, `printf`) or a script file that writes one without naming it is not recognized —
  what it changed is reported after the turn (§32).
- **MCP tools** that may write (not judged a read, §33.5) get the same card when their input names such a file in a
  path-like value (no whitespace: `path`, `pathInProject`, `file`, nested `edits[].file`, a `file://` URI — relative ones are
  the project's; under a one-path key such as `path` / `file_path` / `destination` spaces too, §35.6) or in a command-line value (`command`, `cmd`, `script`, … — read like Bash), also when an app pattern allows
  the server (`mcp__idea__*`). Free text (a file's new content, a message) never counts.
- **Like the other reasons**: never answered by a remembered key, an allow pattern, `autoAllowTools`, the user's rules or a
  pattern saved while the card waits (§33.1, §33.6), no `allowPatterns` on the request — in every permission mode: the hook's
  `ask` reaches `canUseTool` in `acceptEdits` and `auto` too (CLI 2.1.308; for `.claude/settings.local.json` the CLI even
  asks by itself in acceptEdits). `permission_response` is unchanged; clients hide "이 프로젝트에서 항상 허용" and
  "세션 동안 허용" on the card, like for every reason.
- **After approval** the change is not outside the review: an approved settings file never goes to `changedOutside` (§8) and
  raises no `worktree_outside_review`. `.claude/settings.json` / `.mcp.json` are in the review's mods group with their risks
  (§32); `.claude/settings.local.json` is reported by `local_settings_changed` when the turn ends. A denied card leaves the
  file as it was (the CLI gets the deny).
- Clients show a warning line on the card — "Claude Code 설정 파일({path})을 바꿉니다 — 훅·권한·MCP 설정이 바뀌며,
  settings.local.json 은 리뷰에 남지 않아 되돌릴 수 없습니다"; M22, with `keys`: "Claude Code 설정을 바꿔요 ({path}:
  {keys}) — 리뷰보다 먼저 적용돼서 리뷰로 되돌릴 수 없어요" (the keys as the engine sends them, comma-separated) — and
  `message` for a reason code they do not know.
- Verified with the real CLI 2.1.308 (haiku, driver-perms step K, each attempt in a new chat): asked to add an allow rule to
  `.claude/settings.local.json`, an `Edit` in the default mode, an `Edit` in `acceptEdits` and `cp allow-rules.json
  .claude/settings.local.json` while the app pattern `Bash(cp:*)` was set each reached the card with `claude_config` (no
  `allowPatterns`); denied, the file stayed byte-identical and no `local_settings_changed` followed.
- Engine: `engine/src/session/reviewScope.ts` (`isClaudeConfigPath`, `claudeConfigFile`, `bashClaudeConfigTarget`,
  `inputClaudeConfigTarget`, `claudeConfigReason`), `hooks.ts` (`configScopeReason`, the edit / Bash / MCP hooks),
  `claude.ts` (`canUseTool`); tests `engine/test/session.claudeConfig.test.ts`, `engine.permqueue.test.ts`; real CLI:
  `sidecar/test/driver-perms.mjs` step K.

### 33.10 A deny that stops, like the terminal's "No" (r2-chats-cards M25)

A denied card used to tell Claude only "Denied by user" (the clients' words), and Claude went on with the next step or a
workaround — which could raise the next card. Additive on the wire:

```ts
permission_response + interrupt?: boolean   // with allow: false — "멈추기": the deny also ends the turn, like Stop
                    + skip?: boolean        // with allow: false and no message — "건너뛰고 계속": Claude goes on without the call
```

- **A plain deny** (`allow: false`, no `message`) says what the terminal's "No" says — the CLI's own words: "The user
  doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT
  written to the file). STOP what you are doing and wait for the user to tell you how to proceed." Claude stops and ends
  its turn (normally: `turn_end.stopReason` is the CLI result's `"success"`, not `"interrupted"`); the turn's changes are
  collected as always.
- **`message`** is the user's reason exactly as written ("거절하고 지시…", a skipped question) — Claude reads it as the
  answer to its call and follows it in the same turn. It wins over `skip`.
- **`skip: true`** without a message: "The user skipped this tool call; it did not run. Continue with the rest of the
  task without it." — what a deny meant before.
- **`interrupt: true`** ("멈추기"): the deny also stops the turn (the SDK's `interrupt` on the deny), marked as the app's
  own interrupt, so `turn_end.stopReason` is `"interrupted"` as after Stop (§28) — never an error. A subagent's card
  (`agent` set, §33.1) never interrupts: that agent gets the deny, the other agents and the main turn keep running.
  Ignored with `allow: true`.
- Each answer leaves the queue and gets its `permission` row as before (§33.1). An older engine ignores both fields: a
  plain deny there is its old "Denied by user".
- **Clients (r2-chats-cards M24 / M25).** [거부] (⌘⌫ with an empty message box) is the plain deny; its menu has
  "건너뛰고 계속" (`skip`) and — on the main agent's card — "거부하고 멈추기" (`interrupt`); "거부하고 지시…" sends the
  text. While a card waits and the message box holds text, the send key (↩, or ⌘↩ when ↩ makes a new line) denies that
  card — the shortcut target, §33.1 — with the text as `message`: Claude follows it in the same turn instead of the text
  waiting behind the card. The hint reads "↩ 이 지시로 거부하고 계속 · ⌥⌘↩ 중단하고 보내기" and the send button "이 지시로
  거부" (its menu: "바로 보내기" — the text waits behind the card —, "대기열에 추가", "중단하고 보내기"). With the card focused,
  the terminal's keys: 1 allows once, 2 for the session (when the card offers it), 3 opens "거부하고 지시…"; a red card (a
  destructive git command, a worktree command, Claude Code's settings — §33.3, §46) is allowed only with ⌘↩ or a click.
  Mac: Core `CardShortcuts` (`.digit`, `.denyWithDraft`, `.openDenyInstruction`), `AppState+CardAnswers.swift`
  (`denyPermission`, `PermissionDenial`, `cardAnsweredByDraft`), `PermissionCard.swift`, `ChatComposer.swift`; tests
  `CardShortcutsTests`, `CardAnswersTests`. Electron (M25): [거부] and its ▾ menu in `PermissionCard.tsx`, [거절] of a
  SendMessage card without words (`SendMessageCard.tsx`), store `respondPermission(…, deny)`; test `permissionStore.test.ts`.
  Electron (M24): the composer sends with ⌘↩ (Ctrl+Enter), so the hint reads "⌘↩ 이 지시로 거부하고 계속 · ⌥⌘↩ 중단하고
  보내기" (`sendNow.ts` `primarySend` / `composerEnter` "deny", `Composer.tsx`); the focused card's 1 / 2 / 3 are
  `permissionKeys.ts` `cardDigit`, and esc there goes back to the message box; test `cardDigits.test.ts`.
- Engine: `engine/src/session/claude.ts` (`respondPermission`, `USER_DENIED_MESSAGE`, `USER_SKIPPED_MESSAGE`),
  `engine.ts` (`permission_response`); tests `engine/test/session.denyStop.test.ts`, `engine.denyStop.test.ts`. Against
  the real CLI: `sidecar/test/driver-denystop.mjs` (three turns, each asking for `touch <a>` then `touch <b>`; CLI 2.1.319,
  haiku): a plain deny — no further card or tool call, neither file, the turn ends `success` with Claude saying it waits;
  `skip` — the card for `touch <b>` follows; `interrupt` — the turn ends `interrupted` at once, no error.

## 34. Review round 2: review while Claude works, per-turn deltas, line detail, a sourced "why"

"틈틈이 리뷰": the diff being read survives a send, what this turn / the follow-up to a request / the turn after an accept
changed is its own diff, long lines and in-line changes are visible, and "why" says where it comes from. Additive: optional
fields everywhere, two commands (`live_changes`, `live_diff`), one reply event, two command fields (`since`,
`expectedBaseTree`), one setting. Engine: `review/gate.ts` (trees, ranges, notes), `engine.ts`, `review/summary.ts`,
`session/claude.ts`, `session/toolOutput.ts`, `diff/parse.ts` (+ the segment pass).

```ts
type DiffSince = "review" | "turn" | "request" | "accepted";      // absent = "review"
type ChangeTotals = { files: number; added: number; deleted: number };
type FileWhy = {
  text: string | null; source: "reported" | "same_message" | "earlier" | "none";
  age?: number;                    // earlier: the agent's tool calls between the text and the change
  toolUseId?: string;              // same_message / earlier: the call whose rationale it is
  agent?: { toolUseId: string; subagentType?: string };   // the text is a subagent's
  delegation?: string;             // the change ran in a subagent: the main agent's text before that Agent call
  turn?: number;
};
type LastTest = { verdict: "pass" | "fail"; command: string; toolUseId: string; at: string; afterLastEdit: boolean; runs: number };
type LiveChangedFile = { path; oldPath; status; added; deleted; isBinary; inReview: boolean; generated?: GeneratedKind };
type GeneratedKind = "lockfile" | "generated" | "minified";
// state.gate: reviewEndTree: string | null; reviewTurns: number[]; lastTurnChanges: ChangeTotals & { turn } | null;
//             lastRequest: { turn: number; at: string; notes: number } | null
// state.changedFiles[]: changedThisTurn?: true; turnAdded?; turnDeleted?; blob?: string; changedSinceAccepted?: true;
//             changedSinceRequest?: true; generated?: GeneratedKind; whitespaceOnly?: true; sentNoteCount?: number; why?: FileWhy
//             (noteCount: unsent notes only); rejectScheduled?: true (M32, §34.2)
// state.reviewNotes[]: sent?: { at: string; turn: number }; anchor?: "moved" | "gone"
// state.hud.turnFiles: number
// FileDiff.segmentsLimited?: true; DiffLine.segments?: [start, end][]; DiffLine.wsOnly?: true
// file_diff: scope "turn" | "pr" | "live"; since?; baseTree?; stale?: true      full_file_content: since?; stale?: true; endTree?
// tool_use (+ transcript row): rationaleSource?: "same_message" | "earlier"; rationaleAge?: number
// turn_end (+ row): files / added / deleted / external = THIS turn; review?: ChangeTotals; merged?: true
// turn_summary: files = THIS turn's files (files[].whyDetail?, reviewAdds?, reviewDels?); review?; merged?; lastTest?: LastTest | null
// review_history: current?: ReviewHistoryEntry | null (inProgress: true)
// commands: select_file { path, since? } | full_file { path, since? } | reject_hunks { …, expectedBaseTree? }
//           | live_changes → live_changes | live_diff { path } → file_diff {scope:"live"}
// settings: testCommandPatterns?: string[]
```

### 34.1 Trees and ranges

| tree | what it is | lifetime |
| --- | --- | --- |
| A (`gate.turnStartTree`) | the review's baseline (kept across question / request-changes follow-ups, §3) | the review |
| B (`gate.turnEndTree`) | the last collected end (re-snapshotted by reject / refresh / commit) | null while a turn runs |
| held B | B when a `send` / `request_changes` on a standing review cleared it | until that turn's collection |
| `gate.reviewEndTree` | `turnEndTree ?? held B`: what the list, every diff and `blob` refer to | null without a review |
| turn base | the last collected turn's own start tree (§26 record `startTree`; = A for a fresh turn) | replaced at each collection |
| request tree | B when the last `request_changes` was sent | until the round ends |
| accepted tree (per file) | B when the file was accepted (the held B for an accept during a turn, §34.2) | until the file leaves / the round ends |
| live tree | a snapshot taken for `live_changes` (reused while ≤ 2 s old) | the running turn |

`select_file` / `full_file` take `since`; the new side is always `reviewEndTree`, the old side:

| `since` | old side | client label |
| --- | --- | --- |
| `review` (absent) | A | 전체 |
| `turn` | turn base | 이번 턴 |
| `request` | request tree | 요청 이후 |
| `accepted` | the file's accepted tree | 수락 이후 |

- A range whose base is known always answers (possibly with no hunks: "이 범위에는 변경 없음"); otherwise refused
  `range_unavailable:<since>` (`code: "range_unavailable"`) — `turn` before a review's first collection, `request` without a
  request in this review, `accepted` for a file that was never accepted. Any other `since` value: `invalid_since`. The path
  must be in `changedFiles` (`not_a_changed_file`); renames are followed (`-M`) between the two trees.
- `file_diff` (scope `turn`) carries `baseTree` (always), `endTree` = `reviewEndTree`, `since` (omitted for `review`) and the
  usual 20 000-line `truncated`. Clients key caches on (path, since, `reviewEndTree`).
- **Hunk ids of a `since` other than `review` are not `reject_hunks` ids.** `reject_hunks.expectedBaseTree` (new clients
  send the `baseTree` of the diff they show) must equal A, else `stale_diff`; clients offer hunk reject in the 전체 view only.
- `full_file { path, since }`: `lines` as before (the worktree, falling back to B — the held B's content while `stale`),
  `changedNewLines` / `deletedAfterNewLine` / `oldText` from the range; it echoes `since`, `stale`, `endTree`.
- Every tree a range refers to is pinned under `refs/reviewgate/<ns>/range/…` while referenced and persisted with the review
  file (turn base, request tree + `lastRequest`, per-file accepted tree); the pins go with the review (`finish_review`, round
  end, `close_project` of a resolved review) and unreferenced ones are pruned on `open_project`. A restored review whose
  range trees are gone simply has those ranges unavailable.
- *Engine notes (`review/gate.ts`, `review/ranges.ts`):* the pins are `refs/reviewgate/<ns>/range/<tree>` (the held B is pinned
  too while a turn runs); the review file keeps `ranges {turnBaseTree, heldEndTree, requestTree, lastRequest,
  lastTurnChanges, acceptedTrees}`. When the turn's own snapshot is unknown (no §26 record) the turn base is the held B of a
  follow-up, A of a fresh turn. A range without a change replies no hunks with `oldPath` / `newPath` = the path. A restore
  that loses a range tree also drops the marks that would offer it (`lastTurnChanges` and `changedThisTurn` / `turnAdded` /
  `turnDeleted` without the turn base, `lastRequest` / `changedSinceRequest` without the request tree, `changedSinceAccepted`
  without the file's accepted tree): a mark always means its range answers.

### 34.2 Reviewing while a turn runs (comp-02)

- A `send` / `request_changes` on a standing review sets `turnEndTree = null` as before; `reviewEndTree` keeps the held B
  until the collection replaces it. After a **fresh** send (nothing pending: a new A) `reviewEndTree` is null and
  `changedFiles` still lists the previous round's decided files until the collection — clients dim them; there is no diff.
- `select_file` / `full_file` (every `since`) and `side_ask` anchors (§21) are answered from `reviewEndTree` while a turn runs
  or is collected; the replies carry `stale: true` (read-only: the turn may still change the file). Before §34 they were
  refused `no_review`.
- **`accept` / `accept_all` during a turn** (running, not collecting, on a standing review) apply at once — `state`
  `accepted`, `lastReviewSummary`, the history verdict — and record the file's patch A → held B exactly like the files
  accepted before an answer turn (§3): after the collection the file stays `accepted` only when the turn left that patch
  unchanged; otherwise it is `pending` again with `changedSinceAccepted: true` (`since: "accepted"` = held B → new B) and
  leaves the accepted list of the next summary prefix. Refused `session_running` while `collecting` (the list is being
  rebuilt; a second at most) and when no held B exists (a fresh turn: nothing is pending). M28: `unaccept` follows the same
  rule — the undo of an accept made during the turn (the file is pending again and its recorded patch is forgotten).
- **M32 — `reject` / `reject_all` during a turn** (running, not collecting, on a standing review: a held B — a question
  turn, a change request, a peer or auto turn that kept A) are **scheduled**, not refused: a revert mid-turn would be
  swallowed by the turn's own collection (§3), so it waits for that collection. Each pending path (others are ignored, as a
  `reject` ignores them; `not_captured` refused as before) gets `changedFiles[].rejectScheduled: true` and its patch A → held B
  is recorded; Claude is told at once — a message into the running turn (§50, never a `user_message` row): "[Review gate] The
  user rejected your changes to <paths>. They will be reverted on disk when this turn ends — do not build on them, and do
  not edit these files again unless the user asks." — and a gray row says so (`reject_scheduled`, `detail`: the paths).
  Right after the turn's collection, before the gate opens (no send comes between): a file whose patch A → new B is the one
  recorded (the turn left it alone) is rejected exactly like `reject` — B, the list, notes, the history verdict, the summary
  prefix ("Rejected (reverted on disk …)") and the single-file undo (§41.2) follow — and a gray row lists them
  (`reject_applied`, after `turn_end`, whose `review` totals already leave them out); a file the turn changed again (or whose
  patch could not be read) is **not** reverted: it stays pending and a row asks (`reject_changed_again`, `detail`: the path —
  clients offer [되돌리기], an ordinary `reject`, and the file's diff); a file no longer pending is dropped. A revert that
  fails is `error{scope:"git", code:"revert_failed"}` and its files stay pending. `accept` / `accept_all` of a scheduled file
  cancel its reject. A collection that fails keeps the schedule for the retry or the turn that folds it in (M30, §3). The
  schedule is not persisted: an engine that dies mid-turn restores the files pending.
- `reject_hunks` / `finish_review` stay refused `session_running` while a turn runs (hunk ids belong to a diff the turn may
  change) — and `reject*` / `finish_review` `collect_failed` while its collection failed (§37.1). Notes are unchanged: allowed
  during a question turn, refused while a change request runs. A reject during a **fresh** turn (no held B: nothing is
  pending) is still refused `session_running`.
- *Why not a separate "scheduled accept" state:* the answer-turn rule already is "accepted if the turn leaves it alone"
  (patch hash with A fixed = blob comparison), persisted (`acceptedPatchHashes`) and re-verified by `restore()` after a
  crash; a third state would have to be rendered, restored and explained in two clients, and a cancelled schedule would
  say less than `changedSinceAccepted` + the "수락 이후" diff, which show exactly what changed after the user's accept.
- *Engine notes:* a failed collection on a standing review keeps the held B (diffs stay `stale`) and `accept` follows the
  same rule until `retry_collect` succeeds; the turn's own delta is computed before the merge touches the review, so a git
  failure there leaves a clean retry. Only a file accepted *during* the turn leaves `acceptedPaths` when the turn changes it;
  one accepted before a `request_changes` that the follow-up changes is `pending` with `changedSinceAccepted` but keeps its
  place in the summary prefix (§3, unchanged).

### 34.3 This turn vs the whole review (comp-04)

- At every collection the engine compares the turn base with the new B: `changedThisTurn` (+ `turnAdded` / `turnDeleted`,
  numstat turn base → B) per file, `gate.lastTurnChanges {turn, files, added, deleted}` and `gate.reviewTurns` (the round's
  `turns`). They stay until the next collection; a file leaving the list takes its flags.
- **`turn_end.files` / `added` / `deleted` / `external` now count what THIS turn changed** (before §34: the merged list's
  totals, so a question turn that changed nothing said "Changed 2 file(s)"). `review` = `gate.reviewSummary`'s totals;
  `merged: true` for a question / request-changes follow-up. The transcript row carries the same fields.
- **`turn_summary` is emitted only when this turn changed at least one file**; `files` are exactly those (`adds` / `dels` =
  this turn's, `reviewAdds` / `reviewDels` = A → B), plus `review`, `merged`, `lastTest` (§34.9). Each file's `why` prefers this
  turn's calls (§34.8).
- *Engine note:* `external` counts this turn's files that nothing of **this** turn explains (the causes an earlier turn left
  on the file do not count); `gate.lastTurnChanges` is null without a review list.

```json
{"type":"turn_end","stopReason":"end_turn","usage":{"inputTokens":812,"outputTokens":95,"costUsd":0.0123,"durationMs":41200,
 "cacheReadTokens":0,"cacheCreationTokens":0,"contextTokens":51200},"files":1,"added":2,"deleted":1,"changedOutside":[],
 "external":0,"review":{"files":5,"added":40,"deleted":7},"merged":true}
```

### 34.4 Notes after `request_changes` (comp-06, market-05)

- `request_changes` sends the **unsent** notes only, marks them `sent {at, turn}` (`turn` = the follow-up turn), keeps the
  request tree (B at that moment) and sets `gate.lastRequest {turn, at, notes}`.
- The follow-up collection no longer clears the notes. A sent note stays ("요청함: … — 반영 확인") until the user removes it
  (`remove_note`, the "반영 확인" check) or the review ends; it is never sent again. `noteCount` counts unsent notes,
  `sentNoteCount` the sent ones; `canRequestChanges` and every "notes pending" guard (`notes_pending`, the finish-review
  warning) look at unsent notes only.
- `changedSinceRequest`: the file's blob in the request tree differs from B (or the file is new since) — a file with sent
  notes but without it was not touched by the follow-up ("요청 후 바뀌지 않음").
- **Anchors.** After every B change (collection, `refresh`, a reject, a rewind's refresh) each new-side note is carried
  through the file's old B → new B diff: a line outside the changed blocks shifts (`anchor: "moved"` when its number
  changed); a line inside a changed block keeps a place only when a new line of that block has the same trimmed text as the
  note's `excerpt` (the nearest; `moved`); otherwise `anchor: "gone"` ("위치 사라짐"; `line` keeps its last number).
  Old-side notes never move (A is fixed). Unsent notes are carried too (a question turn used to leave them on stale
  lines), and the request message uses the current `line`.
- `review_history` replies `current`: the round in progress (`inProgress: true`, `endedAt` = its last update, its sent notes
  in `notes`) — never inside `entries`; `history_diff { entryId: current.id }` diffs its `turnStartTree` → `reviewEndTree`
  (or the file's `endTree`).
- *Engine notes:* notes are also carried when a commit, `reject_hunks` or a restore moves B (a restore from the saved B); a
  note without an `excerpt` inside a changed block is `gone`; a gone note stays gone. A `request_changes` clears
  `changedSinceRequest` (its request tree is the current B); a refused one puts the notes, the previous request tree /
  `lastRequest` and the marks back. `current` is sent whatever the session filter (the review is worktree state); its
  `endedAt` is the review's last change.

```json
{"id":"0f6c…","path":"api/src/main/java/com/x/Svc.java","line":42,"side":"new","excerpt":"int b = 2;","body":"b는 2 그대로 둬",
 "sent":{"at":"2026-10-23T01:00:00.000Z","turn":4},"anchor":"moved"}
```

### 34.5 Viewed by content (comp-08)

`changedFiles[].blob` is the tree entry id of `path` in `reviewEndTree` (`git rev-parse <tree>:<path>`; absent for a deleted
file). Clients keep "봤음" as (path, blob — `"deleted"` without one) and clear it only when `turnStartTree` changes (a new
review), never because B moved: a viewed key whose blob differs from the current one is "본 뒤 바뀜". The engine stores no
viewed state.

### 34.6 Live changes (comp-03, market-13)

- `state.hud.turnFiles`: the distinct files the running turn's edit tools and post-Bash snapshots touched so far (0 between
  turns) — the HUD's "진행 중 변경 N개" without a snapshot.
- `live_changes` → `live_changes`: the worktree snapshotted now (ignore patterns applied, a temporary index — never the
  worktree's; reused while ≤ 2 s old) diffed against the running turn's own start tree. `files` in path order, at most 200
  (`truncated`), `inReview` when the file is also in `changedFiles`. No turn running: `running: false`, `files: []` (no
  refusal). `no_project` without a project. Nothing here can be accepted; nothing is persisted.
- `live_diff { path }` → `file_diff { scope: "live", baseTree, endTree: <live tree> }` against the latest live tree (one is
  taken if none). Refused `no_live_turn` (no turn running) and `not_a_live_file:<path>` (unchanged between the two trees).
- The chat's `Edit` / `MultiEdit` / `Write` mini diffs come from `tool_use.input` (§2) on the client; no engine change.

```json
{"type":"live_changes","id":"c12","running":true,"turn":5,"baseTree":"4b1e…","liveTree":"9ac0…","at":"2026-10-23T01:05:00.000Z",
 "files":[{"path":"api/src/main/java/com/x/Svc.java","oldPath":null,"status":"M","added":12,"deleted":3,"isBinary":false,"inReview":true},
          {"path":"package-lock.json","oldPath":null,"status":"M","added":310,"deleted":204,"isBinary":false,"inReview":false,"generated":"lockfile"}]}
```

Engine behavior (`review/live.ts`):
- **Cost.** A snapshot is taken only when none can stand for "now": any live tree is reused for 2 s; beyond that a tree
  taken while no call that can write was running stays valid until such a call starts (at most 30 s, so an editor's
  changes outside Claude still show up). Writers are every tool but the permission layer's read-only ones (Read, Glob,
  Grep, LS, NotebookRead, TodoWrite, BashOutput, KillShell, ToolSearch, Skill, …) and WebFetch, WebSearch, Agent / Task
  (their inner calls count), AskUserQuestion, ExitPlanMode, EnterPlanMode, the MCP resource readers and TaskOutput; a
  call runs from its `tool_use` to its `tool_result`. Every post-Bash snapshot the session already takes (§12) becomes the live
  tree for free, and the file list of one (start tree, live tree) pair is computed once. Measured on a 30 000-file
  repository: one snapshot ≈ 0.35 s, the list ≈ 0.1 s; 20 requests at one a second with an edit and a Bash call in
  between took 2 snapshots (0.8 s in all) instead of 20.
- The running turn's own start tree is its §26 record's (A for a fresh turn; a question / request-changes follow-up
  takes its own); while that snapshot is still being taken (the message has not reached Claude yet) the reply is
  `running: true` with `baseTree: null` and no files. A turn that ends while the snapshot runs answers `running: false`.
- `live_changes` / `live_diff` run on a lane of their own: never behind the main lane (an accept while a turn runs,
  `select_file`) nor in front of the composer's `list_files`.
- `live_diff` diffs against the latest live tree of the turn however old (what the list showed), with segments (§34.7)
  and the usual 20 000-line `truncated`; a file beyond the list's 200 can still be asked for.
- `hud.turnFiles` counts distinct files inside the repository, not hidden by the ignore patterns, that an edit tool
  (its error result takes it back) or a post-Bash snapshot attributed to the running turn.

### 34.7 Line detail: segments, whitespace, generated files (comp-07, market-06, comp-18)

- **Pairs.** In a hunk, a run of `del` lines directly followed by a run of `add` lines is a block; its i-th del pairs with its
  i-th add for i < min(dels, adds). A block with more than 200 lines on either side is not paired.
- **Segments.** Each pair is diffed over tokens — `[\p{L}\p{N}_]+` words, whitespace runs, any other single code point —
  and both lines get `segments`: the changed tokens as `[start, end)` ranges (adjacent ones merged, ascending) in **UTF-16
  code units of that line's `text`** (JS string indices = Swift `String.utf16` offsets; a code point is never split; Swift:
  `DiffSegment.range(in:)`). None when either line is longer than 2 000 units, or the changed part covers more than 60 % of
  the longer line (a rewrite reads as a whole-line change). At most 4 000 paired lines of a file get segments, the rest none
  with `FileDiff.segmentsLimited: true`. Lines that are not paired never have segments. Every `file_diff` scope and
  `history_diff` carry them.
- `wsOnly: true` on both lines of a pair whose texts are equal once all whitespace is removed ("공백만 바뀐 줄 숨기기").
  `changedFiles[].whitespaceOnly`: every change of the file is whitespace (`git diff-tree -w` shows none), set at collection.
- `generated` (set at collection; also on `live_changes`): `lockfile` — `package-lock.json`, `npm-shrinkwrap.json`,
  `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `Pipfile.lock`, `composer.lock`,
  `go.sum`, `Package.resolved`, `Podfile.lock`, `gradle.lockfile`, `flake.lock`, `pubspec.lock`, `mix.lock`; `generated` —
  `linguist-generated` set or `-diff` in .gitattributes (`git check-attr`), or `@generated` / `DO NOT EDIT` within the first
  5 lines (≤ 1 KB) of B's content; `minified` — `*.min.js`, `*.min.css`, `*.map`, or a line over 1 000 chars among the first 5
  of a `.js` / `.css` file. Clients fold such diffs by default, and any diff over 3 000 lines ("+N줄 · 펼치기").

```json
{"id":7,"kind":"del","oldNo":12,"newNo":null,"text":"    return repo.find(id).orElseThrow();","segments":[]}
{"id":8,"kind":"add","oldNo":null,"newNo":12,"text":"    return repo.find(id).orElseThrow(NotFound::new);","segments":[[37,50]]}
```

Engine behavior (`diff/segments.ts`, `review/detail.ts`):
- The pass runs inside `parseUnifiedDiff`, so every parsed diff has it (cached with the diff). Tokens are diffed with the
  `diff` package (`diffArrays`, Myers) after their common prefix / suffix is cut off; "more than 60 %" is the larger of
  the two lines' changed units against the longer line, and a pair that cannot pass it (by length, or by the tokens the
  two middles share at most) is rejected before any token diff. In the example above the del line has `[]` (none of its
  tokens changed) and the add line `[[37, 50]]` (`NotFound::new`): `segments: []` is a paired line none of whose tokens
  changed (an insertion's other side, an end-of-line-only change). (The example once read `[[27,38]]` / `[[27,52]]`,
  which splits the word `orElseThrow`; tokens are never split.)
- "4 000 paired lines" counts lines (2 000 pairs). A per-file token-diff work budget ((tokens of both middles) × (the
  edit length allowed)) is a second limit: a pair it cannot pay for gets none, cheaper pairs after it still get theirs,
  and the diff says `segmentsLimited`. Measured: 2 000 paired Java lines ≈ 25 ms, a 1 500-pair rewrite ≈ 0.2 s.
- `generated`, in this order: `linguist-generated` set → `generated`, `linguist-generated=false` / unset → never (the
  user's override, as on GitHub); the lockfile / minified names; `-diff` (numstat then counts the file binary) unless
  the `binary` macro set it (an image is no generated file); the markers of the file's first 8 KB as the worktree holds
  it (B was just snapshotted from it; a deleted file has only the path and attribute rules). One `check-attr` call per
  list; the content rules read at most 3 000 files of a list.
- `whitespaceOnly`: modified / renamed text files with line changes whose `git diff-tree -w --numstat` shows none (one
  call); a generated file is not diffed again for it. Both fields are set at every rebuild of the list (collection,
  `refresh`, restore); `whitespaceOnly` also after a `reject_hunks` that keeps part of the file (§37.5).

### 34.8 Why (comp-01, agents-03)

- `tool_use.rationaleSource` / `rationaleAge`: the §12 rule is unchanged (the same API message's last text, else the same
  agent's latest earlier text of the turn); `same_message` / `earlier` says which, `rationaleAge` how many of the agent's tool
  calls came between that text and this call (0 = the first after it). Persisted in the transcript row.
- **Subagent text.** The session passes `forwardSubagentText: true` (SDK 0.3.270; verified with CLI 2.1.309: a subagent's
  `text` — and `thinking` — blocks then arrive as assistant messages with `parent_tool_use_id`; before, only its tool_use /
  tool_result blocks did, so §12's "subagent calls get their own subagent's text" never happened). Only complete text blocks
  are used, for rationale and reports; subagent stream events stay ignored and nothing new is streamed to the transcript.
- **Reported.** When the turn ends, the main agent's last text (after its last tool call) and each finished Agent call's
  result (the subagent's report; ≤ 4 000 chars kept) are split into sentences / list items; for a changed file the items
  that mention it (`mentionsPath`, §15) — a `- path: reason` item first — form its reported text (≤ 2 items, ≤ 300 chars).
- **`FileWhy`**, per file: (1) `reported` — for a file changed inside a subagent its report first (`agent` set), else the main
  report; (2) this turn's touching calls with a rationale — `same_message` before `earlier`, then the smallest age, then the
  latest call; (3) for a file this turn did not change, the earlier turns' calls of the same review; (4) `none`. `agent`: the
  text is a subagent's; `delegation`: the chosen call ran in a subagent — the rationale of the spawning Agent call.
- `changedFiles[].why` is recomputed for `changedThisTurn` files at each collection, kept otherwise, and persisted with the
  review; `turn_summary.files[].whyDetail` is the same object (`why` / `whyToolUseId` mirror `text` / `toolUseId`).
- Clients: a `why` text two or more files of a card share is shown once at the card's top; `earlier` reads "앞선 설명
  (N개 호출 전)", dimmed; a subagent's text "서브에이전트: …" and `delegation` "위임 이유: …" on separate lines; `none`
  "원인 기록 없음".

Engine behavior (`review/why.ts`):
- The report is split as markdown: fenced code is skipped; list items and table rows are items, paragraphs are split
  into sentences (`.` `!` `?` `。` before whitespace — `Svc.java` stays whole); a heading or a label line (`**Svc.java**:`)
  naming the file is explained by the items under it (a label: the list items right after it). A `path: reason` item
  (`:` `—` `–` `->` `→` `=>` or ` - `; table rows: the first cell) gives its reason without the path, and only when its
  head is a list of paths (`a.ts, b.ts and c.ts`), not a sentence. The text is the items joined by a space, cut at 300
  chars with "…".
- A file changed in a subagent whose report does not name it, but the main report does: `reported` from the main
  report, without `agent`. `delegation` is also set on `none` when the change ran in a subagent whose Agent call has a
  rationale.
- "This turn's files" are those that differ between the turn's own start tree and B (the turn's own delta that
  `changedThisTurn` reads, §37.3; every file of a fresh turn). Such a file without a reported text or a rationale of this turn is `none` — an earlier turn's reason is
  not this change's. A file the turn did not change keeps its `why` (a refresh and a restore carry it too); one without
  any gets the earlier turns' calls (3), else `none`.
- `age` is sent with `earlier` only; `turn` is the call's turn (the collected turn for `reported` / `none`). Calls are
  remembered for the engine's lifetime (the newest 2 000), so a restored review keeps its persisted `why` and computes
  `none` for a file that has none.

### 34.9 Test verdicts (comp-09)

- Recognized test commands (§12) add `mvn`, `mvnw` / `./mvnw`, any `*mvn*.sh` script (`./mvn-ci.sh -q -o test`), `gradle`,
  `gradlew`, `make test|check`, `node --test`, `mocha`, `phpunit`, `dotnet test`, `bazel test`, `ctest`, plus
  `settings.testCommandPatterns` (glob per simple command; live through `set_settings`).
- Markers add, fail: `Tests run: N, Failures: F, Errors: E` with F + E > 0, `There are test failures`, `BUILD FAILURE`,
  `BUILD FAILED`, `> There were failing tests`, `N tests completed, M failed`; pass: `Tests run: N, Failures: 0, Errors: 0`
  (N > 0), `BUILD SUCCESS`, `BUILD SUCCESSFUL`. A non-zero exit is still `fail`.
- `turn_summary.lastTest`: the turn's last recognized, not backgrounded test call by `tool_result` order (subagents
  included); `afterLastEdit` — no file-changing call (an edit with a successful result, a Bash call with attributed files)
  finished after it ("마지막 편집 이후 실행됨" / "편집 뒤 테스트 없음"); `runs` — recognized test calls in the turn; null when
  none ran.

Engine behavior (`session/testCommands.ts`, `session/toolOutput.ts`, `review/tests.ts`):
- A Bash line is split into simple commands (`&&` `||` `;` `|` `&` newlines outside quotes; `2>&1`, `&>f` stay part of
  their command) and each is read past env assignments, wrappers (`time`, `sudo`, `env`, `nice`, `nohup`, `timeout N`,
  `npx`, `bunx`, `pnpm exec` …) and interpreters (`bash ./mvn-ci.sh test`, `php vendor/bin/phpunit`). The §12 runners
  match anywhere in a simple command — not in one that only reads, searches, prints or installs (§37.7).
- **Maven / Gradle count only with a goal / task that runs tests** (`mvn compile` printing BUILD SUCCESS is no
  "테스트 통과"): Maven `test`, `verify`, `integration-test`, `surefire:…`, `failsafe:…`, `<plugin>:test`, or `-Dtest=` /
  `-Dit.test=` with a lifecycle goal; Gradle a task named `test`, `check`, `…Test(s)` or `…Check` (`:app:testDebugUnitTest`,
  `integrationTest`, `connectedCheck`) or `--tests`. Maven `package` / `install` / `deploy` and Gradle `build` run tests
  only by default: they are a test run only when the output shows tests ran (a Surefire `Tests run: N>0` / `T E S T S`,
  `There are test failures`, a Gradle `> Task …:…test`, `N tests completed`, `> There were failing tests`).
  `-DskipTests` / `-Dmaven.test.skip(=true)` and a Gradle `-x <task>` of the test task take the run away;
  `test-compile`, `testClasses`, `compileTestJava`, `assemble` are never test runs. `make` counts with a `test` / `check`
  target, `node` with `--test`, `dotnet` / `bazel` with `test` as the command.
- `settings.testCommandPatterns`: each pattern is matched whole (anchored) against each simple command as typed (quotes
  kept, whitespace collapsed); `*` any run, `?` one char, everything else literal; non-string entries are ignored. The
  session reads them for every Bash result.
- `lastTest.at` is when the engine received the `tool_result`; an edit counts as file-changing only inside the
  repository (a plan file under `~/.claude/plans` does not).

### 34.10 Compatibility and refusal codes

- Every new field is optional: an engine before §34 sends none of them (clients behave as before), a client before §34
  ignores them — `turn_end` then shows this turn's numbers, a no-change question turn has no summary card, sent notes look
  like ordinary notes (never re-sent), accept during a turn is simply not offered. The review file stays `version: 1` with
  optional fields; older files restore with them empty.
- New refusal codes: `range_unavailable` (`range_unavailable:<since>`), `invalid_since`, `no_live_turn`, `not_a_live_file`
  (`not_a_live_file:<path>`). Reused: `stale_diff` (`expectedBaseTree`), `session_running` (`reject*` / `finish_review`
  while a turn runs, `accept*` while collecting), `not_a_changed_file`, `no_project`.

## 35. 0.2.2 engine follow-ups

An adversarial pass over the §29–§33 engine code that shipped in 0.2.1, and the engine follow-ups of the first
integration and of the second (§35.12–35.14). Everything is additive on the wire (new optional fields, new refusal codes for existing failures); the
sections above point here where they changed.

### 35.1 A send whose snapshot A fails is refused

`send` takes snapshot A **before** anything of the turn happens (the gate is closed meanwhile). When it fails the send is
refused — `result{ok:false, code: "lfs_missing"}` (§32.3: the repository's LFS filter cannot run) or
`result{ok:false, code: "send_failed"}` (any other failure); `error` is `<code>:<the first line of the failure>` — and
nothing of it happened: no `user_message` event or row, the chat's title / `lastUserText` stay (a brand-new chat stays new,
so it starts fresh again instead of being `--resume`d: the CLI never saw it), the review-summary prefix
(`gate.lastReviewSummary`), the notes, a pending plan and an answer turn's review all stay, and the gate opens again
(`acceptPending` — "Accept N & Send" — has accepted the pending files before the snapshot; accepting writes nothing, they
stay accepted and the retried message is a plain send). No `error` event goes with it (the refusal is the report).
Clients keep the message — at the front of their queue, the queue paused with the refusal's words — and it goes out
again once the cause is fixed. Before, the reply was `ok` and only an `error` said why, so a client's queue dropped the
message. Chosen over "send anyway with a warning": the review would have
no A to diff Claude's changes against, and Reject could not put anything back. `compact` and the `plan_response` follow-up
go through the same path (refused with the send's code / `plan_followup_failed`). A session that went away while the turn
was being prepared, after a good snapshot, is still `error{code: "send_failed", scope: "session"}` with an `ok` reply.
Test: `engine/test/engine.sendRefusal.test.ts`.

### 35.2 `reject_all` skips what it cannot put back

```ts
// the reply of a reject_all (with an id) that left uncaptured files pending: result{ok: true} plus
type RejectAllResultEvent = { type: "result"; id: string; ok: true; skipped?: RejectSkip[] };
type RejectSkip = { path: string; code: "not_captured" };
```

`reject_all` no longer refuses the whole batch when files whose content no snapshot captured are among its targets (§32.1
mods stubs, §32.3 skipped unreadable files — `uncaptured: true`): the other files are reverted as before (the batch's
`file_changed_since_review` check and `force` cover them only) and the uncaptured ones stay as they are, `pending`, listed
in the reply's `skipped` — clients say so ("내용 미수집 N개는 그대로 두었어요"). Only a `reject_all` with nothing revertible at
all is still refused `not_captured` (+ `paths`), as before. `reject {paths}` is unchanged — naming an uncaptured file refuses
that batch with `not_captured` — so a client that sends the revertible files as `reject {paths}` (what the clients of 0.2.1
do) keeps working. The reply carries `skipped` only when the command had an `id`. Test: `engine/test/engine.rejectSkip.test.ts`.

### 35.3 Error rows keep their banner's details

```ts
// a kind: "error" transcript row (§30) also keeps, when its event carried them (ErrorRowDetails):
toolName?: string; path?: string; branch?: string;   // §33.4 worktree_blocked / worktree_outside_review
files?: string[];                                   // §33.4 worktree_outside_review of a command: what it changed there
exitCode?: number | null; signal?: string | null;   // §30: how the CLI ended
sessionId?: string;                                 // §30 resume_not_found / resume_failed: the chat that could not be continued
resetAt?: string; status?: number | null;           // usage_limit / rate_limited, the HTTP status of an API error
```

Before, a row kept only `code` / `detail`: the banner restored after a restart (`transcript_restore`) lost the tool, branch
and folder of a worktree notice (the clients read them back out of the English text), how the CLI ended and which chat a
resume notice was about. A row has exactly the fields its event had — a `null` exit code / signal / status included,
nothing it did not carry. `server`, `threadId` and the retry counters are not kept: those errors (MCP, side questions,
`api_retrying`) are not rows. Older rows simply lack the fields. Test: `engine/test/engine.errorRows.test.ts`.

### 35.4 A chat Claude Code could not resume opens as a record

A chat flagged `resumeFailed` (§30: the CLI has no conversation for it any more) is never `--resume`d again. Opening it —
`session_open`, the app reopening on it (`open_project` with it current), `restart_session` while it is open — replays its
rows (`transcript_restore`) and starts the CLI **fresh under a new id** that is not in `state.sessions.list`: nothing is
created, no `resume_not_found` repeats, and the input stays open (`gate.canSend`). The first turn started there — `send`
(and what goes through it: `compact`, the `plan_response` follow-up, a promoted side answer, a rewind's `editText`),
`request_changes`, `peer_accept`, or a turn the CLI starts by itself — goes to **one new chat** with that id: it is created
right then (titled by the message as usual), becomes `state.sessions.currentId` (its tab is added;
`transcript_restore{items: []}` comes before its first row) and the conversation continues there; the record keeps its
rows, title and counts. Leaving the record first (`session_open` of another chat, `session_new`) creates nothing. A side
question there starts fresh: there is no conversation to fork (nor does a conversation rewind into it, §37.4). Before, every opening resumed it again, failed again and
made one more empty "New chat" (and the CLI's id could rename the record). The first failure itself is unchanged (§30:
the new chat with its notice). Clients keep their flow — "기록만" asks before opening, the rows show, what is sent next goes
to a new chat; `currentId` changes after that send (a client that keeps showing the record's rows above the new chat's
may replace them then). Test: `engine/test/engine.recordOnly.test.ts`.

### 35.5 A message the CLI never took does not make its chat resumable

A chat is resumed when the CLI knows it (§30); `lastUserText` counts as such a sign — except for the message a restart is
about to send again (§16: the hung CLI produced nothing for it). So the init-timeout fallback of a **brand-new chat's first
message** starts the CLI fresh under the chat's own id (`--session-id`) and sends the message there, instead of
`--resume`-ing a conversation the CLI never had: that failed with "No conversation found", flagged the new chat
`resumeFailed`, moved the user to yet another empty chat with a "cleaned up after 30 days" notice, and the message was not
sent again. Should the hung CLI have recorded the message after all, the fresh start is refused "already in use" and the
chat is resumed at once with the message (§30). A chat with a turn, `cliKnown`, a reported id or a record file is resumed as
before. Test: `engine/test/engine.resendFresh.test.ts`.

### 35.6 Two cheap holes in the location / settings detection

- **A path with a space.** A writing MCP call's value under a one-path key — a key that starts with `path` or ends with
  `path`, `file`, `filename`, `uri`, `dir`, `directory`, `destination`, `dest` or `target` (`path`, `file_path`, `filePath`,
  `pathInProject`, `destination`, …) — is read as one path, spaces included (a project folder called "My Project"; a
  `file://` URI is percent-decoded), so a settings file it names gets the §33.9 card. Before, every value with whitespace
  counted as free text. Free text under any other key (`content`, `text`, …) still never counts.
- **`cd` in a subshell / brace group.** A `cd` / `pushd` after `(`, `{`, `$(` or a backtick (`(cd .claude && … >
  settings.json)`, `{ cd vendor/lib; …; }`) moves the directory the rest of the command is read against, like a plain `cd`:
  the settings file (§33.9) and the nested repository / other worktree the command works in (§33.4) are found. Before, the
  opener stuck to `cd` and the command was read in the shell's own directory (no card for the reason). Still textual: a
  path built at run time (`$VAR`, a glob, a script) is not followed, and a subshell's `cd` is not undone after it.
Test: `engine/test/session.scopeGaps.test.ts`.

### 35.7 The queue is answered with the hooks' own rules

When a remembered allow or a newly saved pattern answers the other queued requests (§33.1, §33.6), the engine now judges
them with the live session's MCP tool annotations (`readOnly` / `destructive` from `mcpServerStatus()`, §33.5) like the
hooks do. Before, it judged MCP tools by their names only: a tool its server marks destructive (or not read-only) whose
name merely looks like a read (`mcp__srv__get_and_rotate_key`) — on a card because of that annotation — was answered
`allow` by the user's `mcp__srv` rule as soon as another card got "세션 동안 허용". Optional on the session object
(`ClaudeSessionLike.mcpToolHints`); without it the names decide, as before. Test: `engine/test/engine.permqueueHints.test.ts`.

### 35.8 `peer_accept` releases only what the card showed

The CLI's release (`crossSessionInbound` `accept`) lets through **every** message held at that moment, and `ids` were
checked before the turn was prepared — so a message held while snapshot A was being taken (seconds in a large repository)
ran without the user's yes. Now `peer_accept` takes snapshot A first (the gate closed meanwhile, like `send`, §35.1), then
looks at the held messages again: with `ids`, a newcomer refuses the accept `peer_inbox_changed:<held ids>` — nothing
released, no `error`, the messages stay `held`, the card shows the inbox as it is now and the user answers again; without
`ids` (`auto`, an older client) the newcomers join the turn. A snapshot A that fails is refused `peer_release_failed`
(`error` code `lfs_missing` / `peer_release_failed`) as before. Either way nothing of the turn is left: no
`delivering`, no checkpoint, no turn number used, the notes, the review round and the per-turn banners (§31 / §32) as they
were — and, since §37.8, the review's A, B and ranges a fresh A had replaced. What remains is the release call itself (~40 ms,
the CLI has no per-message switch). Test:
`engine/test/engine.peerRace.test.ts`.

### 35.9 A restored review keeps the user's edits made while the app was closed

Live, a file the user edited after its review was collected refuses `reject` / `reject_all` with `file_changed_since_review`
(+ `paths`; `force` overwrites — §19.1). A review restored after a restart (§8, §31.5) compared the disk with a **fresh**
snapshot instead, which already holds what changed while the app was closed: a file Claude had changed and the user then
edited in IntelliJ stayed origin `tool` and "Reject all" — which only reverts Claude's changes — reverted the user's edit
too, silently. Now a file restored from the saved list is compared with the B the review was saved with (pinned, §8) until
the next collection, `refresh` (the user takes the current diff as the review) or `finish_review`: changed since, it is
refused like a live edit, `force` reverts it. Files unchanged since, and reviews whose saved B is gone, behave as before.
Test: `engine/test/engine.restoreEdited.test.ts`.

### 35.10 Another spelling of the project's path on macOS

macOS file systems are case-insensitive by default, and git reports the on-disk spelling (`rev-parse --show-toplevel` in
`/users/me/code/proj` is `/Users/me/Code/proj`). The engine's real paths kept the spelling they were given,
so a project opened as `/users/me/code/proj` (a typed or scripted path) compared every file Claude edited against a
root spelled differently: each in-project edit got the "outside the project" card and the collection attributed it to no
one (`external`). `realpathLenient` now takes the on-disk spelling on macOS too (`realpathSync.native`, as on Windows),
so `isInside` / `toRepoRelative` see one path; a file that does not exist yet keeps its own spelling below the nearest
existing folder, and a case-sensitive volume keeps two spellings apart (the other one does not exist). Test:
`engine/test/platform.pathsCase.test.ts`.

### 35.11 A file rewind leaves what nothing of Claude's changed

```ts
type RewoundKeptEvent = RewoundEvent & { keptFiles?: string[] };   // the `rewound` reply; keptFiles only when non-empty
// a turn's checkpoint record (§26) also keeps: external?: string[] — its files no call of the turn explained
```

A file rewind (§26) restores Claude's changes from a turn on — but every path the turns' diffs held went back, also a file
nothing of Claude's explained (§31 origin `external`: the user's IntelliJ save while Claude worked, another session's
write): the user's work was lost, with no question asked. Now each turn's record keeps its files that no call of that turn
(edit tool, Bash, MCP) changed, and a file rewind leaves a path that was `external` in every record of the range that
changed it as it is, like "Reject all" (§31.2); `rewound.keptFiles` lists those that differ from the target, and
`TurnCheckpointView.filesSince` counts only what would be restored. A path Claude changed in any turn of the range goes
back as before (its whole content, the user's part with it — as `reject`). Records written before this have no list:
their paths are restored as before. Test: `engine/test/engine.rewindExternal.test.ts`.

### 35.12 A turn's tail closes its own record

`turn_end` goes out once the collection is done, and the gate is open again from then on — but the turn's tail (the HEAD /
`settings.local.json` / nested-repository checks, then its §26 checkpoint record) still awaits. A send in that window (the
queue's next message) opened the next turn's record, which the tail then closed in its place: the finished turn's record
kept no end, the new one lost its start (no file rewind to either; "this turn" fell back to guesses, §34.8). The tail now
closes the record it started with, on the B and list of its own collection, and leaves the current one alone. No wire
change. Test: `engine/test/engine.recordRace.test.ts`.

### 35.13 Snapshots see a same-size edit made right after the index was written

Every snapshot (A, B, the live tree) starts from a copy of the user's index, so `git add -A` re-reads only files whose stat
changed. Git trusts an entry's stat unless the entry is as new as the index file itself ("racy git"); the copy was stamped
when it was made, so an edit of the same size in the second the real index was written (an IDE's git refresh or a
`git add`, then Claude's edit) kept the old content in the snapshot — the change was missing from the review. The copy now
keeps the real index's timestamps. Test: `engine/test/git.checkpoint.test.ts` ("racy git").

### 35.14 `detail`'s home folder is the folder itself

`detail` (§30) writes the home folder as `~` only where the path is that folder — `/Users/me/x` → `~/x`, `/Users/meme/x`
and `/Users/me.old/x` stay (it read `~me/x`): the Mac's log redaction rule. Test: `engine/test/session.cliRecords.test.ts`.

## 36. Wave 3: agents, sessions and daily flow

Wave 3 makes subagents readable and stoppable one by one, carries what the user's terminal Claude has (local settings,
command descriptions, CLI versions, other sessions) into the app, and finishes daily chores inside it (commit message,
workbench setup, AI pre-review, PR comments). This section is the contract; every lane landed in 0.2.3 and each
subsection's notes say how it was built. Additive on the wire: new commands and events, optional fields, three settings;
nothing an existing client relies on changes meaning.
Types: the `§36` block at the end of `engine/src/protocol.ts`.

Owners — engine: **engine-agents** §36.1–36.4, **engine-session** §36.5–36.9, **engine-flow** §36.10–36.14. Screens:
**mac-/desktop-agents** §36.1–36.4 and the §36.10 chip, **mac-/desktop-session** §36.5–36.9, **mac-/desktop-flow**
§36.11–36.14.

```ts
// commands (reply)
agent_report { toolUseId } → agent_report                                   // §36.1
stop_agent { toolUseId } → result                                           // §36.2
retry_extensions → result                                                   // §36.7
cli_versions → cli_versions                                                 // §36.8
cli_sessions → cli_sessions;  cli_session_import { sessionId } → result     // §36.9
commit_draft { paths? } → commit_draft                                      // §36.11
workbench_preview { branch, from?, location? } → workbench_preview          // §36.12
workbench_create { …, fetch?, setup?, location?, fromPr? } → result          // §36.12 / §36.14 (+ workbench_progress events)
prereview_start { scope, paths?, effort } → prereview;  prereview_cancel { prereviewId };  prereview_dismiss { prereviewId, findingId }   // §36.13
mcp_add / mcp_remove { scope: … | "local" }                                 // §36.6
side_ask { anchor: { pr? } }                                                // §36.14
// events: agent_report, cli_versions, cli_sessions, commit_draft, workbench_preview, workbench_progress, prereview;
//         the notice error{fatal:false, code:"cli_version_changed", cli:{from, to, verified}}
// state:  hud.agents[]: prompt?, model?, reportPreview?, cliAgentId?, stoppedBy?, resumeCount?, resumedBy?;  hud.waitingOnAgents?
//         session.capabilities: commands?, state?;  session.extensions: settingSources + "local", notApplied?
//         session.extensionsWaitingOn?;  session.cli?;  sessions.list[].imported?;  branches.remotes?;  gate.prereviews?
// rows:   tool_use.continues?;  tool_result.agentUsage? / cliAgentId? / stoppedBy? (row only: report?, reportTruncated?)
//         side thread fork: atTurn?, runningTurn?
// settings: loadLocalSettings?, commitTemplate?, workbenchSetup?;  extensionsInitTimeoutMs becomes a floor (§36.7);  claudePath pins a version (§36.8)
```

Rules for every subsection:
- **Optional everywhere.** An engine before §36 sends none of the fields and refuses the new commands `unknown_command`;
  clients then keep the old behavior and show the new control disabled with a one-line reason (or not at all where the
  subsection says so). A client before §36 ignores the fields and events. Both clients ship with their engine; the
  compatibility lines matter for mixed builds and for the lanes landing one by one. Until its lane lands, a command stays
  `unknown_command`. Electron's main process forwards only the commands listed in `clients/desktop/src/main/ipcGuard.ts`:
  each desktop lane adds its own.
- **Read-only forks** — §36.10 side questions, §36.11 commit drafts, §36.13 pre-reviews — use the §21 machinery and its
  read-only policy (PreToolUse hook + `canUseTool`, deny wins in every mode, never a permission card;
  `disableAllHooks`; no MCP server — side questions have the user's since r2 M18, §21, the one-shot forks still none;
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`). They cannot change a file; their cost goes
  to `hud.sideCostUSD`, never to the main chat; the main conversation, transcript and `SessionMeta` are untouched.
- **The gate stays.** Nothing here answers or skips a permission request the engine asks today, and nothing reaches the
  review list except through a collected turn.

### 36.1 Agent details and the report (agents-02, agents-06)

Read what a subagent was told and what it reported — also after the next turn and after a restart.

- `AgentNode` (§13) gains:
  ```ts
  prompt?: string;          // the Agent call's `prompt` (else task_started.prompt), first 8 000 chars
  model?: string | null;    // the Agent call's `model` (else one a task message reports; none do in SDK 0.3.270); null: none named
  reportPreview?: string;   // the cleaned report's first 600 chars, once the call's result arrived
  cliAgentId?: string;      // the result's `agentId: …` — what SendMessage `to` names
  ```
  Usage keeps its §13 home (`tokens`, `toolUses`, `durationMs`): the result's `<usage>` block, once parsed, overrides them
  (final numbers).
- **Cleaning** an `Agent` / `Task` `tool_result` (its text blocks joined): (1) a leading `[Subagent hand-back] …` preamble is
  removed through the line ending in `The report follows:`; (2) when every non-empty line of what remains starts with two
  spaces, two are removed from each; (3) a trailing `agentId: <id> (use SendMessage …)` line and a `<usage>…</usage>` block
  (`subagent_tokens` or `total_tokens`, `tool_uses`, `duration_ms`) are parsed and removed; blank lines at both ends are
  trimmed. A result with none of these markers (another CLI) is kept as it came.
- The call's `tool_result` event and row: `preview` = the cleaned text's first 500 chars, `truncated` = it is longer; plus
  `agentUsage?: {tokens, toolUses, durationMs}` and `cliAgentId?`. The chat's "에이전트 보고" shows `preview`.
- **Kept:** the cleaned report up to 50 000 chars, in memory and in the transcript row (`report`, `reportTruncated: true`
  beyond 50 000). `transcript_restore` leaves `report` out of the rows (restores stay small); `agent_report` reads it.
- **`agent_report {toolUseId}`** → `agent_report {toolUseId, text, truncated, usage, model, prompt}`: from memory, else from
  the current chat's transcript (the tool_use row gives `prompt` / `model`, the result row the rest). `prompt` is the
  whole instructions (≤ 50 000 chars; null when unknown), `usage` null when no numbers are known. It never waits behind the
  main lane (a pure read, like `permission_rules`).
- Refusals: `unknown_agent` (no Agent / Task call with that id in this engine or the current chat), `no_report` (still
  running, or its result had no text).

```json
{"type":"agent_report","id":"r7","toolUseId":"toolu_01Ab…","text":"## 쿠폰 코드 사용처 14곳\n- api/src/main/…","truncated":false,
 "usage":{"tokens":14794,"toolUses":12,"durationMs":491500},"model":"opus","prompt":"couponCode 가 쓰이는 곳을 모두 찾아…"}
```

- Compatibility: without the fields clients keep the raw preview and hide "보고서 전체 보기"; an older client simply gets the
  cleaner preview.
- Security: read-only; the report is the subagent's text, rendered like assistant text.
- Owners: engine-agents (`session/agents.ts`, `session/claude.ts`, `session/toolOutput.ts`, the transcript rows); screens
  mac-/desktop-agents ("Agent details" sheet: Instructions, Report — copy / "Send to main chat" / "Ask in a side thread" —,
  tool calls, files, usage and model chip; opened from the agent card, the chat group head and the HUD agent chip).
- **As built (engine-agents; `session/agentReport.ts`).** The trailer comes off before the indentation (it sits at column 0;
  a trailer-like line inside the report is indented by the harness and stays); a CR left by the removed line break goes
  too. Verified with CLI 2.1.307–2.1.309 (`sidecar/test/driver-agents.mjs`). An **error result** (a stopped or failed
  agent) and a background agent's "launched" placeholder are not a report: no `reportPreview`, no `report` in the row, and
  `agent_report` answers `no_report` (the row's `preview` shows the error). §34.8's `why` reads the cleaned text (its first
  4 000 chars). Memory is this engine's last 200 calls / 4 M chars (instructions and report, ≤ 50 000 each); `usage` falls
  back to the node's task numbers when the result had no `<usage>` block. A row written before §36 (no `report`) answers
  with its `preview` cleaned, `truncated` as the row says. `transcript_restore` loses `report` / `reportTruncated` wherever it
  is emitted. `agent_report` runs on the query lane (with `permission_rules`, `list_files`).

### 36.2 Stop one agent (agents-04)

Stop the one subagent that went astray while the turn and the other agents go on.

- `stop_agent {toolUseId}` → `result{ok}` once `query.stopTask(<AgentNode.id>)` (the task id of `task_started`) returned.
  The node becomes `status: "stopped"`, `stoppedBy: "user"`, `endedAt` set; the CLI then sends `task_notification
  {status: "stopped"}` and the Agent call's `tool_result` (`isError`, "[Request interrupted by user for tool use]"), whose
  event and row carry `stoppedBy: "user"`. The main turn and the other agents keep running (verified with CLI 2.1.307).
- It never waits behind the main lane (a running `send` / `interrupt`).
- Refusals: `unknown_agent` (no node with that `toolUseId`), `not_running` (not pending / running / paused),
  `not_supported` (no task id — a CLI without task messages, where `id` is the tool_use id — or no `stopTask` on the query).
- What the agent changed before it stopped stays in the turn and is reviewed at its end like any other change.
- Compatibility: older engines → no stop control. Older clients show a `stopped` node as before.
- Security: stopping grants nothing; it is a narrow `interrupt`.
- Owners: engine-agents; screens mac-/desktop-agents (hover ■ on a running card, context menu "Stop this agent", the chat
  group head menu; no confirmation; a stopped card reads "Stopped by you").
- **As built (engine-agents).** On the query lane; `stopTask` gets 5 s. From the request on, the agent's end is the user's
  however it arrives — the `stopped` notification, the interrupted `tool_result` (`stopped`, no longer `failed`) or
  `stopTask` returning (the CLI's order is notification, `stopTask` resolving, result); one that completed on its own before
  the stop landed stays `completed` without `stoppedBy`. A failed `stopTask` answers `not_running` when the agent ended
  meanwhile, `not_supported` otherwise (with the SDK's text) — and ok when the CLI's notification had already stopped it.
  Stopping an agent a SendMessage is running again (§36.3): the interrupted SendMessage's result carries `stoppedBy` too.
  Measured with CLI 2.1.309: `stop_agent` answered in 23 ms and the stopped agent's `sleep 60` ended with it.

### 36.3 Agents continued with SendMessage (agents-15)

An agent Claude continues shows as working again, under its original group.

- A `task_started` for a task id whose node has finished: `status: "running"`, `endedAt` removed, `resumeCount` + 1,
  `resumedBy` = its `tool_use_id` (the SendMessage call). `isBackground` is false while that SendMessage call has no result
  (the main agent blocks on it — the CLI registers every resume as background), true if it returned before the agent
  finished. The task messages that follow update the node as on its first run (before §36 they were ignored for a
  finished node).
- The engine remembers task id → the node (toolUseId, type, description, prompt, model, cliAgentId) for the session's
  lifetime, so a continuation after the next turn dropped the finished node (§13 lifetime) brings it back with its original
  `toolUseId` — its inner calls carry that as `parentToolUseId` (observed) — and the next `resumeCount`.
- The `tool_use` of a `SendMessage` whose `to` is a known agent's `cliAgentId` (or task id) carries `continues
  {agentToolUseId, agentType}` (event and row). Other targets (another session, a named teammate) get none.

```json
{"type":"tool_use","id":"toolu_02Cd…","name":"SendMessage","input":{"to":"a1b2c3d4","message":"gradle 테스트도 돌려줘"},
 "continues":{"agentToolUseId":"toolu_01Ab…","agentType":"executor"}}
```

- Compatibility: absent = never continued (the card stays "completed" as before).
- Owners: engine-agents (`session/agents.ts`); screens mac-/desktop-agents ("Resumed (run %d)" with %d = `resumeCount` + 1;
  the SendMessage row "Continue %@: %@" — type, first line — expands the original group).
- **As built (engine-agents).** A continuation clears `summary`, `lastTool`, `error` and `stoppedBy`. A node continued in
  place keeps its `startedAt` (the bar spans both runs; `waitingOnAgents.longest.startedAt` is the current run's); one the
  next turn had dropped comes back into this turn's list as a card of this turn — `startedAt` = the continuation's start,
  no `files` or usage yet — with the original call's `prompt`, `model`, `cliAgentId` and `reportPreview`. Up to 200 task ids
  are remembered (reset with the chat / project). `continues` matches `to` against a remembered task id, then a known
  `cliAgentId`.
- **The continuation's report** (addition): the SendMessage's own result — a JSON status line (`{"success":true,"message":
  "Resumed agent. …"}`), then the hand-back frame of §36.1 — is cleaned the same way (`preview`, `agentUsage` / `cliAgentId`
  when present, `report` in the row), and `agent_report {toolUseId: <that SendMessage>}` answers with it: `prompt` = its
  `message`, `model` = the agent's (from memory, or from the transcript: the SendMessage row's `continues`, the Agent row's
  `model`). CLI 2.1.309 puts no `agentId:` / `<usage>` trailer on it. A SendMessage result without the frame (another session,
  a message queued for a running agent) stays as it came.

### 36.4 Waiting on subagents (agents-05, short term)

Say that the main agent is blocked on subagents, on which, and for how long.

- `hud.waitingOnAgents: {count, longest: {toolUseId, type, startedAt}} | null` — non-null only while a turn runs and at
  least one foreground top-level subagent is live (`depth` 1, not `isBackground`, pending / running / paused; a blocking
  continuation counts). `count` = those; `longest` = the earliest `startedAt` (epoch ms; of the current run for a continued
  one). Sent with the agents (§13 coalescing); null between turns.

```json
"waitingOnAgents":{"count":2,"longest":{"toolUseId":"toolu_01Ab…","type":"executor","startedAt":1792710000000}}
```

- The gate-aware background mode (audit medium term) is not part of §36: background tasks stay off (§13).
- Compatibility: older engines → no status line.
- Owners: engine-agents; screens mac-/desktop-agents (composer status line "Main is waiting for %d subagents · %@ %@",
  queued messages "Sends when the agents finish", one OS notification per turn — "Subagents finished — Claude is
  continuing" — when all finished while the app is in the background).
- **As built (engine-agents).** An engine with §36.4 always sends the field (`null` in the initial state too), as a new
  object whenever it changes. "A turn runs" is the gate's (`send`, `request_changes`, a plan follow-up, a released peer
  turn); a turn the CLI ran on its own (§18) never sets it.

### 36.5 Slash commands with descriptions (SME-03)

The palette shows what each command does and what it takes, right after the session starts.

- `capabilities.commands?: SlashCommandInfo[]` — `{name, description, argumentHint, source, plugin?, server?, aliases?}` —
  filled from `query.initializationResult().commands` (about a second after the start, no message needed) and replaced by
  every `system/commands_changed`. `source`: `builtin` (the CLI's own), `user` / `project` (commands and skills under
  `~/.claude` / `<root>/.claude`), `plugin` (`plugin` = its name, the `<plugin>:` prefix), `mcp` (`server` = the server),
  `unknown`. `slashCommands` / `skills` stay as they are; `commands` is cached with them.
- `capabilities.state: "starting" | "ready"` (absent = `ready`): `starting` from the session start until initialize
  answered. Meanwhile `capabilities` is the cache (`capabilitiesCached: true`) or empty lists — no longer null while a
  session starts.
- The cache is written to `<gitdir>/reviewgate/capabilities.json` **and** `<git common dir>/reviewgate/capabilities.json`; a
  worktree without its own (a new workbench) replays the common one until its first initialize.

```json
"capabilities":{"slashCommands":["mcp","writer-kit:writer-deck"],"skills":["writer-kit:writer-deck"],"plugins":["writer-kit"],"mcpServers":[],"state":"ready",
 "commands":[{"name":"mcp","description":"Manage MCP servers","argumentHint":"[reconnect|enable|disable [<server>|all]]","source":"builtin"},
             {"name":"writer-kit:writer-deck","description":"슬라이드 초안 작성","argumentHint":"<주제>","source":"plugin","plugin":"writer-kit"}]}
```

- How the source is read (CLI 2.1.309, probed): the CLI's own commands carry `builtin: true`; a command / skill of
  `~/.claude` or `<root>/.claude` ends its description with ` (user)` / ` (project)` (removed here; a command in a subfolder
  is `<folder>:<name>`); a skill of the user's claude.ai account ends with ` (claude.ai sync)` and counts as `plugin`, named
  after its alias's prefix (`anthropic-skills:docx` → `plugin: "anthropic-skills"`, else `claude.ai`); any other
  `<prefix>:<name>` is a plugin's; an MCP prompt is listed as `<server>:<prompt> (MCP)` (split at the last colon: a
  plugin's server is `plugin:<plugin>:<server>`) and becomes `name: "mcp__<server>__<prompt>"` (characters outside
  `[A-Za-z0-9_-]` → `_`, as the CLI names MCP tools; the `system/init` `slash_commands` spelling it runs); what nothing marks is
  `unknown` (a CLI that marks no command `builtin` has its plain names counted `builtin`). `description` is the first line,
  ≤ 200 chars (the snapshot carries every command); `argumentHint` ≤ 120 chars (the CLI's `[object Object]` for a YAML list
  hint becomes ""); a repeated name keeps its first entry.
- `state` goes `starting` when a session start begins and `ready` when initialize answered (or `session_info` arrived); a
  start that ends without it (no CLI, the CLI died, the session was stopped) drops `state` again; the cache shown between
  `open_project` and that start carries no `state`. `state` is never written to the cache.
- Compatibility: without `commands` the palette lists names only; without `state`, null capabilities while
  `session.starting` also read "Starting session…" (never "enable user settings").
- Owners: engine-session (`session/claude.ts`, the capability cache in `engine.ts`); screens mac-/desktop-session (name,
  one-line description, dimmed argument hint; groups built-in / mine / project / each plugin / MCP; recently used first).
- **While Claude works (r1-composer M14).** The palette (`/` at the start of the box, ⌘/) opened only while a message
  could be sent, so the next skill had to be typed from memory while Claude worked or the session started. It now works
  whenever a project is open (Core `AppState.canUseSlashPalette`): the session's commands, the cache, or "Starting
  session…" while the CLI starts. A pick only goes into the draft; ↩ then sends it, puts it into the running turn (§50 —
  the CLI expands a command sent that way) or queues it, like any message. Mac:
  `ComposerModel.paletteVisible(available:)` / `openPalette(available:)`; Electron: `slashPaletteShows`
  (`SlashPalette.tsx`). Verified: Core `ComposerPaletteTests` (running, starting, no project), Electron
  `SlashPalette.test.ts` ("when the palette shows").
- **A plugin installed while the session runs (composer).** The CLI notices a new skill or command under `~/.claude` or
  `<root>/.claude` by itself (`commands_changed`, probed with CLI 2.1.322). It never notices a plugin installed, removed or
  switched on or off after it started, for example with `/plugin` in a terminal. The palette went on without it until the
  next session, while the terminal listed it. While a session of ours is alive and the user's settings are loaded, the
  engine looks at the files that say which plugins load every 5 s: `<config>/plugins/installed_plugins.json`,
  `<config>/settings.json`, `<root>/.claude/settings.json` and `settings.local.json`. When one changed and no turn runs
  or is collected, the CLI reloads its plugins (`Query.reloadPlugins({holdOnCacheImpact: true})`). Its commands replace
  `capabilities.commands`, and its plugins replace `plugins` / `pluginDetails`. A held reload (it would change the tools
  the conversation's prompt cache depends on, such as a plugin's MCP server) changes nothing, and the plugin loads with
  the next session. During a turn the look waits until the turn is over. Nothing changes on the wire. Engine
  `startPluginSync` / `syncPlugins` (`engine.ts`), `ClaudeSession.reloadPlugins`; test `engine.pluginSync.test.ts` (a
  reload after the file changed, none during a turn, a held reload, none without user settings). Real CLI: a scratch
  `CLAUDE_CONFIG_DIR` with a directory marketplace; `claude plugin install demo-two@demo-market` while the session ran
  put `demo-two:two-skill` into `capabilities.commands` (it was missing before).

### 36.6 Local settings (SME-01)

What the terminal loads from `.claude/settings.local.json` and the local-scope MCP servers loads in the app too — or the
app says what it left out.

- `settings.loadLocalSettings` (default true; the clients keep it per project and send it before `open_project`; next
  session start): `settingSources` gains `"local"` — `["user","project","local"]`, `["project","local"]` without user
  settings. `session.extensions.settingSources` says what the session used. The §16 fallback drops `local` with `user`
  (`["project"]`): a local MCP server or hook can be what hangs the start.
- When local settings are not applied (the setting off, or the §16 fallback): `session.extensions.notApplied {hooks:
  [{event, command}], envKeys, mcpServers, allowRuleCount} | null`, read from `<root>/.claude/settings.local.json`
  (`hooks`, the keys of `env`, the count of `permissions.allow`) and `~/.claude.json` `projects[<root>].mcpServers`
  (names). Names, commands (≤ 200 chars) and counts only — never an env value. null when local settings apply or hold none
  of these.
- `mcp_add` / `mcp_remove` take `scope: "local"` (`claude mcp add|remove --scope local`: `~/.claude.json`, this project
  only). `McpServerInfo.source: "local"` already exists.
- Claude in Chrome: with user settings loaded, a session starts with `--chrome` when Claude Code's own `/chrome` ›
  "Enabled by default" is on (`claudeInChromeDefaultEnabled` in the same `.claude.json`), as the terminal does. A session
  the SDK starts ignores that setting, so without the flag `claude-in-chrome` never connects (verified against CLI
  2.1.317 and 2.1.318). The server shows in `mcp_status` with scope `dynamic` (source `session`). Its tools are MCP tools,
  so each call has its card. The exception is a tool that only reads and that one of the user's own allow rules covers
  (§33.5). A session without user settings, such as the §16 fallback, starts without it.
- Security: local `permissions.allow` rules are §33.5 rules of scope `local` — they apply only to tools that cannot change
  files, and the engine's PreToolUse hook decides before the CLI's rules — so they never skip a card the engine asks today,
  nor the review of an edit or a command. Local hooks run like user / project hooks (§16; `disableUserHooks` turns them off
  too). `settings.local.json` itself stays uncaptured (§32).
- Details: `notApplied.hooks` lists the command hooks (`type: "command"`), sorted by event; `envKeys` sorted; `mcpServers`
  are the names under `projects[<project path | root>]` (as given or symlink-resolved) of `<CLAUDE_CONFIG_DIR>/.claude.json`,
  else `~/.claude.json` (only read; cached by mtime / size). While local settings apply, their hooks are listed in
  `extensions.hooks` as a `project` source whose `path` is `settings.local.json` (`ExtensionHook.source` has no `local`).
  The local allow rules follow the toggle: off, the engine applies none of them (§33.5) and `permission_rules` (§33.8) lists
  them last with `why: "local_settings_off"`; `defaultMode` still reads the local file (it is the terminal's). Verified
  against CLI 2.1.309: with `local` a local SessionStart hook ran with the local `env`, and a local-scope MCP server
  connected (`source: "local"`); without it neither.
- Compatibility: older engines ignore the setting (no `local`, no `notApplied`) and refuse `scope: "local"`
  `invalid_mcp_scope`.
- Owners: engine-session (`session/extensions.ts`, `mcp/mcp.ts`); screens mac-/desktop-session (per-project toggle "Load
  local settings (settings.local.json)", default on; section "Not applied in the app"; MCP scope "Local (this project, only
  me)").

### 36.7 Extensions start (robustness-05)

A slow start with plugins, MCP servers and hooks waits instead of dropping them; a real hang still falls back, visibly,
and comes back.

- **Stall timer.** The §16 watchdog restarts at every progress signal of the starting CLI (`system/hook_started`,
  `hook_progress`, `hook_response`, `status`, `plugin_install`) and fires only after the limit passed with no signal.
  CLI 2.1.309 runs the SessionStart hooks before it answers initialize and reports each (`hook_name`
  `SessionStart:startup`); it reports nothing while it connects MCP servers (no "MCP server status change" signal exists
  before initialize). The watchdog is also armed when only the local settings load (§36.6), whose hooks / MCP servers can
  hang a start as well. After initialize the same messages are ignored as before.
- **Limit** = max(`settings.extensionsInitTimeoutMs`, adaptive); `0` still turns the watchdog off. Adaptive = 2 × the
  longest of the last 3 successful starts with user settings (start → initialize answered), at least 45 000 ms; 45 000 ms
  without history. Kept per repository in `<git common dir>/reviewgate/extensions-start.json` (every worktree of it shares
  the history; a start's length depends on the project's own hooks / MCP servers as much as on the user's). The setting is
  a floor so the 20 000 the Electron client always sends does not cut a start short.
- **Waiting on.** `session.extensionsWaitingOn: {kind: "hook" | "mcp" | "plugin" | "unknown", name} | null` while starting:
  the latest hook still running (by `hook_id`; `name` = its `hook_name`, else its event), else a plugin install in progress
  (`name` = the marketplace, null for the whole install), else `{kind: "unknown", name: null}` (the CLI works on something it
  does not report); null before the first signal and once initialized. `kind: "mcp"` is not sent by CLI 2.1.309.
- The fallback's `message` says how long the start made no progress and what it waited for ("… did not start within 45 s of
  its last progress with your user settings (plugins, MCP servers, hooks) — it was waiting for SessionStart:startup; …").
- **After the fallback** (the §16 restart without user settings, unchanged): `session.extensions.fallback {reason,
  timeoutMs, at}` is what "extensions off" shows from — it already stays until the project reopens or a retry succeeds.
  `retry_extensions` restarts the session with the user's settings (resumed, as `restart_session`) and clears the fallback.
  The engine also retries **once** by itself, the first time the session is idle after a fallback (no turn, start,
  collection or permission card) — for 5 s, so a message queued for the fallback session goes first; a timeout during a
  retry (by hand or by itself) falls back again and is not retried. A retry whose start answers initialize ends the
  episode: a later fallback gets its own automatic retry.
- Refusals (`retry_extensions`): `no_session`, `extensions_on` (no fallback active), `session_busy` (a turn, start or
  collection runs).
- Compatibility: older engines keep the fixed watchdog and send no `extensionsWaitingOn`; the chip can still come from
  `fallback`, the retry button is hidden.
- Owners: engine-session (`engine.ts` init watchdog, `session/claude.ts` system messages); screens mac-/desktop-session
  (start banner "Waiting for %@"; HUD chip "Extensions off" with "Retry with extensions").

### 36.8 CLI version (daily-06)

A CLI that updated overnight is noticed, and an unverified one can be swapped for the one before.

- `session.cli: {version, verified, verifiedRange: {min, max}, previous: {version, path} | null} | null` (null without a
  session start, and while the version is unknown). `version`: what the running CLI reports (`system/init`
  `claude_code_version`; until then `toolchain.claudeVersion` read at every session start — only a `<x.y.z> (Claude Code)`
  line counts). `verified`: inside `verifiedRange`, an engine constant (inclusive, `compareVersions`; today
  `{min: "2.1.301", max: "2.1.318"}` — the top is the CLI the real-CLI drivers last passed on). `previous`: the version
  used before this one, from an app-wide record (`<app data>/cli-versions.json`, §20); `path` =
  `~/.local/share/claude/versions/<ver>` (or `<ver>.exe`) while it exists (pinnable), else null.
- When the version differs from the record's last one, the first session that sees it sends **once** the notice
  `error{fatal: false, scope: "session", code: "cli_version_changed", message, cli: {from, to, verified}}` (a transcript row
  like every notice, §30 / §35.3; not `state.lastError`) and updates the record (`previous` := the old version). The very
  first version the record sees is written without a notice (`from` is never null today).
- `cli_versions` → `cli_versions {versions: [{version, path, verified}], current, pinnedPath}`: the entries of
  `~/.local/share/claude/versions` (the native installer's; on Windows under `%USERPROFILE%`), newest first; `current` =
  `session.cli.version` (else `toolchain.claudeVersion`); `pinnedPath` = `settings.claudePath` when set. No refusal (an
  empty list without the folder).
- **Verifying a new CLI — no release needed.** `make verify-cli` (scripts/verify-cli.sh) runs the real-CLI drivers (crash,
  hookblock, peer, perms, gate, review2, why, agents, session, flow, follow — `RG_MODEL=haiku node
  sidecar/test/driver-<name>.mjs <scratch> sidecar/dist/sidecar.mjs`, each with its own `REVIEWGATE_DATA_DIR` in a scratch
  folder) against the installed CLI; when all pass it adds the version to `<data dir>/verified-cli.json`
  (`{ version: 1, verified: [{ version, engine, at, drivers }] }`, scripts/verified-cli.mjs). The engine counts a version
  verified when it is inside `VERIFIED_CLI_RANGE` or listed there (`verifiedCliVersions`, read at each session start and
  for `cli_versions`), so `session.cli.verified` and the clients' banner follow without a new app. `IF_NEW=1` skips a
  version already verified (for a scheduled run); a failed driver records nothing and keeps the logs. A release may still
  raise `VERIFIED_CLI_RANGE.max` to fold listed versions into the range. 2.1.314: all eleven passed with haiku (2026-10-30); 2.1.318 too (2026-11-04).
- Pinning is `set_settings {claudePath: <path>}`, unpinning `claudePath: ""`. The engine re-locates the toolchain right
  away (`state.toolchain` shows the pinned CLI); the next session start (`restart_session`) uses it. `cli_versions` runs on
  the `query` lane.

```json
{"type":"error","message":"Claude Code changed from 2.1.307 to 2.1.308 (not verified yet).","fatal":false,"scope":"session",
 "code":"cli_version_changed","cli":{"from":"2.1.307","to":"2.1.308","verified":false}}
```

- Security: the versions folder is listed by name only; `claudePath` must name an executable file (else the start fails
  `cli_not_found` as today).
- Compatibility: without `session.cli` no banner; an older client shows the notice's `message`.
- Owners: engine-session (`platform/toolchain.ts`, `engine.ts`); screens mac-/desktop-session (banner "New CLI %@ — not
  verified yet" once per version, closable, the banner comes from `session.cli` — the notice is the chat row; "Pin previous
  version" when `previous.path`; Settings list "Pin CLI version").

### 36.9 Other Claude sessions (market-03)

See the terminal Claude sessions working in this repository, and carry one into the app.

- `cli_sessions` → `cli_sessions {running, resumable}` (never waits behind the main lane):
  - `running[]` `{pid, sessionId, name, cwd, status: "idle" | "busy" | "waiting" | "unknown", entrypoint, sameWorktree}`
    from `<config>/sessions/<pid>.json` only (`<config>` = `CLAUDE_CONFIG_DIR` or `~/.claude`; the §31.4 registry): live
    pids only, cwd inside this repository's main worktree or one of its linked worktrees, this engine's own CLI processes
    left out; `sameWorktree` = cwd inside this window's worktree. The `*.key` files there — anything but `<pid>.json` — are
    never opened.
  - `resumable[]` `{sessionId, title, updatedAt, cwd}` from the SDK's `listSessions({dir: <main worktree>,
    includeWorktrees: true, includeProgrammatic: false})`: newest first, at most 50, without the running ones and without
    the chats this app already has.
- `cli_session_import {sessionId}` → `result{ok}`: a new chat of this window that resumes that conversation
  (`SessionMeta {title: its title, cliKnown: true, imported: {at, cwd}}`), made current like `session_open`
  (`transcript_restore {items: []}`: the terminal conversation stays in the CLI's file, no rows are copied). From then on
  everything goes through the gate: the next `send` takes its snapshot A — what the terminal session changed before is the
  baseline, not a review.
- Refusals: `no_project`; import also `unknown_session` (not among the resumable), `cli_session_running` (a live registry
  entry has that `sessionId`: two processes on one conversation would corrupt it) and the refusals of `session_open`.
- Handing a folder to the app (Mac `open -a` / URL scheme, Electron's second instance) is client-only.
- Details: `running` lists this window's worktree first (`sameWorktree`), then by pid; a registry `status` other than the
  three reads `unknown`; an entry whose `procStart` is not the process's start (a reused pid) is dropped, and so is every CLI
  whose parent is the engine (side questions, drafts) and the main session's own CLI — the user's other ReviewGate windows
  are listed (`entrypoint: "sdk-ts"`). `resumable` asks `listSessions` for 200 and keeps 50 after the exclusions; `title` =
  the custom title, else the summary, else the first prompt (one line, ≤ 120 chars); `updatedAt` = the file's
  `lastModified`. The listing runs in the engine's process (its `CLAUDE_CONFIG_DIR`). An imported chat's title follows the
  chat title rule (docs/M15-POLISH.md, ≤ 60 chars); its first turn cannot rewind the conversation to before it (the
  terminal's last point is not known). Verified against CLI 2.1.309: a conversation made in one worktree resumes from
  another worktree of the same repository (the CLI finds it), and print-mode (`-p`) conversations are programmatic
  (`sdk-cli`), so they are not listed.

```json
{"type":"cli_sessions","id":"q3","running":[{"pid":82411,"sessionId":"5d0c…","name":"acme-b4","cwd":"/Users/me/acme",
 "status":"waiting","entrypoint":"cli","sameWorktree":true}],
 "resumable":[{"sessionId":"9f1e…","title":"장바구니 합계 수정","updatedAt":"2026-10-23T02:10:00.000Z","cwd":"/Users/me/acme-1600"}]}
```

- Security: the registry is only read (ids, names, cwd, status); nothing is sent to the other processes. An import brings
  no permission along: every card the app asks still comes.
- Compatibility: older engines → no section, no import sheet.
- Owners: engine-session (`review/cliSessions.ts`, `review/concurrent.ts`, `review/sessions.ts`); screens mac-/desktop-session (sidebar "Other Claude
  sessions in this repository" — name, folder, "Working" / "Waiting for input" / "Idle" — refreshed every 30 s while the
  window is frontmost; "Import a CLI session" sheet; "Continue in terminal" copies `cd <folder> && claude --resume <id>`;
  an imported chat says "The review gate applies from here on").

### 36.10 Side questions during a turn (SME-02)

A side question asked while a turn runs knows what that turn was asked and has done so far.

- When a thread's first question starts `fork_at` or `fresh` while a main turn runs, its prompt gets, after the anchor
  context, a block `[Turn N in progress — not part of the forked conversation]` with the turn's `user_message` (mentions
  listed; ≤ 4 000 chars), the turn's assistant text so far (its last ~2 000 chars) and its tool calls so far in order (name
  + short input: the Bash command, the file path or a compact preview, ≤ 200 chars each; the newest 40; a subagent's
  calls under its agent type). A `fork_full` while a turn runs gets nothing more (the fork may hold part of the turn).
- `thread.fork` (`SideFork`) gains `atTurn?: number | null` — the last main turn the fork contains (null: fresh) — and
  `runningTurn?: number | null` — the turn the block summarizes (null: no block).

```json
"fork":{"mode":"fork_at","fromSessionId":"4c2a…","at":"b7e1…","atTurn":6,"runningTurn":7}
```

- Compatibility: older engines send neither field → no chip.
- Security: the §21 read-only side session, unchanged.
- Owners: engine-flow (`side/context.ts`, `engine.ts` fork source); screens mac-/desktop-agents (thread head chip "Turn %d in
  progress — only a summary was shared"; the new-question hint names only what the fork knows — never the review list).
- *Engine notes (`side/runningTurn.ts`, `side/threads.ts`):* the block is built from the chat's transcript rows of that turn —
  its `user_message` (or, for a §29 peer turn, the delivered `peer_message` bodies) and its `tool_use` rows in order, an
  Agent / Task call's own calls indented and labelled `[<subagent_type>]` — plus the engine's text of the turn so far; the
  request and the text are quoted in a backtick fence longer than any run inside them. `atTurn` = the turn whose §26
  record ended with the fork's chain uuid (`fork_at`), the chat's turn count (`fork_full`), null (`fresh`). `runningTurn` is
  set only for a turn the engine started (an unprompted CLI turn, §18, has no request to summarize) and stays on the
  `fork_full` retry of a failed `fork_at` (the prompt does not change). A follow-up question resumes the side session and
  gets no block.

### 36.11 Commit message draft (daily-05)

Claude drafts the commit message in the project's format; the user commits.

- `commit_draft {paths?}` → `commit_draft {message}`. `paths` as `commit` (default `commit.acceptedPaths`; every path must
  be accepted). A read-only fork (§21 fork rules; no side thread is created) gets the accepted diff of those paths (A → B,
  ≤ 2 000 lines, then the file list with +/−), the last 20 commit subjects (`git log -20 --no-merges --format=%s`), the
  branch name and `settings.commitTemplate` rendered — `{issue}` = the branch name's last run of digits
  (`feature/PAY-1502` → `1502`; empty without one), `{branch}` = the branch — and answers with the message alone. The
  engine trims it (no code fence) to ≤ 5 000 chars; `commitTrailer` is still added by `commit`.
- Nothing is committed; the main chat is untouched. Side lane.
- Refusals: `no_project`, `nothing_to_commit` (no accepted path, or a path that is not accepted), `side_limit`,
  `cli_not_found` / `cli_not_executable`, `commit_draft_failed` (`commit_draft_failed:<why>`: the fork failed or answered
  nothing).

```json
{"type":"commit_draft","id":"c4","message":"PAY-1502: 재고 동기화 - 중복 차감 방지\n\n- 같은 주문의 재고를 두 번 차감하던 조건 수정"}
```

- Compatibility: older engines → the button is disabled with its reason.
- Security: read-only fork; never `git commit`; the draft only fills the sheet's field (no automatic commit).
- Owners: engine-flow (`review/commitMessage.ts`, `side/`); screens mac-/desktop-flow ("Write with Claude" → progress → the
  field; a failure is one line; per-project "Commit message template").
- *Engine notes (`review/commitDraft.ts`, `review/roundPatch.ts`, `side/threads.ts` `startDetached`):* the fork starts like a
  side question's first one (§21 fork source; a failed `fork_at` is retried on the whole session) with its own system
  text, no web tools and no session file (`persistSession: false`); it counts in the three running side queries (else
  `side_limit`) and is stopped with them (chat switch, `close_project`: `commit_draft_failed:cancelled`). The diff is A →
  `gate.reviewEndTree` of each path in order (a binary file is one line), cut at a line boundary; the file list always
  follows. The answer loses one surrounding code fence (with a one-line preamble before it). `commit_draft` also works
  while a turn runs (the held B).

### 36.12 Workbench setup (market-02)

A new workbench builds and tests right away: local-only files copied, the setup run, branched from a fresh remote base,
in the folder the user keeps worktrees in.

- `settings.workbenchSetup {copy?: glob[], useWorktreeInclude? (default true), setupCommand?, fetchBase? (default true),
  location?: "managed" | "sibling" (default managed)}` — per project in the clients, live.
- **Files to copy:** the untracked or ignored regular files of this worktree that match `copy` or, with
  `useWorktreeInclude`, `<root>/.worktreeinclude` (gitignore syntax, as Claude Code reads it). Never a tracked file (the
  checkout has it), never `.git`, no symlink followed out of the worktree; `..` and absolute patterns are ignored.
- **Location:** `managed` = under `settings.worktreeRoot` as today (§6); `sibling` = `<parent of the main worktree>/<repo
  name>-<branch tail>` (`feature/PAY-1600` → `acme-PAY-1600`). `workbench_create.path` still wins.
- `workbench_preview {branch, from?, location?}` → `workbench_preview {path, copy: [{path, bytes}], totalBytes, count,
  truncated?}` (at most 500 entries; `totalBytes` and `count` count all — "%d files will be copied" shows `count`, an
  older engine's reply without it the list's length). Refusals: `no_project`, `invalid_branch_name`.
- `workbench_create {branch, from?, path?, fetch?, setup?, location?, fromPr?}` runs on a lane of its own (a long setup
  never holds up the main lane) and replies after its last step:
  - `from` may be a remote-tracking branch (`origin/develop`). With `fetch` (default `fetchBase`) the engine first runs
    `git fetch <remote> <branch>`; when that fails the create goes on from the local ref if there is one, else it is
    refused `fetch_failed` (`fetch_failed:<git's first line>`).
  - Steps `fetch → create → copy → setup → done`, each a `workbench_progress {path, branch, step, logTail?, exitCode?}`
    (`path` = the new worktree: an event's `id` is a reply id). `setup` (default true) = the copy + `setupCommand` in the
    new worktree through the user's login shell (`$SHELL -lc`; Windows `cmd.exe /d /s /c`), at most 10 minutes (then
    killed: `exitCode: null`).
  - A failed setup does not fail the create: the reply is `result{ok}` after `done` (whose `exitCode` repeats the
    setup's); the client opens the window and shows the log.
- `state.branches.remotes?: RemoteBranchInfo[]` (`BranchInfo & {remote: true}`, `name` like `origin/develop`):
  `refs/remotes/*` without `*/HEAD`, at most 300, newest first, refreshed with `branches` / `refresh`. Never part of
  `list`, so the branch switcher does not offer them.

```json
{"type":"workbench_progress","path":"/Users/me/acme-PAY-1600","branch":"feature/PAY-1600","step":"setup",
 "logTail":"[INFO] BUILD SUCCESS\n","exitCode":0}
```

- Security: only the user's create runs the setup command — never Claude, never on open; it is the user's own setting,
  shown in the sheet first, and runs outside the review like a terminal command. Copies stay inside this repository's
  worktrees.
- Compatibility: older engines ignore the new `workbench_create` fields (a plain create from the given ref) and send no
  `remotes`; the sheet then hides fetch, copy, setup and remote bases.
- Owners: engine-flow (`git/worktrees.ts`, `git/branches.ts`, `engine.ts`); screens mac-/desktop-flow (remote base,
  "Fetch before creating", "%d files will be copied" with the list, "Setup command", "Managed folder" / "Next to the
  repository", steps and log while creating).
- *Engine notes (`git/workbenchSetup.ts`):* the copy list is git's own matcher — `git ls-files --others --ignored` with
  the `.worktreeinclude` lines first and the `copy` globs after them as `--exclude` patterns (so a glob wins over a
  `!` line of the file); a `copy` glob is anchored at the root (`mvnw` = `<root>/mvnw`; `**` spans folders; a folder
  copies what is in it), a `.worktreeinclude` line is used as written (gitignore syntax; a line or glob naming `..`, an
  absolute or drive / UNC path is dropped). git never lists a tracked file, anything in `.git` or inside a nested
  repository; symlinks and other non-regular files are skipped. The copy keeps the file mode, leaves a file the new
  checkout already has alone and never writes through a folder of the new worktree that resolves elsewhere (both
  listed in the copy step's `logTail`). Each step sends a `workbench_progress` when it starts (no `logTail` /
  `exitCode`); `fetch` and `copy` send one more with their log (`fetch` with git's exit code), a running `setup` sends
  its log tail at most once a second and ends with its `exitCode`; `done` follows the last step. The fetch is `git fetch
  --no-tags <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>` (so a single-branch clone's ref is updated
  too), without a credential prompt, at most 2 minutes; a remote base is recognized by a `git remote` name prefix and
  the new branch is created `--no-track` (the first push / `pr_create` publishes it under its own name). The setup runs
  `$SHELL -lc` (`/bin/sh` when `SHELL` is unset) with the toolchain's login PATH, in a process group that is killed at
  10 minutes and when the engine is disposed. `workbench_create` runs on the `workbench` lane, `workbench_preview` on
  the query lane. This engine always sends `branches.remotes` (`[]` until the first refresh / without remotes).

### 36.13 AI pre-review (market-04)

Claude reviews the round first; its findings sit on the diff lines, outside the main chat.

- `prereview_start {scope: "round" | "files", paths?, effort: "low" | "medium" | "high"}` → `prereview` (`status:
  "running"`) as soon as it started (side lane, like `side_ask`). A read-only fork (also allowed: `ReportFindings`; `Agent` / `Task` stay denied) runs `/code-review <effort>`
  with `CLAUDE_CODE_REPORT_FINDINGS=1`, told to review only this round's change — A → `gate.reviewEndTree` of every file
  (`round`) or of `paths` (`files`); the patch (≤ 3 000 lines, then the file list) is in its prompt. Its `ReportFindings`
  calls become the run's `findings` (`file` made repo-relative; `short_summary` → `shortSummary`, `failure_scenario` →
  `failureScenario`; `category` kept; ids `f1`, `f2`, …). `done` at its turn end (no call: no findings), `failed` with
  `error` when the fork failed, `cancelled` by `prereview_cancel`.
- `prereview {prereviewId, status, source, scope?, paths?, effort?, endTree, startedAt, endedAt?, findings, error?,
  costUSD?}` goes out at the start, when findings arrive and at the end; the same objects are `state.gate.prereviews`
  (newest first, at most 5). `endTree` = the B the lines refer to: a run whose `endTree` is not the current
  `gate.reviewEndTree` describes an earlier B (clients dim its findings: lines may have moved). `prereviewId`, not `id`:
  `id` is the command / reply correlation field (§1).
- `prereview_cancel {prereviewId}` stops a running one; `prereview_dismiss {prereviewId, findingId}` removes a finding.
- Runs are stored with the review (the review file) and removed when the round ends (§14, `finish_review`).
- **Main chat.** The main session also runs with `CLAUDE_CODE_REPORT_FINDINGS=1` (unless the environment sets it); its
  `ReportFindings` calls are allowed without a card — the tool reports, it changes nothing — and each becomes a run
  `source: "main"`, `status: "done"`, `prereviewId` = the tool_use id (kept in `prereviews` only while a review is in
  progress).
- Refusals: `no_project`, `no_review` (`reviewEndTree` null), `prereview_running` (a round run is running),
  `not_a_changed_file:<path>`, `invalid_prereview` (unknown scope / effort, `files` without `paths`), `side_limit`,
  `cli_not_found` / `cli_not_executable`; cancel / dismiss: `unknown_prereview`, `unknown_finding`, `not_running`.

```json
{"type":"prereview","id":"p1","prereviewId":"pr-3f2a","status":"done","source":"round","scope":"round","effort":"medium",
 "endTree":"9ac0…","startedAt":"2026-10-23T03:00:00.000Z","endedAt":"2026-10-23T03:01:40.000Z","costUSD":0.21,
 "findings":[{"id":"f1","file":"api/src/main/java/com/x/Svc.java","line":42,"summary":"A soft-deleted cart now throws NotFound",
              "shortSummary":"deleted cart throws","failureScenario":"cart soft-deleted → the nightly batch aborts","category":"correctness"}]}
```

- Security: the fork cannot change files; `ReportFindings` is a report in both sessions. "Add as note" is an ordinary
  `add_note` (then `request_changes`), "Ask in a side thread" an ordinary `side_ask`.
- Compatibility: older engines → the button is disabled with its reason; no `prereviews`.
- Owners: engine-flow (`side/`, `review/gate.ts` + `review/persist.ts`, `session/hooks.ts`); screens mac-/desktop-flow
  ("AI pre-review" in the Changes head; "Pre-reviewing…" / "%d findings" / failed with the reason; file list badges; diff
  line marks with an inline card — "Add as note", "Ask in a side thread", "Dismiss" —; cancel).
- *Engine notes (`review/prereview.ts`, `side/threads.ts` `startDetached`):* the fork's prompt is the slash command on its
  first line and the scope, the patch and the file list after it (the CLI hands the rest of the message to `/code-review` as its
  arguments; verified with CLI 2.1.309: the review keeps to the patch and reports through `ReportFindings` without a Bash
  call); it starts like a side question's first one (§21 fork source, fork_at → fork_full retry), with its own system
  text, `maxTurns` 60, no session file, and counts in the three running side queries. This engine always sends
  `gate.prereviews` (`[]` without runs). `prereviewId` = `pr-` + 8 hex digits. A finding needs a `file` and a `summary` (an
  empty `summary` takes `short_summary`); `line` is a positive integer or null; an absolute `file` inside the repository
  becomes repo-relative; a repeated finding (same file, line and summary) is dropped; ids count up per run and a dismissed
  id is never reused. A run the engine stopped (closing the project or the app, a chat switch: the fork belongs to the
  chat) ends `failed` with `error: "interrupted"`, one a restored review file still had running with `"interrupted
  (ReviewGate was closed)"`; `cancelled` is only the user's `prereview_cancel`. A run's fork is stopped when its round ends. The round ends —
  and `prereviews` empties — whenever the gate completes the round: a fresh `send` (a new A), nothing left to review,
  `finish_review`, `close_project` of a resolved review. The main chat's run keeps `endTree` = `gate.reviewEndTree` at the
  call (the held B during a question turn) and is kept only while that is non-null and the review has files — except a
  report made in a turn that had no review yet (Claude reviewing its own edits in the same turn): it waits for that
  turn's collection and, when the collection lists files on the same A, joins the new review with that B as `endTree`
  (its `prereview` event goes out again); otherwise it goes.

### 36.14 PRs and Claude (market-07)

Hand PR comments to Claude, ask about a PR hunk, open a PR as a workbench.

- `SideAnchor.pr? {number, path, line, side: "LEFT" | "RIGHT", hunk, commitId?}` — a line / hunk of the PR open in the PR
  tab: the side prompt gets `PR #<number> <path>:<line> (<side>)` and the hunk (cut at 4 000 chars), quoted as data; the
  review-anchor fields are then ignored. The side session is still a read-only fork of this window's main session.
- `workbench_create.fromPr {number, headRef}`: a local branch named `branch` is checked out as it is (refused
  `branch_in_use` when another worktree has it — the client offers that workbench instead); otherwise the engine fetches
  `refs/pull/<number>/head` from the PR's remote (the one whose URL matches the PR's repository, else `origin`) and
  creates `branch` from it (no upstream). Then the §36.12 copy and setup. Refused `fetch_failed` when the fetch fails.
  Clients pass `branch: headRef` (`pr-<number>` for a head from a fork).
- Sending comments to Claude is client-only: a composer draft (file, line, author and body of the chosen or of every
  unresolved comment) in the window of the PR head branch's workbench when one is open (`state.workbenches`), else in this
  window; with the client's per-project setting `prRespondCommand` (e.g. `/acme-tools:review-reply {pr}`, `{pr}` =
  the PR number; never sent to the engine) the draft is that command. Nothing goes out without the user's send, under the
  usual gate rules.
- Compatibility: older engines ignore `anchor.pr` (the question runs without the hunk) and `fromPr` (a plain create of
  `branch`).
- Security: a PR's text is untrusted — the prompt quotes it as data; the side session cannot change files.
- Owners: engine-flow (`side/context.ts`, `engine.ts`); screens mac-/desktop-flow ("Send to Claude" per comment, "Send all
  unresolved", PR diff line context menu "Ask in a side thread", PR head "Open as workbench").
- *Engine notes (`side/context.ts`):* `anchor.pr` is kept when `number` is a positive integer, `path` a non-empty string,
  `side` `LEFT` / `RIGHT` and `hunk` a string; a `line` that is not a positive integer becomes null and a `commitId` that
  is not 4–64 letters / digits is dropped. The thread then keeps only `{pr}` (the review fields are not stored, so the
  thread never becomes a review note: `side_promote {as: "note"}` is refused `side_no_anchor`). A malformed `pr` is
  dropped and the rest of the anchor applies. The hunk is quoted in a backtick fence longer than any run inside it.
- *Engine notes (`engine.ts` `workbenchCreate`, `prRemote`):* the PR's remote is the one whose URL (`parseRemoteURL`)
  names the host / owner / repository of the PR tab's summary with that number (the open PR, else a listed one), else
  `origin`, else the only remote; none → `fetch_failed:no remote`. The head is fetched into a temporary
  `refs/reviewgate/pr-fetch/<n>` (deleted once the worktree exists), so a concurrent fetch in the user's terminal cannot
  swap `FETCH_HEAD` under it. A `fromPr.number` that is not a positive integer is refused `invalid_pr_number`.
- *Engine notes (`send`):* a message whose first word is one of the session's slash commands or skills
  (`capabilities.slashCommands` / `skills`, e.g. the `prRespondCommand` draft or `/code-review low` for §36.13) — or a
  name or alias of `capabilities.commands` (a plugin skill typed by its short name: `/release-notes 12` for
  `acme-plugin:release-notes`, whose `aliases` hold `release-notes`) — goes out as that command, like `/compact` (§27):
  the "[Review gate] …" summary prefix waits for the next real message (a prefixed text no longer starts with `/`, so the
  CLI never ran the command: a `disable-model-invocation` skill failed outright, the others ran sideways through the Skill
  tool) and the text is not the commit sheet's suggestion source. While no list is known yet — a fresh worktree whose CLI
  has not answered initialize, no cache — any `/word` counts as a command (the summary waits a message rather than break
  one). Text that only starts with `/` (a path: a second `/` in its first word) is sent as before.

## 37. 0.2.3 engine follow-ups

An adversarial pass over the §34–§35 engine code that shipped in 0.2.2, and the engine follow-ups of its integration.
Nothing new on the wire: existing refusal codes on more commands (§37.1, §37.4) and existing fields set in more cases; the
sections above point here where they changed.

### 37.1 Nothing moves B while a collection failed

While a turn's collection failed (`gate.phase: "collect_failed"`), `reject`, `reject_all`, `reject_hunks` and `commit` are
refused `collect_failed` — like `finish_review` and `rewind` already were — until `retry_collect` succeeded. Each of them
re-snapshots B, and `retry_collect` collects only while B is unset: after one of them the retry did nothing, the failed
turn's changes never reached the review, and an answer turn's `isAnsweringReview` stayed set. `accept` / `accept_all` stay
allowed (§34.2: held against the held B, re-checked by the retried collection). `commit.canCommit` is false meanwhile.
Clients offer the refused actions disabled with the banner's reason; the retry is the way on — or (M30, §3) the next send,
which folds the failed turn into its own collection; the engine retries once by itself first. Tests:
`engine/test/engine.collectFailedGuard.test.ts`, `engine/test/engine.collectRetry.test.ts`.

### 37.2 A rejected file takes its notes with it

`reject`, `reject_all` and a `reject_hunks` that leaves nothing of the file drop that file's notes, sent ones too — as
`refresh`, `commit` and a collection already did for a file that left the list. Before, they stayed: the next
`request_changes` sent them (asking Claude about a change that had just been reverted), `canRequestChanges` stayed true,
`notes_pending` refused a chat switch with no note left on screen, and the review never counted as resolved. A
`reject_hunks` that keeps part of the file keeps its notes (new-side notes follow the new B, §34.4). No wire change:
`reviewNotes` simply loses them. Test: `engine/test/engine.rejectNotes.test.ts`.

### 37.3 One diff of the turn's own trees per collection

A collection diffs the turn's own start tree against B once (renames detected), and three readers share that delta:
`changedThisTurn` / `turnAdded` / `turnDeleted` (§34.3), the §34.8 "this turn's files" (which files get a fresh `why`) and
the turn's §26 checkpoint record (`files`, what a file rewind restores). Before, the §34.8 set came from a second,
name-only diff of the same two trees and the record from a third — two more `git diff-tree` runs (three processes) per
turn. The sets are unchanged: a rename counts by both its names, as the name-only diff listed them; the record keeps the
unfiltered delta (a tracked file the ignore patterns hide from the list is still a file the turn changed), the `why` set
looks at the listed files. Where the turn's own start tree is unknown (its snapshot failed), the `why` set now follows
`changedThisTurn` (the held B → B) instead of guessing from the turn's own calls. No wire change. Test:
`engine/test/engine.turnDelta.test.ts`.

### 37.4 A record's conversation rewinds only to its fresh start

In a chat opened as a record (§35.4: Claude Code no longer has its conversation), a conversation rewind (`conversation` /
`both`, §26) to a point inside that conversation cannot fork it. The engine used to try: it made a new chat, the fork failed
("No conversation found"), that new chat became a record too with a resume notice, and the record got the
"(되돌리기 전)" suffix — for nothing. Now those turns say `canRewindConversation: false` while the record is open, and the
rewind is refused `rewind_unavailable:conversation` before anything happens (a `both` rewind leaves the files as they are).
A point before the chat's first turn (a fresh fork) still rewinds — there is nothing to fork; a `files` rewind is
unaffected. Clients already disable the conversation choice on `canRewindConversation: false`. Test:
`engine/test/engine.recordRewind.test.ts`.

### 37.5 `reject_hunks` re-checks `whitespaceOnly`

A `reject_hunks` that keeps part of a file re-checks its §34.7 `whitespaceOnly` — one `-w` numstat of that file, next to the
diff the command already runs. Before, the flag stayed what the collection said until the list was rebuilt: a file whose
only real hunk was rejected, leaving an indentation change, was not marked (no "공백만" badge, not folded). A generated file
is left alone, as at a collection. No wire change: the file in `changedFiles` gains or loses the flag. Test:
`engine/test/engine.rejectHunksWs.test.ts`.

### 37.6 A path written with its folders names that file only

The §15 path mentions — the plan steps' files (`turn_summary.plan`) and the §34.8 `reported` reasons — took any mention of a
file's basename for that file, also inside another folder's path: in a multi-module change `acme-api/pom.xml: added
dependency X` explained `acme-core/pom.xml` too, ahead of its own `bumped Y`, and `acme-core/pom.xml` contained a
mention of `core/pom.xml`. Now the whole path counts alone or as the tail of a longer path (an absolute one); a trailing
sub-path, the basename and the distinctive stem count only where the mention starts with them (not after a `/` or inside
a longer name), and a name character right after a path ends no mention (`src/a.ts` is not `src/a.tsx`). A Windows `\` in the
text reads as `/`. No wire change. Test: `engine/test/review.whyPaths.test.ts`.

### 37.7 A command that only reads, searches or installs runs no test

The §12 runners (`vitest`, `jest`, `pytest`, `npm test`, `go test`, `cargo test`, `swift test`, `xcodebuild … test`) counted
anywhere in a Bash line, so a command that merely named one counted as a test run — and, exiting cleanly, as a passing one:
`grep -rn "jest" src`, `cat vitest.config.ts`, `npm i -D vitest`, `pip install pytest` became `turn_summary.lastTest`
"테스트 통과" (§34.9) and a `testOutcome` on the command while no test ran. Now they count per simple command, and never in
one whose program only reads, searches, prints, edits in place, fetches or installs (`grep`, `rg`, `cat`, `head`, `ls`,
`find` without `-exec`, `echo`, `sed`, `which`, `git`, `pip`, …; a package manager's `install` / `i` / `add` / `remove` /
`info` / `list` … command, `python -m pip`). A runner after such a command in the same line still counts
(`grep -c jest package.json && npx jest`), as does one handed to another program (`xargs npx vitest`, `docker compose exec
web pytest`, `bash -c "npm test"`). Also: a package manager running a test script with options before it counts
(`pnpm -r test`), and a Gradle dry run (`-m` / `--dry-run`) executes no task. A program is known by its name (§20
`programName`; a quoted `"C:\…\git.exe"` keeps its backslashes, as in Git Bash): before, Windows' `git.exe log
--grep=jest` or `git.exe commit -m "fix the vitest config"` was no `git` and counted as a test run. No wire change. Test:
`engine/test/session.testCommandsLooking.test.ts`.

### 37.8 A fresh turn called off after snapshot A leaves the review as it was

A fresh turn (nothing pending: a new snapshot A) that is called off after A was taken — `peer_accept` refused
`peer_inbox_changed` (§35.8: a message was held while A was taken), a `send` whose session went away right then, a peer
release that failed — now puts back what the new A replaced: A, B, the §34.1 ranges and what A had left out. Before, the
new A stayed and B was cleared: a review whose files were all accepted but not committed yet (no pending file, so the next
turn is a fresh one) lost every diff (`select_file` / `full_file` refused `no_review`), its "이번 턴" / "수락 이후" ranges
went, and the review file was saved that way. The turn's own collection drops what it would have put back. No wire change.
Test: `engine/test/engine.abortRestore.test.ts`.

### 37.9 `whitespaceOnly` fits a Windows command line

`whitespaceOnly` (§34.7) diffed up to 300 candidates with one `:(literal)<path>` pathspec each — a rename's two names both —
on one command line. Windows caps a command line at 32 767 characters: a review of a few hundred long paths (a Java package
move is 300 renames, 600 pathspecs) could not even start git, and every file silently lost the flag. The pathspecs now go
in calls of at most 16 000 characters, a rename's two names in the same call (or git would see a delete and an add); a
failed call marks none of its files. Beyond 300 candidates the whole `-w` diff runs once, as before. No wire change. Test:
`engine/test/review.detailChunks.test.ts`.

## 38. Wave 4 (first batch): daily friction

What gets in the way of daily use: work that stops or goes away without a word, a file reverted without asking, history
gone after a restart. Each lane took its own feature through the engine and both clients (no contract written first);
every subsection says how it was built. Additive on the wire: two query commands, optional fields, one setting, new
notice codes; nothing an existing client relies on changes meaning.

- §38.1 **Safety while Claude works** — close / quit and the reject shortcut ask first, a turn's notification says why it
  stopped, [강제로 다시 시작] after a stop that did not stop, checkpoint git capped at 300 s, a draft per chat (client rules).
- §38.2 **Long work** — the tool-call limit as a setting with [이어서 계속], hook / CLI words as chat rows, the usage windows
  and "풀리면 이어서 하기", a changed budget told to Claude.
- §38.3 **History that lasts** — earlier rows page in, turn summary cards survive a restart, the chat history searches the
  messages, the review history filters and says why a file changed.
- §38.4 **Install, projects and processes** — the disk image banner, recent projects without temp or gone folders, bounded
  worktree dirty checks, a forced stop that ends the whole process tree, path lists under the Windows command line.
- There is no §38.5: the 0.2.3 check (a §36 wire golden from the engine's own paths, `engine/test/fixtures/wire/wave3.agents.json`)
  and the input pass (IME Enter, shortcuts, the Korean glossary `docs/GLOSSARY.ko.md`) changed nothing on the wire.

```ts
// commands (reply)
transcript_page { sessionId?, before, beforeAt?, limit? } → transcript_page     // §38.3
transcript_search { query, limit? } → transcript_search                           // §38.3
// events: transcript_restore + start? / sessionId? (§38.3);  history_diff + why? (§38.3)
//         notices error{fatal:false, code: "max_turns" (+maxTurns) | "hook_failed" (+hookName, exitCode) | "hook_blocked" | "cli_warning" | "cli_notice"}   // §38.2
// state:  hud.rateLimits?   // §38.2
// rows:   kind "turn_summary" (§38.3);  error rows keep maxTurns? / hookName? (§38.2);  ReviewHistoryFile.commit? (§38.3)
// settings: maxTurns? (10–1000, default 200)   // §38.2
```

Rules: as §36 — every field optional, an older engine refuses the two commands `unknown_command` and the clients keep the
old behavior; Electron's main process forwards `transcript_page` / `transcript_search` (`ipcGuard.ts`). The gate stays:
nothing here answers or skips a permission request, and the read-only forks stay read-only (the §36.13 pre-review fork
also runs without web tools since 0.2.4: the patch it reads is untrusted text).

### 38.1 Safety while Claude works

Client rules (Mac and Electron the same, same i18n keys); the wire does not change. An older engine works as before.

- **Close / quit (daily-12, polish-12).** Closing a window (⌘W, the close button; Electron also Ctrl+W / Alt+F4) while
  `gate.phase === "running"`, or while `session.pendingPermission` / `session.pendingPermissions` / `session.pendingPlan`
  waits (a question is a permission request), asks first: "Claude가 작업 중이에요 — 닫으면 이 턴이 멈춰요" (waiting:
  "Claude가 답을 기다리고 있어요. …") with [닫기] [취소]; quitting asks once for every such window ([종료] [취소], the count
  when more than one). Idle windows never ask. "다시 묻지 않기" turns it off; Settings › General turns it on again (Mac
  `confirmCloseWhileWorking` in UserDefaults, Electron `AppSettings.confirmCloseWhileWorking`, absent = on).
- **Reject shortcut (daily-11).** Review → Reject (⌘⇧R; Electron's window-wide Ctrl/⌘+Shift+R) asks first, one line on
  what the revert does to the file (created → deleted, deleted → restored, renamed → back to its old name, else back to
  the turn's start). The other Reject buttons stay one click. An undo of the revert is not part of this round.
- **Why a turn stopped (daily-14).** An `error` whose `code` is `usage_limit`, `rate_limited`, `auth_required`,
  `api_error`, `max_turns` (§38.2; non-fatal) or `session_crashed` (fatal) while the turn runs becomes the turn's stop reason
  (login > usage > crash > tool-call limit > rate > API when several arrive; Electron also reads a `turn_end` whose
  `stopReason` is `error_max_turns`). The "turn finished" notification then leads with it ("사용량 한도로 멈췄어요 —
  15:00에 풀려요", "로그인이 필요해요", "오류로 멈췄어요: …"), and the non-fatal error's own notification is not posted
  (no second one); a fatal error is posted at once and the turn's end adds none. Outside a turn errors notify as before.
  Reasons are a list to extend (a kind, its code, a rank): Core `TurnStopReason.swift`, Electron `renderer/workSafety.ts`.
- **A stop that does not stop (robustness-07).** 10 s after `interrupt` with `gate.phase` still `"running"`, the composer
  shows [강제로 다시 시작] next to Stop: `restart_session` (§8 — it closes the running turn, collects its changes and
  resumes the same conversation; the queue and the review stay). It goes away when the turn ends.
- **Hung git (robustness-07, engine).** Every checkpoint git call (snapshot, diff, revert, ranges, branch listing) is capped
  at 300 s unless the caller passes its own `timeoutMs`; a call that does not answer is killed and fails with "git …
  did not respond within 300 s — …" through the existing error paths (`send_failed`, `collect_failed` with retry,
  `revert_failed`). The user's commit / push (their hooks) and `git switch` are not capped. No wire change. Test:
  `engine/test/git.timeout.test.ts`.
- **An open whose git does not answer (engine).** `open_project` / `switch_project` start with `git rev-parse
  --show-toplevel`, which answers at once in any folder. On macOS it once never answered (git started by GUI apps
  waited on a privacy check until the Mac restarted), and the open waited for ever, with nothing on screen in the window or a
  new one. It is capped at 20 s: the open ends with `project_open_failed`, "git rev-parse did not respond within 20 s —
  macOS may be holding ReviewGate's access to this folder: check System Settings › Privacy & Security › Files and
  Folders, and restart the Mac if it keeps happening", never with the git-init offer. A newer `open_project`,
  `switch_project` or `close_project` does not wait behind it: the open still in its git call ends quietly (an `info`
  log line), and the newer command runs at once; the git left behind is killed at its cap. No wire change. Test:
  `engine/test/git.timeout.test.ts`.
- **An open on its way says so (Mac).** While `open_project` / `switch_project` is answered, `AppState.openingProject`
  names the folder and the empty window shows "Opening acme-shop…" ("acme-shop 여는 중…") with a spinner instead of "Open a
  project to start". A newer open replaces it; an older one ending does not clear it. The `project_open_failed` banner
  above the empty window has **Reopen**, which opens that folder again. Test: `Core/Tests/…/OpenProjectStallTests.swift`.
- **A draft per chat (polish-12).** The composer's draft, mentions and images are kept per chat (`sessions.currentId`):
  another chat tab shows its own. An engine without `state.sessions` keeps the one window draft as before.
- **A draft that lasts (r1-composer M12, Mac).** The chat column lived only in the Changes / History / Search tabs with
  a project open: the PRs tab, or an engine that stopped and the project opened again, made a new one, and what was
  typed (its mentions and images), the question card's picks, a deny instruction, the plan card's notes and the scroll
  place were gone. The window now keeps the composer and the transcript's own state (`WindowModel.chatComposer` /
  `chatTranscript`), so the chat made again shows them as they were (it opens at the newest row); "Claude에게 보내기" on
  PR comments joins the draft kept there. The composer remembers the chat its draft belongs to and follows it when it
  comes back (another chat meanwhile swaps the drafts as above). Each chat's draft — its text and @ mentions; images
  stay in memory — is also saved on disk as it is typed (UserDefaults `composerDrafts`, under the chat's id,
  `project:<root>` for an engine without chats; at most 50, the oldest saved go first; an empty box removes it at once,
  a draft over 200 000 characters is not saved). The first chat an engine reports (a window opened, the app started
  again, the engine restarted) shows its saved draft when the box is empty; what was typed before stays and belongs to
  that chat. Core `AppState.moveDraft`, `saveDraft`, `savedDraft` (`Session/ComposerDraftKeep.swift`); verified by Core
  `ComposerDraftKeepTests` (a draft back after a restart, chat to chat with and without images, an engine without chats,
  the cap and a huge draft).

### 38.2 Long work

Long work that stops says so in the chat, and a usage limit tells when it lifts (daily-07, robustness-15, market-11,
robustness-08, SME-10 in part, daily-18). Every field is optional; an older engine sends none of it and the clients look
as before.

- **Tool-call limit.** `settings.maxTurns` (new, optional): the CLI's `maxTurns` — model round trips of one message (≈ tool
  calls). **No limit by default** (absent or `0`: the session passes no `maxTurns`, so a long skill or migration runs until
  Claude is done or the user stops it, as in the terminal, whose interactive CLI has no cap — `--max-turns` is a `--print`
  flag); a limit the user sets is a whole number in 10–1000 (0.5.x defaulted to 200, earlier engines to a fixed 60). It
  applies at the next session start (`--max-turns` is a flag of the CLI process). A turn that stops at a limit
  (`result.subtype: "error_max_turns"`) sends the notice `error{fatal: false, scope: "session", code: "max_turns",
  maxTurns: N}` before its `turn_end` (whose `stopReason` stays `error_max_turns`). The clients' row "도구 호출 한도(N회)에
  닿아 멈췄어요" with **[이어서 계속]**, which sends "계속해" to the same chat by the composer's queue rules (the limit counts
  per message: the CLI starts counting again). Settings › 제한 has "메시지당 도구 호출 수 제한하기", off by default — the
  clients send `maxTurns: 0` until it is turned on (Mac `maxTurnsLimit`, Electron `settings.maxTurnsLimit`); the number
  (10–1000, 200 until changed) stays stored for then, its stepper greyed out while off, the note "끔(기본): 제한 없음 —
  Claude가 터미널에서처럼 메시지 하나를 끝날 때까지 이어서 하고, 언제든 [중지]로 멈출 수 있어요". A number stored before
  the switch (Electron's file kept the old default 200) limits nothing until the limit is turned on.
- **Hooks and CLI words.** The session sets `includeHookEvents: true`. These become notices
  (`error{fatal: false, scope: "session"}`, a transcript row like every notice, §30; never `state.lastError`, never a
  stopped queue; repeats merge on `code` + `detail`, ×N):
  - `hook_failed` + `hookName`, `exitCode`, `detail` (stderr's first line, else the output's; masked as §30): a
    `system/hook_response{outcome: "error"}` — after initialize, and before it (a SessionStart hook; the §36.7 watchdog still
    sees those). Successful / cancelled hooks and every `hook_started` / `hook_progress` after initialize say nothing.
  - `hook_blocked` + `detail`: `system/informational{prevent_continuation: true}` (a UserPromptSubmit hook blocked the
    prompt, a Stop hook denied continuation; the CLI's text is `detail`), or — without such a message in the turn — a
    `result.terminal_reason` of `hook_stopped` / `stop_hook_prevented` ("A hook stopped this turn.").
  - `cli_warning` (`informational` level `warning` / `suggestion`, orange) and `cli_notice` (level `notice`, gray) with the
    CLI's text as `message` and `detail`; level `info` (terminal transcript mode only) goes to the log.
  A `kind: "error"` transcript row also keeps `maxTurns` and `hookName`.
- **A PreToolUse hook's deny is the call's, not a notice** (r1x). A user or plugin command hook that denies a call (a JSON
  `permissionDecision: "deny"`, exit 2) is normal flow: Claude reads the reason and adapts (reads the big file in parts).
  It was a `hook_blocked` notice — an orange row at the chat's end, ×N, far from the call (a subagent's under nothing).
  Now the session holds the block (`pendingHookDenies`, 30 s) until the denied call's result, which CLI 2.1.318 words
  `PreToolUse:Read hook error: <reason>` (exit 2: `PreToolUse:Bash hook error: [<command>]: <stderr>`), and puts it on that
  result: `tool_result.hookDenied {hook, reason}` (event and row). No notice is sent for it. Clients show the result as a
  quiet gray row under the call — a subagent's inside its agent's group — "훅이 막음 · PreToolUse:Read — <reason>", never
  an error. The app's own denies (no `hook_response`: §18, plan mode, `.git`) and other errors are unchanged; a hook that
  failed (`hook_failed`) stays a row, gray now. A `hook_blocked` restored from before (a PreToolUse `hookName`) reads gray
  too. `w4c.hookBlockOnce.test.ts` (a subagent's JSON deny, exit 2, an unrelated error, a failed hook). Mac
  `HookDeniedRow` (ToolRows.swift, `ToolResultInfo.hookDenied`), `ErrorRowInfo.quiet` / `LongWorkText.isQuietHookNotice`;
  Core `LongWorkTests`. Electron the same (`ToolRows.tsx` `HookDeniedRow`, `longWork.isQuietHookNotice` /
  `hookDeniedOf`, `ErrorFacts.hookName`; `longWork.test.ts`).
- **Usage windows.** Every `rate_limit_event` whose `rate_limit_info` names a `rateLimitType` updates
  `state.hud.rateLimits?: [{kind, status: "allowed" | "allowed_warning" | "rejected", percent?, resetsAt?, at}]`, one entry per
  kind (`five_hour`, `seven_day`, `seven_day_opus`, …, as the CLI names it), windows whose `resetsAt` passed dropped. The
  windows are the account's: a new chat keeps them; absent until the first event. CLI 2.1.309 (seen with haiku) sends the
  use of every window only in `rate_limit_info.unifiedWindows` (`{five_hour: {utilization: 0.22, resetsAt}, seven_day:
  {…}}`, not in the SDK's type): each entry is a window too, `allowed` unless it is the event's own `rateLimitType` (whose
  `status` it takes). `percent` = `utilization` × 100 (a value above 1 is taken as a percentage), rounded, ≤ 100. A
  rejection still sends `usage_limit` + `resetAt` (§19.6, unchanged).
- **After the limit (client side, opt-in).** The `usage_limit` banner offers **[풀리면 이어서 하기]** (off by default). Armed,
  the client sends "계속해" once, by the queue rules, at the first idle moment from `resetAt` + 1 min; quitting the app, a
  message the user sends (any new turn) or a new limit without `resetAt` disarms it. The HUD shows "사용량 한도 — HH:MM에
  풀려요" while a window is `rejected` (from `state.hud.rateLimits`, else the last `usage_limit.resetAt`), and the five-hour
  / weekly use ("5시간 72% · 주간 41%", orange from 80 %) when the CLI reports `percent`.
- **The budget Claude is told.** The engine remembers the budget the client's `systemPromptAppend` was rendered with (the
  budget of the `hello` / `set_settings` that carried it) and, per session, the budget its Claude was last told. When
  `settings.budget`'s files / lines differ from that at a `send` (not a slash command), the message goes out behind
  `[Review gate] The change budget is now at most N files and about M changed lines per reply (this replaces the numbers in
  your instructions).` and the session counts as told. The Mac's budget-only `set_settings` and Electron's re-rendered
  prompt both reach the running session this way; a session started after the change gets no note when its prompt already
  has the numbers. The user's row shows the message alone. §54: a budget turned on where Claude was told none reads
  `[Review gate] The user set a change budget: at most N files and about M changed lines per reply.`, one turned off
  `[Review gate] The change budget is off: there is no limit on files or changed lines per reply (this replaces the numbers in
  your instructions).`; a count without a limit is left out of the words.
- Compatibility: an older engine ignores `maxTurns` (60) and sends none of the new codes / `rateLimits`; an older client
  shows a new notice with its English `message` (orange row) and no button.
- Owners: w4-longwork (`engine/src/session/longWork.ts`, `session/claude.ts`, `engine.ts`; Mac `LongWork.swift`,
  `AppState+LongWork.swift`, `UsageLimitChip`; Electron `longWork.ts`). Tests: `engine/test/longWork.test.ts`.

### 38.3 History that lasts

A chat opened the next day shows more than its last 200 rows, keeps its turn summary cards, and can be found by what was
said in it; a past review round says why a file changed and which commit took it (audit daily-09, comp-16, comp-15).
Additive on the wire: two read commands with their replies, optional fields on `transcript_restore`, `history_diff` and
`ReviewHistoryFile`, one transcript row kind. Types: the `§38.3` block at the end of `engine/src/protocol.ts`; engine
`engine/src/review/transcriptHistory.ts`.

```ts
// commands (reply)
transcript_page { sessionId?, before, beforeAt?, limit? } → transcript_page { sessionId, items, start, before }
transcript_search { query, limit? } → transcript_search { query, matches: TranscriptSearchMatch[] }
// events: transcript_restore + start?, sessionId?;  history_diff + why?: FileWhy | null
// rows:   { kind: "turn_summary", …TurnSummaryEvent without type / turn, truncated? }
// history: ReviewHistoryFile.commit?: { sha, subject }
```

- **Row index.** A row's index is the position of its line among the session file's non-empty lines (a torn line keeps its
  place). `transcript_restore` now carries `start` (the index of `items[0]`) and `sessionId` (the chat the rows are of)
  whenever it has rows; an empty restore stays `{type, items: []}` as before. `start > 0` means older rows exist.
- **`transcript_page {sessionId?, before, beforeAt?, limit?}`** replies the up to `limit` (default 200, at most 2 000) rows
  ending right before row `before` of that chat (default the current one), oldest first, with `start` (the first row's
  index; `before` when none) and `before` (the end actually used). `beforeAt` is the `at` of the row the client holds at
  `before`: when the file was rotated meanwhile (§8: past 2 MB the oldest rows go), the engine re-finds that row by its
  `at` and pages before it; when no row has it any more, nothing older is left (`items: []`, `start: 0`). Kept agent
  reports stay out of the rows (§36.1). Refusals: `no_project`, `unknown_session:<id>`. Query lane (a pure read).
- **`turn_summary` rows.** Every `turn_summary` event (§15) is also recorded as a row of the chat right after it: the
  event's fields without `type` / `turn` (the row's own `turn` is the summary's). Bounded: ≤ 300 files, ≤ 100 commands,
  ≤ 100 plan steps, ≤ 50 tools / ids per file and per step, `why` / `whyDetail.text` / `delegation` / step texts ≤ 2 000
  chars, commands ≤ 1 000 chars, and the whole row ≤ 128 KB (files are dropped from the end until it fits); `truncated:
  true` when anything was cut. `transcript_restore` / `transcript_page` return them like any row. §15's "not persisted"
  no longer holds.
- **`transcript_search {query, limit?}`** looks through every chat of the worktree (newest chat first) for user messages
  and Claude answers (`user_message` / `assistant_text` rows) containing `query` (trimmed, case-insensitive, ≤ 200 chars;
  empty → no matches) and replies at most one match per chat — its newest — and at most `limit` (default 50, ≤ 200) chats:
  `{sessionId, title, row, turn, at, kind, line}`, `line` being the matching line of the text (≤ 160 chars, `…` where cut
  around the match). Tool inputs, results and notices are not searched. Refusal: `no_project`. Query lane; a file whose
  raw text cannot contain the query is not parsed.
- **`history_diff.why`**: why the round changed the file, read from the round's chat: the newest `turn_summary` row of the
  round's turns that lists the path (its §34.8 `whyDetail`, else its `why`), else the first of the file's `toolUseIds`
  whose `tool_use` row has a rationale (`source` its `rationaleSource`). `null` when the rows say nothing (a chat from
  before these rows with no rationale, a file nothing of Claude's touched, a deleted chat). Data already kept — nothing new
  is stored for it.
- **`ReviewHistoryFile.commit`**: a file that left the review through `commit` keeps `{sha, subject}` (the commit's first
  line, ≤ 200 chars) next to `committed: true`. Rounds recorded before have none.
- **Clients.** Both show [이전 대화 더 보기] above the oldest shown row while `start > 0` (each press: the 200 rows before it;
  the view stays where it was; Mac dims them like restored rows), turn a `turn_summary` row back into the summary card
  (none for a row without files, as live), search the messages in the chat history (debounced; the matched line under the
  chat's title; opening a match scrolls to its row after loading the rows above it, a jump waits ≤ 15 s for its chat's
  rows), filter the review history by path (old names too), request, note and commit subject, show `why` in a past file's
  diff ("왜 바뀌었나") and the commit subject on its "커밋됨" chip.
- **Compatibility.** An engine before §38.3 sends no `start` (no button), refuses the two commands `unknown_command` (the
  chat history then searches titles only, as before), sends no `why` / `commit` (nothing shown) and writes no summary rows
  (old chats keep only their "Changed N file(s)" line). A client before §38.3 ignores the fields and skips the new row kind
  (Mac: `.other`, Electron: no case).
- **Not in this pass.** "20줄 더 보기" in the history and PR diffs, the Mac full-file view's in-line highlight, a final /
  proposal toggle (`history_diff.final`) and "this file's history" entry points (comp-15's proposal).
- Tests: `engine/test/review.transcriptHistory.test.ts`, `engine/test/engine.transcriptHistory.test.ts`,
  `clients/desktop/src/renderer/transcriptHistory.test.ts`, `Core/Tests/ReviewGateCoreTests/TranscriptHistoryTests.swift`.

### 38.4 Install, projects and processes

**`workbench_list` dirty checks (daily-08).** `workbench_list` (and `refresh` with the `workbenches` scope) ran
`git status` on every worktree at once with a 2 s limit; with 30 worktrees all of them timed out and every `dirty` stayed
`null`. Now the engine publishes `state.workbenches` first with the last known values (the current worktree's from
`branches.isWorktreeDirty`), then checks at most 4 worktrees at a time (15 s each) and updates `dirty` as each answer
arrives (more `state` events); the reply still comes when the checks are done. A timeout keeps the last known value. An
answer younger than 20 s is reused by `workbench_list` (sent on every window focus); `refresh` re-checks all. A
`workbench_list` while the same checks are running joins them. No wire change. Test: `engine/test/git.dirtyScan.test.ts`.

**Forced stop of a process tree (robustness-12).** `claude` is spawned without `detached`, so it shares the sidecar's
(Electron's) process group, and the forced stop (`kill(-pid)`, else `kill(pid)`) killed only `claude`: what it had
started (dev servers, MCP servers) kept running without a parent. On macOS / Linux the forced stop now reads the process
table (`ps -A -o pid=,ppid=`), SIGSTOPs the tree, looks again, and SIGKILLs the group (when the pid leads one) and every
pid below it. Windows keeps `taskkill /pid <pid> /T /F`. No wire change. Test: `engine/test/platform.processTree.test.ts`,
`engine/test/platform.winKillTree.test.ts`.

**Long path lists and the Windows command line.** `commit` staged its files with one `git add -A -- <paths>` and committed
with `git commit --only -- <paths>`, and the post-commit overlay ran `update-index -- <paths>` — a few hundred long paths
passed Windows' 32 767-character limit. `git add` now runs in chunks of at most 8 000 characters of paths, `commit --only`
reads a long list from a NUL-separated pathspec file (`--pathspec-from-file`, git ≥ 2.25; a short list stays on the
command line), and the overlay reads its paths from stdin (`-z --stdin`). No wire change. Test:
`engine/test/git.longPathspecs.test.ts`.

Client-only (no wire change): the Mac app run from a disk image (`/Volumes/…`) or App Translocation shows a banner with
"Move to Applications Folder" (copy, reopen once this one has quit, quit; a replace asks with both versions; a running turn
disables it); Settings › General shows `0.2.3 (610)`. Both clients keep `/tmp`, `/private/tmp` and `/var/folders` (Electron
also the OS temp folder) out of the recent projects, show a folder that is gone dimmed with "Not found" (never opened), and
let every row be removed. Tests: `Core/Tests/ReviewGateCoreTests/AppInstallTests.swift`,
`clients/desktop/src/main/recentProjects.test.ts`.

## 39. Wave 4 (second batch): big turns, chat tabs, subagents, following Claude into a worktree, auto mode, notifications

Daily use in a large repository with many terminal sessions and subagents: turns of hundreds of files on a disk that is
nearly full, reading another chat while Claude works in one, seeing what each subagent does, following Claude into the
worktree it works in, an auto mode that does not ask for every command, notifications that reach the user while they are
away. As §38, each lane took its
own feature through the engine and both clients (no contract written first); every subsection says how it was built.
Additive on the wire: four commands, the `chat_moved` event, optional fields, notice and refusal codes, one setting; nothing an
existing client relies on changes meaning.

- §39.1 **Big turns and a full disk** — large untracked files as stubs, save failures and the disk's free space as banners
  with [다시 시도], [오래된 리뷰 기록 정리…], reject of many files in one batch, a bulk list folded by folder.
- §39.2 **Chats you can read without switching** — another chat tab shows its saved rows read-only while the Claude
  session stays put (only Send / [이 채팅으로 이어가기] moves it), a run of reads and searches folds into one row.
- §39.3 **Subagents at a glance** — a subagent's current step, retry / no-response badges, the HUD's subagent line, one
  MCP / Skill label rule, earlier turns' agents, which agent changed a file, the isolated-worktree badge.
- §39.4 **Following Claude into another worktree** — the chat moves to the worktree Claude made or works in ([이 채팅을
  거기로 옮기기], [허용하고 따라가기]); the same conversation goes on there and is reviewed there, the source window keeps
  it as a record.
- §39.5 **Auto mode that does not ask for every command** — in 자동 the hooks leave commands to Claude Code's classifier
  (the git guard, budget, worktree rules and reason cards stay), what it blocked is a gray row, the HUD mode chip is the
  mode menu, a pick mid-turn waits for the turn's end, Settings › 시작 모드.
- §39.6 **Notifications you notice** (client rules only) — the OS permission asked up front and said when it is off,
  Windows' AppUserModelId, one switch per group, plain lines, a click that lands on the card it was about.

```ts
// commands (reply)
retry_save → result                                                  // §39.1
history_cleanup { keep?, apply? } → history_cleanup                  // §39.1
chat_move { path, interrupt?, followUp? } → result (+ chat_moved)     // §39.4
chat_receive → result                                                // §39.4
permission_response + follow? / followUp?                            // §39.4 "허용하고 따라가기"
// events: chat_moved { sessionId, path, name, baseline, interrupted };  error codes chat_moved_in / chat_moved_in_disk / chat_move_failed (§39.4)
//         error codes auto_mode_denied / auto_mode_unavailable;  set_permission_mode refusal auto_mode_unavailable (§39.5)
// events / rows: tool_use + explore?: true                           // §39.2 (another chat is read with §38.3 transcript_page)
// state:  storage? { saveFailed, disk } (§39.1);  changedFiles[].tooLarge? / largeBytes? (§39.1)
//         hud.agents[] + lastStep? / retry? / activeAt? / turn? / isolation? / worktreePath? / worktreeBranch?;  hud.agentHistory? (§39.3)
//         sessions.list[].movedTo? / movedFrom? (§39.4)
// settings: largeFileMB? (1–100000, default 50)                      // §39.1
```

Rules: as §36 and §38 — every field optional, an older engine refuses the new commands `unknown_command` and the clients
keep the old behavior; Electron's main process forwards `retry_save` / `history_cleanup` / `chat_move` / `chat_receive`
(`ipcGuard.ts`). Where two
lanes meet, both clients follow one rule (client-only, no wire change):

- The §39.3 author filter narrows a §39.1 bulk list before it folds: a folder counts the files it opens to and one with
  none of them is not listed; the ordinary group headers keep the group's count (Core `listSections(keep:)`, Electron
  `BulkFolders` gets the kept files).
- While another chat is shown read-only (§39.2), the review, the HUD and the agent panel stay the running chat's; the
  review panel and the agent panel say so ("실행 중인 채팅('…')의 리뷰예요" / "…의 에이전트예요"). A turn summary card of
  the shown chat names its authors ("에이전트별 변경") from that chat's rows, and a link to a call in the shown chat's rows
  is revealed there; any other reveal (an agent card, diff → cause, 카드로 이동) shows the running chat first.
- A clicked notification (§39.6) never switches the Claude session either: one of the running chat (or without a chat)
  shows the running chat again, also while another chat is shown read-only — its permission / question / plan card is
  there; one from a chat the session has left since shows that chat read-only (§39.2) while its tab is open and scrolls
  to its summary card; a closed tab's chat is not reopened and nothing is scrolled to (Core `AttentionReveal.chatToShow`,
  Electron `notificationClickPlan` → `viewChat`).
- A chat moved to another worktree (§39.4) reads "옮김 → <worktree>" above the composer when it is the chat on screen —
  also when it is shown read-only (§39.2) — and not while another chat is shown over the moved record; the banner's move
  button still reads the running chat (Core `shownChatMovedTo`, Electron `movedChatOf`).
- In 자동 (§39.5) the reason cards are decided before the classifier, so a `worktree_command` card still comes and offers
  [허용하고 따라가기] (§39.4) in every mode; the moved chat takes its mode along (the handoff's `permissionMode`). A mode
  picked while the turn runs (§39.5) is not part of the handoff: it stays with the source window (dropped when its session
  closes).

The gate stays: nothing here answers or skips a permission request, an edit is still reviewed, and the history cleanup
only drops the app's own refs under `refs/reviewgate/`.

### 39.1 Big turns and a full disk

A turn that makes hundreds of files, a 2 GB heap dump in the repository and a disk at 99 % (robustness-10, robustness-11).
Every field is optional; an older engine sends none of it and refuses the two commands `unknown_command` — the clients
then look as before (no banner, no chip, no fold; the cleanup button reports the refusal).

```ts
// commands (reply)
retry_save → result                                   // refused save_failed while a save still fails
history_cleanup { keep?: number /* 1–1000, default 20 */, apply?: boolean /* default false: count only */ } → history_cleanup
                                                      // refused no_project; with apply, session_running while a turn runs / is collected
type HistoryCleanupEvent = { type: "history_cleanup"; id?; keep; rounds; checkpoints; refs; bytes: number | null; kept; applied };
// state
storage?: { saveFailed: SaveFailure | null; disk: DiskSpace | null };
type SaveFailure = { what: ("review" | "history" | "checkpoints" | "transcript")[]; code: string | null; diskFull: boolean; detail: string; since: string; at: string };
type DiskSpace = { freeBytes: number; totalBytes: number; level: "ok" | "low" | "critical"; at: string };
changedFiles[].tooLarge?: true; changedFiles[].largeBytes?: number
// settings
largeFileMB?: number   // 1–100000, default 50; live (the next snapshot)
```

- **Large untracked files (①).** Before `git add -A`, a snapshot lists the untracked, not ignored files (`ls-files --others
  --exclude-standard`, the app's ignore patterns included) and `lstat`s them; one at least `largeFileMB` large is excluded
  from the add and stands in the tree as a stub blob (`[ReviewGate] large file not captured (too large): <size> bytes,
  modified <mtime>`, as the §32.1 mods stubs). A 2 GB `*.hprof` is no longer hashed into `.git/objects` (6.5 s and 200 MB
  per 200 MB file before). Files git tracks are captured whatever their size. One limit per engine process — the hooks'
  post-Bash snapshots use the same one, so A, B and the budget's numstat agree. A listed file whose A or B side is such a
  stub is `tooLarge` (+ `largeBytes` from the newer stub) and `uncaptured`: it **stays in the list, pending** — the gate
  still asks about it — but `reject` refuses it (`not_captured`), `reject_all` skips it (§35.2), a file rewind fails
  (`revert_failed`), and `commit` never stages it (`acceptedPaths` / `canCommit` leave it out, like §32 ignored files).
  Clients show above the list "큰 파일 N개는 내용을 저장하지 않았어요(되돌릴 수 없어요)" with each path and size.
- **Failed saves (③).** The review file and its pins, the review history, a chat's checkpoint file / pins and the
  transcript rows used to fail with a log line only. Each failure now sets `state.storage.saveFailed` (`code` from Node
  — `ENOSPC`, `EDQUOT`, `EROFS`, `EACCES`, … — or git's words "No space left on device"; `diskFull` for ENOSPC / EDQUOT;
  `since` = when this run of failures began) and the kind leaves `what` with its next good save. Clients show one banner
  per `since` — "디스크가 가득 차서 리뷰를 저장하지 못했어요 — 공간을 비운 뒤 다시 시도하세요." (else "리뷰를 저장하지
  못했어요(<code>).") with **[다시 시도]** (`retry_save`: the review, history and checkpoints are written again; rows that
  failed are gone — the next row says whether appends work) and [닫기]; the same run never shows it again.
- **Free space (②).** `statfs` of the project's volume at `open_project`, every minute and after a failed save;
  published when the level changes or the free space moved 256 MB. `low` below **2 GB**, `critical` below **1 GB**: the HUD
  shows "디스크 여유 1.2 GB" (orange; red when critical) only then — a disk that often runs with a few GB free would see a
  10 GB mark every day — and a critical disk shows one banner per window until closed.
- **Old review history (④).** Settings › General › 디스크 공간 › [오래된 리뷰 기록 정리…]: `history_cleanup` (count) →
  "리뷰 기록 N개와 체크포인트 M개를 지워요(최근 20개는 남겨요) — 약 X를 비워요." → [정리] → `history_cleanup {apply:
  true}`. It drops the history rounds beyond the newest `keep` and, per chat of the worktree, the checkpoint records beyond
  the newest `keep`; deletes only their refs (`refs/reviewgate/<ns>/history/<id>/…`, `…/turns/<id>/…` of this worktree's
  namespace — a plan holds nothing else, checked again before `update-ref --stdin`); then `git prune --expire=1.hour.ago`
  (a lock or timeout only logs; `git gc` frees the rest later). Branches, tags, stash, notes, reflogs, the index and other
  worktrees' namespaces are never touched, and git's own reachability keeps what they reach. The open review (its pins
  are not under `history/` or `turns/`; the round in progress is not in the history yet) stays. `bytes`: the loose objects
  reachable from the dropped refs but not from the other app refs or HEAD (an estimate: what a branch or reflog also
  reaches stays; packed objects are not counted); null when it could not be measured in 60 s.
- **Reject of many files (robustness-10 ①).** `reject` / `reject_all` of more than one file reverts them at once — the
  added files (and a rename's new path) removed, every other path restored by one `git restore --pathspec-from-file`
  (literal pathspecs; a path git refuses falls back to the one-file restore) — then **one** snapshot; the §35.9 check
  (`file_changed_since_review`) reads the trees once (`ls-tree -r` + `hash-object --stdin-paths`) instead of three git
  calls per file. The list, notes (§37.2), history verdicts and B follow as before; a batch that fails part way counts
  the files that are back at A as rejected and refuses the rest with the first error. 300 files: **0.3 s** (35 s before).
- **Bulk lists (robustness-10 ②).** Client rule: over **300** changed files the review list folds by folder ("대량 변경:
  파일 N개"; each group's files, `FolderFold` / `foldFolders`: the deepest grouping by the first d folder levels with at
  most 40 folders), a click opens a folder and a selected file opens its own. Pure and shared with the files pane's
  "묶기 › 폴더" (§40.2).
- Not done here: `changedFiles` still travels whole in every `state` (③ of robustness-10 — a summary + per-folder reads)
  and the post-Bash snapshot is not skipped when it was slow (④).
- Security: the stub keeps a big file visible (listed, pending, never committed by the app); nothing it holds can be
  written back, so a reject cannot destroy it either. A file Claude makes large on purpose shows the same way — it
  cannot slip past the review, only past the diff (its content is not shown, as for a binary).
- Owners: w4b-bigturn (`engine/src/git/largeFiles.ts`, `review/storage.ts`, `review/cleanup.ts`, `GitCheckpoint.revertMany`
  / `worktreeMatchesMany`, `ReviewGate.revertBatch`; Mac `BigTurnProtocol.swift`, `BigTurn.swift`, `AppState+BigTurn.swift`,
  `StorageBanners.swift`, `ReviewListNotices.swift`, `StorageSettingsSection.swift`; Electron `bigTurn.ts`,
  `StorageNotices.tsx`, `BulkFolders.tsx`, `settings/StorageSettings.tsx`). Tests: `engine/test/engine.bigTurn.test.ts`,
  `Core/Tests/ReviewGateCoreTests/BigTurnTests.swift`, `clients/desktop/src/renderer/bigTurn.test.ts`.

### 39.2 Chats you can read without switching

Another chat tab shows that chat's saved rows at once and leaves the running Claude session alone; a run of reads and
searches is one line in the chat (audit daily-13, market-12). Additive on the wire: one optional field on `tool_use`;
no new command — reading another chat is §38.3's `transcript_page`.

```ts
// events / rows: tool_use + explore?: true      (event and transcript row)
// reads:         transcript_page { sessionId: <another chat>, before: 1e9, limit: 200 }   // §38.3, any time (query lane)
```

- **`tool_use.explore`.** The engine marks a call that only reads or searches (`engine/src/session/explore.ts`
  `isExploreCall`): Read, Glob, Grep, LS, NotebookRead, ListMcpResourcesTool, ReadMcpResourceTool; a Bash command the §16
  read-only classifier accepts (`isReadOnlyCommand`, never `run_in_background`); an MCP tool (`mcp__<server>__<tool>`)
  whose tool name starts with a lookup verb (get, list, search, read, query, find, fetch, describe, show, lookup, view,
  resolve). The mark is on the event and on its transcript row; rows saved before it get it in `transcript_restore` /
  `transcript_page` (the file is not rewritten). Display only: nothing here allows, denies or skips a call — the
  permission hooks keep their own rules.
- **Folding (client rule, Mac and Electron the same).** Consecutive top-level marked calls and their results become one
  row "탐색: 파일 12개 읽음 · 검색 5회 · 커맨드 2개 · 조회 1회" (files = distinct Read paths; searches = Grep / Glob / LS;
  커맨드 = Bash; 조회 = the rest), "탐색 중: …" with a spinner while a call of the run waits for its result. Fewer than two
  calls stay as they are. Claude's text, an unmarked call (edits, other Bash, tests), a permission card, an agent group
  (a subagent's calls stay in their group), an error row and a marked call whose result is an error end a run and are
  never folded. A click opens the run; a find match (Mac) or a revealed call inside opens it, and Electron's find bar
  shows every row while it is open. Settings › General "탐색 행 자세히 보기" (Mac UserDefaults `showExploreDetail`, Electron
  `AppSettings.showExploreDetail`; absent = off) shows every row as before. Pure parts: Core `ExploreFold.swift`,
  Electron `renderer/exploreFold.ts`.
- **Reading another chat (client rule).** A tab click or ⌘1…9 on another chat asks `transcript_page {sessionId, before:
  1 000 000 000, limit: 200}` (the engine clamps `before` to the chat's row count) and shows its rows read-only; the live
  chat keeps its rows, its events and its session. [이전 대화 더 보기] pages the viewed chat's older rows the same way.
  The live tab shows a dot (filled while a turn runs, hollow while idle); the other tabs are never disabled. Clicking the
  live tab shows it again, with the turn's progress as it went on. The view ends by itself when the live chat changes
  (a switch, a new chat, another project).
- **Sending from a viewed chat.** The composer shows "이 채팅을 보는 중이에요 — 보내면 이 채팅으로 이어가요" with [이 채팅으로
  이어가기]. That button, Send and ⌘↩ switch by the old path (`session_open`, the same guard) and the message then goes out
  by the queue's rules (Electron queues it once the snapshot of the switch has landed: a chat change under a queue stops
  it; a snapshot that does not land within 3 s gives the text back, so it never joins the old chat's queue). While the live
  chat is busy (starting, running, collecting, reverting) or its queue still holds messages, Send and [이 채팅으로
  이어가기] **wait** instead (r2-chats-cards M33, §9 "Held switches"): the line says why — "Claude가 '<제목>'에서 작업
  중이에요", "Claude가 '<제목>'에서 답을 기다리고 있어요" (a permission, a question or a plan waits), "'<제목>'의 대기열에 메시지가
  남아 있어요" — with [실행 중인 채팅으로], and the message goes to this chat once the live one is done ("'<실행 중인 채팅>' 채팅의 작업이
  끝나면 메시지를 '<이 채팅>' 채팅으로 보내요" with [취소], which gives the text back). Only a failed collection refuses (its retry belongs to
  the live chat). Before M33 Send was disabled while the live chat was busy. A refused switch gives the text back. A record-only chat
  (`resumeFailed`, §30) says "기록만 남은 채팅이에요 — 보내면 새 채팅으로 이어가요" and needs no confirmation to be read.
- **What stays the running chat's.** The HUD, the queue bar, the review and its panel ("실행 중인 채팅('<제목>')의 리뷰예요" over
  the changed files while another chat is shown), Stop. From a viewed chat the composer offers no Request changes, Accept
  & Send, Add to queue or Stop & send, ⌘⇧C only focuses the composer, the card keys (⌘↩ allow / ⌥⌘↩ / ⌘⌫ with an empty
  composer) answer nothing, the plan card waits, a reveal (diff → cause, "카드로 이동") shows the live chat first, and the
  viewed chat's rows ask no side questions. Each chat keeps its own draft (§38.1): the viewed chat's id is the draft key.
- **Compatibility.** An older engine sends no `explore` (nothing folds; old rows fold once a §39.2 engine restores them)
  and refuses `transcript_page` `unknown_command` before §38.3 — the tab then switches as before. An older client
  ignores `explore`. Side-question threads are still tied to the session switch (w4b-side, §40.3).
- Owners: w4b-tabs (engine `session/explore.ts`; Mac `AppState+ChatViewing.swift`, `ExploreFold.swift`,
  `ViewingChatViews.swift`, `ExploreRunRow.swift`; Electron `viewedChat.ts`, `exploreFold.ts`, `ViewingChat.tsx`). Tests:
  `engine/test/engine.explore.test.ts`, `Core/Tests/ReviewGateCoreTests/ChatViewingTests.swift`,
  `clients/desktop/src/renderer/viewedChat.test.ts`.

### 39.3 Subagents at a glance

What a subagent is doing now, what it left after the next message, which files it changed and where an isolated one worked
(audit agents-07, agents-12, agents-08, agents-11, agents-13, agents-14). Additive on the wire: optional `AgentNode` fields
and `hud.agentHistory`; no command, event or setting. Types: `AgentStep`, `AgentRetry` and the `MARK: wave4b w4b-agents`
fields in `engine/src/protocol.ts`; engine `session/agents.ts`, `session/toolLabel.ts`.

```ts
// state: hud.agents[] + lastStep?, retry?, activeAt?, turn?, isolation?, worktreePath?, worktreeBranch?
//        hud.agentHistory?: AgentNode[]
type AgentStep = { tool: string; detail?: string; since: number; endedAt?: number };   // epoch ms
type AgentRetry = { attempt: number; max: number; at: number; status?: number | null };
```

- **`lastStep`** — a live agent's latest tool call: `tool` (the raw name), `detail` (the HUD's `activityDetail`: a file's
  name, the command's start, the skill, a query; for `mcp__…` the representative argument below), `since` (when it
  started; a call first seen through `tool_progress` uses `now − elapsed_time_seconds`), `endedAt` once its result came.
  Its next call replaces it. `lastTool` stays as before.
- **`retry`** — the CLI retrying the agent's API request (`tool_progress.subagent_retry`: `attempt`, `max_retries`,
  `error_status`; also on a heartbeat line, which is otherwise still dropped), matched by the progress line's call, its
  parent, its task id, then the CLI agent id. Cleared by the agent's next call.
- **`activeAt`** — when anything was last heard from a live agent (a call, a result, progress, a retry). Progress of the
  same call moves it on the wire at most every 10 s. A finished agent has no `lastStep`, `retry` or `activeAt`.
- **`turn`** — the user turn (`user_message.turn`) the agent started in; a §36.3 continuation takes the current one.
- **`isolation`** — the Agent call's `isolation` input as given. `worktreePath` / `worktreeBranch`: from §33.4's
  `worktree_outside_review` for that call (the CLI's `worktreePath` / `worktreeBranch` on the result). With
  `allowWorktreeIsolation` off the call is denied (§33.4) and the node ends `failed` with `isolation` set.
- **`hud.agentHistory`** — the finished agents of this chat's earlier turns, newest first, at most 50: each `beginTurn`
  moves the agents it drops (§13) here. Slim copies: no `prompt` (`agent_report` has it), `reportPreview` / `summary` ≤ 200
  chars, `files` ≤ 20. A continued agent (§36.3) leaves it when it comes back into this turn's list. Cleared with the chat /
  project (`AgentTracker.reset`); not kept across an engine restart. Sent with every agents update (§13 coalescing); absent
  until the first one.
- **HUD detail of an MCP call** — `hud.activity.detail` of a `mcp__…` call is its representative argument (was the first
  of `query` / `url` / `path`).
- **One label rule** (`toolLabel`, the same code in `engine/src/session/toolLabel.ts`, Electron `renderer/toolLabel.ts` and
  Mac `ToolLabel` in Core `AgentGlance.swift`, all three checked against `engine/test/fixtures/toolLabels.json`):
  `mcp__<server>__<tool>` → `{kind: "mcp", server, name, arg?}` — `name` drops a repeated `<server>_` prefix and reads `_` /
  `-` as spaces (`mcp__acme__acme_list_issues` → `acme` · `list issues`); `arg` is the first non-empty string or finite
  number among `issueNumber, number, query, sql, q, index, url, path, file_path, name, title, id, pattern, command,
  prompt`, whitespace folded, 60 characters + "…". `Skill` → `{kind: "skill", name: <skill>, arg?: <args>}`. Anything
  else (also `mcp__x` without a tool) → `{kind: "tool", name}`.
- **Clients** (Mac and Electron the same, same i18n keys; rules in Core `AgentGlance` / `renderer/agentGlance.ts`, both
  tested with the same cases):
  - The card's line under the description: "Bash · ./gradlew :acme-api:test · 4분 12초" (the call's time; dimmed once it
    ended); the tool name alone on an older engine. Badges on a live card: "재시도 3/10" (help: the HTTP status or a
    connection error), "응답 없음 2분" once `activeAt` is 2 minutes old; neither while it waits for a permission answer
    ("권한 대기" says it) or is paused.
  - HUD while subagents run: "서브에이전트 3개 실행 중 — executor: Edit CartService.java" (the live agent whose call
    started last, a running call first); the HUD's own words when no agent has a step.
  - MCP / Skill calls read "github · get issue · 1800" (server chip in tool rows) and "스킬 acme-tools:smoke" in the chat's
    tool rows, the card's step, the HUD and the permission card's title.
  - The agent panel keeps "이번 턴" as it was and adds "이전 턴": `agentHistory` by turn, one line each — "executor · 설명 ·
    ✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2" (opens its chat group; ⓘ the details sheet).
  - A finished agent's collapsed chat group shows the same numbers ("✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2", from the node, else
    the result row's `agentUsage` and the group's edit rows, so they survive a restart) above the report's first line.
  - A click on a card or a timeline bar opens its chat group, scrolls to it and flashes it (agents-11; Mac now as
    Electron); the card's menu: 대화에서 보기 / 보고서 보기 / 지시 보기 / 중지 (Electron: 에이전트 상세 / 대화에서 보기 / 중지).
  - Which agent changed a file: the nearest Agent / Task call above each of `ChangedFile.toolUseIds` in the transcript,
    else the main agent. Rows show the agents' chips; with two or more authors a filter "전체 · 메인 · executor · …" sits
    above the list (two agents of one type read "executor", "executor 2"). The turn summary card lists "에이전트별 변경"
    (each author → its files) when a subagent changed any.
  - An agent with `isolation` (not `none`, not a denied call) shows "격리 worktree · 리뷰 밖" (help: where its changes
    stay) and, with `worktreePath`, "그 worktree를 워크벤치로 열기" (Electron: a known workbench's window, else the folder).
- **Compatibility.** An engine before §39.3 sends none of the fields: cards show `lastTool` as before, no badges, no
  "이전 턴", no isolation badge; the file chips and the filter work from the transcript alone. A client before §39.3
  ignores them.
- **Not in this pass.** `agentHistory` after an engine restart (the chat rows keep the numbers; the panel does not rebuild
  the list from them), agents-09 (model chips per call and per-model tokens / cost in the turn summary), the list's
  grouping menu and path display (w4b-files), a "merge request to main" for an isolated agent's branch.
- Tests: `engine/test/session.agentSteps.test.ts`, `clients/desktop/src/renderer/agentGlance.test.ts`,
  `Core/Tests/ReviewGateCoreTests/AgentGlanceTests.swift`; wire goldens `state.reviewing.json` / `wave3.agents.json` gained
  `turn` and `agentHistory`.

### 39.4 Following Claude into another worktree

A team that makes a worktree per issue lets Claude run `git worktree add` and then work there — outside this window's
review (§33.4: only a warning). Now the chat can **follow** Claude: it moves to that worktree's window, the same
conversation goes on there (same CLI session id, `--resume`; CLI 2.1.309 continues a conversation in another worktree of
the same repository, §36.9), and everything it does there is reviewed there. Every field is optional; an older client
sends none of it and the engine behaves as before.

- **`chat_move {path, interrupt?, followUp?}`** → `result`. Hands the current chat to the worktree that holds `path`
  (`git worktree list`; a folder inside a worktree names that worktree, the longest match wins). Refusals:
  `path_not_found`, `not_a_worktree` (any folder that is no worktree of this repository), `same_worktree`, `session_busy`
  (a turn runs, a card / question / plan waits, the CLI is starting — without `interrupt: true`), `chat_is_record` (a chat
  that moved already, or one Claude Code lost, §35.4), `cli_still_running` (the CLI did not exit within 5 s after it was
  stopped: the chat stays and resumes here), `no_project`, and the chat-switch review guard `collect_failed` (the review
  stays here; since M31 notes and a change request do not hold the chat, §9). Lane: main; scope: session.
  - With `interrupt: true` the running turn is stopped first (an open card is denied with it), its changes are collected
    here (≤ 120 s), then the CLI is stopped and the engine **waits until its process is gone** — two processes on one
    conversation corrupt its file. Side questions of the chat are closed.
  - Then `<target gitdir>/reviewgate/incoming/<id>.ndjson` (a copy of the chat's rows) and `<id>.json` (the handoff:
    `{version: 1, meta, from: {path, name, at}, to, baseline, followUp, permissionMode, at}`, written atomically last) are
    written. Only the target's own engine writes its sessions index.
  - This window keeps the chat as a **record**: `SessionMeta.movedTo = {path, name, at}` (new, optional). Opening it later
    shows its rows and starts a fresh CLI (like a §35.4 record); `chat_move` on it is `chat_is_record`. The review of this
    folder (pending files) stays here. Event **`chat_moved {sessionId, path, name, baseline, interrupted}`**.
  - `followUp` is kept only when a turn was stopped (`interrupted`); the target sends it once as a normal `send`.
- **Taking the chat.** The target worktree's engine takes every waiting handoff on `open_project` (the newest becomes the
  current chat and is resumed) or on **`chat_receive`** → `result` (a window that already has the worktree open; refused
  with `nothing_to_receive`, or the chat-switch guards of that window). The taken chat gets `movedFrom = {path, name, at}`;
  the permission mode (§11) follows it; '세션 동안 허용' (§33.7) does not. Then the notice `error{fatal: false, scope:
  "session", code: "chat_moved_in" | "chat_moved_in_disk", path: <source folder>, sessionId}` and the follow-up.
- **Review baseline.** When this chat created the target (the engine saw a `worktree_command` card's command succeed in
  this session: the path is a worktree right after it ran, and was none when the card came — `git worktree add … 2>&1 |
  tail` on an existing worktree "succeeds" but created nothing), `baseline: "head"`: the target's first review starts at its
  HEAD commit tree, so what Claude did there before the move (copied files, edits) is pending in the review as external
  changes (`chat_moved_in`). Any other worktree (it may hold the user's own work), or a target that already has a review,
  starts from the disk as it is (`baseline: "disk"`, `chat_moved_in_disk` — "옮기기 전 변경은 리뷰에 들어가지 않아요").
- **"허용하고 따라가기".** `permission_response {requestId, allow: true, follow: true, followUp?}` on a `worktree_command`
  card (with `toolUseId`): when that command ran and its path is a worktree of this repository, the engine moves the chat
  there with `interrupt` (pressing the button is the confirmation) — no `worktree_outside_review` for that command. A
  command that did not create the worktree leaves the chat here with `error{fatal: false, code: "chat_move_failed", path,
  detail: <refusal code>}`. A command that ran without `follow` lists the new worktree in `state.workbenches` at once, so
  the warning can offer the move mid-turn.
  - **Which worktree** (fixed after 0.5.9). The card's path is read from the command's words. `$HOME` / `${NAME}` that the
    environment defines are expanded. When that path names no worktree, the one the command added is followed: the
    worktree `git worktree list` shows now and did not show when the card came, if there is exactly one. So a variable
    the engine cannot know, `$(…)`, or a script still works. `detail` is the real refusal: `path_not_found` when nothing
    is at the path; before, every refusal read `not_a_worktree`. The clients put the reason in words after the line.
  - **Another repository's worktree** (fixed after 0.5.9). A chat moves only between worktrees of one repository: the
    CLI's record of the conversation stays with it. The Bash hook compares the repository the command's `git worktree
    add` runs in (after its `cd`s and `-C`) with this one (`git rev-parse --git-common-dir`). When they differ, the
    reason carries `otherRepository: true` with its own message, and the clients show no "허용하고 따라가기" on that card.
    A `follow` sent anyway is a plain allow. `chat_move` (and a plan sent to a workbench) to such a folder is refused
    `other_repository` instead of `not_a_worktree`. Seen in a real chat: a window on one repository's worktree, and
    Claude ran `cd <another repository> && git worktree add …`.
- **Made in auto mode** (2026-11). In auto mode a `git worktree add` of this repository runs without a card (§33.4,
  §39.5). The Bash hook reads the repository's worktrees before the command and passes them with its after-notice, so the
  engine still knows whether this chat made the worktree (`baseline: "head"` on a move, as after a card). Once the worktree
  is there it is listed in `state.workbenches`, and then `worktree_outside_review {path: <its root>}` says so — a chat row
  whose [이 채팅을 거기로 옮기기] sends `chat_move` (asking first while Claude works, below). A command that made no worktree
  says nothing. In default mode the card and "허용하고 따라가기" are as they were.
- **EnterWorktree** (M05b, 2026-11). Claude Code's own way into a worktree (a new `.claude/worktrees/<name>` or an
  existing one) moves the CLI's folder there, so everything it does next is outside this window's review — now the chat
  follows. **In auto mode** it runs without a card (the CLI's call, §39.5) and once it ran the engine moves the chat into
  that worktree as "허용하고 따라가기" does: the running turn stops (its changes are collected here), the conversation goes on
  in that worktree's window, reviewed from its HEAD when this chat made it (`baseline: "head"`: the hook read the worktrees
  before the call — what Claude changed there before the move is pending there), from the disk when it was already there;
  `chat_moved {interrupted: true}` as usual, and the follow-up sent there is **`settings.chatMoveFollowUp`** (new, optional;
  `{name}` = the worktree folder; clients send it in their language — default *"The working folder moved to {name}. Please
  continue what you were doing."*). No `worktree_outside_review` for it. **In the other modes** it gets the
  `worktree_command` card (§33.4: `path` = where it goes when the call names it) with "허용하고 따라가기"; a plain allow keeps
  the chat here and the row `worktree_outside_review {toolName: "EnterWorktree", path: <the worktree>}` — made or already
  there — offers [이 채팅을 거기로 옮기기].
- **ExitWorktree** (M05b). It takes the CLI back to the folder it entered from (the tool result's `originalCwd`). When that
  is another worktree of this repository — the chat followed Claude here — the chat follows it back: at once in auto mode
  (the turn stops, `baseline: "disk"` there, the same follow-up), else the row `worktree_outside_review {toolName:
  "ExitWorktree", path: <that worktree>}` offers the move. Back in this window's own folder (the chat never followed)
  nothing happens. In a window on a linked worktree the CLI leaves, `action: "remove"` would delete the folder this window
  reviews and this chat's rows (they live in its git dir): the hook changes it to `"keep"` (`updatedInput`, `discard_changes`
  dropped) and tells Claude why (`additionalContext`); the user removes the worktree in ReviewGate once its review is done.
  Elsewhere `remove` with `discard_changes: true` throws away that worktree's uncommitted work: the `git_command` card
  (§46), in every mode; without it git refuses a worktree with work in it, as `git worktree remove` without `--force` does
  (the CLI's call, §46: only `--force` asks).
  Verified with the real CLI 2.1.319 (sonnet, `RG_FOLLOW_STEP=enter node sidecar/test/driver-follow.mjs <scratch>`): in auto
  mode a project skill's `EnterWorktree {name: "acme-42"}` ran without a card, window A moved the chat into
  `.claude/worktrees/acme-42` by itself (`baseline: "head"`, `interrupted: true`) and the main checkout stayed on `main`;
  window B took it, the follow-up turn wrote the skill's file there (pending in B's review, not in A's); the CLI resumed in B
  still knew its worktree session — `ExitWorktree {action: "keep"}` went back to the main checkout, B moved the chat back
  (`baseline: "disk"`) and A took it.
- **System instruction (§33.4, changed 2026-11, M05b).** *"ReviewGate reviews every change you make in this folder (<cwd>).
  To work in a separate worktree use EnterWorktree, or run `git worktree add ../<repo>-<name> -b <branch>` (never under
  /tmp) and continue there: ReviewGate moves this chat into that worktree's window (in auto mode at once, otherwise the user
  chooses), where its review goes on. Do not switch this checkout's branch to start new work unless the user asked.
  Commands may run in this repository's other worktrees; ReviewGate lists what they changed after the call, and that
  worktree's own window reviews it."* plus the isolation sentence. Before, it said *"EnterWorktree is not available in
  ReviewGate"* (earlier *"never use EnterWorktree"* with only the user's workbench as the way out, and *"Do not `cd` into
  another worktree or a nested repository to change files there."*): a skill that starts its work in a worktree skipped
  that step and ran `git checkout -b` in this checkout (the IDE's checkout followed).
- **Clients** (Mac and Electron the same, same i18n keys). The `worktree_outside_review` row (2026-11: a banner before,
  §33.4) leads with **[이 채팅을 거기로 옮기기]** when `path` is in `state.workbenches.list` ([워크벤치로 열기] stays; off with a one-line reason on a
  record). While Claude works (a turn, a card / question / plan, a start) it asks "Claude가 작업 중이에요 — 멈추고 옮길까요?"
  [멈추고 옮기기] [취소] with "거기서 하던 일을 이어서 하라고 보내기" (on): `followUp` = "작업 폴더를 <worktree>로 옮겼어요. 하던
  일을 이어서 해 줘.". A `worktree_command` card shows **[허용하고 따라가기]**. On `chat_moved` the app fronts the window
  that has the target open and sends it `chat_receive` (its refusal is said there), else opens a window for it; the source
  window stays. The moved chat reads "옮김 → <worktree>" (tab badge; a bar above the composer, read-only here, [그 창
  열기]); a refused move is one line above the composer. `chat_moved_in` / `chat_moved_in_disk` are blue info rows
  ("이 채팅을 <원래 폴더>에서 옮겼어요. 여기서부터 리뷰돼요. …"), `chat_move_failed` orange. M05b: the row of an
  EnterWorktree the chat did not follow reads "Claude가 워크트리로 들어갔어요: <path>. 거기서 하는 작업은 이 창의 리뷰에
  잡히지 않아요 — 이 채팅을 거기로 옮기면 거기서 리뷰돼요." and that of an ExitWorktree "Claude가 원래 폴더로 돌아갔어요:
  <path>. 이제 하는 작업은 이 창의 리뷰에 잡히지 않아요 — …", with [이 채팅을 거기로 옮기기].
- Security: the target is only a worktree of this repository; after the move every edit there goes through that window's
  gate, budget and git guard like any other.
- Compatibility: an older engine refuses `chat_move` / `chat_receive` as unknown commands and ignores `follow`; an older
  client never sends them, shows the notices with their English `message` and ignores `chat_moved` / `movedTo`.
- Owners: w4b-follow (`engine/src/review/chatMove.ts`, `engine.ts`, `review/sessions.ts`, `session/reviewScope.ts`; Mac
  `AppState+ChatMove.swift`, `ChatMoveViews.swift`; Electron `renderer/chatMove.ts`, `components/chat/ChatMoveViews.tsx`,
  `main/chatMove.ts`). Tests: `engine/test/engine.chatMove.test.ts`, `Core/Tests/ReviewGateCoreTests/ChatMoveTests.swift`,
  `clients/desktop/src/{main,renderer}/chatMove.test.ts`; real CLI: `sidecar/test/driver-follow.mjs`.

### 39.5 Auto mode that does not ask for every command

"자동" (`permissionMode: "auto"`, §11) now behaves like the terminal's auto mode: commands run on Claude Code's own judgment
(its auto-mode classifier) instead of a card per command, while every file change is still reviewed. Additive: two notice
codes, one refusal code, no new command or field. Engine `engine/src/session/autoMode.ts`.

- **Hooks.** In auto mode the PreToolUse hooks no longer force `ask` on the calls that are not edits, not read-only and not
  allowed by an app rule (Bash, WebFetch, MCP tools, …): they return no decision, and the CLI's own rules and classifier
  decide. It applies only while the hook input's `permission_mode` is `auto` too (absent — an older CLI — counts as the
  engine's mode); a CLI that runs another mode keeps the cards. Unchanged in every mode, because they are decided first: the
  git guard and budget denies, the isolated-agent rules the user turned off (§33.4), the reason cards (§33.3:
  `outside_project`, `nested_repository`, `other_worktree`, `worktree_command`, `worktree_isolation`, `claude_config`)
  — except, since 2026-11, a Bash command in another worktree of the repository or in a nested repository and a
  `git worktree add` of this repository (§33.4: the CLI's call, listed after it), an edit outside the project, in a
  nested repository or in Claude's memory (§8: the CLI's call, listed in `changedOutside`), `EnterWorktree` (M05b: the CLI's
  call, the chat follows it, §39.4), an isolated agent (M05b: the CLI's call, its row after it ran, §33.4) and a change to
  Claude Code's settings that touches no key that runs code or widens permissions (M22, §33.9) —
  the edit budget hook and the review of every file a call changed (a Bash command that writes a project file is caught by
  the post-Bash snapshot and lands in the review, as before). `SendMessage`, `AskUserQuestion`, `EnterPlanMode` and
  `ExitPlanMode` keep their card (§44.1: EnterPlanMode no longer — it only restricts Claude; §33.2: nor a SendMessage to
  a recipient the session verified — its own subagent, a live session of the user's). What the classifier hands to
  the user still comes as `can_use_tool` → a card (§33.1).
- **What the classifier blocked.** `system/permission_denied{decision_reason_type: "classifier"}` (CLI 2.1.309) becomes the
  notice `error{fatal: false, scope: "session", code: "auto_mode_denied", detail: "<call> — <reason>", toolName}` (the call:
  a Bash command's first line, else a URL / query / path, masked as §30, ≤ 160 chars; the reason when the CLI gives one).
  A gray chat row "자동 모드가 막음: <detail>"; repeats merge (×N); never `state.lastError`, never a stopped queue. Other
  denials (a deny rule, …) add nothing: the tool row says it failed.
- **Auto mode the CLI cannot run.** A model without auto mode (e.g. `claude-haiku-4-5`) or a policy that turns it off makes
  the CLI start in `default` (`system/init.permissionMode`): the session asked for `auto` → one notice per session
  `code: "auto_mode_unavailable", detail: "<the CLI's mode>"` ("이 모델에서는 자동 모드를 쓸 수 없어서(또는 꺼져 있어서) 명령마다
  물어봐요", gray). `set_permission_mode {mode: "auto"}` that the CLI rejects for the model is refused with the new refusal
  code `auto_mode_unavailable` (the mode stays; the clients put the previous mode back and say why).
- **A mode picked while Claude works.** `set_permission_mode` during a turn switches among `default` / `acceptEdits` /
  `auto` at once: the CLI applies it from its next tool call, as Shift+Tab does in the terminal, the hooks follow
  (`HookContext.permissionMode`) and the mode is stored as between turns. Cards already open stay the user's. Refused
  `session_busy`: a switch into or out of `plan` while a turn runs (plan mode changes what the turn may do and how its plan
  is proposed), and any switch while a session starts or a turn's changes are collected / reverted. Nothing of the review
  depends on it: files are collected at the turn's end in every mode, and the git card (§40.1, §46) is the same in every
  mode.
- **Clients.** The mode help of 자동: "명령은 Claude Code의 자동 판단으로 실행돼요. 파일 변경은 그대로 리뷰돼요." The HUD's mode
  chip is the mode menu (one click picks a mode). While Claude works a pick of 기본 / 편집 바로 허용 / 자동 goes out at once
  (above) — the menu's last line says "Claude가 작업 중이에요 — 고른 모드는 다음 단계부터 적용돼요 (계획 모드는 이번 턴이
  끝나면)"; a pick the engine would refuse then (into or out of 계획, a collection) — or did refuse `session_busy` — waits and
  is sent when the turn ends: the picker shows "기본 → 계획", the menu "Claude가 작업 중이에요 — 이번 턴이 끝나면 모드가
  바뀌어요"; another project or a closed session drops it. Settings › Permissions has "시작 모드" (the mode a project
  opened for the first time starts in, auto included; a pick in a project stays that project's: Mac
  `AppSettings.startPermissionMode` — unset, the last mode used anywhere as before —, Electron `settings.permissionMode`; a
  worktree of a repository whose other worktrees ran in ReviewGate starts as they ran last, before either, §11). The
  terminal's `permissions.defaultMode: "auto"` is offered as before (§2.8, "터미널처럼 자동 모드로 시작할까요?").
  `bypassPermissions` / `dontAsk` stay unoffered.
- Verified with CLI 2.1.309 / SDK 0.3.270 (haiku, `canUseTool` set, hooks returning no decision): in auto mode `mvn -v`,
  `echo > file`, `node -e`, `mkdir && touch` ran without `can_use_tool`; the classifier let what the user's prompt asked for
  through (`rm -rf <a scratch dir outside cwd>`, `curl … | sh`, `git push --force`): in the app the force push keeps its card
  (§46, r1-git: the `git_command` card, in every mode; a plain push is the classifier's), a `cd` / `git -C` outside the project still gets its reason card, and judging the rest is the classifier's, as
  in the terminal; an `autoMode.soft_deny` rule against `mvn` gave `permission_denied{decision_reason: "[Security Weaken]"}` and no
  `can_use_tool`; `claude-haiku-4-5` and auto mode turned off by settings started in `default` with a `can_use_tool` per
  command; `setPermissionMode("auto")` between turns took effect on the next turn. During a turn (CLI 2.1.318, sonnet,
  `sidecar/test/driver-modeswitch.mjs`): a default-mode chat asked for three commands that write files; the first one's card
  was allowed and `set_permission_mode auto` went out while it ran — the other two ran with no `can_use_tool` and no
  `auto_mode_denied`, and all three files were in the turn's review.
- Compatibility: an older engine keeps the cards in auto mode and sends none of the codes; an older client shows the notices
  with their English `message` and the refusal as a generic one.
- Owner: w4b-auto (engine `session/autoMode.ts`, `session/hooks.ts` `askOrAllow`, `session/claude.ts`; Mac `AutoMode.swift`,
  `AppState+AutoMode.swift`, `PermissionModeMenu.swift`, `DefaultModeSettingsRow.swift`; Electron `autoMode.ts`,
  `storeAutoMode.ts`, `ModeMenu.tsx`, `DefaultModeSetting.tsx`). Tests: `engine/test/autoMode.test.ts`,
  `engine/test/engine.autoMode.test.ts`, `Core/Tests/ReviewGateCoreTests/AutoModeTests.swift`,
  `clients/desktop/src/renderer/autoMode.test.ts`.

### 39.6 Notifications you notice

Client rules (Mac and Electron the same, same i18n keys); the engine and the wire do not change — the notifications are
made from the events the clients already get (`permission_request` with `agent?` §33.1, `plan_proposed`, `turn_end`, …).
An older engine works as before.

- **Asked up front.** The Mac asks macOS at launch (and when Settings › Notifications is turned on) instead of at the
  first notification, reads the answer again on every activation and before a notification is dropped (one turned on in
  System Settings works without a relaunch). Core `NotificationHealth`; App `AttentionCenter`, `NotificationStatusModel`.
- **Said when it cannot reach the user.** macOS off: Settings › Notifications shows "macOS에서 ReviewGate 알림이 꺼져
  있어요" with [시스템 설정 열기] (alert style None: "배너 없이 와요 — 알림 센터에만 쌓여요"), and each project window says it
  once ([닫기] closes it for good, `notificationsOffNoticeDismissed`). Electron sets the Windows AppUserModelId to the
  installer's `appId` (`io.github.seunggulee1007.reviewgate.desktop`; the executable's path when run unpackaged) — Windows shows toasts only
  for the AUMID of the Start menu shortcut. A notification Windows did not show (`Notification` `failed`) is logged and
  said once in the window with [알림 설정 열기] (`ms-settings:notifications`, a fixed address in main) and [닫기]
  (`notificationsHintDismissed`); Settings shows where to look (Do not disturb / Focus assist).
- **One switch per group** below the main one, all on by default: permission requests · questions · plans (`waiting`),
  when work finishes (`turnEnd`), everything else (`other`: errors, side questions, other sessions, subagents). Mac
  UserDefaults `notifyWaiting` / `notifyTurnEnd` / `notifyOther`, Electron `AppSettings` of the same names (renderer-
  writable, checked in main); absent = on. Core `NotificationGroup`, Electron `notifyGroupOf`.
- **What they say.** Mac title / body, Electron one line after "ReviewGate — <project>": "허용이 필요해요" — "Bash: <the
  command's first line>" (else the path or URL; a subagent's: "허용이 필요해요 — code-reviewer 에이전트"), "Claude가
  질문했어요" — the first question, "계획을 승인해 주세요" — the plan's first line, "작업이 끝났어요" — "리뷰할 파일 3개" /
  "리뷰할 파일 없음" (a §38.1 stop reason replaces the headline). The coalescer and the "not while in front" rule are
  unchanged.
- **Where a click lands.** The window comes forward (restored from the Dock / taskbar), goes back to the review tab from
  PRs, shows the notification's chat (`state.sessions.currentId` when posted; read-only as a tab click, §39.2 — nothing
  switches; only an open tab) and scrolls to the permission / question card (flashed), the plan still waiting or the
  turn's summary card (else its end line). Mac: `AttentionTarget` in the notification's `userInfo`, `AttentionReveal`; Electron: the request's
  optional `target {chatId?, requestId?}` (dropped when malformed), `rg:notificationClick` to the window, renderer
  `notificationClickPlan`.
- Not in this pass: answering from the notification itself ([한 번 허용]) — the banner shows a command's first line
  only, so allowing from it would approve what the user did not see.
- Tests: `Core/Tests/ReviewGateCoreTests/NotificationRoutingTests.swift`, `clients/desktop/src/main/notifyRouting.test.ts`,
  `clients/desktop/src/renderer/notifyClick.test.ts`.

## 40. Wave 4 (third batch): follow-ups, the review list, side questions

0.2.7: what an adversarial pass over §38 and §39 found, a review list that reads like a Java / Spring repository, and
side questions that keep read code at home. As §38 and §39, each lane took its own feature through the engine and both
clients (no contract written first); every subsection says how it was built. Additive on the wire: optional fields, one
notice source, one setting; nothing an existing client relies on changes meaning.

- §40.1 **0.2.4–0.2.6 follow-ups** — auto mode keeps the card for a push, a git config / ref write and a write into
  `.git/` (r1-git: now only for ReviewGate's own state in git; §46 cards what rewrites the remote); 자동 picked in one
  project does not start a new one; a hook that blocked on purpose is `hook_blocked`, not a
  failure; the turn-end line says the stop reason in words; "풀리면 이어서 하기" belongs to its chat; wave 4 wire goldens.
- §40.2 **A review list that reads like the code** — one risk rule in the engine (settings, SQL, schema, CI and
  permission badges; a test below the code it tests), a diff without lines says what changed, the list grouped by folder
  or by layer.
- §40.3 **Side questions you can trust** — the web off unless chosen, forks named `[곁질문] …` in `claude --resume` and
  deleted with their thread, "턴 N 시점" and [최신 대화로 다시 묻기], a quote of Claude's answer as the anchor, a queued
  conclusion on record.

```ts
// events: error code hook_blocked + hookName? / exitCode? / detail? from a command hook's hook_response   // §40.1
// state:  changedFiles[].risks? / riskScore? / oldMode? / newMode? / similarity?;  turn_summary.files[].risks? / riskScore?  // §40.2
// file_diff.diff + oldMode? / newMode? / similarity? / binarySize? { old, new }                          // §40.2
// commands: side_ask + refork?;  side_promote + queued?                                                // §40.3
// types:  SideAnchor.quote? { text, turn? };  SideThread.promotions[].queued?                         // §40.3
// settings: sideWeb? ("off" | "rules" | "on", default off; sideAllowWeb no longer turns the web on)   // §40.3
```

Rules: as §38 and §39 — every field optional; without `risks` (an older engine) the clients keep their own risk rules,
an older engine ignores `refork` / `queued` / `quote` and reads `sideAllowWeb`. Where two lanes meet, both clients follow
one rule (client-only, no wire change):

- The §40.2 grouping splits what the §39.3 author filter kept, and a §39.1 bulk list (over 300 files) still folds by
  folder with the grouping menu disabled and its reason.
- While another chat is shown read-only (§39.2), the §40.3 quote anchor ("곁질문으로 묻기" on Claude's answer) is disabled
  with its reason and a turn summary file whose review is done offers no '왜?' (its question would go to the running
  chat; a file still in the review keeps it); showing a chat read-only is not a switch, so a side answer coming in goes
  on. A real switch while a side answer is coming asks first (§40.3), and turns "풀리면 이어서 하기" off (§40.1).
- A chat moved to another worktree (§39.4) takes its side threads along when the target window takes it (§40.3) and
  disarms "풀리면 이어서 하기" in the source (§40.1).

The gate stays: auto mode asks for more, not less; the risk badges and grouping are display only; side questions stay
read-only forks and get the web only when the user chose it.

### 40.1 0.2.4–0.2.6 follow-ups

An adversarial pass over §38 and §39 (w4b-check4): what lets work outside the review through, what the app sends on its
own, and the engine's real JSON against both clients. On the wire only `hook_blocked` gains a source (a command hook's
`hook_response`, with `hookName` / `exitCode` / `detail`) and auto mode asks for a few more commands; the rest is client
rules. Every field stays optional; an older engine or client behaves as before.

- **Auto mode keeps the card for what git keeps outside the review** (engine `session/autoMode.ts`
  `autoModeKeepsCommandCard`, consulted by `autoModeDecides`). §39.5 said the git guard still denies a push in auto mode;
  it never did — the guard denies commits and working-tree moves (§4), a push only ever had the default mode's card. In
  auto mode a Bash command that runs `git push`, `git config`, `git update-ref` / `symbolic-ref` / `commit-tree` /
  `replace` / `filter-branch` / `filter-repo` or `git worktree remove|move|prune` (options before the verb count:
  `git -C x push`), or that names a path inside a `.git` folder (a hook written there runs on the next commit — the app's
  own commit included), gets the card (`ask`, the plain reason) instead of the classifier. The app's own rules answer
  first as before (a `Bash(git push:*)` pattern still allows; `git log`, `cat .git/HEAD` still run without a card); the
  other modes are unchanged (they already asked); `.gitignore` / `.github/` are not `.git`.
  MARK: r1-git — reversed for git: in auto mode a push, `git config`, `update-ref` / `symbolic-ref` / `commit-tree` /
  `replace` / `filter-branch` / `filter-repo`, `git worktree remove|move|prune` and any other path inside `.git/`
  (`rm -f .git/index.lock`, `.git/info/exclude`, `test -f .git/hooks/x`) go to the CLI's rules and classifier, as in the
  terminal (they cost a card per push and per `git config user.email`). What rewrites the remote or throws work away — a
  force push, `+refspec`, `--delete`, `--mirror`, `--prune`, `worktree remove --force` — has the `git_command` card in
  every mode (§46). The plain card stays only for a command that names ReviewGate's own state in git:
  `<git dir>/reviewgate/…` (chats, remembered allows, attachments; a linked worktree's `.git/worktrees/<name>/reviewgate/`
  too), `reviewgate-review.json`, `refs/reviewgate/…` (the review's pinned trees) or the `.git` folder itself (`rm -rf
  .git`) — `REVIEWGATE_STATE_RE` / `GIT_FOLDER_RE`, case-insensitive — and for one that deletes or overwrites what holds
  the commits inside it (`GIT_STORE_RE`): `refs`, `objects`, `logs` (and what is in them), `packed-refs`, `index`, `HEAD` (a
  linked worktree's under `worktrees/<name>/` too) or a glob over the folder (`rm -rf .git/*`). Only the words a command
  writes count: every operand of `rm` / `rmdir` / `unlink` / `shred` / `truncate` / `mv` / `tee`, the target of `cp` / `ln`
  / `install` / `rsync` / `ditto` (`-t` too), `dd of=`, the start points of `find … -delete` and a redirection's file (`>
  .git/HEAD`) — also in a script a shell runs (`bash -c 'rm -rf .git/logs'`, `bash.exe -c …`: the §46 scanner, which
  knows a shell or a wrapper by its name, §20) and after a `cd` into the folder (`cd .git && rm -rf refs`). Before,
  `rm -rf .git/refs`, `.git/objects` or `.git/*` (the stash, unpushed commits,
  the review's pinned trees) ran without one; a lock file (`.git/index.lock`, `HEAD.lock`, `cd .git && rm -f index.lock`),
  `info/`, `hooks/` and a copy out of `.git` (`cp -r .git/objects ../backup`) stay the CLI's. A name that only leaves the
  folder out is no name of it (`leftOutWords`; before, the bare word kept the card): an exclusion flag's value (`tar
  --exclude=.git -czf ../src.tgz .`, `rsync -a --exclude .git ./ ../copy/`, `grep --exclude-dir=.git`; any `--…exclude…=` /
  `--…ignore…=` — not with `--delete-excluded`, which deletes it at the target) and the pattern of a find test whose branch
  prunes it without `-delete` / `-exec` (`find . -path ./.git -prune -o -name '*.orig' -delete`, `\( -name .git -o -name
  node_modules \) -prune -o …`). A negated test (`find . ! -name .git -delete`) still names it — it leaves the folder's
  contents in — and so does a command run inside ReviewGate's state folder (`cd .git/reviewgate && …`). An MCP tool
  writing into `.git/` keeps its card (§41.2, unchanged).
- **자동 spreads like any other mode** (Mac `AppSettings.permissionMode(root:)`; reversed after 0.5.6). The last mode used
  anywhere (`"*"`, also what `hello` carries) seeds a project opened for the first time, 자동 included — keeping 자동 out
  (→ 기본) started every new worktree of a repository worked in auto mode in 기본, with a card for every command and MCP
  call. A project opened for the first time now starts in: the mode its repository's other worktrees ran in last (engine,
  §11), else Settings › 시작 모드, else the last mode used anywhere. Electron has no last-mode fallback
  (`settings.permissionMode` is the 시작 모드 only); a moved chat still takes its mode along (§39.4, same repository).
- **A hook that blocked is not a failure** (engine `session/longWork.ts` `hookFailureNotice`). `system/hook_response`
  with `exit_code: 2` (Claude Code's blocking exit code; the reason is stderr's first line), or `exit_code: 0` with a JSON
  `{"decision": "block", "reason"}` / a PreToolUse `permissionDecision: "deny"` on stdout, is
  `error{fatal: false, scope: "session", code: "hook_blocked", hookName, exitCode, detail: <reason>}` — it was
  `hook_failed` "(exit 2)". Only a command hook (it has an exit code): the app's own in-process hooks never get here.
  Clients: "훅이 막음: <이름> — <이유>" (key "Blocked by a hook: %@ — %@", without a reason "Blocked by a hook: %@"),
  no gray second line; a `hook_blocked` without `hookName` (a Stop hook's `informational` line, an older engine) reads
  as before ("훅이 이 턴을 멈췄어요" + its detail).
- **The turn-end line says why in words** (Core `TurnEndText.stopWords`, Electron `stopReasonWords`; the words of the
  §38.1 stop reasons). `success` / `ended` / `end_turn` → "완료", `interrupted` → "사용자가 중지", `error_max_turns` →
  "도구 호출 한도에 닿아 멈췄어요", `error_max_budget_usd` → "비용 한도에 닿아 멈췄어요", `error` /
  `error_during_execution` / `error_max_structured_output_retries` → "오류로 멈췄어요", the engine's own
  `session restarted` / `session closed` / `chat moved` in words; any other value as it came.
- **"풀리면 이어서 하기" belongs to its chat** (Core `LongWorkState.armedChatId` + `LimitResume.leftChat`, Electron
  `LimitResumeState.chatId` + `leftChat`). Turning it on remembers `state.sessions.currentId`; a snapshot whose current
  chat is another one (a switch, the chat moved to another worktree §39.4, another project in the window) disarms it, so
  "계속해" never goes to a chat that did not stop. Armed without a chat id (an engine without chats): as before.
- **Checked, unchanged** (reasons in the lane's report): `chat_move` only targets a worktree of this repository — a
  symlink out, `..` and another repository's worktree are `not_a_worktree` (`engine/test/check4.chatMove.test.ts`); the
  handoff is written only after the CLI's process is gone; the HEAD baseline only for a worktree a card of this chat
  created; the source keeps its review; notifications carry no allow action; [이어서 계속] and the moved chat's
  follow-up go once and by the queue rules; `killTree` signals only the tree of a live child; `transcript_page` reads
  only chats of the index; the move to Applications strips the quarantine of the app's own copy only.
- Wire goldens: `engine/test/fixtures/wire/wave4.follow.json` (written by `engine/test/engine.wave4Wire.test.ts`: a moved
  chat's event, both metas, the target's notice and the refusals, the auto-mode notices, a blocked and a failed hook, a
  turn end) read by `Core/Tests/ReviewGateCoreTests/Wave4WireGoldenTests.swift` and
  `clients/desktop/src/renderer/wave4Wire.test.ts`.
- Not in this pass: the chat history search's three matches per chat with "N건 더", "20줄 더 보기" in the review history
  and a PR's diff.
- Owner: w4b-check4. Tests: `engine/test/autoMode.test.ts`, `engine/test/longWork.test.ts`,
  `engine/test/check4.chatMove.test.ts`, `Core/Tests/ReviewGateCoreTests/{AutoModeTests,LongWorkTests,Check4Tests}.swift`,
  `clients/desktop/src/renderer/{longWork,stopWords}.test.ts`.

### 40.2 A review list that reads like the code

A turn in a large web app touches controllers, services, mapper XML, templates and `application*.properties`; the list now says
which of those are risky in the same words on both clients, what a change without lines is, and can be read by layer or
folder (audit comp-12, comp-11, comp-14; comp-13 was already §31). Additive on the wire: optional fields only — no
command, event or setting.

```ts
// state:  changedFiles[].risks?: FileRiskKind[];  changedFiles[].riskScore?: number      (also turn_summary.files[])
//         changedFiles[].oldMode? / newMode?: string;  changedFiles[].similarity?: number
// file_diff.diff (FileDiff): oldMode? / newMode?: string;  similarity?: number;  binarySize?: { old: number | null; new: number | null }
type FileRiskKind = "sensitive" | "deleted" | "permission" | "schema" | "bash" | "sql" | "large" | "settings" | "ci" | "external" | "config" | "test";
```

- **One risk rule (comp-12).** The engine classifies every changed file (`engine/src/review/fileRisk.ts`, derived
  whenever the state is built, never stored): `risks` most serious first in the order above, `riskScore` their summed
  weights (sensitive 100, deleted 50, permission 40, schema 35, bash 30, sql 25, large 25, settings 20, ci 20, external 20,
  config 15, test −1). New kinds: **settings** `application*.{yml,yaml,properties}`, `bootstrap*.…`, any `*.properties`;
  **sql** an XML under `mapper(s)/` or `sqlmap(s)/`, `*Mapper.xml`, `*Dao.xml`; **schema** `*.sql`, `db/migration(s)/`,
  `flyway/`, `liquibase/`, `changelog*.{xml,yml,json}`; **ci** `Jenkinsfile*`, `.github/workflows/` (also sensitive),
  `.gitlab-ci.yml`, `.circleci/`, Azure / Bitbucket pipelines, `.travis.yml`; **permission** the mode changed (644 ↔ 755)
  or a new executable file. One badge per file kind (settings / CI / schema / sensitive files are not "config" too; a
  schema `.xml` is not "sql"). `bash` is origin `bash` (§31), `large` is ≥ 300 lines, a test file weighs −1 so it never sorts
  above the code it tests. Clients show `risks` as sent (a kind they do not know is dropped) and sort by `riskScore`; the
  Mac shows `external` with its own chip as before. Without `risks` (an older engine) each client keeps its own rules —
  the Mac's test weight is now −1 there too.
- **What a diff without lines is (comp-11).** The checkpoint's `diff-tree` now reads `--raw`, so a changed file carries its
  modes when they changed (`oldMode` + `newMode`; a new executable file `newMode` alone) and a rename its `similarity`.
  A parsed patch names the same (`old mode` / `new mode`, `new file mode 100755`, `similarity index N%`); a binary's
  `file_diff` gets its modes / similarity from the file (review range only) and its sizes from the trees (`cat-file -s`).
  Clients (Core `FileMetaText`, Electron `fileMeta.ts`, same lines): "내용 변화 없이 이동 (유사도 100%)", "이름 바뀜 (유사도
  87%)", "실행 권한 추가 644→755" / "실행 권한 제거 755→644", "실행 파일로 추가 (755)", "파일 모드 변경 100644→120000",
  "바이너리 · 12KB → 14KB" / "새 파일 2KB" / "삭제 500B" — as the diff's body when it has no lines (instead of "변경 없음"),
  else one line above it.
- **Grouping (comp-14, client rule).** The list's header has "묶기": 묶지 않음 / 폴더별 / 계층별, kept per project (Mac
  UserDefaults `fileGroupByProject`, Electron localStorage `rg.fileGroupBy`). Inside each group (설정·훅 / Claude / 앱 밖) the
  files split into sections — by folder in the order the folders first appear, by layer in the order controller · service ·
  mapper/SQL · resources · webapp (JSP·JS) · test · other (a test first: `FooControllerTest.java` is a test; then
  `mapper(s)/`, `dao/`, `*Mapper|Dao|Repository.{xml,java,kt}`; `controller(s)/`, `*Controller|Resource|Endpoint`;
  `service(s)/`, `*Service|ServiceImpl|Facade`; `webapp/`, `static/`, `templates/`, `public/`, `*.jsp`; `resources/`).
  Sections keep the incoming order (git or risky first), the §39.3 author filter narrows them first (a section with none
  of its files is not listed), and ⌘] / ⌘[ and the move after a verdict follow the sections (Core
  `AppState.navigationSections`, Electron `displayOrder`). A bulk list (§39.1, over 300 files) folds by folder as before and
  the menu is disabled with "대량 변경은 폴더별로 접혀요". Row paths drop the source root and the app's root package, the module
  kept ("…/orders/billing/InvoiceServiceImpl.java", "acme-api/…/orders/Api.java", JSP without `WEB-INF/jsp/`); the full path is
  the row's tooltip.
- **Already there (comp-13).** A file nothing of Claude's explains is origin `external` with its own badge ("앱 밖 변경"), never
  "Bash"; a post-Bash file is that call's only when its ctime falls in the call's execution window (§31.1); a file without
  a recorded cause says so in the diff header with a side question ("원인 기록 없음 — 곁질문으로 물어보기"; Mac
  `WhyChangedSection`, Electron `ChangeCause`).
- **Not in this pass.** Grouping by cause (subagent · Bash command · turn — the §39.3 author filter covers the subagents),
  a whitespace-ignoring diff (`select_file {ignoreWhitespace}`; §34.7's `whitespaceOnly` badge stays), image previews of
  a binary's two sides, user rules for badges per project, the turn summary card grouped like the list, and the Mac
  full-file view's in-line change highlight.
- Security: display only — no badge, size or grouping allows, skips or reverts anything; the gate, the git guard and the
  budget are unchanged.
- Owners: w4b-files (engine `review/fileRisk.ts`, `diff/fileMeta.ts`, `GitCheckpoint.blobSize`; Mac
  `FileListProtocol.swift`, `FileMeta.swift`, `FileGroups.swift`, `AppState+FileGroups.swift`, `FileMetaViews.swift`;
  Electron `fileMeta.ts`, `fileGroups.ts`, `GroupedFiles.tsx`, `diff/FileMetaRow.tsx`). Tests: `engine/test/w4b.files.test.ts`,
  `Core/Tests/ReviewGateCoreTests/FileListTests.swift`, `FileGroupsTests.swift`, `clients/desktop/src/renderer/riskEngine.test.ts`,
  `fileMeta.test.ts`, `fileGroups.test.ts`; wire goldens `state.initial.json` / `state.reviewing.json` gained `risks` /
  `riskScore` (and §39.1's `storage`, its free space pinned).

### 40.3 Side questions you can trust

Side questions (§21) that do not send read code to the web unasked, do not fill `claude --resume` with copies of the chat,
know how old they are and can be asked again with the latest conversation, start from Claude's answer and from a finished
turn, and keep a queued conclusion on record (audit SME-06, SME-07, SME-08, SME-12, SME-13; peer-06 was already done).
Additive: one setting, two optional command fields, one anchor field, one promotion field; nothing an existing client
relies on changes meaning.

```ts
// settings
sideWeb?: "off" | "rules" | "on"                     // default off; live (the next question)
// commands
side_ask { threadId?, anchor?, question, refork?: boolean }            // refork: fork the latest main conversation again
side_promote { threadId, as, text?, acceptPending?, queued?: boolean }  // queued: only recorded, nothing sent
// types
SideAnchor.quote?: { text: string /* ≤ 2000 chars */; turn?: number | null }
SideThread.promotions[].queued?: true
```

- **The web is off by default** (SME-08). `settings.sideWeb`: `off` (absent or unknown, too) — `WebFetch` / `WebSearch`
  are refused in the side session's PreToolUse hook and `canUseTool` with *"ReviewGate: this is a side question (곁질문) — the
  web is off here (ReviewGate Settings › Side questions), or this site is not in the user's Claude Code allow rules. …"*
  (it starts like the read-only reason, so the call is marked `denied`); `rules` — only a call the user already allows
  without a card: their `permissions.allow` rules `WebFetch(domain:…)` / `WebFetch` / `WebSearch` (the rules the main
  session applies, §33.5; their deny / ask rules win) or the app's allow patterns (`bashAllowPatterns`, §33.6); `on` — any
  site, as before. `sideAllowWeb` no longer turns the web on: both clients sent `true` as their default, so it never meant
  the user chose it; `sideAllowWeb: false` still means off. The one-shot forks (commit draft §36.11, pre-review §36.13)
  never get the web, not even the allowed sites. The clients send `sideAllowWeb: sideWeb === "on"` next to it.
- **Peer messages** (peer-06): every side CLI — questions, commit drafts, pre-reviews — runs with the flag setting
  `crossSessionInbound: "refuse"` (already since §29; tests `engine.peer.test.ts`, `side.trust.test.ts`).
- **The side sessions' own files** (SME-06). A new fork is renamed `[곁질문] <thread title>` (SDK `renameSession`, after its
  first answer; the CLI keeps the main chat's title for a fork otherwise). Its session file is deleted (SDK
  `deleteSession {dir: <project path>}`) when the thread is closed (`side_close`), dropped by the 30-thread limit, when its
  chat is deleted (`session_delete`) and when the side file of a chat that is gone is pruned on open; never an id that is
  the thread's chat, the fork's source, the current main session or any chat in the index, and never one another thread of
  the chat still uses. Failures (already gone) are logged only.
- **A gone side session** (SME-06): a follow-up whose resume fails before any output with *"No conversation found …"* forks
  the main conversation again (the fork source of a first question) with the thread's questions and answers so far quoted
  as data (`[Earlier in this side thread — … may be out of date]`, newest kept within 8 000 chars) and the question just
  asked; `thread.fork` is the new fork's.
- **The fork point** (SME-07). `side_ask {threadId, refork: true}` (a thread with messages) does the same on purpose:
  "최신 대화로 다시 묻기". The replaced side session is deleted once the new one answered. Clients show `fork.atTurn` as "턴 N
  시점" at the thread head (orange once `hud.turnCount` is past it) with [최신 대화로 다시 묻기] — it asks the follow-up being
  typed, else the thread's last question; disabled while the thread answers.
- **Chats that change id or place** (SME-07). After 대화 되돌리기 (§26) the chat's threads move to the new chat (the rewound
  record keeps none). A chat moved to another worktree (§39.4) takes its threads along: `chat_receive` copies the chat's
  side file from the source worktree's git dir once the chat is in the target's index (unless the target has one; the
  source's record keeps its copy); a follow-up there forks again (its side session lives under the source's project dir). A chat switch still stops running
  side questions: both clients ask first while one is answering ("곁질문 답이 아직 오는 중이에요(N개). 채팅을 바꾸면 답이 끊겨요.
  그래도 바꿀까요?"; Mac `AppState.confirmSideSwitch`, Electron `storeSessions` `swap`). Reading another chat (§39.2) does not
  switch and cuts nothing.
- **Entry points** (SME-12). `anchor.quote`: a passage of Claude's answer and its turn (the nearest user message before it);
  well-formed (non-empty text, cut at 2000 chars, a bad `turn` → null) it wins over the review fields (a `pr` wins over it);
  the prompt quotes it fenced as data. Right-click on Claude's answer → "곁질문으로 묻기": Electron the selected text (else
  the whole answer), Mac the whole answer (SwiftUI gives a menu no selection); disabled while another chat is shown
  read-only. A turn summary card's file keeps its '왜?' after the review is done (anchor: the path and the call that made
  the change; not on a chat shown read-only). PR diff lines / hunks have had theirs since §36.14.
- **Input** (SME-13). The Mac opens the draft sheet even when the summary fails ("요약하지 못했어요. 결론을 직접 써 주세요.",
  Electron did already). The side model is picked from the session's models (`state.session.availableModels`; a stored
  value the list lacks stays listed; free text while no session has listed models), with "same model = the conversation's
  cache, fastest". A conclusion put in the composer queue sends `side_promote {queued: true}`: the thread records
  `{as: "message", queued: true}` and shows "⏳ 메인 대화 대기열에 넣음" — also after a chat switch.
- Verified with CLI 2.1.309 / SDK 0.3.270 (haiku): a fork (`resume` + `forkSession` + `sessionId`) is a new session with the
  main chat's title in `listSessions`; `renameSession` gives it `customTitle: "[곁질문] …"` and leaves the main one alone;
  `deleteSession {dir}` removes the fork's file and keeps the main one, a second call throws "not found"; resuming a session
  that is gone yields `result/error_during_execution` with nothing before it, then "No conversation found with session ID".
- Unchanged: the side policy (§21) — edits, `Agent` / `Task` (but an Explore agent in a side question, r2 M18), MCP tools
  (but their reads in a side question, r2 M18), `SendMessage`, mutating Bash stay refused in every read-only fork; the review
  gate, the git guard and the budget apply to whatever a promoted message makes the main turn do.
- Compatibility: an older engine ignores `sideWeb` (it reads `sideAllowWeb`, which the clients send as `sideWeb === "on"`),
  `refork` (a plain follow-up) and `quote` (a question without anchor); `side_promote {queued}` would reach an older engine as a
  send (both clients bundle their engine, so the pair does not occur). An older client shows `quote` threads
  without an anchor chip and queued promotions as sent.
- Not in this pass: answers that go on across a chat switch (they are stopped, after the question); @-mentions and images in
  the side composer; the draft on its own lane (SME-13); '왜?' on plan steps and agent cards.
- Owner: w4b-side (engine `side/threads.ts`, `side/sideQuery.ts`, `side/context.ts`, `engine.ts`; Mac `SideTrust.swift`,
  `SideQuestions.swift`, `SideTrustViews.swift`, `SideSettingsRows.swift`; Electron `sideTrust.ts`, `storeSide.ts`,
  `QuoteMenu.tsx`, `SideSettings.tsx`, `SidePanel.tsx`). Tests: `engine/test/side.trust.test.ts`,
  `Core/Tests/ReviewGateCoreTests/SideTrustTests.swift`, `clients/desktop/src/renderer/sideTrust.test.ts`.

## 41. Wave 4 (fourth batch): team commits, trusted auto-accept, review leftovers

0.2.8: commits and PRs in the team's own format, low-risk changes that no longer pile up in the review list, and what the
review screens still lacked. As §38–§40, each lane took its own feature through the engine and both clients (no contract
written first); every subsection says how it was built. Additive on the wire: new commands with their replies, optional
fields; nothing an existing client relies on changes meaning.

- §41.1 **Commits and PRs in the team's format** — the commit draft follows the format the repository's recent subjects
  follow (`PAY-1800: 제목 - 설명`), `{issue}` is the branch's issue number, the PR sheet starts from the branch's
  commits and keeps its metadata per repository; `/clear` is the app's new chat and a compacted turn says so.
- §41.2 **Trusted auto-accept and undoing a reject** — opt-in rules per repository accept a whitespace-only file, a
  lockfile beside an accepted manifest and a test that passed (never a risky file or one Bash, an MCP tool or someone
  outside the app changed); a whole-file reject can be put back; one row for a blocking prompt hook; auto mode asks for an
  MCP write into `.git/`.
- §41.3 **Review leftovers** — "20줄 더 보기" in past and PR diffs, a read-only whitespace-ignoring view, three search
  lines per chat, the Mac full-file view's in-line marks, the review list grouped by cause, an image's two sides.

```ts
// commands: commit_format {} → commit_format;  pr_draft { base } → pr_draft;  pr_create + assignees? / labels? / reviewers? / projects?  // §41.1
// events:  turn_end.usage.compacted? { trigger, preTokens? }                                                                  // §41.1
// commands: set_auto_accept { rules };  auto_accept_undo { paths? };  reject_undo { path }                                    // §41.2
// state:   autoAcceptRules?;  changedFiles[].autoAccepted?;  gate.rejectUndo?;  turn_summary.autoAccepted?;  ReviewHistoryFile.autoAccepted?  // §41.2
// commands: history_file_lines / pr_file_lines → file_lines;  file_image → file_image                                       // §41.3
// commands: select_file + ignoreWhitespace? (→ file_diff + ignoreWhitespace?);  transcript_search + perChat? (→ matches[].more? / total?)  // §41.3
```

Rules: as §38–§40 — every field optional; an older engine refuses the new commands `unknown_command` and the clients go
on as in 0.2.7 (no 팀 형식 line and no PR auto-fill, no rules and no undo banner, no "20줄 더 보기" in past and PR diffs,
no image preview), and ignores `pr_create`'s metadata and `ignoreWhitespace` / `perChat` (the clients then say the engine
cannot ignore whitespace, and show one search line per chat); an older client ignores `usage.compacted` and shows an
auto-accepted file as accepted. Where two lanes meet, both clients follow one rule (no wire change):

- A file a §41.2 rule accepted keeps its "규칙으로 수락 · <규칙>" chip on its row in every grouping, §41.3 원인별 included
  (the row is the same; its cause is never a Bash command, since a file Bash touched is never accepted by a rule).
- The risk badges that keep a file from every rule are the ones its row shows: §41.2 reads the engine's §40.2
  `fileRisks`, the rule behind `changedFiles[].risks`.
- The §41.2 whitespace rule and the §41.3 whitespace-ignoring view read the same `-w` diff (§34.7 `whitespaceOnly`): a
  file the rule accepted has no hunks in that view ("공백만 바뀌었어요 …").

The gate stays: the learned format and the PR draft only read, a commit, a push and a PR still wait for the user's click;
every auto-accept rule is off until the user turns it on, never touches the disk and is told to Claude as an accept in
the next message; a reject comes back only while the disk still holds what the reject left; the §41.3 reads only read
trees the review or the history already pins and the PR the user opened, and the whitespace-ignoring view is read-only.

### 41.1 Commits and PRs in the team's format

An acme commit reads `PAY-1800: 장바구니 합계 수정 - 중복 할인 방지` on branch `feature/PAY-1800-2`, and its PR
needs an assignee, labels and a project. The commit draft (§36.11) now follows the format the repository's own subjects
follow, `{issue}` is the issue and not the `-17`, the PR sheet starts from the branch's commits and remembers its metadata,
and the two CLI commands that desync the chat from Claude's memory get the app's meaning (audit market-10, SME-11).
Additive: two commands, two replies, four optional `pr_create` fields, one optional usage field.

```ts
// commands
commit_format {}                    // → commit_format { learned, kind, examples, issue, branch, effective, source }  (query lane)
pr_draft { base: string }           // → pr_draft { title, body, commits, baseRef, hasUpstream, gh, host }  (PR lane)
pr_create { …, assignees?: string[], labels?: string[], reviewers?: string[], projects?: string[] }
// types
TurnUsage.compacted?: { trigger: "manual" | "auto"; preTokens?: number }     // turn_end (event and transcript row)
type CommitFormatKind = "path" | "key" | "number" | "conventional";
type GHReadiness = "ok" | "not_found" | "not_logged_in";
```

- **The format is learned** (engine `review/commitFormat.ts` `learnCommitFormat`). From `git log -50 --no-merges --format=%s`
  (reverts, `fixup!` / `squash!` / `amend!` and merge subjects not read) every subject gets a shape: `#<repo>/<n>/…` (also
  `#<repo>/<n>: …`, `#<repo>/<n> …`) → `path`, `[ABC-<n>] …` / `ABC-<n>: …` → `key`, `[#<n>] …` / `#<n> …` → `number`,
  `feat|fix|…(scope)!: …` → `conventional`. The shape most subjects share wins when it covers ≥ 40 % of them and ≥ 2 (1 when
  only one subject was read); the repository segment / Jira key is kept, the number becomes `{issue}`, and ` - {summary}` /
  `({scope})` are added when most of its subjects have them: `PAY-{issue}: {title} - {summary}`, `[PAY-{issue}] {title}`,
  `{type}({scope}): {summary}`. `examples` are its newest five subjects; free-form subjects give `learned: null`.
- **`{issue}` is the issue** (`branchIssue`; also §36.11's `renderCommitTemplate`). The branch's run of digits that the
  learned format's subjects already use as an issue (the branch has commits), else its longest run, the first of equals:
  `feature/PAY-1800-2` → `1800` (§36.11 took the last run: `2`), `fix/PROJ-12-part-3` → `12`. Clients without the
  reply (and the template preview) use the longest-run rule (Core `CommitTemplate.issue`, Electron `commitIssue`).
- **`commit_format`** replies the learned format, the issue, the branch and `effective` — `settings.commitTemplate` when set,
  else `learned` — with `{issue}` / `{branch}` filled in (`source` `settings` / `learned` / null). A read; nothing is stored.
- **`commit_draft`** asks for `effective` (the setting still wins; without one the learned format, said to be "the team's
  format, learned from the recent subjects"), lists the `examples`, and tells Claude to fill what is left in braces (`{title}`,
  `{summary}`, `{type}`, `{scope}`) in the language of the examples and to keep the rest (prefix, issue, separators). The
  prompt still carries the newest 20 subjects. Nothing else of §36.11 changes (read-only fork, no web, nothing committed).
- **`pr_draft {base}`** (PR lane; `empty_base` for a blank one): the branch's commit subjects since `origin/<base>` (else
  `<base>`, else none: `baseRef: null`), oldest first, ≤ 50, merges left out; `title` — one commit: its subject, several:
  the part they all share before ` - ` (`PAY-1800: 재고 동기화`), else the oldest subject; `body` — `- <subject>` per commit;
  `hasUpstream` — false: `pr_create` pushes first (§6 as before: only when the user creates the PR); `gh` — `not_found`
  without a `gh`, `not_logged_in` when `gh auth status` (the PR store's account probe, `state.pr.accounts` refreshed) lists
  the `origin` host without a working account — or, for a host it does not list (an ssh alias), has no working account at
  all; `host` that host. It pushes nothing and writes nothing.
- **`pr_create` metadata**: `assignees` / `labels` / `reviewers` / `projects` become `--assignee=<v>` / `--label=<v>` /
  `--reviewer=<v>` / `--project=<v>` per value (the `=` form: a value that starts with `-` is never a flag); a value is kept
  when it is a non-blank string ≤ 200 chars without a line break, ≤ 20 per flag. `@me` is gh's own "the logged-in user".
  A `gh` failure (a label or project that does not exist, a token without the `project` scope) is the usual
  `result{ok:false}` with gh's words.
- **`gh pr create` runs in the worktree.** A `pr_create` without a title used to pass `--fill`, and gh ran in the
  engine's own folder. gh then failed with "could not compute title or body defaults: failed to run git: fatal: not a git
  repository". Now gh runs in the project's folder, and `--fill` is never passed. A missing title is `pr_draft`'s title
  (the branch's commits since the base), else the branch name. A missing body is then the commits' list.
- **Clients — the commit sheet** (Mac `TeamFormatLineView` / `LearnedFormatRow` in `CommitDraftViews.swift`, Electron
  `TeamFormat.tsx` in `CommitDraft.tsx`; logic Core `TeamFormat`, Electron `commitFormat.ts`): `commit_format` when the sheet
  opens (and per branch); under "Write with Claude" one line "팀 형식: <the project's template, else the learned one, first
  line>" (+ "(최근 커밋에서 배움)" for the learned one) and [형식 바꾸기], which opens the template editor. The editor (sheet and
  Settings › Project) offers "최근 커밋에서 배운 형식: … [이 형식 쓰기]" when the learned format is not what is typed (it fills
  and saves the project's template; the user can change it). An older engine: no line, no offer (as before).
- **Clients — the PR sheet** (Mac `CreatePRSheet`, Electron `CreatePRDialog`): `pr_draft` per base fills the title / body
  until the user typed in them ("이 브랜치의 커밋 N개로 채웠어요(<base> 이후)"); 담당자 (default `@me`) / 라벨 / 리뷰어 /
  프로젝트, comma-separated, are kept per repository (the main worktree's key, like the commit template; Mac UserDefaults
  `projectPRMeta`, Electron localStorage `rg.prMeta`) after a successful create; `gh` `not_found` / `not_logged_in` disables
  [PR 만들기] with its reason in one line ("GitHub CLI(gh)가 없어요 — …", "gh 가 <host> 에 로그인하지 않았어요 — PR 탭에서
  로그인해 주세요"); a branch without upstream says that the create pushes it first.
- **`/clear` is the app's new chat** (SME-11; engine `send`). The CLI's `/clear` empties Claude's memory and starts a new
  session id while the app kept showing the old conversation under it (§30 adopted the new id). A `send` whose first word is
  `/clear` — or an alias the session's `capabilities.commands` lists for `clear` (`/reset`, `/new` in CLI 2.1.30x) — is now
  `session_new` (same refusals; the earlier chat stays in the list; arguments mean nothing, as in the CLI). Typed, picked in
  the palette or queued: the same. The palette's description of `clear` says so ("앱에서 새 채팅을 열어요 — 지금 채팅은 목록에
  남아요"; Core `SlashCommandCatalog.entries`, Electron `slashBuiltins.ts`).
- **`/compact` stays the CLI's** (§27) and the chat now says what happened: the session reads `compact_boundary`'s
  `compact_metadata {trigger, pre_tokens}` into `turn_end.usage.compacted` (also the CLI's own auto-compaction mid-turn), and
  both clients put one line before that turn's end line, live and restored: "대화를 줄였어요 · 16.3k → 3.7k 토큰 — Claude 는
  이전 대화를 요약으로 기억해요" (auto: "대화가 길어져 자동으로 줄였어요 …").
- Compatibility: an older engine refuses `commit_format` / `pr_draft` (`unknown_command`: no format line, the PR sheet as
  before), ignores the `pr_create` metadata and sends `/clear` to the CLI; an older client ignores `usage.compacted`.
- Security: `commit_format` / `pr_draft` only read (`git log`, `rev-parse`, `gh auth status`); the draft stays a read-only
  fork and fills a field; nothing is committed, pushed or created without the user's click; the review gate, the git guard and
  the budget are unchanged.
- Not in this pass: a "Claude 로 PR 본문 쓰기" fork; an editable PR title format of its own (the title follows the commits);
  `/model`, `/effort`, `/mcp`, `/config` mapped to the app's controls (they still go to the CLI as before); a divider for a
  `conversation_reset` that reaches the engine some other way.
- Owner: w4c-commit (engine `review/commitFormat.ts`, `review/commitDraft.ts`, `pr/create.ts`, `session/claude.ts`,
  `engine.ts`; Mac `CommitFormatProtocol.swift`, `TeamFormat.swift`, `AppState+TeamFormat.swift`, `TeamFormatViews.swift`;
  Electron `commitFormat.ts`, `slashBuiltins.ts`, `TeamFormat.tsx`, `TurnEndRow.tsx`, `CreatePRDialog.tsx`). Tests:
  `engine/test/commitFormat.test.ts`, `engine/test/engine.commitFormat.test.ts`, `engine/test/session.m23.test.ts`,
  `Core/Tests/ReviewGateCoreTests/TeamFormatTests.swift`, `clients/desktop/src/renderer/commitFormat.test.ts`.

### 41.2 Trusted auto-accept and undoing a reject

Low-risk changes no longer pile up in the list, and a reject made by mistake comes back (audit comp-21; the reject undo
0.2.4 left out, §38.1). Plus two 0.2.7 follow-ups: one row for a blocking prompt hook, and auto mode asking for an MCP
write into `.git/`. Additive on the wire: three commands, optional fields; nothing an existing client relies on changes.

```ts
// commands
set_auto_accept { rules: AutoAcceptRules }   // the repository's rules (a rule left out is off); refused no_project
auto_accept_undo { paths?: string[] }        // files a rule accepted → pending (absent: all of them); refused session_running
reject_undo { path: string }                 // the last single-file reject comes back; refused session_running /
                                             // reject_undo_unavailable / reject_undo_changed_on_disk / reject_undo_review_changed
// types
type AutoAcceptRule = "whitespace" | "lockfile" | "tests";
type AutoAcceptRules = { whitespace?: boolean; lockfile?: boolean; tests?: boolean };
type AutoAcceptedFile = { path: string; rule: AutoAcceptRule };
type RejectUndoState = { path: string; oldPath: string | null; status: ChangeStatus; available: boolean; reason?: "changed_on_disk" | "review_changed" };
// state
autoAcceptRules?: AutoAcceptRules            // only while a project is open and a rule is on
changedFiles[].autoAccepted?: AutoAcceptRule // state "accepted" by that rule (gone once the file is pending again)
gate.rejectUndo?: RejectUndoState            // only while a reject can be (or was) put back
// events
turn_summary.autoAccepted?: AutoAcceptedFile[]   // what this collection's rules accepted
// history
ReviewHistoryFile.autoAccepted?: AutoAcceptRule
```

- **Rules (opt-in per repository, every one off by default).** `set_auto_accept` writes
  `<git common dir>/reviewgate/auto-accept.json` (every worktree and workbench of the repository shares it; read on
  `open_project`). The engine runs them (`engine/src/review/trust.ts` `planAutoAccept`, one pure function) after every
  collection, before `turn_end` / `turn_summary` go out, over every pending file of the list; the lockfile rule also right
  after the user accepts (`accept`, not during a turn). A rule turned on applies from the next collection.
  - `whitespace` — §34.7 `whitespaceOnly`, status `M`, and not a file where whitespace is syntax (`*.py`, `*.ya?ml`,
    Makefiles / `*.mk`, Pug / Haml / Slim / Sass / Stylus / CoffeeScript, `*.nim`, F#, Haskell, Elm, `*.rst`, `*.tsv`):
    `git diff -w` hides an indentation change there. It is `-w` (all space ignored inside a line), so a space added or
    removed inside a string literal counts too; a line split or joined never does.
  - `lockfile` — a lockfile whose manifest in the same folder is accepted (by the user, or by a rule in the same pass):
    `package-lock.json` / `npm-shrinkwrap.json` / `yarn.lock` / `pnpm-lock.yaml` / `bun.lock(b)` ↔ `package.json`,
    `gradle.lockfile` ↔ `build.gradle(.kts)`, `settings-gradle.lockfile` ↔ `settings.gradle(.kts)`, maven-lockfile's
    `lockfile.json` ↔ `pom.xml` (Maven writes no lockfile of its own), `Cargo.lock`, `Gemfile.lock`, `poetry.lock` /
    `uv.lock`, `Pipfile.lock`, `composer.lock`, `go.sum`, `Package.resolved`, `Podfile.lock`, `flake.lock`,
    `pubspec.lock`, `mix.lock` with theirs. Not a deleted lockfile.
  - `tests` — a test file (§40.2 `test`: `*Test.java`, `*Tests.java`, `*IT.java`, `*.test.ts`, `*.spec.ts`, `src/test/…`)
    when the collected turn's `lastTest` (§34.9) is `pass` with `afterLastEdit`.
- **Never accepted by a rule** (`autoAcceptBlock`, first that applies): not pending; Claude Code's own files (§32 mods);
  `tooLarge` (§39.1); `uncaptured`; origin `external` (§31 — nothing of Claude's explains it, "앱 밖 변경"); any Bash
  attribution (`tools` has `Bash`, an edit too); an MCP write or anything but Claude's edit tools (Edit / Write /
  MultiEdit / NotebookEdit — an MCP write is placed by its time window, §31); a §40.2 badge `sensitive`, `deleted`,
  `permission`, `schema`, `sql`, `settings`, `ci` (`large` ≥ 300 lines, `config` and `test` do not block); a part reject
  (`partial` / `rejectedHunks`); review notes (sent or not); a path rejected before — wholly or in part, while the project
  is open, in this round or in one of the last 20 rounds of the history (a rename's old path counts). So a lockfile
  `npm install` rewrote (Bash) is not accepted with its manifest: the user accepts it.
- **Marks.** A rule's file is `state: "accepted"` with `autoAccepted` (and in `acceptedPaths`: the next message tells
  Claude it was accepted, as for any accept); the mark follows the file while it stays accepted (answer / request-changes
  merges, `refresh`, restore) and goes when it is pending again. The round's file keeps `autoAccepted` into the history.
  `turn_summary.autoAccepted` lists what the collection accepted (also files of earlier turns of the review; the card's
  files are this turn's). `auto_accept_undo` puts files a rule still holds back to pending — the accepted tree, the patch
  hash and the history verdict go too; nothing on disk changes.
- **Undo a reject.** A whole-file reject of one file (`reject {paths: [one]}`, ⌘⇧R, the row's button, `reject_all` of
  one file, a `reject_hunks` of every hunk — §17 makes it a whole reject; not a part reject, not a batch) leaves
  `gate.rejectUndo`. `reject_undo` writes the proposal back — the B
  before the revert (`cp.revert(…, endTree)` per path: an added file written again, a deleted one removed, a rename's new
  path back and its old path removed) — re-snapshots B, puts the file back in the list as it was (pending, its notes,
  §37.2), takes it out of `rejectedPaths` (and out of the rule memory when this reject put it there) and restores its
  round entry; a reject that had completed the round (nothing was left) reopens that round, its §34 ranges and drops its
  history entry. Allowed only while A is the same, nothing lists the path and its disk content is still what the reject
  left (`worktreeMatches` against the B right after it); otherwise `available: false` + `reason`, re-checked at every
  `refresh` with `review` in scope and at the command. The offer ends when a turn starts (`send`, `request_changes`, any
  `beginTurn`), at another reject (whole, batch or part), a commit, `finish_review`, a restore and a project change.
- **Clients** (Mac `TrustRules.swift`, `TrustViews.swift`; Electron `trust.ts`, `components/trust/TrustViews.tsx`; same
  keys in the Core catalog): the list row's green chip "규칙으로 수락 · <rule>" with the rule in its tooltip (also in the
  review history); the turn summary's line "규칙으로 수락 N개 (<rules>) [모두 대기로 되돌리기]" — disabled with "이미 대기로
  돌아갔거나 리뷰에서 빠졌어요" / "Claude가 작업 중이에요 — 턴이 끝나면 할 수 있어요"; above the review the banner "거절했어요 —
  <path> [거절 취소]", disabled with "거절한 뒤 파일이 바뀌어서 되돌릴 수 없어요" / "거절한 뒤 리뷰가 바뀌어서 되돌릴 수 없어요";
  Settings › Project › 자동 수락 규칙 (one switch per rule, what each does, what none ever accepts). The button says "모두
  대기로 되돌리기", not "모두 되돌리기": in the glossary 되돌리기 is a revert on disk, and this one changes no file. The banner's
  says "거절 취소" (as "수락 취소"), not "되돌리기": the reject was the revert, and this puts the proposal back.
- **One row for a blocking prompt / stop hook** (0.2.7). A UserPromptSubmit / Stop / SubagentStop command hook that blocks
  (JSON `decision: "block"` or exit 2) is reported twice by the CLI — its `hook_response` (`hook_blocked` with `hookName`,
  §40.1) and `informational{prevent_continuation}` — and became two rows ("훅이 막음: UserPromptSubmit — …" + "훅이 이 턴을
  멈췄어요"). The session keeps the first of the two per turn (`continuationBlock`), either order; a PreToolUse deny is its
  call's (`tool_result.hookDenied`, §38.2); the result's terminal reason adds none (as before). Verified with CLI 2.1.309 (`sidecar/test/
  driver-hookblock.mjs`, the project's own `.claude/settings.json`, no model call): a JSON block and an exit 2 each end
  the turn with one row, `hookName: "UserPromptSubmit"`, `exitCode` 0 / 2, `detail: "commit first"`.
- **Auto mode asks for an MCP write into `.git/`** (§40.1 for MCP tools, `autoModeKeepsMcpCard`). An `mcp__…` call whose
  path arguments (`path`, `file_path`, `source`, `destination`, `paths[]`, a `uri` …; not the content it writes) name a
  `.git` path segment gets the card in auto mode — a hook in `.git/hooks`, another worktree's `reviewgate/incoming/*.json`.
  The app's allow patterns still answer first; the other modes already asked.
- Compatibility: an older engine refuses the three commands `unknown_command` (both clients bundle theirs) and sends no
  `autoAccepted` / `rejectUndo` / `autoAcceptRules` — nothing is accepted on its own and no banner shows; an older client
  shows an auto-accepted file as accepted. No wire golden changed (the rules are off and no reject is offered in them).
- Security: the gate stays — rules are off until the user turns one on, accept only files Claude's edit tools wrote that no
  risk rule flags, never touch the disk, and the next message names them as accepted; `reject_undo` writes back only the
  proposal the reject removed, refuses when anything changed since and keeps the review (the file is pending again).
- Not in this pass: a rule for snapshots / generated files, per-path user rules, a turn summary card listing the
  auto-accepted files of earlier turns, an undo for a batch reject, an MCP `.git` check outside auto mode (the card is
  there already), the lockfile rule for a lockfile a package manager rewrote through Bash.
- Owner: w4c-trust (engine `review/trust.ts`, `review/trustStore.ts`, `review/gate.ts`, `engine.ts`, `state.ts`,
  `session/claude.ts`, `session/autoMode.ts`; Mac `TrustProtocol.swift`, `TrustRules.swift`, `TrustViews.swift`; Electron
  `trust.ts`, `TrustViews.tsx`). Tests: `engine/test/w4c.trust.test.ts`, `engine/test/engine.w4cTrust.test.ts`,
  `engine/test/w4c.hookBlockOnce.test.ts`, `engine/test/w4c.autoModeMcpGit.test.ts`,
  `Core/Tests/ReviewGateCoreTests/TrustRulesTests.swift`, `clients/desktop/src/renderer/trust.test.ts`.

### 41.3 Review leftovers

What the review screens still lacked after 0.2.2–0.2.7 (audit comp-19, comp-11, comp-15, daily-09, comp-07 / market-06,
comp-14): "20줄 더 보기" in a past round's diff and a PR's diff, a diff with whitespace ignored, three search lines per
chat, the Mac full-file view's in-line marks, the review list grouped by cause, and an image's two sides. Additive on the
wire: three read commands, one reply each (two share `file_lines`), an optional field on `select_file` / `file_diff` and
on `transcript_search` / its matches; no event, setting or state field. Types: the `MARK: wave4c w4c-review` block at the
end of `engine/src/protocol.ts`; engine `engine/src/review/reviewLeftovers.ts`.

```ts
// commands (reply)
history_file_lines { entryId, path, final? } → file_lines { scope: "history", path, entryId, lines, isBinary, isTooLarge }
pr_file_lines { filename } → file_lines { scope: "pr", path, sha, lines, isBinary, isTooLarge }
file_image { path } → file_image { path, oldPath, mediaType, old: FileImageSide | null, new: FileImageSide | null, endTree }
select_file { path, since?, ignoreWhitespace?: boolean } → file_diff { …, ignoreWhitespace?: true }
transcript_search { query, limit?, perChat?: number } → transcript_search { matches[] + more?: TranscriptSearchHit[], total? }
type FileImageSide = { size: number; dataBase64?: string; tooLarge?: true };
type TranscriptSearchHit = { row; turn; at; kind; line };   // TranscriptSearchMatch without sessionId / title / more / total
```

- **"20줄 더 보기" in the history and PR diffs (comp-19, comp-15).** `history_file_lines` reads the tree `history_diff`
  diffs to (`final` → the round's last B, else the file's proposal tree `endTree ?? turnEndTree`; the round in progress
  — `review_history.current` — too); `pr_file_lines` reads the open PR's file at its head commit (`headRefOid`): from this
  repository when it has that commit (a fetched branch), else through `gh api repos/O/R/contents/<path>?ref=<sha>` (raw).
  Lines are split as `full_file_content.lines` (`\r?\n`, the last empty line dropped); over 2 MB or 20 000 lines →
  `isTooLarge`, a NUL in the first 8 KB → `isBinary` (both: `lines: []`). Refusals: `unknown_history_entry:<id>`,
  `not_in_history_entry:<path>`, `history_trees_gone`, `no_new_side:<path>` (a deleted file, a file the final tree no longer
  holds); `unknown_pr_file` (no PR open, not one of its files, a removed file). Lanes: `history_file_lines` the query lane,
  `pr_file_lines` the pr lane. Clients ask on the first click only, for a modified / renamed text file (history status `M` /
  `R`; PR status `modified` / `renamed` / `changed`), and use the lines only while every new-side line of the hunks matches
  them (the review diff's rule, Electron `diffContext.ts`, Core `DiffDisplay.fullFileMatches`); otherwise the expander rows
  are disabled with the reason. A line shown this way in a PR diff takes no comment and no side question (GitHub comments
  need a line of the diff); in a history diff it takes the history side question like any new-side line. A large diff
  (over 3 000 lines) offers none, as the review diff.
- **The whitespace-ignoring diff (comp-11, market-06).** `select_file {ignoreWhitespace: true}` answers the same range
  (`since`, the same `baseTree` / `endTree`, `stale` while a turn runs) diffed with `git diff-tree -w` and says
  `ignoreWhitespace: true`; a binary file gets its usual reply without the flag (an older engine ignores the field: no
  flag either — clients then say the engine cannot ignore whitespace instead of showing the normal diff as if it were).
  A file whose every change is whitespace (§34.7 `whitespaceOnly`) has no hunks there. **Its hunk ids are not
  `reject_hunks` ids** (as any range but the whole review, §34.1): clients show the view read-only — "공백 무시" in the diff's
  tool row (Mac: the header, next to "Only whitespace changed" / "공백만 바뀜", which the Mac now shows too), one line saying
  part revert, notes and line side questions work in the normal view, no hunk controls, no "+" / "?" gutter, "Add note"
  (⌥⌘N) disabled with that line; copy, find and "20줄 더 보기" stay. The switch is per window and not remembered across
  launches (the view turns those parts off). The gate does not depend on it: `reject_hunks` still takes only the whole
  review's hunks (`expectedBaseTree` = A, §34.1), and nothing here accepts, reverts or skips anything.
- **The chat search (daily-09, §38.3's "not in this pass").** `transcript_search {perChat: N}` (1–10; absent = 1, the §38.3
  reply unchanged) answers per chat its newest match plus `more` (the next older ones, newest first, at most N − 1) and
  `total` (every matching user message / Claude answer of the chat). A line whose raw text cannot contain the query is not
  parsed. Clients ask for 3 and show up to three lines under the chat's title — each opens the chat at its row (the open
  chat scrolls there) — and "N건 더" (`total` − shown, help: open the chat and use Find) when more matched. An older engine
  sends one match without `total`: one line, no count.
- **The Mac full-file view's in-line marks (comp-07, §40.2's "not in this pass").** The full-file view (Full file) marks
  the changed parts of a changed line with the review diff's own §34.7 segments — added lines by their new number,
  deleted lines by the new line they follow and their order (the keys of `full_file_content.deletedAfterNewLine`), a
  whitespace-only pair drawn faint — only while the row's text is still the diff line's (an edit on disk since: plain).
  Client rule (Core `FullFileEmphasis`); Electron's full-file view is Monaco's diff editor, which marks words itself.
- **Grouping by cause (comp-14, §40.2's "not in this pass"; client rule, no wire change).** "묶기" gains 원인별 (`cause`, kept
  per project like the others): inside each group (설정·훅 / Claude / 앱 밖) a file's section is the subagent that changed it
  ("◆ executor", the §39.3 author rule), else — origin `bash` — the Bash command its toolUseIds name ("Bash · ./gradlew
  spotlessApply", the first line folded to 60 characters; "Bash" when the call is not in the rows), else the turn of its
  reason (`why.turn`: "턴 3"), else "메인"; sections in the order they first appear (the incoming order kept inside), the
  §39.3 author filter narrows them first, and ⌘] / ⌘[ and the move after a verdict follow them (Electron `displayOrder`
  reads the causes the list drew, Mac `navigationSections`). Two agents of one type share a section. A bulk list (§39.1)
  folds by folder as before. Rules: Core `ReviewLeftovers.fileCause`, Electron `fileCause` (`reviewLeftovers.ts`).
- **An image's two sides (comp-11, §40.2's "not in this pass").** `file_image {path}` for a changed `.png` / `.jpg` /
  `.jpeg` / `.gif` of the review (case-insensitive): `old` from A at `oldPath ?? path` (null for an added file), `new` from
  the review's B (null for a deleted one), each `{size, dataBase64}` — over 2 MB only `{size, tooLarge: true}`. Refusals:
  `not_a_changed_file:<path>`, `not_an_image:<path>`, `no_review`. Query lane. Clients show both sides above the binary
  file's sizes line ("변경 전" / "변경 후", the size under each, "2MB가 넘어 미리 보지 않아요", "이번 리뷰에서 추가됨" /
  "삭제됨") on a checkerboard drawn from the theme's two greys, so a transparent or dark image shows on the dark theme;
  an older engine (`unknown_command`) shows nothing new.
- Rules: as §38–§40 — every field optional, both clients the same words (one key each, Mac catalog → Electron `ko.json`);
  Electron's main process forwards the three commands (`ipcGuard.ts`). Security: pure reads of trees the review or the
  history already pins and of the PR the user opened; the `gh` call is the user's own `gh` with the host named, the path
  URL-encoded per segment; nothing reaches a read-only fork; the gate, the git guard and the budget are unchanged.
- **Not in this pass.** "20줄 더 보기" in the whitespace-ignoring view of the Mac (Electron has it, from the same B); image
  previews in the history and PR diffs; a final / proposal toggle in the history diff (`history_diff.final`, comp-15); the
  turn summary card grouped like the list.
- Owner: w4c-review (engine `review/reviewLeftovers.ts`, `pr/gh.ts` `fileContent`, `pr/store.ts` `headOf` /
  `fetchHeadContent`, `engine.ts`; Mac Core `ReviewLeftoversProtocol.swift`, `ReviewLeftovers.swift`,
  `AppState+ReviewLeftovers.swift`, `FileGroups.swift` / `AppState+FileGroups.swift` (cause), App
  `ReviewLeftoversViews.swift`, `HistoryDiffView`, `PRDiffPane`, `DiffView`, `FullFileView`, `ChatTabs`; Electron
  `reviewLeftovers.ts`, `fileGroups.ts` (cause), `FileCauses.ts`, `diff/MoreLines.ts`, `diff/WhitespaceDiff.tsx`,
  `diff/ImagePreview.tsx`, `dialogs/SearchMatchLines.tsx`). Tests: `engine/test/w4c.review.test.ts`,
  `Core/Tests/ReviewGateCoreTests/ReviewLeftoversTests.swift`, `clients/desktop/src/renderer/reviewLeftovers.test.ts`.

## 42. Wave 4 (final batch): plans, sessions, config, agents, Windows, speed and accessibility

0.3.0: what the audit still listed after 0.2.8 — plans read and implemented the way this user makes them, Claude sessions
that say who is talking, MCP servers and Claude's instructions managed from the app, what each model cost, the Windows
client in Korean with the Mac's keys, and a review that stays fast and reads aloud. As §38–§41, each lane took its own
feature through the engine and both clients (no contract written first); every subsection says how it was built.
Additive on the wire: optional fields, optional command fields, three commands with one reply; §42.5 and §42.6 change
nothing on the wire; nothing an existing client relies on changes meaning.

- §42.1 **Plans you can review and follow** — the plan at full size with a note per step, implemented in a fresh chat or
  a new workbench, and "plan vs actual" from the chat's own plan file, Claude's to-do list, a numbered first message or
  the first request's @mentions.
- §42.2 **Messages between Claude sessions** — the session name carries the chat's title, a SendMessage card names the
  session it reaches, the sidebar says how the other sessions see this window, the app's messages are the user's.
- §42.3 **MCP servers and Claude's instructions** — where a server is defined (a parent folder's `.mcp.json` removed
  there), off for every workbench, reconnect after a login; CLAUDE.md and memory files with when Claude reads them, the
  project's CLAUDE.md edited over its diff, the subagent list.
- §42.4 **Subagent cost and the agents panel** — what each model cost in a turn and in the session, the model each
  subagent ran on, the Mac panel at its default 340 pt, the earlier turns' agents after a restart.
- §42.5 **The Windows client: Korean and the Mac's keys** — menus, dialogs and refusals in Korean, one shortcut table for
  both apps (`docs/SHORTCUTS.md`) and Help › Keyboard Shortcuts (client only).
- §42.6 **Speed and accessibility** — a streaming answer redraws its own row, a diff hover one row, VoiceOver and screen
  readers hear the review in words, dark-mode hints at AA contrast (client only).

```ts
// state:    session.pendingPlan.steps?;  session.planSource?;  sessions.list[].planFile?                                  // §42.1
// commands: plan_response + into? ("new_chat" | "workbench") / path?;  plan_follow { path | null }                        // §42.1
// events:   plan_proposed.steps?;  plan_approved + into? / target? / from?;  turn_summary.plan + source? / title?            // §42.1
// types:    PermissionRequest.toSession?;  CliRunningSession.address?;  CliSessionsEvent.self?;  the user message's origin  // §42.2
// types:    McpServerInfo.origin? / disabledIn? / authWaiting?;  McpStatusEvent.repositoryToggle?;  MemoryFile.kind? / editable?  // §42.3
//           SessionExtensions.projectInstructions? / agents?
// commands: mcp_toggle + scope?;  mcp_remove + file?;  claude_md_read { path } / claude_md_write { path, text, baseSha } → claude_md  // §42.3
// events:   turn_end.usage.models?;  turn_summary.models?;  state: hud.turnModels? / sessionModels?;  AgentNode.apiModel?      // §42.4
```

Rules: as §38–§41 — every field optional. An older engine refuses `plan_follow` and `claude_md_read` / `claude_md_write`
`unknown_command`, would read `plan_response.into` as a plain approve (so the clients offer [새 채팅에서 구현] /
[새 워크벤치에서 구현] only to an engine that sends `steps`, else disabled with the reason), ignores `mcp_toggle.scope` and
`mcp_remove.file` (sent only with `repositoryToggle` / `origin`), and sends none of the new fields: the clients keep 0.2.8's
plan card, SendMessage card, MCP rows, memory list and HUD. An older client ignores them all; `origin` is the CLI's to read.
Where two lanes meet, both clients follow one rule (no wire change):

- §42.1's implementation turn — the fresh chat's or the workbench's first message — is a normal send, so it carries
  §42.2's `origin {kind: "human"}`; a chat started that way shows its title in the session name (§42.2) from its CLI's next
  start, like any new chat.
- The engine builds a turn summary once — §42.1's plan source, then §41.2's `autoAccepted`, then §42.4's `models` — and the
  card shows "plan vs actual" (titled by its source, "요청 범위" for a request scope) before "이번 턴 비용(추정)".
- §42.6's memoized transcript rows (Electron) take what they show as props: §42.1's plan row and §41.1's compacted turn-end
  row read only their item. Every Mac text this batch added follows §42.6's contrast rule (`.secondary`; `.tertiary` only
  on a decorative icon): §42.3's instruction views, §42.2's address line, §42.4's popover note and elapsed time, §41.3's
  image sizes and "N건 더".
- A key added to either client goes into `docs/SHORTCUTS.md` and both tables (§42.5; tests hold them to the doc). This
  batch added none besides §42.5's; §42.1's plan sheet closes on Esc without answering the plan.
- §42.3's every-workbench MCP choice (`mcp-repository.json`) and §41.2's rules (`auto-accept.json`) sit in the git common
  dir's `reviewgate/`, §42.1's handoff (`plan-handoff.json`) in the target worktree's own git dir; none is read across
  repositories.

The gate stays: every implementation turn of a plan is a normal send (the review gate, the git guard and the budget
apply) and a handoff names `default`, `acceptEdits` or `auto` only; a SendMessage asks every time and the session registry
is only read; the app's own CLAUDE.md save is the user's edit — never during a turn, while a collection failed or over a
file in the review — and a parent folder's MCP server is removed only by the CLI, in the folder of the file the user
confirmed; the costs, the model chips, the panel, the keys and the screen reader's words are display only.

### 42.1 Plans you can review and follow

A long plan is read and answered at full size, step by step, and implemented in a chat that is not already full of the
research behind it; "plan vs actual" (§15) works for plans made the way this user makes them — an OMC plan file, Claude's
to-do list, a numbered first message — not only for one approved through ExitPlanMode (audit market-08, comp-17; one lane
took it through the engine and both clients). Additive on the wire: optional fields, one command field pair, one command.

```ts
// state:    session.pendingPlan.steps?: PlanStepBrief[]          // also plan_proposed.steps
//           session.planSource?: PlanSourceState                 // absent without a chat / when there is nothing to show
//           sessions.list[].planFile?: string                    // the chat's chosen plan file (absolute)
// commands: plan_response + into?: "new_chat" | "workbench", path?   (approve only)
//           plan_follow { path: string | null }
// events:   plan_approved + into?, target?, from?
//           turn_summary.plan + source?: PlanSourceKind, title?
type PlanStepBrief = { index: number /* 0-based */; text: string /* ≤ 300 chars */ };
type PlanSourceKind = "approved" | "file" | "todos" | "message" | "request";
type PlanSourceState = { kind: PlanSourceKind | null; path?: string; chosen?: boolean; candidates: string[] };
```

- **Steps for notes** (market-08). A proposed plan carries its steps (`parsePlanSteps`, §15; ≤ 200, each ≤ 300 chars):
  `plan_proposed.steps` and `pendingPlan.steps`. The card is a short preview with [크게 보기] (Mac `PlanReviewSheet`,
  Electron `PlanReviewDialog`): the whole plan beside its steps, a note field per step and one for the whole plan.
  [계속 계획하기] sends them as one `plan_response {approve: false, message}`, a line per noted step then the general note
  (Core `PlanReviewNotes.message`, Electron `planNotesMessage`; key "Step %lld (%@): %@" → "단계 3 (Spring 설정): 빼 주세요", the
  step quoted ≤ 60 chars). The notes stay on the card until it is answered (a new proposal clears them); Esc closes the large
  view, never answers the plan.
- **Implement in a new chat** (`into: "new_chat"`). Checked like `session_new` (`collect_failed`, `session_busy`; §9) and
  refused `invalid_mode` for `plan`, before anything changes. A fresh chat of this
  worktree starts with its CLI in the approved mode, the plan becomes its approved plan (its summaries follow it) and its
  first message is *"Implement the approved plan at <path> (it was made in an earlier chat — read it first)."* (§54: without
  "Work in small units and stop after each unit for review.") — the plan itself, fenced, when it only came through ExitPlanMode — a normal
  send through the gate. `plan_approved {mode, path, into: "new_chat"}` is emitted in the fresh chat. A follow-up that does
  not go out leaves the plan pending there in the previous mode (`plan_followup_failed`, §19.5).
- **Implement in a new workbench** (`into: "workbench", path`). The client creates the workbench first (the New Workbench
  sheet, branch suggested `plan/<file name>`), then answers with its folder; `path` must be another worktree of this
  repository (`moveTarget`, §39.4: `path_not_found` / `not_a_worktree` / `same_worktree`). The engine writes
  `<target gitdir>/reviewgate/plan-handoff.json` (`{version: 1, from, planPath, plan, mode, text, at}`), clears the card and
  emits `plan_approved {mode: <this chat's mode, unchanged>, path, into: "workbench", target}` — this chat stays in plan mode
  and sends nothing. The client then opens the workbench's window; its engine takes the handoff once on `open_project`
  (deleted when read; ignored when malformed, older than 15 minutes, or its mode is `plan` or unknown; a chat moved there
  the same moment comes first and the plan waits), makes a fresh chat current, starts its CLI in the handoff's mode, keeps
  the plan as approved and sends the follow-up (`plan_approved {into: "workbench", from}`); when the session cannot take a
  message the plan waits on its card there.
- **Plan vs actual without an approved plan** (comp-17). `turn_summary.plan` (§15) now says where it came from —
  `source: "approved"` for the plan approved in ReviewGate (absent from an older engine), else, in this order: the plan
  file the chat chose (`plan_follow`), the plan file its user messages named last (an @mention or a path word ending `.md`
  under a `plans/` folder or named `plan…` / `…-plan…`: `.omc/plans/x.md`, `docs/db-plan.md`, `~/.claude/plans/x.md`; read
  at every summary, capped at `MAX_PLAN_BYTES`; one that cannot be read or has no steps falls through) — `source: "file"`,
  `path` absolute, `title` its name; Claude's own to-do list (the latest top-level `TodoWrite` list, else the
  `TaskCreate` / `TaskUpdate` list; `done` = completed) — `"todos"`; the chat's first message when it has two or more
  numbered or checklist items — `"message"`. Steps and files are matched as in §15.
- **Outside the request.** Without any of those, a first request that @mentions files is the scope: `source: "request"`,
  `title` its first sentence (≤ 120 chars), one step with the files it covers — the request's text names them (§15
  `mentionsPath`), an @mention is the file, a folder above it, or a file whose stem it starts (`FooService.java` covers
  `FooServiceImpl.java`, `FooServiceTest.java`) — and `unplannedFiles` the rest. Clients call them "요청 범위 밖" (header
  "요청 밖 N개", the row badge "요청 범위 밖", the section "요청 범위" with the sentence instead of a step list). A request
  that @mentions nothing gives no plan (every change would be "outside" it); a chat without any source shows no plan
  section, as before.
- **What the chat follows.** `state.session.planSource {kind, path?, chosen?, candidates}` says what the next summary
  follows without reading a file (`path` repo-relative inside the worktree), and `candidates` lists plan files to choose
  from: `.omc/plans/`, `.claude/plans/`, plan-named Markdown under `docs/` (two levels), then the five newest of Claude
  Code's own plans folder (`<CLAUDE_CONFIG_DIR or ~/.claude>/plans`), newest first, ≤ 12; read when the project opens and
  after every turn. `plan_follow {path}` (repo-relative, absolute or `~/…`) chooses one for the open chat — kept in its
  meta (`planFile`), refused `invalid_plan_file` for anything but a readable `.md` file; `null` / `""` goes back to the
  automatic sources. The chat's sources are read back from its rows (the last 5 000) when it is opened, so they survive a
  restart.
- **Older engine / client.** Without `steps` the clients keep the one note field and offer [새 채팅에서 구현] /
  [새 워크벤치에서 구현] disabled with "이 앱 버전의 엔진이 필요해요 — 프로젝트를 다시 열어 주세요" — an older engine would read `into` as
  a plain approve and implement here. Without `source` the section reads as the approved plan; an older client shows a
  request scope as a one-step plan and ignores `planSource`, `into`, `target` and `from`.
- Security: the review gate, the git guard and the budget apply to every implementation turn (a normal send); the handoff
  names one of the three implementing modes (`default`, `acceptEdits`, `auto` — never a bypass); `plan_follow` and the named files are read,
  never written, and only their steps reach the client.
- Not in this pass: implementing in an existing workbench's window (only a workbench created for the plan). A chooser UI
  for `plan_follow` and '왜?' on plan steps and agent cards came in §43.5.
- Owner: w4d-plan (engine `review/planSources.ts`, `review/planHandoff.ts`, `engine.ts`; Mac `PlanReviewProtocol.swift`,
  `PlanReview.swift`, `AppState+PlanReview.swift`, `PlanReviewSheet.swift`, `PlanCard.swift`; Electron `planReview.ts`,
  `PlanReviewDialog.tsx`, `PlanCard.tsx`). Tests: `engine/test/w4d.planSources.test.ts`, `engine/test/w4d.plan.test.ts`,
  `Core/Tests/ReviewGateCoreTests/PlanReviewTests.swift`, `clients/desktop/src/renderer/planReview.test.ts`.

### 42.2 Messages between Claude sessions

Messages to and from the user's other Claude sessions that say who is talking: the session's name for the others carries
the chat it is, the SendMessage card names the session a message goes to instead of a socket path, the sidebar says how the
other sessions see this window, and the app's messages say they are the user's (audit peer-05, peer-07, peer-08; peer-04 and
the read-only `ListAgents` were already done, §29 / §33.2). Additive: one optional field on a permission request, one on a
running session, one on the `cli_sessions` reply, and `origin` on what the engine writes to the CLI.

```ts
type PeerSessionInfo = { address: string; pid: number; name: string | null; cwd: string | null; status: CliSessionStatus; entrypoint: string | null };
type PeerSelf = { pid: number; name: string | null; address: string | null };
PermissionRequest.toSession?: PeerSessionInfo   // SendMessage to another session's address: whom it reaches
PeerSessionInfo.sessionId?: string             // r2-peers: the conversation its registry entry names (§33.2's remember key)
CliRunningSession.address?: string             // "uds:<socket>"
CliSessionsEvent.self?: PeerSelf               // this window's main session as the others see it
```

- **The name** (peer-05). `--name` is `ReviewGate · <project>[/<branch>]` (§29) and, once the chat has a title (not "New
  chat"), ` · <chat title>`: at most 64 characters (the CLI keeps 64 code points of a name), a long title cut with `…`,
  never inside a character; dropped when fewer than 8 characters of it would fit. The CLI takes the name at start only (SDK
  sessions cannot be renamed live: `rename_session` needs a host callback the SDK does not register), so a new chat shows
  the title from its next start (restart, reopening, chat switch). The registry lists it with `nameSource: "user"` — the
  entry the other sessions' `ListAgents` reads — and it is the `/resume` picker's title (§29).
- **`cli_sessions.self`**: this window's CLI as its registry entry (`<config>/sessions/<pid>.json`, only read) lists it —
  `name` and `address` (`uds:` + `messagingSocketPath`; null when there is none); absent before the CLI registered.
  `running[].address` the same for the other sessions. Clients show it at the end of "Other Claude sessions in this
  repository": "다른 세션에 보이는 이 창 이름: ReviewGate · acme · …" with [복사] (`name (address)`), so the user can tell
  a terminal Claude where to send.
- **`permission_request.toSession`** (peer-07). For a `SendMessage` whose `to` is a session address — `uds:<socket>`
  (percent-decoded as the CLI does) or a bare socket / named-pipe path — the engine looks for the live registry entry with
  that `messagingSocketPath` (the pid in the socket's name first, then every `<pid>.json`; never the `*.key` files) and
  puts it on the request: name, folder, status, entrypoint. Best effort: a lookup over 400 ms, a failure, a dead pid, an
  agent or teammate name (§36.3) leave it out, and the card shows `to` as before. A call the CLI withdrew during the lookup
  gets no card. The card's title is the name ("받는 세션: acme-b4"), under it "터미널 · ~/acme · 입력 대기" and the
  address. Nothing else changes: SendMessage always asks (§33.2), nothing is remembered, auto mode keeps its card.
  (r2-peers, §33.2: in auto mode a message to a live session the lookup finds — or to the session's own subagent — no
  longer asks, and in the other modes the card can remember that session: `toSession.sessionId`.)
- **`origin {kind: "human"}`** (peer-08). Every message the engine writes for the user (`send`, `request_changes`, the
  plan follow-up, a resend) carries it next to its uuid — the SDK: a host that wraps keyboard input stamps it, an absent
  origin is unattributed and fails closed at the CLI's strict trust gates. A peer turn (§29) writes nothing of ours, so its
  message keeps the peer's origin. Side CLIs (§21) are unchanged (read-only, they refuse peers).
- Verified with CLI 2.1.309 (haiku, a scratch repository): a message with `origin {kind: "human"}` runs normally; the
  `--replay-user-messages` echo and the `result` carry `origin: {"kind": "human"}` (the engine ignores both, as before:
  only a peer origin means anything to it); the registry lists `--name "ReviewGate · probe · 재고 동기화"` as given,
  `nameSource: "user"`, with its `messagingSocketPath`; a conversation resumed under a longer `--name` (the title added) is
  listed under the new one. The registry's `messagingSocketPath` and the CLI's `uds:<path>`
  address scheme are the CLI's own (its `ListAgents` builds addresses the same way).
- Security: the registry is only read, as §36.9; the engine sends nothing to another process. A name is the registry's
  claim (any process of the user can write one) — the card shows it as the receiving session, the address under it is what
  the message actually goes to.
- Compatibility: absent fields — an older engine — leave the card and the section as they were; an older client ignores
  them. `origin` is an SDK field of the user message (not checked with CLIs before 2.1.309).
- Not in this pass: the cross-session panel (peer-09 — a log of received / sent messages and "send to this session"); the
  sidebar's list (§36.9) and the transcript's peer rows (§29) and SendMessage cards stay where they are.
- Owner: w4d-peers (engine `review/cliSessions.ts`, `session/claude.ts`, `engine.ts`; Mac `PeerSessionProtocol.swift`,
  `PeerSessions.swift`, `PeerSessionViews.swift`; Electron `peerSessions.ts`, `SendMessageCard.tsx`, `OtherSessions.tsx`).
  Tests: `engine/test/review.peerAddress.test.ts`, `engine/test/session.peerOrigin.test.ts`,
  `engine/test/engine.peerSelf.test.ts`, `Core/Tests/ReviewGateCoreTests/PeerSessionsTests.swift`,
  `clients/desktop/src/renderer/peerSessions.test.ts`.

### 42.3 MCP servers and Claude's instructions

MCP servers a worktree gets from a workspace folder above it can be removed, turned off once for every workbench
and reconnected after a login; CLAUDE.md, memory files and subagents are no longer a read-only list (audit SME-09, SME-14).
Additive on the wire: optional fields on `McpServerInfo`, `McpStatusEvent`, `MemoryFile` and `SessionExtensions`, two
optional command fields, two commands and their reply; nothing an existing client relies on changes meaning.

```ts
// types
McpServerInfo.origin?: McpServerOrigin;  McpServerInfo.disabledIn?: "worktree" | "repository";  McpServerInfo.authWaiting?: true
McpStatusEvent.repositoryToggle?: true
type McpServerOrigin = { file: string | null; place: "project" | "parent" | "home" | null; removable: boolean;
                         reason?: "plugin" | "claude_ai" | "managed" | "not_found" | "read_only" | "unknown"; command?: string };
MemoryFile.kind?: InstructionKind;  MemoryFile.editable?: true
type InstructionKind = "user" | "project" | "local" | "parent" | "nested" | "rules" | "auto_memory" | "managed" | "other";
SessionExtensions.projectInstructions?: { path: string; relPath: string; kind: "project" | "local"; exists: boolean }[]
SessionExtensions.agents?: { name: string; description: string; model?: string; source?: "project" | "user" | "plugin"; path?: string }[]
// commands
mcp_toggle { name, enabled, scope?: "worktree" | "repository" }        // default worktree (§22)
mcp_remove { name, scope, file?: string }                              // file: the origin file the user confirmed
claude_md_read { path }                       → claude_md
claude_md_write { path, text, baseSha: string | null }  → claude_md { …, saved: true }
type ClaudeMdEvent = { type: "claude_md"; id?; path; relPath; kind: "project" | "local" | "nested"; text; sha: string | null; exists; saved? };
```

- **Where a server is defined (SME-09).** The CLI loads the `.mcp.json` of the project and of every folder above it and
  reports all of them as scope `project`, but `claude mcp remove --scope project <name>` edits only the `.mcp.json` of its
  cwd: from a worktree a server of the parent folder's `.mcp.json` failed "No MCP server named … in .mcp.json"; run in
  that folder it is removed (CLI 2.1.309, a scratch `CLAUDE_CONFIG_DIR`). So every `mcp_status` row carries `origin`
  (engine `mcp/mcpOrigin.ts`): a project server's file is the nearest `.mcp.json` from the session's cwd upwards whose
  `mcpServers` names it (≤ 40 folders, ≤ 1 MiB, re-read by mtime / size) — `place: "project"` inside the project,
  `"parent"` above it; user / local servers are `place: "home"` (`<CLAUDE_CONFIG_DIR>/.claude.json`, else `~/.claude.json`,
  never read for this); plugin, claude.ai and managed servers are `removable: false` with their `reason`. A project file
  the CLI cannot rewrite (the file or its folder not writable) is `reason: "read_only"`, one no file names `"not_found"`;
  both carry `command`, the terminal line that removes it (`cd '<folder>' && claude mcp remove --scope project <name>`,
  `cd /d "…"` on Windows).
- **Removing it there.** `mcp_remove {scope: "project", file}` runs the CLI in `dirname(file)` when `file` is the server's
  origin as found now, else it is refused `mcp_origin_changed:<name>` and nothing runs; without `file` (an older client) the
  CLI runs in the project as before. Clients send `file` only for `place: "parent"`, after a confirmation that names the
  file and says every project and workbench under that folder loses the server; a row that cannot be removed opens the
  same confirmation with the reason and [명령 복사] (the `command`). ReviewGate itself writes no MCP file: the CLI does,
  and only for the file the user confirmed; `~/.claude.json` / `~/.claude/settings*.json` are never written by the app.
- **Off for every workbench.** `mcp_toggle {scope: "repository"}` keeps the choice in
  `<git common dir>/reviewgate/mcp-repository.json` `{version: 1, disabled}` (engine `mcp/mcpScopes.ts`); the worktree's own
  `<git dir>/reviewgate/mcp.json` gains `enabled` — on here although the repository turns it off (written only when there
  is one, so §22's shape is kept). Off here = this worktree's `disabled`, or the repository's list without this worktree's
  `enabled`; `disabledIn` says which. Every open worktree re-reads the repository file at its session start and on each MCP
  poll when its mtime / size changed, and turns the servers it newly turns off off (and back on only the ones it had turned
  off) — so a choice made in one window reaches the other open workbenches within a poll (10 s). The file is read again
  just before each write (another window may have changed another name). `repositoryToggle: true` on `mcp_status` when the
  project has a git common dir. Clients: the switch stays this workbench's (§22); [모든 워크벤치에서 끄기 / 켜기] beside
  it (Mac a menu, Electron buttons), the chip "모든 워크벤치에서 꺼짐".
- **The login, then reconnect.** After `mcp_auth {name}` the server is `authWaiting` and the polls reconnect it every other
  poll (at most every 20 s) while it still needs a login, for 10 minutes or until it connects — a reconnect is the CLI's
  normal connect (it opens no browser); the row and the banner say "터미널에서 로그인하면 자동으로 다시 연결해요" and keep
  [재연결]. On Windows the console starts in the project (`Platform.openTerminal(command, cwd)`), so `claude /mcp` lists its
  project / local servers.
- **What an instruction file is (SME-14).** `memoryFiles[].kind` (engine `instructions/claudeMd.ts` `instructionKind`, one
  rule): `<config>/CLAUDE.md` user, `<cwd>/CLAUDE.md` / `.claude/CLAUDE.md` project, `<cwd>/CLAUDE.local.md` local, a
  CLAUDE.md / CLAUDE.local.md in a folder above parent, below the root nested, `.claude/rules/**` rules, anything under
  `<config>/projects/` auto memory, a managed / policy label managed. Clients word when Claude reads each ("모든 프로젝트에서
  대화를 시작할 때마다 읽어요", "Claude 가 그 폴더의 파일을 다룰 때 읽어요", …; Core `InstructionText`, Electron
  `claudeConfig.ts`). `editable` marks the ones `claude_md_write` takes. `projectInstructions` lists the project's own
  CLAUDE.md (`.claude/CLAUDE.md` when only that one exists) and CLAUDE.local.md whether they exist yet or not.
- **Editing the project's CLAUDE.md.** `claude_md_read` / `claude_md_write` take a project-relative path (or an absolute one
  inside the project) whose name is CLAUDE.md / CLAUDE.local.md, never `..`, `.git` or a symlink that points outside
  (`invalid_path`); ≤ 256 KiB (`too_large`). A write needs `baseSha` = the sha256 the read returned (null = the file did not
  exist) and is refused `claude_md_changed` when the file changed meanwhile (an editor, Claude), `session_busy` while a turn
  starts, runs, is collected or reverted, and `in_review` while the file is among the open review's pending files; it is
  written next to the real file and renamed over it (a symlink stays one, the mode is kept). Clients show the text, then its
  diff (3 lines of context, longer unchanged runs folded; Core `InstructionDiff`, Electron `instructionsDiff`) and save only
  from there; after it, "Claude 는 다음 세션부터 바뀐 내용을 읽어요" with [지금 재시작]. Files in the home folder (~/.claude/CLAUDE.md,
  auto memory) are only opened.
- **Open in the default app.** Every memory file, project instruction file and subagent definition has [에디터에서 열기]:
  the system's default app for a Markdown file that exists (Mac `NSWorkspace.open` behind `InstructionText.canOpen`;
  Electron `rg:openMarkdown` → `shell.openPath` behind main's `isOpenableMarkdown`: absolute, no control characters,
  `.md` / `.markdown`, a regular file) — never a program, a folder or an `.app`.
- **Subagents.** `extensions.agents` from `initializationResult().agents` (name, description ≤ 300 chars, model), with
  `source` / `path` when the definition is found: `<plugin path>/agents/<name>.md` for `plugin:name`, else the project's
  `.claude/agents/<name>.md`, else the user's `<config>/agents/<name>.md` (built-in ones have neither). Clients list them under
  "서브에이전트" (folded on Electron) with [에디터에서 열기].
- Security: the review gate is unchanged — the app's own CLAUDE.md save is the user's edit (as in an editor): never during a
  turn, never over a file under review, a working-tree change like any other (`branches.isWorktreeDirty`), and Claude's own
  edits of instruction or settings files keep their flows (§32 mods review, §33.9 `claude_config` card). Removing a server
  from a parent folder's file is an explicit user action naming that file; Claude has no command for it.
- Compatibility: an older engine sends no `origin` / `disabledIn` / `authWaiting` / `repositoryToggle` / `kind` /
  `projectInstructions` / `agents`: the clients keep §22's rows (remove by source, the switch only), the old memory list,
  and offer neither the repository choice nor the editor. An older engine ignores `mcp_toggle.scope` / `mcp_remove.file`
  (the clients only send them with `origin` / `repositoryToggle`) and refuses `claude_md_*` `unknown_command`.
- Verified with the real CLI 2.1.309 (no model): `claude mcp remove --scope project parentsrv` in a child folder of the file
  exits 1 "No MCP server named "parentsrv" in .mcp.json"; in the file's folder it exits 0 and rewrites only that file.
- Not in this pass: adding a server from a pasted JSON / `claude mcp add …` line, a "규칙 추가" sheet from the review, a skill
  search with descriptions, editing a subagent or rules file in the app (they open in an editor).
- Owner: w4d-config (engine `mcp/mcpOrigin.ts`, `mcp/mcpScopes.ts`, `instructions/claudeMd.ts`, `engine.ts`; Mac
  `ClaudeConfig.swift`, `McpServers.swift`, `McpServersView.swift`, `InstructionsViews.swift`; Electron `claudeConfig.ts`,
  `McpServers.tsx`, `Instructions.tsx`, `main/markdownOpen.ts`). Tests: `engine/test/w4d.config.test.ts`,
  `Core/Tests/ReviewGateCoreTests/ClaudeConfigTests.swift`, `clients/desktop/src/renderer/claudeConfig.test.ts`,
  `clients/desktop/src/main/markdownOpen.test.ts`; wire golden `state.reviewing.json` gained `projectInstructions`.

### 42.4 Subagent cost and the agents panel

What each model cost in a turn, which model each subagent ran on, a Mac agent panel that reads at its default 340 pt, and
the 0.2.5 follow-ups (audit agents-09, agents-10). Additive on the wire: optional fields and one internal agent signal; no
command, event or setting. Types: `ModelCost` and the `MARK: wave4d w4d-agents2` fields in `engine/src/protocol.ts`;
engine `session/modelCost.ts`, `session/agentHistoryRows.ts`.

```ts
// events: turn_end.usage.models?: ModelCost[];  turn_summary.models?: ModelCost[]   (rows keep them: turn_end / turn_summary)
// state:  hud.turnModels?, hud.sessionModels?: ModelCost[];  hud.agents[] / agentHistory[] + apiModel?: string
type ModelCost = { model: string; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
```

- **`usage.models`** — the SDK's `result.modelUsage` is cumulative over a streaming session (like `total_cost_usd`): a
  turn's entry per model is the difference from the previous owned result's numbers (main loop, subagents, compaction),
  most expensive first, models without change left out; absent when the CLI sent none. A session total below the last one
  (a `/clear`, a fresh CLI process) or a model whose numbers went down takes the numbers as they are; an unprompted turn
  moves no baseline, so its usage lands in the next turn (as its cost does); a review turn over several released peer
  messages (§29) differences the last result. `turn_summary.models` copies the turn's list; both rows keep it.
- **`hud.turnModels` / `hud.sessionModels`** — the last finished turn's list (a turn without one clears it) and the lists
  summed per model over the chat since the engine opened it (as `sessionCostUSD`, reset with the HUD).
- **`AgentNode.apiModel`** — the model a subagent's answers came from: claude.ts reads `message.model` of its first
  assistant message (`parent_tool_use_id` = the agent's call; `<synthetic>` is no model) and sends the internal
  `agent_signal {kind: "agent_model"}` once per agent and model. `model` (§36.1) stays what the call named.
- **`hud.agentHistory` after a restart** — §39.3 kept it in memory only. Opening a chat (a fresh engine, `session_open`,
  `session_new`) rebuilds it from the chat's last 2 000 rows (§38.3 keeps them) into an empty tracker: each Agent / Task
  `tool_use` row with its `tool_result` row (`agentUsage`, `stoppedBy`, `cliAgentId`, the result's start as `reportPreview`
  / `error`), the edits under it (and under its nested agents) as `files`, `turn` from the row; a call without a result
  ended with the engine (`stopped`); a background agent (its result is only the launch) is left out. Same slimming as
  §39.3 (no `prompt`, texts ≤ 200 chars, ≤ 20 files, ≤ 50 agents, newest first). Nothing new is stored.
- **Clients** (Mac and Electron the same; the display rule in Core `ModelCostText` / `renderer/agentCost.ts`, both checked
  against `engine/test/fixtures/modelCosts.json`): models grouped by family (opus / sonnet / haiku; another model by its
  id without `claude-` and the date), "$0.38", under half a cent "<$0.01".
  - The HUD's "$1.23 세션" opens a popover: the session cost, "지난 턴 모델별(추정)" and "이 세션 모델별(추정)" as a stacked
    bar tinted like the model chips with "opus $0.38 · sonnet $0.06 · haiku $0.01", the estimate's note, and the side
    questions' cost (apart, §21). Without lists: "턴이 끝나면 모델별 비용이 여기에 보여요."
  - The turn summary card ends with "이번 턴 비용(추정)" and its bar (nothing from an older engine).
  - An agent card, the chat's agent group and the details sheet name `apiModel ?? model`; the card's tokens carry a gauge
    (was "#" / "▤"). Electron's model chip reads like the Mac's ("sonnet 4.5", was "sonnet-4-5").
  - Electron's card menu is the Mac's: 대화에서 보기 / 보고서 보기 / 지시 보기 / 이 에이전트 중지 (the sheet opens at the
    report / the instructions; the group head's ⋯ keeps 에이전트 상세).
- **Mac agent panel** (agents-10; rules in Core `AgentPanelLayout` / `AgentIdentity` / `AgentCardEmphasis`): three or more
  agents side by side are one compact row each (status, type, description, ■, time; the second line what a live agent does
  now or what a finished one left; a click opens the full card under it, the menu is the card's); every agent type has a
  color (FNV-1a of the type without its plugin, bits 13 up, modulo 8; none of the status colors) on the card's left edge and
  before its timeline label; the type reads without the plugin prefix ("executor" + a small "OMC" badge); a failure is a
  red card with the strongest border, a stop quieter than a finished agent; the main card names the model as the HUD does
  and, idle, shows "지난 턴 3분 2초 · $0.45 · 컨텍스트 42%" instead of a second "쉬는 중". Checked by offscreen renders
  (light / dark, 340 pt) of the App's own views.
- **Compatibility.** An engine before §42.4 sends none of the fields: no bars, no popover lists (its note instead), the
  model chip as before, an empty "이전 턴" after a restart. A client before §42.4 ignores them (`agent_model` never leaves
  the engine).
- **Not in this pass.** A per-agent cost estimate (tokens × price; the chip shows the model only), Electron's panel layout
  and identity colors (agents-10 is a Mac finding; `AgentIdentity.colorIndex` is the rule to take), the timeline's axis
  ticks / main lane on the Mac and an "agent board" window, the frequent MCP servers' (mysql, elasticsearch, chrome)
  icons and Korean tool names, background agents in the rebuilt history.
- Owner: w4d-agents2. Tests: `engine/test/session.modelCost.test.ts`, `engine/test/session.agentHistoryRows.test.ts`,
  `Core/Tests/ReviewGateCoreTests/{ModelCostTests,AgentPanelLayoutTests}.swift`,
  `clients/desktop/src/renderer/agentCost.test.ts`, `clients/desktop/src/renderer/components/chat/TurnSummaryCard.test.ts`.

### 42.5 The Windows client: Korean and the Mac's keys

The Windows (Electron) client speaks Korean from its first screen, and both apps take the same keys, written in one table
(audit polish-07, polish-08; one lane, Electron first, the Mac where the keys differed). No wire change: client only.

- **Korean in the main process** (polish-07). The menu bar (파일 · 편집 · 보기 · 창 · 도움말) is built from labelled items:
  Electron's role menus (`editMenu`, `windowMenu`, `appMenu`) become the same roles with a `t()` label (`main/menu.ts`;
  `mainKorean.test.ts` fails on a label without Hangul). Dialog titles (프로젝트 열기, "{0} 선택", 이미지 첨부, 새 창에서
  열기), the taskbar overlay's description ("확인할 항목 N개") and a refused program path's reason
  (`settingsGuard.refusalText`, e.g. "파일 이름이 claude.exe 또는 claude.cmd 여야 해요."; the log keeps the English) are
  Korean. Where the Mac's words name the Mac, Windows says its own (`platformWords.ts`): "탐색기에서 보기" for Finder, "PATH"
  for the login shell, "cmd.exe" for the workbench setup command (the engine runs it there). A closed gate
  (`gate_closed:*`, `request_changes_unavailable`) reads as the Mac's `EngineMessages.gateText` sentence instead of its raw
  state (`gateText.ts`).
- **One set of keys** (polish-08). `docs/SHORTCUTS.md` is the table (Mac, Windows, note; seven sections). Core
  `ShortcutTable` and `renderer/shortcutTable.ts` are its two copies, held to it row by row by `ShortcutTableTests` /
  `shortcutTable.test.ts`; the labels are App catalog keys (one translation). Electron takes the Mac's keys: Ctrl+Alt+A the
  agent panel (was Ctrl+Shift+E; no hidden alias), Ctrl+Alt+S side questions, Ctrl+Alt+F find in the unified diff, Ctrl+.
  stop while Claude works — matched by physical key (`keymap.ts windowKey`), so they work with a Korean input source. The
  View menu lists the panel toggles with their keys (`registerAccelerator: false`: the renderer still decides, with its
  dialog / tab / focus checks). On the Mac, ⌥⌘↩ with a message typed stops the turn and sends it, as Ctrl+Alt+Enter does
  (`CardShortcuts.stopAndSendDraft`; an empty composer still answers the card for the session, the side follow-up still
  adds a note, typing never answers a card), and View › Show/Hide Sidebar (⌃⌘S) pairs with Ctrl+B.
- **Help › Keyboard Shortcuts** in both apps: the table with both platforms' columns, this platform's in bold (Electron
  `ShortcutsDialog`, the Mac a single `Window` scene, `ShortcutsView`).
- CI: `actions/checkout` / `actions/setup-node` v5 (Node 20 is retired); on the Windows runner Defender skips the
  workspace, the temp folders and git / node / bash (its 19 minutes were 16 of engine tests and 31 s of `npm ci`, so no
  cache was added).
- Not in this pass: an Electron Review menu (accept / reject / next … with their keys — a static menu cannot show the
  renderer's disabled reasons without an IPC), find in the diff in Electron's Monaco views, Electron's View toggles disabled
  without a project, the Mac's side-by-side diff and folded unchanged lines.
- Owner: w4d-windows (Electron `main/menu.ts`, `main/ipc.ts`, `main/notify.ts`, `main/settingsGuard.ts`, renderer
  `platformWords.ts`, `gateText.ts`, `keymap.ts`, `shortcuts.ts`, `shortcutTable.ts`, `ShortcutsDialog.tsx`; Mac
  `ShortcutTable.swift`, `ShortcutsView.swift`, `CardShortcuts.swift`, `ReviewGateApp.swift`; `.github/workflows/ci.yml`).
  Tests: `clients/desktop/src/main/mainKorean.test.ts`, `clients/desktop/src/renderer/{windowsWords,keymapParity,shortcutTable}.test.ts`,
  `clients/desktop/src/renderer/components/dialogs/ShortcutsDialog.test.ts`,
  `Core/Tests/ReviewGateCoreTests/{ShortcutTable,CardShortcuts}Tests.swift`.

### 42.6 Speed and accessibility

A long chat and a large diff stay smooth, and the review can be heard (audit polish-09, polish-10; one lane through both
clients). No wire change: client only.

- **A streaming answer redraws its own row** (Electron). While only the last assistant row's text grows, the list follows
  the transcript's shape — the same array (`transcriptShape.ts`) — and only that row (`AssistantMessage`) reads the live
  text from the store and keeps the view pinned. Rows and agent groups are memoized and take their call's result and tool
  name as props (not a context), so a new tool result redraws its own row; the diff's cause, the side question preview,
  the older rows and the agent sheet follow the shape too. 500 rows and 100 deltas draw the list 0 more times; a delta
  went from ~20 ms to ~0.1–0.3 ms in the static-render bench. No virtualisation: find, highlights and scroll-to-row need
  every row in the DOM.
- **A diff hover redraws one row** (Mac). `HoverRow` keeps the hover in its row (review diff, PR diff, changed files list),
  so a pointer move redraws the row it enters and the one it leaves, not the pane over every line, its plan and its risk
  order; the pane's line count and hunk header map come from Core `FileDiffIndex`, built once per diff
  (`DiffPlanCache.index(for:)`; 1 000 hovers over a 3 000-line diff: ~90 ms → ~0.13 ms of derived work).
- **The review in words** (polish-10). A diff line is one sentence — "추가된 줄 42: …", "삭제된 줄 41: …", "문맥 줄 40: …",
  "변경 부분: @@ …", "(빈 줄)", "공백만 바뀜" — for VoiceOver (one element; the hover buttons are its actions: "이 줄에 메모
  추가", "이 줄에 대해 묻기", on a PR "댓글 추가") and for Electron's screen readers (an off-screen prefix; the number and the
  sign hidden, nothing extra in a copy). A file row is "수정됨, 12줄 추가, 3줄 삭제, 리뷰 대기"; icon-only buttons (✕, 🗑, ↻,
  the queue editor's ←/→, MCP "⋯", the side anchor's chevron) have names. One set of words: Core `ReviewSpeech` keys,
  Electron's `a11yText.ts` through ko.json.
- **Dark-mode contrast** (Mac). A caption that says something uses `.secondary` (≈5–6:1 on the dark window, WCAG AA);
  `.tertiary` (≈2.3:1) is left to decorative icons — the rule the batch's other Mac texts follow (§42 head).
- Not in this pass: ending the processes OMC's SessionStart hook leaves detached after a forced restart (only a marker in
  the CLI's environment, read with `ps -E`, could tell ours from the user's, and Windows cannot read another process's
  environment; left to the user), the Mac chat's own streaming cost, a count of SwiftUI body evaluations (no App test
  target).
- Owner: w4d-speed (Electron `transcriptShape.ts`, `Transcript.tsx`, `a11yText.ts`, `a11y.css`, `UnifiedDiff.tsx`,
  `ChangedFiles.tsx`; Core `DiffRowSupport.swift`; Mac `RowHover.swift`, `DiffView.swift`, `PRDiffPane.swift`,
  `ChangedFilesList.swift`). Tests: `clients/desktop/src/renderer/{transcriptShape,a11yText}.test.ts`,
  `Core/Tests/ReviewGateCoreTests/DiffRowSupportTests.swift`.

## 43. Wave 5: the agent board, the sub-brain, the code graph, auto model

0.4.0: what the user first built as Claude Code mods — a board of every subagent as a face, what Claude's auto memory (the
"sub-brain") is collecting, the code graph — drawn in both apps, where an SDK session never shows a mod; a model picked per
message when the user asks for it; and what 0.3.0 left. As §38–§42, each lane took its own feature through the engine and
both clients; every subsection says how it was built. Additive on the wire: four commands with three replies (two of them also
sent as events), two settings, one command field, optional fields; §43.1 and §43.5 change nothing on the wire; nothing an
existing client relies on changes meaning.

- §43.1 **The agent board** — one board per project window (Mac: Window › Agent Board, ⌥⌘B; Windows: View › Agent Board,
  Ctrl+Alt+B) with three tabs; the agents tab draws every subagent as a face per type with its mood and what it runs in
  words, the summary line and the earlier turns (client only).
- §43.2 **The sub-brain** — what the repository's auto memory holds (one folder for every workbench), what this session
  added and who wrote it, as cards, a graph around MEMORY.md and a timeline (read only).
- §43.3 **The code graph and mods** — graphify's report with how far HEAD has moved since, rebuilt in the background on the
  user's click only where git ignores `graphify-out/`; the user's Claude Code mods in Settings › Extensions.
- §43.4 **Auto model** — opus / sonnet / haiku picked per message before it goes out (never during a turn) under a policy,
  one message on a model of its own, and always which and why.
- §43.5 **0.3.0 follow-ups** — Claude's to-do list asks nothing, CLI 2.1.310 verified, the "plan vs actual" basis menu,
  '왜?' on plan steps and agent cards, one Korean text per catalog key (no wire change).

```ts
// commands: brain { watch? } → brain;  brain_read { name } → brain_memory;  events: brain (no id) while watched         // §43.2
// commands: code_graph → code_graph;  code_graph_build → code_graph, then code_graph (no id) while it runs and at its end  // §43.3
// state:    extensions.mods?                                                                                             // §43.3
// settings: modelMode? ("manual" | "auto");  modelAutoPolicy? ("cost" | "balanced" | "quality");  commands: send + model?  // §43.4
// state:    session.autoModel?;  hud.autoModelCounts?;  events: user_message / turn_end / turn_summary + autoModel?       // §43.4
```

Rules: as §38–§42 — every field optional. An older engine refuses `brain` / `brain_read` and `code_graph` /
`code_graph_build` `unknown_command` (the sub-brain tab asks to reopen the project with this app's engine, the code graph
tab to update ReviewGate), ignores `modelMode`, `modelAutoPolicy` and `send.model`, and sends none of the new fields: the
agents tab still works (it reads what §13, §36.1, §39.3 and §42.4 send), the model chip shows "자동" with no pick and every
message runs on the chip's model. An older client sends none of the commands and ignores the fields. Where two lanes meet,
both clients follow one rule:

- The board (§43.1) hosts §43.2's and §43.3's tabs: each is a view without arguments that reads the project's state (Mac
  `SubBrainBoardView` / `CodeGraphBoardView` with `AppState` in the environment, Electron's default exports `SubBrainBoard`
  / `CodeGraphBoard`); the placeholders that stood in for them while the lanes worked are gone. A tab reads only while it is
  shown: §43.2 watches the memory folder (`brain {watch: true}` / `false`), §43.3 reads every 15 s.
- §43.2's "who" wears §43.1's faces: the timeline shows the writer's face before its name — Claude's star for the main
  agent, the subagent type's face (the sparkle robot for a type the table does not know), none from outside (Core
  `SubBrainText.writerAvatar`, renderer `writerAvatar`) — small and still, without a mood badge (Mac
  `AgentAvatarView(showsMood: false)`, Electron `<Avatar showsMood={false}>`).
- §43.3's [관제판 열기] (Settings › Extensions › the mods) opens this project window's board — Mac `BoardWindows.show`,
  Electron `toggleBoard(true)` after the dialog closes — and never closes a board already open, as the board's own key would.
- A tile's menu is the agent card's (§42.4), so §43.5's "왜 시작했는지 묻기" is on the board too. The side question opens
  beside the chat, so the board gets out of its way: the Mac brings the project window forward (as for "대화에서 보기"),
  Electron's board steps aside — for a new question only (`sideStepsAside`), never for an answer arriving.
- The engine builds a turn summary once — §42.1's plan source, §41.2's `autoAccepted`, §42.4's `models`, then §43.4's
  `autoModel` — and the card shows the model line ("모델: opus (자동 · 설계 판단)") under its numbers, then "plan vs actual"
  with §43.5's basis menu, then "이번 턴 비용(추정)"; the cost popover keeps §42.4's split by model and adds §43.4's "이
  세션에서 자동이 고른 모델". Auto picks the main session's model only; a subagent's model stays the CLI's (its call or its
  definition; the board's tiles show it, §42.4).
- A key added to either client goes into `docs/SHORTCUTS.md` and both tables (§42.5): this batch added ⌥⌘B / Ctrl+Alt+B,
  the board.

The gate stays: the board, the sub-brain and the code graph only read — memory text and the report go to the screen only,
nothing leaves the machine, and the board never starts, stops or answers anything by itself; a graph build is the user's
click, writes only graphify's own `graphify-out/` and is refused unless git ignores it, so it never enters a turn's review;
auto model switches only between turns and always says so, and the review gate, the git guard and the budget apply to every
message whatever its model; the to-do list tools write no file (stopping a task and starting a subagent still ask).

### 43.1 The agent board

What every subagent is doing, as faces — the agent board ("관제판"), the kind of view a Claude Code mod can draw in the
terminal, now in both apps (its "1 에이전트" tab; "2 서브브레인" and "3 코드 그래프" are §43.2 and §43.3). No wire change: the
board reads what §13, §36.1, §39.3 and §42.4 already send (`hud.agents`, `hud.agentHistory`, the permission queue, the HUD)
and acts only through the existing commands (`stop_agent`, `agent_report`). Rules in Core `AgentAvatar.swift` /
`AgentBoard.swift` and Electron `renderer/agentAvatar.ts`, both checked against `engine/test/fixtures/agentAvatars.json`.

- **The board.** One per project window. Mac: a window of its own — Window › Agent Board (⌥⌘B; the agent panel's header
  button too) — that shows its project window's project and follows it when that window switches project. It comes back
  where it was (its frame is saved per project, `NSWindow` autosave name `BoardPrefs.frameName`) on the tab it was on
  (`BoardPrefs.tab`, per project); open when the app quit or its project window closed, it opens again with the project
  (behind the project window); closing it yourself forgets that. Electron: a large panel over the window — View › Agent
  Board (Ctrl+Alt+B; the agent panel's header button) — with the tab remembered per project (`localStorage`
  `rg.board.tab.<path>`); Esc, ✕ or a click outside close it, and showing an agent in the chat closes it. Tabs: 에이전트 ·
  서브브레인 · 코드 그래프. Each tab is one view without arguments that reads the project's state (Mac `AgentBoardView` /
  `SubBrainBoardView` / `CodeGraphBoardView` in `App/UI/Board/`, Electron default exports `AgentBoard` / `SubBrainBoard`
  / `CodeGraphBoard` in `components/board/`). docs/SHORTCUTS.md has the row.
- **Avatars.** A round face per agent type: a pastel ring and the type's icon — executor 망치, architect 컴퍼스, explore /
  Explore 쌍안경, test-engineer 플라스크, designer 붓, writer 연필, code-reviewer 안경, security-reviewer 방패, debugger 무당벌레,
  planner / Plan 지도, critic 저울, scientist 원자, verifier 인증 도장, document-specialist 책, git-master 가지, tracer 발자국,
  qa-tester 체크리스트; `general-purpose` and any type the table does not know are the sparkle robot in the tone of its
  §42.4 identity index; the main agent is Claude's star. The type is matched without its plugin prefix, case-insensitively;
  the plugin is a small badge ("OMC"). Tones are fixed per type and per appearance (light keeps 3:1 on white, dark 8:1 on
  the dark window); the Mac draws SF Symbols, Electron the same pictures as inline SVG (the robot and the star are drawn on
  both). The Mac panel's identity band and timeline dot and Electron's card edge use the same tone (`AgentIdentity.color`
  is now the avatar tone).
- **Moods** (`AgentMood`): working (pending / running) — a little bounce and running dots; waiting — a permission request
  of that agent is open (§33.1; the main agent: one without `agent`) — a waving hand; retrying — `retry` set (§39.3) — a
  turning arrow; done — a check and a sparkle; failed — a red X, a tilted face and dizzy stars; stopped — a gray square;
  idle (paused, the main agent between turns) — a breathing "z". Reduce Motion (macOS, `prefers-reduced-motion`) keeps
  every face still.
- **What it runs** (`AgentToolIcon`, `AgentToolText`): the latest call's icon — Read 문서, Edit / Write 연필, Bash 터미널,
  Grep / Glob 돋보기, Web 지구, Skill 반짝이, Agent / Task 사람들, TodoWrite 체크리스트, an MCP tool a plug or its server's own
  icon — and its words: the three frequent MCP servers (matched in the server's name: `mysql`, `elastic`, `chrome`) by
  name and action in the UI language ("MySQL 쿼리 실행 · SELECT 1", "엘라스틱서치 ES|QL 조회", "크롬 페이지 이동"; English
  "MySQL: run a query"), an unknown tool of those servers "MySQL · list users"; any other MCP server the plug and the §39.3
  title, its repeated name dropped from its tools for every server ("acme · list issues · 1800" for
  `mcp__acme__acme_list_issues`, "context7 · query docs"); anything else the §39.3 title too ("Bash · ./gradlew test").
- **The agents tab.** A summary line — "지금 3명 일하는 중 · 1명 권한 대기 · 1명 재시도 중 · 오늘 12명 다녀감" (today: distinct
  `toolUseId`s of `hud.agents` and `hud.agentHistory` started since local midnight); "모두 쉬는 중" or "조용해요 — Claude가
  서브에이전트를 부르면 여기 모여요" when nothing runs. The main agent's tile (star, model, what it does now and the turn's
  time, else the last turn), then the subagents as a tree: agents that ran at the same time side by side (the §39.3
  batches), nested ones in a dashed box under their parent. A tile: face, type + plugin badge, description, what it runs
  now and for how long (else its error or its report's first line), tool calls · time · tokens · model (what §36.1 /
  §42.4 sent; no per-agent cost — the engine has none). A click shows its group in the chat (§39.3; the Mac brings the
  project window forward), the menu is the card's (§42.4). "이전 턴": `agentHistory` by turn, a row of small faces each
  (help: the §39.3 history line; click: its group).
- **Electron's agent panel** takes the Mac's §42.4 layout with these rules: three or more agents that ran at the same time
  are compact rows (status, a small face, type, plugin badge, description, time, ■; the second line what a live agent
  does now or what a finished one left — `rowDetail`, the Mac's `AgentPanelLayout.rowDetail`); a click opens the full card
  under the row; every card has its type's tone on its left edge and the plugin badge after the type.
- **Compatibility.** An engine before §39.3 / §42.4: the tiles show `lastTool` (no time), no earlier turns, no model
  chip. A client before §43.1 shows none of it. Nothing is read or written outside the engine's state; the board never
  starts, stops or answers anything by itself.
- **Not in this pass.** A per-agent cost, Electron restoring the open board after a restart (it is a panel over the
  window, so it opens when asked), animation of the earlier turns.
- Owner: w5-board. Tests: `Core/Tests/ReviewGateCoreTests/AgentBoardTests.swift`,
  `clients/desktop/src/renderer/{agentAvatar,boardScreens,keymapParity}.test.ts`.

### 43.2 The sub-brain

What Claude Code's auto memory of this repository holds and what this session added to it, as the board's "서브브레인" tab
(a terminal mod can show it there only; ReviewGate's SDK sessions never draw a mod). One lane took it
through the engine and both clients. Additive on the wire: two commands and their two replies; no state field, no setting.
Types: the `MARK: wave5 w5-brain` block of `engine/src/protocol.ts`; engine `brain/subBrain.ts`.

```ts
// commands: brain { watch?: boolean } → brain;  brain_read { name } → brain_memory
// events:   brain (the reply, and — while watched — the folder after each change, without an id)
type BrainMemoryType = "user" | "feedback" | "project" | "reference" | "other";
type BrainMemory = { name: string; title?: string; type: BrainMemoryType; description: string; mtime: number; size: number;
                     indexed: boolean; links: string[]; session?: "add" | "change" };
type BrainChange = { at: number; kind: "add" | "change" | "remove"; name: string; title?: string; type: BrainMemoryType;
                     description: string; by: "main" | "agent" | "external"; agentType?: string };
type BrainEvent = { type: "brain"; id?; dir: string | null; dirSource?: "cli" | "settings" | "default"; exists: boolean;
                    memories: BrainMemory[]; counts: Record<BrainMemoryType, number>; hasIndex: boolean; unindexed: string[];
                    missing: string[]; brokenLinks: { from: string; to: string }[]; changes: BrainChange[];
                    tally: { add: number; change: number; remove: number }; sessionCount: number;
                    baselineAt: number | null; scannedAt: number | null; truncated?: true; error?: string; watching?: boolean };
type BrainMemoryEvent = { type: "brain_memory"; id?; name: string; path: string; text: string; truncated?: true };
```

- **Which folder** (CLI 2.1.310, read from its own code and checked with `claude -p` in a scratch repository): the MEMORY.md
  the CLI loaded (`extensions.memoryFiles`: type `AutoMem` or under `<config>/projects/`) decides; else the user settings'
  `autoMemoryDirectory` (`~/` expanded, absolute only); else the CLI's rule — `<CLAUDE_CODE_REMOTE_MEMORY_DIR or config>/projects/
  <key>/memory`, the key being the main checkout's real path with every character but A–Z a–z 0–9 turned into "-" (over 200
  characters: cut, "-", base-36 of the absolute Java string hash). **Every worktree of a repository shares the main
  checkout's folder**: the CLI follows a linked worktree's `.git` → gitdir → `commondir` (and the gitdir's back-link) to the
  main checkout — in a linked worktree `claude -p` names `…/projects/<main checkout>/memory/`, and the acme worktrees'
  project folders hold transcripts but no `memory/`. The CLI creates the (empty) folder when a session starts.
- **What is read.** `*.md` regular files (MEMORY.md is the index, not a memory), sorted, at most 2 000 (`truncated`); each up
  to 64 KiB, opened with `O_NOFOLLOW` — a symlink is never a memory and never followed; the frontmatter's `name` (→ `title`),
  `description` (≤ 300 chars; a `>` / `|` block joined) and `type` (top level or under `metadata:`; else the file name's
  prefix, `feedback_x` / `project-y`; else `other`); the body's `[[links]]` (before `|` / `#`, without `.md`; case, `-` and
  `_` do not matter: `[[feedback-plain-words]]` reaches `feedback_plain_words.md`). MEMORY.md (≤ 256 KiB): its
  `[text](name.md)` and `[[name]]` targets. `unindexed` = memories it does not link (empty without it), `missing` = names it
  links with no file, `brokenLinks` = [[links]] that reach nothing (≤ 200). A file is re-read only when its mtime / size
  changed.
- **The session.** The engine reads the folder once when the project opens (the baseline; again when the CLI's MEMORY.md
  names another folder) and after each memory write's result; later reads list what was added, changed (mtime / size) and
  removed since — `changes` newest first (≤ 100), `tally` all of them, `sessionCount` the distinct memories added or
  changed that are still there ("이번 세션에 쌓인 것"), `memories[].session` `add` for one new this session, else `change`. Who: a `Write` / `Edit` /
  `MultiEdit` whose `file_path` is in the folder names its caller until its result (a failed or denied call names nobody) —
  `main`, or `agent` + the `subagent_type` of the Agent / Task call it runs under (§36.1's tracker); anything else is
  `external` (a shell command, an editor, another Claude session of the repository, the CLI's own background memory work,
  which an SDK session does not stream).
- **Watching.** `brain {watch: true}` — sent when the tab appears — reads now and re-reads every 4 s, sending `brain`
  (without an id) whenever something changed; `watch: false` when it goes away; no field = one read. The timer ends with
  the project and the engine. `brain_read {name}` returns one listed memory's text (≤ 64 KiB; `invalid_name` for a path,
  `not_found` for anything not listed, `no_project`).
- **The tab** (Mac `SubBrainBoardView`, Electron `SubBrainBoard`; the rules in Core `SubBrain.swift` / renderer `subBrain.ts`):
  cards per kind (사람 · 피드백 · 프로젝트 · 참고, 기타 when there is one) and "이번 세션에 쌓인 것 N개"; the graph — MEMORY.md
  as a 🧠 hub in the middle, faint lines to what it lists, links drawn, nodes in their kind's color (sized by links), this
  session's memories with a shimmering ring (still with Reduce Motion / `prefers-reduced-motion`); the legend turns a kind
  off; zoom (pinch / wheel, buttons) and drag; over 300 memories this session's, then the most linked, then the newest are
  drawn and "N개 더" says the rest; the layout is a seeded Fruchterman–Reingold with gravity (`SubBrainLayout` /
  `brainLayout`, deterministic; 12–300 nodes never end pinned to the frame). A click shows the memory on the right — kind,
  "더함 / 고침", age, file name, description, its links, the body without the frontmatter — with [에디터에서 열기]
  (§42.3's opener: a Markdown file that exists). Below: this session (더함 · 고침 · 지움, who — "Claude", the agent type
  without its plugin, "외부" — and when), the eight latest edits, and the index's problems. An empty or missing folder: "이 프로젝트에는
  아직 자동 메모리가 없어요" with what it is and the folder. The tab never writes: a memory is edited in the editor.
- Where lanes meet: the board (§43.1) hosts the tab — Mac `SubBrainBoardView()` with `AppState` in the environment,
  Electron `components/board/SubBrainBoard.tsx`'s default export; "who" carries the agent type (`SubBrainText.writerAgentType` /
  `writerAgentType`) and the timeline shows the board's face for it (`SubBrainText.writerAvatar` / `writerAvatar`, §43 head).
- Security: read only — nothing writes the folder, the review gate, the git guard and the budget are unchanged (Claude's own
  memory writes keep the card every edit outside the project gets); paths stay inside the folder (no symlinks, no `/` in a name);
  memory text goes to the client's screen only — never to a log, the network or a side question.
- Compatibility: an older engine refuses `brain` `unknown_command` — the tab says "이 앱 버전의 엔진이 필요해요 — 프로젝트를 다시
  열어 주세요"; an older client never sends it. Every field is decoded leniently (an unknown kind is `other`, a nameless
  memory or change is dropped).
- Not in this pass: a "서브브레인 +3" chip in the HUD / sidebar (the engine sends `brain` only while the tab watches),
  project / local settings' `autoMemoryDirectory` (the CLI reads them only for trusted folders; the loaded MEMORY.md covers
  it once it exists), team / personal memory stores, editing or deleting a memory in the app, the contribution grid of the
  mod.
- Owner: w5-brain (engine `brain/subBrain.ts`, `engine.ts`; Mac `SubBrainProtocol.swift`, `SubBrain.swift`,
  `App/UI/Board/SubBrainBoardView.swift`; Electron `subBrain.ts`, `subBrainStore.ts`, `components/board/SubBrainBoard.tsx`).
  Tests: `engine/test/w5.brain.test.ts`, `Core/Tests/ReviewGateCoreTests/SubBrainTests.swift`,
  `clients/desktop/src/renderer/subBrain.test.ts`.

### 43.3 The code graph and mods

The board's third tab shows what graphify's report says about the repository's code — and how far HEAD has moved since —
and rebuilds it when the user asks; Settings › Extensions lists the user's Claude Code mods, whose own panes never draw in
the app (a board mod's "3 코드 그래프" tab, inside ReviewGate). One lane took it through the
engine and both clients. Additive on the wire: two commands with one reply (also an event), one optional extensions field.

```ts
// commands
code_graph {}        → code_graph                       // a read (query lane)
code_graph_build {}  → code_graph {build.running}       // then code_graph (no id) while it runs (≤ 1/s) and when it ends
// event
type CodeGraphEvent = { type: "code_graph"; id?; root: string; reportPath: string | null; shared?: true; builtAt: string | null;
  report: CodeGraphReport | null; reportError?: "unreadable" | "too_large"; head: string | null; behind: number | null;
  htmlPath: string | null; graphify: string | null; outIgnored: boolean | null; build: CodeGraphBuild | null };
type CodeGraphReport = { name; date; files; words; nodes; edges; communities; extractedPct; inferredPct; ambiguousPct; commit;
  hubs: string[] /* ≤ 20 */; hubCount; gods: { name; edges }[] /* ≤ 15 */; surprises: CodeGraphLink[] /* ≤ 10 */;
  bigCommunities: { id; name; nodes; cohesion }[] /* ≤ 15, largest first */; isolated };
type CodeGraphBuild = { running; startedAt; finishedAt?; ok?; exitCode?; timedOut?: true; line? };
// state
SessionExtensions.mods?: UserMod[]   // { name, description, version?, path, source: "dev" | "plugin_dirs", sessionId?, loaded, hasHooks }
```

- **The report** (engine `board/codeGraph.ts`; `parseGraphReport` is pure): `<project root>/graphify-out/GRAPH_REPORT.md`,
  else — in a linked worktree without one — the main worktree's (`shared: true`; an acme clone keeps one graph, not one per
  issue worktree). Re-parsed only when its mtime / size changed; over 8 MiB it is not read (`too_large`); `graph.json`
  (100 MB+ in a large repository) is never opened. Read: the title, Corpus Check, Summary, Extraction, "Built from commit", Community
  Hubs (Navigation), God Nodes, Surprising Connections (with the file line under each), Communities (`### Community <id> -
  "<name>"`, `Cohesion:`, `Nodes (<n>)`), Knowledge Gaps (isolated nodes); an unknown layout yields zeros and empty lists.
- **Freshness.** `head` = the project's `git rev-parse HEAD` (short), `behind` = `git rev-list --count <report commit>..HEAD`
  (null when this repository has no such commit), cached per (commit, HEAD). Clients: "최신" (green), "HEAD 보다 37커밋 뒤"
  (orange), "기준 커밋을 이 저장소에서 찾지 못했어요" / "git 밖에서 만든 그래프예요" (gray), the two commits on hover.
- **The build.** `graphify update .` in the project root — `~/.local/bin/graphify` (uv's tool folder; `graphify.exe` on
  Windows) when it is there, else graphify on the login PATH (looked for again after a minute) — without a shell, with
  `GRAPHIFY_NO_TIPS=1`, stdout and stderr as one log, at most 10 minutes (then its process tree is killed: `timedOut`), one at
  a time (`graph_build_running`), only on the user's click (no command of Claude's, no schedule). Refused `graphify_missing`
  without graphify and `graph_out_not_ignored` when git does not ignore `graphify-out/` in the project (`git check-ignore
  graphify-out/GRAPH_REPORT.md`): a build during a turn would otherwise land in the turn's snapshot B and its review. While
  it runs, `code_graph` events carry graphify's latest line (≤ 1/s); at its end its result line ("Rebuilt: 9 nodes, 10 edges,
  3 communities", or the failure's line) with a fresh summary. Switching or closing the project and the engine's dispose stop
  it.
- **Clients** (Mac `CodeGraphBoardView` + Core `CodeGraphText` / `CodeGraphStore`; Electron `components/board/CodeGraphBoard.tsx`
  + `codeGraph.ts`, one rule): the tab reads `code_graph` when it is shown and every 15 s while it stays shown (two git calls
  per read; the report is re-parsed only when it changed). Big numbers (노드 · 엣지 · 커뮤니티), the badge, "파일 1,204개 · 확정
  89% · 추론 11% · 3일 전 빌드"; the 15 most connected nodes and the 15 largest communities as bars (communities in colors
  that are none of the status colors; bars do not animate with Reduce Motion / `prefers-reduced-motion`); the surprising
  connections with their files' names (paths on hover) and 확정 / 추론; the hubs as chips with "외 N개". [다시 빌드] ("여기에
  만들기" for a shared report) is disabled with one reason — an older engine, reading, graphify missing (with the install line
  `uv tool install graphifyy`), not ignored, running — and the build's line sits under it. [graph.html 열기] opens it in the
  default browser: Mac `NSWorkspace.open` behind `CodeGraphText.canOpenHtml`, Electron `rg:openGraphHtml` → `shell.openPath`
  behind main's `isOpenableGraphHtml` (absolute, no control characters, `graphify-out/graph.html`, a file). Empty: "아직 코드
  그래프가 없어요" · "Java 같은 코드 파일만 들어가요 — 토큰은 쓰지 않아요" · [만들기].
- **Mods** (engine `board/mods.ts`): the folders `CLAUDE_CODE_PLUGIN_DIRS` names — the session's environment, else the `env`
  of `<config>/settings.json` (read only) — split as the CLI splits it (the platform's path delimiter, `~` expanded, absolute
  ones only; a folder of plugins lists each child), then `<config>/dev-mods/<session id>/<name>` (newest session first), each
  with `.claude-plugin/plugin.json`; one per real folder, ≤ 50, re-read at most every 10 s, absent when there are none;
  `loaded` = the session reported a plugin at that folder. Settings › Extensions › "Claude Code mod": name, version,
  description, folder (Finder / Explorer), "이 세션에 로드됐어요" / "만든 Claude Code 세션에서만 로드돼요" / "이 세션에는 로드되지
  않았어요", and "앱에서는 mod 화면이 보이지 않아요 — 같은 정보는 관제판에 있어요" with [관제판 열기] (this project window's board, opened
  or brought forward — never closed: Mac `BoardWindows.show`, Electron `toggleBoard(true)` after the dialog closes).
- **Verified with the real CLI** 2.1.310 (haiku, a scratch repository, `sidecar/test/driver-board.mjs`, a board mod
  copied — never moved): with `CLAUDE_CODE_PLUGIN_DIRS` naming the copy's folder, the SDK session loads the mod beside the
  marketplace plugins (reported after the first snapshot), its hooks module runs (its `/board` command is registered), no
  error, the turns took 2.10 s / 1.85 s against 1.96 s / 1.72 s without it (two samples each); without the variable it does
  not load — a dev mod loads only in the session that made it. Its panes and toasts have no surface in an SDK session. The
  real graphify built the scratch graph in 0.5–0.8 s ("Rebuilt: 9 nodes, 10 edges, 3 communities"), `behind` 0.
- Security: reads only — the report, the git state, the plugin manifests and settings.json's `env`; nothing leaves the
  machine. A build is the user's click, writes only graphify's own `graphify-out/`, and only where git ignores it (it can never
  enter a review); the review gate, the git guard and the budget are unchanged.
- Compatibility: an older engine refuses `code_graph` / `code_graph_build` `unknown_command` (the tab says to update
  ReviewGate) and sends no `mods` (no section). An older client never sends them and ignores `mods`.
- Not in this pass: a drawn node map (the report has no layout; graph.html has the whole graph), graphify's queries (`query` /
  `path` / `explain`), a build in a worktree other than the project's, `--force` for a rebuild with fewer nodes, a one-click
  `graphify-out/` exclude.
- Owner: w5-graph (engine `board/codeGraph.ts`, `board/mods.ts`, `engine.ts`; Mac `CodeGraph.swift`, `CodeGraphBoardView.swift`,
  `ModsSection.swift`; Electron `codeGraph.ts`, `components/board/CodeGraphBoard.tsx`, `components/extensions/Mods.tsx`,
  `main/graphOpen.ts`). Tests: `engine/test/{board.codeGraph,board.mods,engine.board}.test.ts`,
  `Core/Tests/ReviewGateCoreTests/CodeGraphTests.swift`, `clients/desktop/src/renderer/codeGraph.test.ts`,
  `clients/desktop/src/renderer/components/board/CodeGraphBoard.test.ts`, `clients/desktop/src/main/graphOpen.test.ts`; the
  real CLI: `sidecar/test/driver-board.mjs`.

### 43.4 Auto model

ReviewGate picks the model of each message when the user asks it to — opus for design, debugging and big changes, haiku
for tiny fixes, sonnet for the rest, the OMC "model routing" this user knows — and always says which and why; a message
can still name its own model (one lane through the engine and both clients). Additive on the wire: two settings, one
command field, optional fields; nothing an existing client relies on changes meaning. Types: the `MARK: wave5 w5-model`
blocks of `engine/src/protocol.ts`; engine `session/autoModel.ts` (the decision, pure) and `engine.ts chooseTurnModel`.

```ts
// settings: modelMode?: "manual" | "auto"  (default / unknown: manual);  modelAutoPolicy?: "cost" | "balanced" | "quality"  (default / unknown: balanced)
// commands: send + model?: string   (this message only; `set_model.model` rules, refused `invalid_model` before anything)
// state:    session.autoModel?: AutoModelChoice | null;  hud.autoModelCounts?: AutoModelCount[]
// events:   user_message.autoModel?;  turn_end.autoModel?;  turn_summary.autoModel?   (rows keep them: user_message / turn_end / turn_summary)
type AutoModelChoice = { model: string | null; family?: "opus" | "sonnet" | "haiku"; reason: AutoModelReason; policy: AutoModelPolicy;
                         by: "auto" | "user" | "manual"; switched?: true; from?: string | null };
type AutoModelCount = { family: string; count: number };
```

- **When.** Right before a message goes out — `send` (after snapshot A, the gate closed), `request_changes`, a plan's
  follow-up — never during a turn: the session's model is set with `Query.setModel` between turns only (a slash command
  and a peer turn are left alone; a starting CLI keeps its start model). The engine keeps the value each live session was
  last set to (its start options, `set_model`, a turn's pick) and calls `setModel` only when it differs; a failing call is
  logged and the message goes out on the model the session has (no choice recorded). Checked against the real CLI
  (`sidecar/test/driver-automodel.mjs`, haiku → sonnet → haiku in one chat): each answer came from the model picked
  (`usage.models`, `session.model`) and the chat remembered its code word across both switches.
- **Which** (`decideAutoModel`, tested with 60+ Korean and English requests). Reasons for opus, the strongest named
  first: `plan_implementation` (the first message after a plan was approved, §42.1), `plan_mode`, a retry —
  `after_failure` (the last turn stopped with an `error…`), `after_revert` (a reject, a hunk reject or a rewind since),
  `changes_requested` — then the words: `design` (설계, 아키텍처, 트레이드오프, design, trade-offs), `debug` (원인, 디버깅,
  NPE, 안 돼, failing, exception), `refactor`, `why` (왜, why), `wide_scope` (프로젝트 전체, 여러 파일, 마이그레이션, every
  file), `long_message` (> 1 000 chars), `attachments` (3+ images or 5+ attachments). Policies: `balanced` and `quality`
  take opus on one reason, `cost` on two (a plan counts two). haiku only for simple requests — `trivial_edit` (오타, 이름
  바꾸기, 포맷, import 정리, typo, rename) or `quick_question` (a one-line question without a build verb): `balanced` when
  very short (≤ 60 chars), `cost` up to 200 chars and any one-line request ≤ 40 chars without a build verb
  (`short_message`); `quality` never (`simple_task` → sonnet) and sends everything else to opus (`quality_policy`). A
  bare "계속" / "진행해" / "go on" keeps the previous turn's family (`continuation`). Otherwise sonnet (`standard`;
  `cost_policy` when cost left a reason for opus on sonnet).
- **To a model.** The family maps to the newest option the session offers (`availableModels`: an alias the CLI did not
  resolve counts as the newest; a plain context window before a `[1m]` variant; never `default`); a family it does not
  offer falls back to sonnet, without sonnet nothing is switched.
- **This message's own model** (`send.model`, by `user`, reason `user_choice`) wins over auto, in either mode. In manual
  mode the next message goes back to the chip's model (`set_model` / `settings.model`; by `manual`, reason `manual`); in
  plain manual mode nothing is touched and no field is sent. Auto does not change the project's `set_model` choice:
  turning auto off returns to it.
- **What the user sees** (Mac and Electron the same; words in Core `AutoModelText` / `renderer/autoModel.ts`, one
  catalog): the model chip's menu starts with "자동" (메시지를 보내기 전에 opus·sonnet·haiku 중에서 골라요) and, when on,
  비용 우선 / 균형 / 품질 우선 with a line each; picking a model turns auto off. In auto the chip reads "자동 · sonnet" (the
  last pick; "자동" before one), its hover "자동이 opus 를 골랐어요 — 설계 판단 (균형)". Every switch leaves a faint line
  under the message: "모델을 opus 로 바꿨어요 — 설계 판단" (rows keep it after a restart); the turn summary says "모델:
  opus (자동 · 설계 판단)"; the HUD's cost popover adds "이 세션에서 자동이 고른 모델 — opus 3 · sonnet 5 · haiku 2"
  (`hud.autoModelCounts`, auto picks only, reset with the HUD). The composer has a small model menu before Send: "이번엔
  opus" goes with the next message only (queued, stop-and-send and plain sends alike) and clears once it went out.
- **Settings.** Both are app settings (every window): the Mac stores them in UserDefaults (`modelMode`,
  `modelAutoPolicy`) and sends them with `hello` and `set_settings` to every open window's engine; Electron keeps them in
  its settings file (checked renderer-writable keys) and main sends them to every engine. Both apply from the next message.
- **Compatibility.** An older engine ignores both settings and `send.model` and sends none of the fields: the chip shows
  "자동" with no pick, no lines, no counts — every message runs on the chip's model as before. An older client ignores the
  fields; its chip shows the model the CLI reports after a switch.
- Security and cost: auto is off by default; a switch never happens during a turn and is always shown; the review gate,
  the git guard and the budget apply to every message whatever its model; nothing is sent anywhere but the CLI.
- Not in this pass: the palette's `/model` and `/effort` opening the app's menus (they still go to the CLI), a per-model
  context-window check before switching down from a 1M model, learning from the user's own picks, an Electron
  offscreen render of the new controls.
- Owner: w5-model (engine `session/autoModel.ts`, `engine.ts`, `protocol.ts`, `state.ts`; Core `AutoModelProtocol.swift`,
  `AutoModel.swift`; Mac `AutoModelViews.swift`, `SessionControls.swift`; Electron `renderer/autoModel.ts`,
  `components/chat/AutoModelBits.tsx`). Tests: `engine/test/{session,engine}.autoModel.test.ts`,
  `Core/Tests/ReviewGateCoreTests/AutoModelTests.swift`, `clients/desktop/src/renderer/autoModel.test.ts`,
  `clients/desktop/src/main/autoModelSettings.test.ts`; real CLI `sidecar/test/driver-automodel.mjs`.

### 43.5 0.3.0 follow-ups

What 0.3.0 left and a CLI that updated overnight (one lane through the engine and both clients). No wire change: no new
command, event or field — `plan_follow` and `state.session.planSource` (§42.1) and the side question anchors (§21, §40.3)
are reused; the engine's permission sets and its verified CLI range move.

- **Claude's to-do list asks nothing.** CLI 2.1.310 gives Claude `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`
  (with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` or a 4.x model; the app does not set the variable). They only keep Claude's list,
  like `TodoWrite`: `READ_ONLY_TOOLS` (`session/hooks.ts`) and the permission rules' non-mutating / already-allowed sets
  (`session/permissionRules.ts`) take them — no card, allowed between turns (the unprompted guard), never a writer of the
  live view (§34.6); a user's allow rule for one is "applied". `TaskStop` (stops a background task) and `Task` / `Agent`
  (start a subagent) still ask. Verified with CLI 2.1.310 (haiku, `-p` in default mode without a permission tool, where a
  tool that asks is denied): the four ran without a denial.
- **CLI 2.1.310 is verified.** Every real-CLI driver (crash, hookblock, peer, perms, gate, review2, why, agents, session,
  flow, follow) passed on it with haiku, so `VERIFIED_CLI_RANGE` is `{min: "2.1.301", max: "2.1.310"}` (§36.8). The drivers
  now keep the app-wide records in their scratch folder (`REVIEWGATE_DATA_DIR`, as driver-session did): they inherited the
  shell's environment, wrote the user's `~/.reviewgate/cli-versions.json`, and driver-crash then failed on the "CLI changed"
  notice that record produced. driver-flow's main `/code-review low` once ended with no ReportFindings call (haiku answered
  in text; the CLI itself reported through it when probed) and passed when run again.
- **The basis of "plan vs actual"** (§42.1's chooser). The newest turn summary of the live chat (not another chat shown
  read-only) has a menu "기준: 자동 · db-migration.md" in its plan section: [자동으로 고르기], then `planSource.candidates`
  ("name · folder", the home folder as `~`; a chosen file that is no candidate comes first), the followed one checked, and a
  note — "다음 턴 요약부터 이 기준과 비교해요", or without files where they come from. Choosing sends `plan_follow {path}`
  (`null` for automatic), only for another basis; `invalid_plan_file` reads "그 계획 파일을 더는 읽을 수 없어요 — 다른 파일을
  골라 주세요". While a plan approved in ReviewGate decides (`kind: "approved"`), the items are off with "이 채팅은 ReviewGate
  에서 승인한 계획을 따라요". A summary without a plan section shows a line "계획 대비 · 이 턴에는 비교할 계획이 없었어요" with the
  menu. An engine without `planSource` shows no menu. Rules: Core `PlanBasis`, Electron `planBasis.ts` (same words);
  Electron selects the plan source as text, so a snapshot with the same source does not redraw the card (§42.6).
- **'왜?' on plan steps and agent cards.** A side question about a plan step quotes it (`quote: {text: "3. <step>", turn:
  null}`, §40.3): from each step of a proposed plan's sheet / dialog (it closes first; the notes stay on the card) and of
  "plan vs actual" (the live chat's summaries). One about an agent anchors at its Agent call (`toolUseId`: the call and
  Claude's words before it, §21): the agent card's menu "왜 시작했는지 묻기 (곁질문)" (the Mac's is off with its reason when
  the engine has no side questions). The question names the step itself — "계획의 3단계 「…」 — 이 단계는 왜 필요하고, 지금까지
  어떤 변경이 이 단계에 해당해?" — so an engine that ignores the anchor still knows what is asked. Core `WhyQuestions`,
  Electron `whyQuestions.ts`. The Mac summary numbers its steps from 1 (it showed the 0-based wire index).
- **Words.** The three keys the App and Core catalogs translated differently ("Thinking…", "That branch is already checked
  out in %@", "Working tree has uncommitted changes") read one way in both apps, in 해요; the unused "Side questions may
  search and fetch the web" goes (the old `{issue} = the last number in …` help had gone in 0.3.0).
- Security: nothing here lets a change skip the review. The to-do list tools write no file (stopping a task and starting
  an agent still ask); `plan_follow` only reads a plan file; a side question stays read-only (§21).
- Not in this pass: Windows Ctrl+Alt+F in the side-by-side and full-file views and an Electron Review menu (§42.5's
  leftovers); before / after image previews in the review history tab and the PR diff (§41.3); ko.extra.json's ~300
  "~습니다 / 합니다" lines in 해요 (88 assertions in 26 Electron test files read them today); offscreen PNGs of the new
  controls; a file picker for a plan file that is no candidate.
- Owner: w5-fixes (engine `session/hooks.ts`, `session/permissionRules.ts`, `session/cliVersion.ts`, `sidecar/test/driver-*.mjs`;
  Core `PlanBasis.swift`, `WhyQuestions.swift`; Mac `PlanBasisMenu.swift`, `TurnSummaryCard.swift`, `PlanReviewSheet.swift`,
  `PlanCard.swift`, `AgentGlanceViews.swift`, `ChatView.swift`; Electron `planBasis.ts`, `whyQuestions.ts`, `PlanBasisMenu.tsx`,
  `TurnSummaryCard.tsx`, `PlanReviewDialog.tsx`, `AgentBits.tsx`, `errorCodes.ts`). Tests: `engine/test/session.taskTools.test.ts`,
  `engine/test/{session,engine}.cliVersion.test.ts`, `Core/Tests/ReviewGateCoreTests/{PlanBasis,WhyQuestions}Tests.swift`,
  `clients/desktop/src/renderer/{planBasis,whyQuestions}.test.ts`, `clients/desktop/src/renderer/components/chat/PlanBasisMenu.test.ts`.

## 44. Wave 6: the terminal feel

What the user has in Claude Code's terminal — its keys, its modes, their own status line — in both apps, the same way.

### 44.1 Modes like the terminal: auto that stays auto, plan mode Claude enters, ⇧⇥

The user's session (mode chip 자동): "우선 플랜 모드로 한번 계획 세워볼까?" — Claude called EnterPlanMode and got a card; once it
was allowed the CLI ran in plan mode (hook input `permission_mode: "plan"`) while the engine still said `auto`, so §39.5 no
longer applied and the next WebFetch got a card too ("자동이라면서 또 계속 물어보네?"); the plan file write would have asked as
an edit outside the project and the plan card never came (`proposePlan` wants plan mode). The user also wanted the
terminal's Shift+Tab. One lane took it through the engine and both clients. Additive on the wire: one state field, one
changed default.

```ts
// state:    session.prePlanMode?: PermissionMode | null   // while permissionMode is "plan": the mode before it; else null
// commands: plan_response {approve: true} without `mode` → "auto" when prePlanMode is "auto", else "default" (was: "default")
```

- **EnterPlanMode needs no card in auto mode.** It only restricts Claude. `AUTO_MODE_KEEPS_CARD` is now `SendMessage`,
  `AskUserQuestion` and `ExitPlanMode` (the engine still turns ExitPlanMode into the plan card, §11); in auto mode the hooks
  leave EnterPlanMode to the CLI, which allows it there itself (CLI 2.1.310 `checkPermissions`: it asks only outside auto
  and plan mode). In the other modes, and in auto mode the CLI could not start, it keeps its card.
- **The engine follows the CLI into plan mode.** Three signals, whichever comes first: `system/status {status: null,
  permissionMode}` (CLI 2.1.310 sends one for every mode change), a turn's `system/init.permissionMode`, and every main-thread
  PreToolUse hook input's `permission_mode` (read before the call is decided, so the first call after EnterPlanMode already
  gets the plan rules; a subagent's input — it carries `agent_id` — is its own mode). Only the way **into** plan mode is
  followed: leaving it stays the user's (plan approval, the mode menu) — an engine that kept plan mode where the CLI left it
  only denies more — and `auto` ↔ `default` stays §39.5's fallback (the notice, the user's mode). And only while a turn of
  ours runs: Claude can call EnterPlanMode only then (outside one the unprompted-turn guard, §18, denies it) and the engine
  switches into plan mode only between turns (a switch during a turn is among default / acceptEdits / auto, §39.5), so a
  report of the engine's own switch (`set_permission_mode`, plan approval) — even a late one — is never taken for Claude's; a conversation resumed in plan mode says so at the next turn's init. From then on everything of §11 /
  §19.4 holds: no edits but the plan file under `~/.claude/plans/` (allowed, kept out of the review and the budget),
  read-only commands only, ExitPlanMode → `plan_proposed` → the card; `state.session.permissionMode` is `"plan"` (the chip
  and the mode line say 계획) and `prePlanMode` the mode before. A turn's init in plan mode no longer raises
  `auto_mode_unavailable`.
- **Plan mode entered from auto keeps auto's judgment for what cannot change anything.** While `permissionMode` is `plan`
  and `prePlanMode` is `auto` (Claude's EnterPlanMode or the user's pick), the hooks leave to the CLI the calls §33.5 calls
  non-mutating — WebFetch, WebSearch, Agent / Task, the MCP resource readers, CronList, the to-do list tools, an MCP tool
  that only reads (its annotations, else a read verb in its name) — plus a read-only command (the plan rules denied every
  other first) and EnterPlanMode. The CLI judges them in plan mode with its classifier where auto mode runs
  (`useAutoModeDuringPlan`, default on: "In plan mode, an automatic check may approve read-only actions"); where it does
  not, it asks and the card comes through `can_use_tool` as before. A writing MCP call, PowerShell, TaskStop, CronCreate,
  SendMessage, AskUserQuestion and any other tool keep the card; plan mode from `default` / `acceptEdits` keeps every card.
  Unchanged in every case, because they are decided first: edits denied in plan mode (`PLAN_MODE_EDIT_REASON`), commands
  that clearly write denied (`PLAN_MODE_BASH_REASON`, §19.4; M19: any other command reaches the classifier there), the git guard, `.git/` writes, Claude Code's own settings files (§33.9), the
  worktree / isolation rules (§33.4), the budget and the unprompted-turn guard (§18). What the classifier blocks there is
  the `auto_mode_denied` row naming the call, as in auto mode. Engine `session/autoMode.ts` `autoModeDecides(…, prePlanMode, hints)`.
- **`prePlanMode`.** Set by `set_permission_mode {mode: "plan"}` (the mode it left) and by Claude's entry; `null` outside
  plan mode, and for a plan mode restored from the project's stored mode (the mode before is not stored). Always sent by
  this engine.
- **Approving goes back to auto.** `plan_response {approve: true}` without `mode` switches to `auto` when `prePlanMode` is
  `auto`, else to `default` as before — the same default for `into: "new_chat"` / `"workbench"`. Both clients send the
  mode themselves: "승인하고 실행" becomes "승인하고 자동 모드로 실행" (help "계획 모드를 나와 자동 모드로 돌아가고, …") and the
  new chat / new workbench answers use the same mode and say so ("새 채팅에서 구현 (자동 모드)", "새 워크벤치에서 구현… (자동
  모드)" — that chat or worktree starts in it); "승인 후 편집 바로 허용" still switches to `acceptEdits`. When the CLI refuses
  that switch back to auto (`auto_mode_unavailable`: another model, a policy) the engine runs the plan in the `default`
  mode instead — `plan_approved {mode: "default"}` and the usual `auto_mode_unavailable` notice (§39.5, detail `default`),
  never a refusal the card would loop on. Once the engine said auto mode cannot run here — that notice, or any refusal with
  the code — the clients approve into `default` themselves and the mode line drops "승인하면 자동 모드로 돌아가요". A follow-up
  that does not go out puts `prePlanMode` back with the mode (§19.5).
- **Claude's own plan mode is not the project's mode.** It was Claude's choice for one conversation: storing it would
  reopen the project in a mode the user never picked (and on the Mac, as the last mode used anywhere, start every new
  project in it). So `reviewgate-session.json` keeps the user's mode (`prePlanMode`) while it lasts, a chat moved to another
  worktree (§39.4) carries the user's mode, and a new chat (`session_new`, `session_open`) starts in it; a chat restarted in
  place (`restart_session`, the automatic restart) stays in plan mode with its `prePlanMode` (the conversation is still
  planning; `SessionSettings.prePlanMode`). The user's own pick of plan mode is stored as before (§11: a project parked in
  plan mode reopens in it). The Mac no longer mirrors plan mode into its per-project store (a pick of it stored itself).
- **⇧⇥ / Shift+Tab** in the message box cycles the mode as the terminal does: 기본 → 편집 바로 허용 → 계획 → 자동 → 기본, through
  `set_permission_mode` (plan mode included, as the mode menu). Auto is skipped once the engine said it cannot run here —
  the `auto_mode_unavailable` notice or refusal — until another project, another model (`selectedModel`) or auto taken after
  all; while Claude works a pick goes out at once unless plan mode is involved (§39.5) — that one waits for the turn's end
  and the next ⇧⇥ goes on from it (기본 → 편집 바로 허용 now → 계획 waiting → 자동 now) —, and a ⇧⇥ pressed again
  before the engine's state came back goes on from the mode on its way (Mac: shown at once; Electron
  `requestedPermissionMode`), so the same mode is never sent twice. Only the message box
  takes the key: everywhere else Shift+Tab still moves the focus back (Mac `ComposerKey.backtab` from `insertBacktab:`,
  Electron `isModeCycleKey` on the textarea; an input method composing keeps it).
- **The mode line.** Under the message box, one line in the terminal's words, updated with every state: "⏵⏵ 자동 모드
  (shift+tab 전환)", "⏵⏵ 편집 바로 허용 모드 (shift+tab 전환)", "⏸ 계획 모드 (shift+tab 전환)", "⏸ 계획 모드 — 승인하면 자동 모드로
  돌아가요 (shift+tab 전환)" (plan mode from auto), "기본 모드 (shift+tab 전환)"; a pick waiting for the turn adds "· 다음 턴부터:
  계획"; auto mode the engine said cannot run here reads "자동 모드를 쓸 수 없어 기본 모드로 동작해요 (shift+tab 전환)" (gray —
  the CLI runs the default mode and asks). Auto and accept edits in orange, plan in the accent colour, default gray. The
  app keeps its own name for plan mode (계획) everywhere.
- **Esc** in the message box, after the mention / slash palettes and the prompt history had theirs, stops a running turn as
  the terminal does (⌘. / Ctrl+. as before; never from another chat shown read-only, §39.2): with a recalled prompt on
  screen the first Esc brings the typed draft back and the next one stops.
- **↑ / ↓** recall prompts with a draft typed too (before: only from an empty box), and that draft is never lost: it waits
  until ↓ past the newest prompt or Esc brings it back, or a prompt is sent; what is typed into a recalled prompt is kept
  for the walk (as a shell keeps an edited history line; Esc drops those edits); a chat switch, a reload (Electron) and a
  text inserted into the box (an agent's report, PR comments) keep the draft typed before ↑, not the recalled prompt on
  screen. Where the walk starts: Mac — the caret on the first / last visual line (inside a recalled multi-line or wrapped
  prompt the caret moves first); Electron — an empty box, else ↑ only at the very start and ↓ only at the very end (the
  first press moves the caret there), so a long soft-wrapped paragraph keeps its arrows; after ↑ the caret sits at the
  start, so ↑ walks on. Core `PromptHistoryNavigator`, Electron `promptHistory.ts`. There is no `!` shell mode.
- Verified by reading CLI 2.1.310 (the user's): `system/status` carries `permissionMode` on every change
  (`onPermissionModeChanged`, EnterPlanMode's included), EnterPlanMode's `checkPermissions` allows it in auto mode, plan mode
  keeps `prePlanMode` and runs the classifier when auto mode is available, ExitPlanMode would return to `prePlanMode` (the
  engine denies it and approves in its place). Run against CLI 2.1.310 without a model call (scratch `CLAUDE_CONFIG_DIR`,
  no setting sources): `setPermissionMode("plan")` / `("default")` each came back as `system/status {status: null,
  permissionMode}`. A live EnterPlanMode turn was not run in this pass.
- Compatibility: an older engine sends no `prePlanMode` and does not follow the CLI (the clients approve into `default`, the
  line shows plain plan mode); an older client ignores `prePlanMode`, and a client that sends `plan_response` without `mode`
  gets auto back for a plan made in an auto chat. Keys: `docs/SHORTCUTS.md` and both tables (§42.5).
- Owner: w6-terminal (engine `session/autoMode.ts`, `session/hooks.ts` `noteCliMode` / `askOrAllow`, `session/claude.ts`
  `followCliMode`, `engine.ts` `userMode` / `planReturnMode`; Core `TerminalMode.swift`, `TerminalModeProtocol.swift`,
  `ComposerSupport.swift` `PromptHistoryNavigator`; Mac `ComposerTextView.swift`, `ComposerModeLineView.swift`, `ChatView.swift`,
  `PlanCard.swift`, `PlanReviewSheet.swift`; Electron `terminalMode.ts`, `storeAutoMode.ts`, `promptHistory.ts`, `Composer.tsx`,
  `ModeMenu.tsx`, `PlanCard.tsx`, `PlanReviewDialog.tsx`). Tests: `engine/test/autoMode.test.ts`, `engine/test/w6.terminal.test.ts`,
  `Core/Tests/ReviewGateCoreTests/{TerminalMode,DailyUX,ShortcutTable}Tests.swift`,
  `clients/desktop/src/renderer/{terminalMode,ux,shortcutTable}.test.ts`.

### 44.2 The user's status line

The user's own Claude Code status line — their `statusLine` command, e.g. the OMC HUD — runs as the CLI runs it and both
apps draw its lines under the composer, colored as in the terminal. The app's own HUD (§13, §38.2) stays; this line is
the user's. Additive: one command, one event (its reply too), two settings; an older engine or client loses nothing.

```ts
// commands: status_line { columns?, visible? } → status_line;  events: status_line (no id) whenever what it shows changes  // §44.2
// settings: showStatusLine? (default true);  allowedProjectStatusLine? (sha256 hex; per project, default "" = none)          // §44.2
```

- **Which `statusLine` runs** (engine `statusline/settings.ts`, re-read before every run, so an edited settings file
  applies at once as in the CLI). Claude Code merges `statusLine` from user (`<config>/settings.json`, `<config>` =
  `CLAUDE_CONFIG_DIR` or `~/.claude`) < project (`.claude/settings.json`) < local (`.claude/settings.local.json`; not read
  while the project's local settings are off, §36.6) < managed — field by field, as it merges objects — and runs it only
  once the workspace is trusted. Every file is read only as a regular file of at most 1 MB, opened non-blocking and
  checked through its own descriptor (a repository's `settings.json` linked to `/dev/zero` or a FIFO is skipped, never
  read; the §16 hook reader alike). Taken from the merged object: `type` (`command` or absent), `command`, `padding`
  (blank columns each side, 0–20), `refreshInterval` (seconds, 1 s – 1 day), and the hook fields the CLI reads for every
  command, `timeout` (seconds, ≤ 10 minutes) and `shell` (`powershell`). A client sending its whole settings again
  changes nothing; only a switch that changed applies.
  - **The managed tier** (engine `statusline/managed.ts`) is read from every source the CLI 2.1.310 reads: server-managed
    `<config>/remote-settings.json` (keys starting with `$` dropped but `$schema`); MDM — macOS
    `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`, then the device's
    `/Library/Managed Preferences/com.anthropic.claudecode.plist` (the first with content; through `plutil -convert json`),
    Windows `HKLM\SOFTWARE\Policies\ClaudeCode` value `Settings` (JSON, `REG_SZ` / `REG_EXPAND_SZ`); the managed folder's
    `managed-settings.json` then `managed-settings.d/*.json` (sorted, no dotfiles) merged over it (macOS
    `/Library/Application Support/ClaudeCode`, Windows `C:\Program Files\ClaudeCode`, else `/etc/claude-code`); and
    Windows `HKCU\SOFTWARE\Policies\ClaudeCode` only when none of those is present. `managedSourcesBehavior` (from the
    highest source that sets it): `first-wins` (default) — the highest present source alone; `merge` — all deep-merged,
    the highest on top, a restrictive switch (`disable*`, `allowManaged*Only`) on when any source turns it on. Cached by
    mtime and size (the registry for a minute), read at the CLI's limits (8 MB server-managed, 2 MB the others). **Fail
    closed:** a source that exists but cannot be read or parsed runs nothing (`disabled: "managed_policy"`) until it is
    fixed.
  - **The rules** (the CLI's `Ph` / `Nft`): managed `disableAllHooks: true` runs nothing (`disabled:
    "disable_all_hooks"`); managed `allowManagedHooksOnly: true` — or the merged `disableAllHooks: true` of the other
    layers (user < project < local < ReviewGate's `disableUserHooks`, §16, which is that flag in the CLI's flag layer <
    managed; the last one set wins) — leaves only the managed `statusLine` (nothing else: `disabled:
    "disable_all_hooks"` for the flag, `"managed_policy"` when the policy hides the user's or the project's).
  - **A project's own** `statusLine` (local over project) is code that came with the repository: it is merged in only
    while its command hashes (sha256 of the command as written) to `settings.allowedProjectStatusLine`, which the clients
    keep per project and send with the project's settings before every `open_project` / `switch_project` (as
    `loadLocalSettings`), so a pull that changes the command no longer matches and is asked about again. It is always told:
    `project {path, command, sha256, allowed}`.
- **stdin** (engine `statusline/input.ts`; the shape read from the CLI 2.1.310 binary, the same in the SDK's 2.1.270):
  `session_id` (the chat), `transcript_path` (the CLI's own record, `<config>/projects/<key of the real cwd>/<id>.jsonl`,
  §30 — the OMC HUD counts tools and agents from it), `cwd`, `effort {level}` (the chat's effort, else `high`, the CLI's
  default; left out for a model without effort), `session_name` (the `--name` the session started with, §42.2), `model {id,
  display_name}` (the live / chosen model resolved, else the last main answer's, else the CLI's; "Opus 5.5", "Sonnet 4.5
  (1M context)"), `workspace {current_dir, project_dir, added_dirs: [], git_worktree?, repo? {host, owner, name}}` (the
  linked worktree's name; the origin remote), `version` (the CLI's), `output_style {name}` (the merged `outputStyle`, else
  `default`), `cost {total_cost_usd (this chat since the engine opened it, as the HUD's cost), total_duration_ms (since the
  CLI process started), total_api_duration_ms (its results' `duration_api_ms`), total_lines_added / total_lines_removed
  (what the collected turns changed)}`, `context_window {total_input_tokens, total_output_tokens, context_window_size,
  current_usage, used_percentage, remaining_percentage}` (the last main-agent answer's usage — a resumed chat's from the
  end of its CLI transcript until the session answers itself; percentages null before an answer), `exceeds_200k_tokens`,
  `fast_mode: false`, `thinking {enabled: true}`, `rate_limits {five_hour?, seven_day? {used_percentage, resets_at}}`
  (§38.2's windows whose reset is ahead, seconds since the epoch; `used_percentage` the CLI's — the window's utilization
  with one decimal, at most 100, `Math.round(u × 1000) / 10`; a window without one its whole percent; absent before the CLI
  reported one). Not sent, as the CLI leaves out what does not apply: `vim`, `agent`, `remote`, `worktree`,
  `prompt_cache`, `pr`, `scratchpad_dir`, `prompt_id`; no `hook_event_name` (2.1.310 sends none).
- **Running** (engine `statusline/runner.ts`). As the CLI: `/bin/sh -c <command>` (Windows: Git Bash `-c` — found as the
  CLI finds it: `CLAUDE_CODE_GIT_BASH_PATH`, Program Files, next to `git` — else PowerShell; `shell: "powershell"`:
  `pwsh` / `powershell.exe -NoProfile -NonInteractive -Command`), in the session's folder, the JSON on stdin, the engine's
  environment with the login shell's `PATH` (Windows: one `PATH`, Git Bash's folder in front), `CLAUDE_PROJECT_DIR`,
  `COLUMNS` = the client's width (the CLI's is the terminal's) and, when the app has none (a GUI app starts without them),
  the terminal's `TERM=xterm-256color` / `COLORTERM=truecolor`. It runs 300 ms after the last change it shows (at most 2 s
  later in a steady stream): a session start, every main-agent answer (a top-level tool call), a turn's end, a usage
  window, the models, and the commands that change any of it (`send`, `set_model`, `set_permission_mode`,
  `plan_response`, `rewind`, `compact`, chat and project switches); periodically only with `refreshInterval` (the CLI's
  rule — no default refresh); once more a second after the earliest usage window of its stdin resets (the CLI's; timers
  capped at 2^31 − 1 ms). Without a command it re-reads the settings every 15 s while on screen (nothing runs), so a
  `statusLine` added later shows. One run at a time — a change during a run runs it once more afterwards; stopped with
  its whole process tree after `timeout` (default 10 s; the tree first, then the shell); a shell whose left-behind process
  keeps the pipes open ends 2 s after its exit with what it printed, and that process goes (POSIX: the shell's own
  detached process group; Windows: what is left of the tree). Only while a client asked (`status_line`), the line is on
  screen (`visible`), the setting is on, something is configured and a chat is open. The output is taken as the CLI takes
  it: CRs dropped, trimmed, split into lines (≤ 20 of ≤ 2000 UTF-16 units, never cut inside a surrogate pair; stdout read
  up to 64 KB). A run that fails (`exit` non-zero, `timeout`, `spawn`) keeps the last good lines and sets `error {code,
  message (its stderr's first line), at, exitCode?}`; it is logged once (naming the settings file, never the command)
  until a run succeeds again (where the CLI blanks the line). A project switch or close takes the lines away at once and
  stops a run of the last project; a switch that changes what runs (a project's command allowed or revoked, the hooks
  off) takes the other command's lines away and stops its run; output printed for a folder that is no longer open, or by
  a command that no longer resolves, never lands.
- **The event** `status_line {id?, lines, updatedAt, enabled, configured, source?, path?, command?, padding?, error?,
  project? {path, command, sha256, allowed}, disabled? ("disable_all_hooks" | "managed_policy")}`: the reply to
  `status_line` (what it shows now; the run follows) and sent without an id whenever any of it changes (a repeat of the
  same failure, or the same lines again, sends nothing). `lines` keep the ANSI escapes and OSC 8 links: drawing them is
  the clients'. Every string reaches the clients well formed: the sidecar writes each NDJSON line with lone surrogate
  halves as U+FFFD (Swift's `JSONDecoder` refuses a whole line for one), and the Mac logs a line it cannot decode by its
  `type`, size and where decoding stopped — never its content.
- **Both clients.** The line sits under the composer's buttons, above the engine log (Mac `StatusLineView` in
  `ChatView`'s composer; Electron `<StatusLine/>` between `<Composer/>` and `<SidecarLog/>` in `ChatPane`) — under the
  input, as in the terminal. Monospaced (11 / 11.5 pt), one row per line, never wrapped: a line wider than the columns is
  cut with an unstyled "…" (Ink's `wrap="truncate"`), padded by `padding` columns. Drawn by one rule set, Core
  `AnsiText` / Electron `renderer/ansi.ts`, held to `engine/test/fixtures/ansiVectors.json`: SGR 0 / 1 / 2 / 3 / 4 (and
  `4:n`, 21) / 7 / 8 / 9 and their offs (22–29), 30–37 / 90–97 / 40–47 / 100–107, 38 / 48 with `5;n` or `2;r;g;b` (and the
  colon forms), 39 / 49; OSC 8 links (BEL or ST; SGR 0 does not end one); every other CSI, OSC, DCS / SOS / PM / APC and
  two-byte escape and the C0 / C1 controls dropped (an unterminated one with the rest of its line); a tab to the next
  multiple of 8 columns; styles carried from line to line (the CLI prefixes every line with the escapes of the lines above
  it); columns per grapheme (East Asian wide / fullwidth and emoji presentation 2, marks 0). The 16 colors are VS Code's
  terminal palette per appearance, 16–255 the xterm cube and grays; plain text is the CLI's dim default (the secondary
  text color), dim is 55 %. A link opens in the browser when it is http(s) only (a `file://` or custom scheme stays text).
  The width goes to the engine in columns — the line's width (the composer's, `padding` included) over the font's "0"
  (≥ 20) — 250 ms after it settles, with `visible`: Mac the chat on screen in a visible window (`occlusionState`: not
  minimized, covered, on another Space or hidden); Electron the chat mounted and the window not hidden. A chat without
  lines keeps its layout (Mac: the width is measured behind the composer's buttons; Electron: a zero-height box). A
  failed run's tooltip: "상태줄 명령이 실패했어요: <why>. 마지막 출력을 보여 주고 있어요." Settings › General › "Claude Code
  상태줄": [Claude Code 상태줄 표시] (on; nothing shows without a `statusLine`; every window at once), the command in use (or
  why nothing runs — the hooks off, or "조직의 관리 설정으로 꺼져 있어요…"), "마지막 실행이 실패했어요: <why>" after a
  failure, and — when the window's project has its own — [이 프로젝트의 상태줄 실행] (off) with that command: on stores its
  sha256 for this project (Mac `projectStatusLineAllowed` `[projectKey: sha256]`; Electron
  `settings.projectStatusLineAllowed` `{projectRootHash: sha256}`); a changed command shows it off with "허용한 뒤 명령이
  바뀌었어요. 확인한 뒤 다시 켜 주세요."
- **Compatibility.** An older engine refuses `status_line` `unknown_command`: the clients stop asking and show nothing.
  An older client never sends it, so the engine never runs the command (it runs only for a client that asked). An older
  engine ignores `allowedProjectStatusLine` (no project's own runs); the earlier `allowProjectStatusLine` is gone.
- **Security.** The command is the user's own (or their organization's, whose managed settings are obeyed from every
  source and fail closed); a repository's runs only after the user allowed that very command for that project. Its stdin
  holds what the terminal's would and goes to that command only; the lines go to the screen only. Whatever the command
  writes in the worktree is the user's process like any other — a turn's review shows it as an external change (the OMC
  HUD writes only under `.omc/`, which git ignores here). Links open only as http(s), in the browser.
- **Verified.** The stdin builder, the runner's scheduling (`Nit`: a refresh only with `refreshInterval`; the reset run
  `resets_at × 1000 + 1000`), the managed sources and their order, `used_percentage` read from the CLI 2.1.310 binary
  (`statusLine` builder, `XMr` runner: shell, trust gate, `stdout.trim().split("\n")`). A sample command that calls
  another script (`~/bin/statusline.sh`) ran through the engine's runner with a synthetic chat and printed, well under a
  second, the same lines as in the terminal (`main · Opus · $0.12`).
- **Not in this pass.** `pr` (the engine does not track the branch's PR), `prompt_cache`, `added_dirs` beyond [], a
  client-side picker for the command; the Mac draws an OSC 8 link in the accent color (SwiftUI's link tint), Electron in
  the line's own color; a run the engine started outlives an engine that died (no timeout without it, as for §43.3's
  build); the registry is read with a synchronous `reg.exe` (at most once a minute per key); on Windows a process that
  left the tree after the shell exited survives the grace; the Windows shells and managed sources were exercised by tests
  and CI only.
- Owner: w6-statusline (engine `statusline/{settings,managed,input,runner}.ts`, `util/safeRead.ts`, `engine.ts`,
  `session/claude.ts`; sidecar `io.ts`; Core `Engine/StatusLineProtocol.swift`, `StatusLine/AnsiText.swift`,
  `Session/StatusLine.swift`; Mac `StatusLineView.swift`, `StatusLineSettingsSection.swift`; Electron `ansi.ts`,
  `statusLine.ts`, `StatusLine.tsx`, `StatusLineSettings.tsx`, `main/sessionSettings.ts`). Tests:
  `engine/test/statusLine.{settings,managed,input,runner}.test.ts`, `engine/test/safeRead.test.ts`,
  `engine/test/engine.statusLine.test.ts` (writes `fixtures/wire/wave6.statusline.json`),
  `Core/Tests/ReviewGateCoreTests/{AnsiText,StatusLine}Tests.swift`, `clients/desktop/src/renderer/{ansi,statusLine}.test.ts`,
  `clients/desktop/src/main/statusLineSettings.test.ts`.

## 45. Wave 7: the app keeps up

The Mac app 0.4.1 felt sluggish on a Mac under memory pressure: a 4-minute sample of real use was idle but for
one ~4 s hitch on the main thread — ~2.3 s of it SwiftUI diffing the review diff's List over every line, 0.74 s AppKit
recomputing the menu bar's key equivalents because the menus were rebuilt on state changes; its 376 MB footprint was
mostly swapped out (whatever walks the heap on the main thread pages it back in), and the status line started a process
per change. This wave removes those costs without changing what the user sees or can do: the same rows, order, look, keys,
identifiers and flows. Nothing new on the wire; snapshots come less often.

### 45.1 The chat keeps up (Mac)

No wire change: client only (Core `Session/`, Mac `App/UI/Chat`, `Agents`, `Side`, `Diff/WhyChangedSection.swift`).

- **A keystroke redraws the composer.** The draft, the caret, the mentions and images, the palettes' state and the prompt
  history live in `ComposerModel`, read by `ChatComposer` and by the palettes over the transcript (`ComposerPalettes`, at
  the same place as before); `ChatView` is a shell that reads none of it. The sidecar log disclosure (`store.logs.count`),
  the capabilities caption, the header, the plan card and the peer inbox read the store in their own views. §44.1 as it
  was: ⇧⇥ modes, Esc, ↑ / ↓ history that keeps the draft, the mode line, the mention popover, chips, send.
- **A streamed delta redraws the streaming row.** `AppState.liveText` (`LiveAssistantText`) keeps the open answer's text
  as appended pieces (nothing that came before is copied); the transcript row is appended with the first delta and gets
  the whole text once, when it finishes — also when another row was put after it (the next delta starts a new message;
  a row left streaming would stay raw text without Copy). Deltas already queued for the main actor land as one change
  (`publishLiveText`: `liveText.revision` and `transcriptRevision` once per burst). `transcript`'s `didSet` no longer
  reads `oldValue` (that copied the array on every change): its count and first / last id are kept apart. The streaming
  row draws plain text (no attributed string per delta; markdown once finished, the same final look), and
  `TranscriptFollower` follows the bottom per new row as before and, while an answer streams, at most every 80 ms (once
  more after the last burst).
- **The rows stay in view when the transcript's room changes.** ⇧⇥ (the HUD's mode badge is 2 pt taller), a card above
  the composer, the review notice and the diff pane give the transcript more or less room. Anchored to its bottom for those
  changes too (`defaultScrollAnchor(.bottom)`), the lazy stack re-estimated the height of the rows it had not made, and the
  view moved to a bottom where it had made none: a blank transcript until the next scroll or resize (at 1000 × 637, ⇧⇥ into
  plan mode beside the diff pane and every review that began). It is anchored to the bottom only when it opens and while its
  rows are shorter than the view; a change of size keeps the offset, and while following, `TranscriptFollower` scrolls to the
  newest row (the bottom marker, which the stack makes) instead of an estimated end. The layout check (§49.2) shoots it.
  The newest rows are not lazy (0.5.12). Beside the diff pane a card above the composer (Claude's question, permission
  cards — r2-review-flow M27) leaves the transcript 80–108 pt; the lazy stack, making a row or two, re-estimated the rows
  it had not made (13 220 → 157 724 → 13 817 pt within 30 ms), and following them the view ended where no row was made —
  blank — or 1 000–2 000 pt above the newest row. The last rows and the bottom marker are now a plain stack under the lazy
  one, so the bottom has its rows' real heights whatever is estimated above (`TranscriptPane.tailStart`: at least the last
  30, the boundary moving ten at a time). Rows that cross into the lazy stack are estimated there, and everything below
  them moves by the difference under a still offset, so the boundary is set when the rows are placed — a chat opened,
  shown or switched to, rows put in front, fewer rows — and otherwise moves on only when a turn begins (its message glides
  in) or past 150 rows made at once, and then only while following and not scrolling. (0.5.12 also moved it whenever
  following resumed: a reader scrolling back down to the newest row turned following on, and the rows shown were pushed
  down 621–1 607 pt — the transcript "reset" upward on every scroll down. Never moving it during a chat instead made a long
  session's stack hundreds of rows: 33–37 % of the main thread while an answer streamed, 18–27 % before, and 659–734 ms to
  lay the chat out again, 327–376 ms before.) The bottom marker takes the stack's bottom padding, so a pin to it is the content's very
  end (a reader who reached the end was pulled 12 pt back up). Each row still observes what it draws (a streamed delta
  redraws the streaming row).
- **The transcript holds still while rows change above the bottom** (r1x). Subagents at work (§52.2) add their calls to their
  groups — above the bottom when several run — rows finish in place, a notice counts ×N, a group folds when its agent ends.
  Following, the view was left wherever that put it: 608 pt above the newest row after three agents' calls, because the
  follow scroll ran per appended row, before the rows above were laid out, and nothing followed a change of height in
  place; every row also restarted its own animated scroll. Now, while following, every change of the content's height pins
  the bottom marker at once (`onScrollGeometryChange` of the content size), a row that comes alone still glides in while
  rows that keep coming (< 400 ms apart) are followed without an animation each, and one more pin follows 200 ms later
  (after their layout; also after a change of the room). Scrolled up, the view keeps its offset as before: rows growing in a
  group above it still move what it shows (25 pt in the check; keeping the shown row with `scrollPosition` blanked the
  transcript in the layout check, as §45.1's room changes did). `SHOTS_LAYOUT=scroll` (scripts/screenshots.sh,
  `ScreenshotTour.scrollChecks`; also part of `SHOTS_LAYOUT=1`) feeds three agents' calls into their groups, a repeating
  notice and an agent's end, and logs the scroll offset every 4 ms: following, it never moved up and ended at the bottom
  (13 pt: the stack's padding); the 50 transcript shots of the layout check stay without a blank one. Scrolled up, two
  turns' rows then come below ("newer rows below": did the offset move?).
  `SHOTS_LAYOUT=blank` (`ScreenshotTour.blankChecks`) does the same in windows taller than the laptop's — 1257 × 1104 and
  the screen's height — through a turn (shot while it streams), subagents' calls, the diff pane, a review, the app hidden
  and back, the window minimised and back, every other display (another backing scale) and a new chat that grows past the
  view, and says BLANK when the transcript shows none of its rows, OUT OF THE WINDOW when the composer's send button is not
  in the window. A short chat sits at the bottom of the view: its ink is measured where its rows are, not over the empty
  room above them. `SHOTS_LAYOUT=cpu` (`ScreenshotTour.cpuChecks`) measures the main thread over a 60-turn chat at
  1257 × 1104 while nothing changes on screen but the HUD's clock and the live agents' dots (in front, behind another app,
  with an answer streaming 25 pieces a second), how late a job queued on it every 50 ms runs, and how long a new chat takes
  from the click to its laid-out rows, and back from the PRs tab how long until the chat is laid out again; `cpulong` does
  the same after 45 more turns came while the chat stayed open (a long session). `SHOTS_LAYOUT=cards` (`ScreenshotTour.cardsOnly`) runs the composer's shots — a
  review, Claude at work, Claude's question and a permission card above the composer, dark and light — six times over the
  layout check's transcript (a long chat, the scroll check's agents), each round with request ids of its own: beside the
  diff pane Claude's question leaves the transcript 108 pt, and it showed none of its rows in 6 of 38 question shots (6 of
  8 in the first round); a permission card leaves it 190 pt and never did. Then three permission cards at once leave it its
  least room, 80 pt, four times (`cards-stacked-*.png`). `SHOTS_LAYOUT=scrolldown` (`ScreenshotTour.scrollDownChecks`)
  leaves a 64-turn chat 5 000 pt above its end while 16 turns come in, then scrolls it down as a trackpad moves the clip
  (40 pt every 16 ms, the transcript told the user scrolls) to the end, idle and while Claude streams, at 1000 × 637 with
  and without the diff pane and at 1257 × 1104; a jump is the view going further from the newest row than the reader took
  it.
  `SHOTS_LAYOUT=open` (`ScreenshotTour.openChecks`) runs Open Project… / Switch Project… / Open in New Window… (their menu
  items, the folder picker answered by `ProjectOpener.debugPick`) and `ProjectOpener.open` in each state a window can be in
  — idle, the project already open here or in another window, files pending review (also on the PRs tab), a turn running,
  a message typed, no project, a second window after the first one closed — and logs what each ended in (`open <case>:
  opened in this window / opened in a new window / asked — "…" / said — "…" / its window came forward / message — …`); SILENT
  when none of these happened, which fails the run. Every window the tour opens logs under its folder, never to
  ~/Library/Logs/ReviewGate. `open-opening.png`: the empty window while an open is on its way.
- **A breathing dot costs the window nothing** (0.5.12). The dot of a live agent — the HUD's "N agents running", an agent
  group's "Running" chip, the Changes tab while Claude works, a side question at work — breathed by a SwiftUI
  `repeatForever` animation, which updates and renders the window's whole view graph every frame (the transcript's scroll
  view included) for as long as one dot shows, in front or behind another app: 29–45 % of the main thread with three agents
  at work over a 60-turn chat (Debug), and macOS's CPU report of the installed app behind another app (54 % for 166 s, in
  the hosting view's layout and render). The ring is now a Core Animation animation of its own layer (`PulseRingView`),
  which the window server runs: 2–3 % with the agents, as idle; an answer streaming still costs what its rows cost.
- **The chat is one view, the diff pane open or closed.** It was the split's trailing pane while the diff pane was open and
  the window's own child while it was closed: two places, so SwiftUI made a new chat whenever a review began (the pane
  opens) or the pane opened or closed (⌘⇧D), and the message being typed, its mentions and images, the composer's focus and
  the transcript's place went with the old one. The split (`SplitPane(collapsed:)`) now leaves out only its leading pane;
  the chat stays the same view. The composer's height follows a new width too (the text wraps anew; before, only a change
  of the text resized it). The layout check (§49.2) types a message before the pane first opens and logs after every
  toggle and review whether it is still in the same, focused composer.
- **A new row places itself.** Core `TranscriptModel` keeps the row tree (agent groups), the folded exploration runs, the
  tool-call index, the row positions and each answer's turn up to date row by row; it rebuilds only for rows put in front
  (a restore, [이전 대화 더 보기]), replaced or removed, or a late row the full build would move (a result or a subagent row
  before its call, an error that takes a folded call out of its run, a call id seen twice). `AppState.liveLookups` /
  `transcriptModel` / `transcriptIndex` share it — the chat, "Why it changed", the side panel's rows and its compose field,
  the side thread's anchor, the file authors, the "원인별" grouping and ⌘F — with each agent group's files and each
  report's first line, worked out once per change.
- **Rows SwiftUI can skip.** A transcript row takes values (its item, what was looked up for it, one cached root URL) and
  compares them (`Equatable`): a new row, a decision or a finished answer redraws that row only. Actions go through one
  `ChatActions` object (open the diff, open an agent's group, focus the composer, open a workbench) instead of closures
  made on every draw; no `AnyView`. The rows of an open agent group (a running one is open) are made as they scroll into
  view (a lazy stack, the same look).
- **Worked out once.** A tool row's tooltip — its input as JSON, at most 4 000 characters: a smaller input reads as
  before, a larger one has each long string cut first, so a 1 MB Write is not encoded to show its start — and its mini
  diff, per row; markdown blocks and inline lines, per text (`TranscriptRowCache`, `NSCache`: dropped under memory
  pressure, worked out again when needed). ⌘F searches the rows as they are now and keeps each tool call's JSON while the
  search is open (`TranscriptLookups.searchText`, let go when it closes).
- **↑ reads the history only to walk it**: with the caret on the first line or an empty draft. The decoded history is
  kept until this window adds a prompt or opens another project (`AppState.promptHistory`).
- **Measured** (`ChatPerformanceTests`: debug, thread CPU, best of three; 200 / 2 000 rows with 40 KB Writes, 3 KB Edits
  and agent groups; base = 0.4.1): a streamed delta 15.4 / 115.4 µs → 2.5 / 2.5 µs; an appended row (the event plus the
  tree, runs, index and positions) 1 086 / 8 552 µs → 10.7 / 34.3 µs; a ⌘F keystroke after the first no longer encodes the
  calls' JSON ("co" at 2 000 rows: 24.4 → 7.8 ms).
- **Not in this pass.** Capping the tool input a `.toolUse` row keeps (the mini diff counts every line of an Edit's strings,
  the agent sheet shows a Task's whole prompt, ⌘F searches the whole input — they all need it); letting old rows go (every
  row stays, as before); a faster search than Foundation's case- and diacritic-insensitive one (a query absent from a
  large Write still reads all of it: ~250 ms a keystroke over 140 × 40 KB in a debug build); image thumbnails decoded at
  full size; what reads `state` is redrawn by every snapshot that changed a slice (§45.2).
- Owner: w7-chat (Core `Session/TranscriptLive.swift`, `TranscriptModel.swift`, `TranscriptRowCache.swift`,
  `AppState.swift` (the transcript, streaming and prompt history), `ReviewInsights.swift`, `ComposerSupport.swift`,
  `AppState+FileGroups.swift`; Mac `ChatView.swift`, `ChatComposer.swift`, `TranscriptPane.swift`,
  `TranscriptRows.swift`, `ToolRows.swift`, `MarkdownText.swift`, `AgentGlanceViews.swift`, `SidePanelView.swift`,
  `SideThreadView.swift`, `WhyChangedSection.swift`). Tests: `Core/Tests/ReviewGateCoreTests/TranscriptModelTests.swift`
  (random append / prepend / replace sequences against the full build, the streaming buffer, the shape revisions, the
  shared index, the row texts, the history), `ChatPerformanceTests.swift`, `DailyUXTests.swift`.

### 45.2 The review, the state and the menus keep up

What every state snapshot cost: the engine sent one for each change (4–5 per tool call: the activity line streamed, then
repeated by the assistant message, then ended; each subagent step), each carrying every slice; the Mac kept the whole
snapshot in one observed property, so every view reading anything derived from it re-ran — the review diff's List, whose
rows were a variable number of List rows per line (the line, its notes, its findings, the composer), evaluated every line
again; and the menus, rebuilt for AppKit on each.

- **The engine sends a snapshot when something changed** (engine `engine.ts`, `review/storage.ts`; owner w7-state):
  - The same activity again (the `assistant` message repeats the streamed `tool_start`), an idle activity again, an agent
    update that leaves `hud.agents` / `subagentDepth` / `waitingOnAgents` / `agentHistory` equal, the same usage window
    again (its kind, status, use and reset equal and no other window's reset passed — whenever it arrives, its `at`, which
    no client shows, and whatever the order of the kinds): no snapshot, and the kept window keeps its first `at`. The
    `activity` event itself still goes out every time.
  - **HUD churn** — the activity line, a subagent's step or lifecycle (`agentsChanged`; progress keeps its 250 ms), the
    usage windows — goes out in at most one snapshot per 100 ms (`STATE_CHURN_GAP_MS`): the first at once, the rest in one
    trailing snapshot with the latest values. Any other snapshot in between carries the churn and restarts the window.
  - **Never held:** permission requests and questions, plan proposals, errors, the turn's end, command replies (their
    snapshot still follows on the next macrotask), `text_delta` (no snapshot at all). The order of events is unchanged;
    `seq` stays strictly increasing; `engine.state` flushes what waits (tests, Electron).
  - **The disk reading** (§39.1) is sent when its level changes, or when the free space moved by a quarter of the last
    sent figure while `ok` (no client shows it) or a tenth while `low` / `critical` (the HUD chip's figure) — no longer on
    every 256 MB swing (swap growing on the same volume sent one while idle).
- **The user's status line runs at most every 5 s** (engine `statusline/runner.ts`, §44.2): a change runs the command
  no sooner than 5 s after the last run started (`minIntervalMs`, test seam), and the last change still runs once after
  the wait. The first show (the first `status_line` request, or after the lines were cleared), a new `columns` and a
  changed switch (`settingsChanged`) run after the 300 ms debounce alone: a change that follows inside it never puts that
  run off (it runs with it), and one that comes while a run is in flight makes the next run follow that run after the
  debounce alone; `statusLine.refreshInterval` and the run after a usage window resets keep their own schedule. A command that writes the same stderr text on every run is logged once
  (a new text is logged again) — it no longer adds a `log` event, and a chat re-render, per run.
- **The Mac observes slices, not the snapshot** (Core `AppState.swift`): each part of `state` is a stored property of its
  own — `projectInfo`, `gitInitInfo`, `projectURL`, `sessionInfo`, `engineToolchain`, `gate` and `gatePhase`,
  `changedFiles`, `reviewNotes`, `budget`, `budgetUsage`, `hudWire` (as sent) / `hud` (localized once per change) /
  `hudTurnCount` / `hudTurnFiles` / `agents` / `liveAgentCount`, `branchesInfo`, `workbenches`, `engineLockConflict`,
  `commitState`, `sessionsInfo` / `openTabs`, `storage`, `autoAcceptRules` — written only when its value changed (compared explicitly,
  whatever the toolchain's `@Observable` setter does; Swift 6.3's skips equal values, its `_modify` does not). Every
  accessor keeps its name and meaning and reads its slices (`isRunning` from `gatePhase`, `selectedFile` from
  `changedFiles`, …), so a snapshot that moves the HUD alone re-renders only what reads the HUD. `state` stays the whole
  snapshot for the code that needs it; its readers are told only when a slice (or `pr`, `lastError`) changed — not for a
  snapshot that changed nothing. The PR store writes its mirror only when it changed.
- **The menus follow what they show** (Core `MenuState.swift`; Mac `UI/MenuCommands.swift`, `Chat/ChatCommands.swift`):
  the View, Edit (find), Review, Workbenches and Chat menus are `Commands` of their own that read the key window's
  `menuState` alone — enabled flags, the worktrees, the first nine chat tabs — and act on the store when chosen. The store
  recomputes it whenever what it reads changes (never the HUD) and writes it only when it differs.
- **The review diff keeps up** (Mac `Diff/DiffView.swift`, `Diff/DiffPlanRows.swift`): exactly one List row per plan
  item — a line row stacks its line, its notes, its AI pre-review findings and the open note composer (with the notes'
  former row insets as padding), so the List counts its rows from the items and builds only those on screen. The notes and
  findings come keyed by line once per change (`NotePlacement.inlineByLine`, `PreReviewDisplay.findingsByLine`). The list
  and each row compare their inputs (closures aside), so a change that leaves the diff alone re-runs neither; the header,
  the stale-diff and the hunk-refusal banners read the locks in views of their own; the window passes no closures, so its
  re-render skips the pane. Rows keep their `DiffDisplayItem.key` ids (find in diff), hover, context menus, accessibility
  identifiers and actions. The history diff (line + notes) and the full file (line + the lines deleted after it, now
  flattened with their own keys, `FullFileView.rows`) get one row per element too; the live diff colours at most 3 000
  lines, as the others.
- **The highlighter's cache is bounded** (Core `Diff/SyntaxHighlighter.swift`): by about 24 MB of cost per line (key,
  text, runs) besides its 50 000 entries, and cleared when a project opens, switches or closes, the engine stops, or a new
  review starts.
- **Compatibility.** Nothing changed on the wire. A client sees fewer `state` events while Claude works (the HUD at most
  ~10 times a second); a client waiting for the snapshot after a command still gets it at once. The Electron client needs
  nothing.
- **Verified.** `engine/test/engine.wave7.test.ts` (the same activity / idle sends nothing, nor the same usage windows
  made again from the CLI's event later and in the other order (`rateLimitChanges`); churn in one
  immediate and one trailing snapshot with the last activity; subagent steps likewise; a permission request, the turn's
  end and an error go out at once and carry what waited; text deltas send no snapshot; the disk thresholds),
  `engine/test/statusLine.runner.test.ts` (the interval and its trailing run; a new width and a switch run soon — also
  with a turn's changes inside the debounce, and right after a run in flight — the window shown again waits; stderr
  logged once per text), `Core/Tests/ReviewGateCoreTests/StateSlicesTests.swift` (a
  HUD-only snapshot tells no reader of the changed files, the locks, the project, the tabs or the menus —
  `withObservationTracking`; a seq-only one tells nobody; in-place writes reach the slices; the menu slice follows the
  selection and a running turn but not the HUD; notes / findings by line equal the per-line filters; the full file's
  rows), `SyntaxHighlighterTests` (the cost limit and the clear). The Mac app builds; the engine, sidecar, Core and Electron
  suites pass.
- **Not in this pass.** The PR diff (`PR/PRDiffPane.swift`) still emits a variable number of rows per line (outside this
  lane); the changed-files list still follows the transcript's structure for its file authors (`FileAuthorsCache`, §45.1's
  ground); chat views that read `store.state.hud.*` directly are told on every slice change rather than the HUD's alone;
  the transport's newline scan and per-line decoder (off the main thread) are unchanged.
- Owner: w7-state (engine `engine.ts`, `review/storage.ts`, `statusline/runner.ts`; Core `Session/AppState.swift` and the
  `AppState+*.swift` accessors, `Session/MenuState.swift`, `Session/PRStore.swift`, `Session/ReviewRound.swift`,
  `Session/WorkflowLogic.swift`, `Diff/SyntaxHighlighter.swift`, `Diff/FullFileView.swift`; Mac `ReviewGateApp.swift`,
  `UI/MenuCommands.swift`, `UI/Chat/ChatCommands.swift`, `UI/MainWindow.swift`, `UI/Diff/*`, `UI/Sidebar/*`).

## 46. Git commands Claude runs when asked

Until now the PreToolUse Bash hook denied every git command that changes the repository ("The app manages git; do not
commit or move the working tree"), so a user who asked Claude to merge `develop` and resolve the conflicts got a refusal.
Claude may now run them when asked, and the review keeps showing only Claude's work. MARK: r1-git — git runs as it does
in a terminal: only a command that throws away uncommitted work or rewrites the remote waits for the user's click (before,
every commit, checkout, pull, merge, stash or restore did — 3 to 8 cards per task, N + 2 for a commit-splitting skill, while
the terminal's auto mode asked for none).

- **Which commands ask** (engine `session/gitDestructive.ts` `destructiveGitReason`, called by hooks.ts `gitCommandReason`).
  The command line is read by a tolerant shell scanner: only the words of commands count — a git command inside `echo`,
  `grep`, quotes or a here-document (a commit message saying `git push --force`) never does; chains, pipes, redirections
  (`2>&1`, `> /dev/null`), subshells, `$( … )` / backticks, `bash -c` / `sh -c` / `eval` scripts, `if` / `for` bodies and
  wrappers (`sudo`, `env`, `time`, `nohup`, `timeout`, `xargs`, `parallel`, …), the commands of `find -exec` /
  `-execdir` / `-ok`, a script a shell reads on stdin — a here-document or here-string given to `bash` / `sh` / … with no
  `-c` and no script file (`bash <<'EOF'`, `sh -s <<< '…'`); when the line pipes or redirects into a shell a script it
  does not spell out (`echo '…' | sh`, `cat <<'EOF' | bash`, `sh < x`, `bash -c "$(cat <<'EOF' …)"`), every text of the
  line that could be one (a quoted string with a space, a here-document's body; `\n` read as a line break) — and what git
  runs itself (`submodule foreach <cmd>` in every submodule, `rebase -x|--exec <cmd>`, `bisect run <cmd>`: one word is a
  script, several are the command's own words; a checkout, restore or `--abort` there has no folder to look at, so it
  counts as holding work) are looked into; before, they slipped through. A program is known by its name (§20
  `programName`): `git.exe`, `GIT`, `"C:\Program Files\Git\cmd\git.exe"` are git, `bash.exe` a shell, `env.exe` /
  `xargs.exe` wrappers, `find.exe` find (before, Git Bash's `git.exe reset --hard` got no card). Global options before
  the verb are skipped (`-C <dir>` moves where paths point, as does the line's own `cd`). Always:
  `reset --hard|--merge`; `checkout` /
  `switch` with `-f` / `--force` / `--discard-changes`; `clean` unless `-n` / `--dry-run` (a `clean.requireForce = false`
  config deletes without `-f`); `branch -D` / `-M` / `-C` or any forced branch change (`-df`, `--delete --force`,
  `branch -f x y`); `stash drop|clear`; `push` with `--force`, `-f` (also inside a cluster: `-uf`), `--force-with-lease`,
  `--force-if-includes`, `--mirror`, `--delete`, `-d`, `--prune` or a refspec starting with `+` or `:`; `worktree remove`
  with `--force` / `-f`. Long options count by any prefix git accepts (`--har`); `--no-…` forms never. Only when the
  working tree holds work — a file under review, or an uncommitted or unmerged one anywhere in it (`git status -- :/`):
  `merge --abort` (`reset --merge`) and `rebase` / `cherry-pick` / `revert` / `am` with `--abort` or `--skip` — a conflict
  Claude resolved and left uncommitted (as the instruction below asks) goes with them; `--continue` / `--quit` keep it.
  Before, `GIT_MUTATING_RE` gave these the card; r1-git had let them through, and a remembered `Bash:git merge` even answered
  `git merge --abort` in the default mode — the reason is decided first, so no key does now. Only when the targets
  hold work: `checkout [<tree-ish>] -- <paths>`, `checkout .`, `checkout <x>` when `<x>` is an existing path (or a glob) and
  not a commit (`git rev-parse --verify --quiet <x>^{commit}`), `checkout --ours|--theirs|-p <paths>`, `checkout <commit>
  <paths>`, and `restore` of the working tree (no `--staged` / `-S`, or with `--worktree` / `-W`) — when a pathspec (`.`,
  a folder, a glob, `:(magic)` — everything) covers a file still under review (`pending` / `changesRequested`; the engine
  hands the hooks its list, `HookContext.reviewPaths`) or a file with an uncommitted change (`git status --porcelain -z
  --untracked-files=no -- <paths>` where the command runs; from a tree-ish untracked files count too). A
  `--pathspec-from-file`, a `--git-dir` / `--work-tree` elsewhere or a status git could not give counts as holding work.
  A target is read as the shell hands it to git — for the review check and for the probe alike: `~`, `~/…`, `~<your user
  name>/…`, `$HOME` and `${HOME}` are the home folder (`shellWord`; before, git was handed `~/proj/x` as written — a path
  relative to the shell's folder that names nothing — so `git checkout -- ~/proj/x` threw an uncommitted file away without
  a card, and `$HOME/…` stood for the whole tree).
  The status runs before any card, so in a folder of another repository (a nested clone or submodule, another worktree, a
  folder outside the project) it runs nothing of that repository's configuration: fsmonitor and hooks are off for every
  git call (§4), and every filter driver its configuration defines is turned off too (`-c filter.<driver>.clean=` /
  `smudge=` / `process=` / `required=false`; release 1 review: a nested clone's clean filter ran as soon as Claude named a
  checkout there). A file such a filter would have cleaned (Git LFS) may then read as changed — a card, never a lost file.
  A submodule counts by its commit only (`--ignore-submodules=dirty`): a checkout in the repository around it does not
  touch the submodule's files, and git would run a status inside it with that submodule's configuration — release-2
  review: unless the command may recurse into it. `--recurse-submodules` (the last of it and `--no-recurse-submodules`
  wins), `-c submodule.recurse[=<bool>]` / `--config-env=submodule.recurse=…` on the line, else `submodule.recurse` set
  true where it runs (`git config --type=bool --get submodule.recurse`: a common global setting, and a plain `git checkout
  -- .` recurses then) make each checked-out submodule under the targets (`git ls-files --stage`, mode 160000) count with
  its own uncommitted changes, probed on its own as another repository (its filter drivers off), down to three levels. Before,
  `git checkout --recurse-submodules -- .` reset a submodule's changed file with no card.
  A target only the run knows is the whole working tree (`:/`): a substitution or any other variable (`git checkout --
  $(git diff --name-only)`, `git restore $(git ls-files -m)`, `for f in …; do git checkout -- "$f"; done`), another user's
  `~bob/…` or the shell's `~+` / `~-`, a brace expansion (`{a,b}.txt`), and the arguments `xargs`, `parallel` or
  `find -exec … {}` hand on (`git diff --name-only | xargs git checkout --` — an empty `--` there is no branch);
  `checkout <x>` with such an `<x>` (`$(…)`, `"$f"`, `~bob/x`) is checked the same way — paths or a branch, only the run
  tells —, and so is `checkout <x> <paths>`: the whole tree as paths, and `<paths>` from a tree-ish (before, such an `<x>`
  was taken for a commit and only `<paths>` were looked at). So with a file under review or uncommitted these ask; with
  nothing to lose they run.
  Everything else — `commit`, `checkout -b` / `switch -c`, `checkout <branch>`, `pull`, `merge`, `rebase`, `stash` (push),
  `stash pop`, a plain `push` / `push -u`, `config`, `restore --staged` — is an ordinary command: in auto mode the CLI's own
  rules (the user's `Bash(git checkout:*)`, a skill's `allowed-tools: Bash(git commit:*)`) and its classifier decide (§39.5),
  in the default mode the ordinary card asks — one that "allow for session" remembers (`Bash:git commit`).
  `GIT_MUTATING_RE` (hooks.ts) no longer decides any card: it only says which commands' file changes are git's (below).
- **The card.** A command that asks reaches `canUseTool` with `permission_request.reason = {code: "git_command", message:
  "A git command that throws away uncommitted work or rewrites the remote — the review cannot bring it back."}` (§33.3; the
  hook answers `ask`, reason `ReviewGate: a git command that throws away uncommitted work or rewrites the remote — needs
  the user's approval`, after the location and settings reasons) — in every permission mode, `acceptEdits` and `auto`
  included, and whatever `autoAllowTools`, an allow pattern (`Bash(git *)`), a remembered key or the user's rules say; like
  every reason card it offers no "always allow" and stores no `remember` — so a remembered `Bash:git push` (the key is the
  first two words) never answers `git push --force` (it used to). `canUseTool` finds the reason itself should the hook not
  have seen the call. Plan mode (§19.4) and the unprompted guard (§18) still deny first; an approved command raises no
  `worktree_outside_review` — unless it ran in another worktree or a nested repository and changed something there (§33.4:
  the row lists those files). Clients localize on the code (Mac and Electron: red, "커밋하지 않은 작업을 버리거나 원격 기록을
  바꾸는 git 명령이에요 — 리뷰로 되돌릴 수 없어요"); one that does not know it shows `message`. A card with a reason has no
  session allow (⌥⌘↩ does nothing there): its "Allow once" says why in its help — "한 번씩만 허용돼요 — 리뷰로 되돌릴 수 없는
  작업을 버릴 수 있는 git 명령이라 기억해 두지 않아요 (⌘↩)" (another reason: "… 리뷰가 따라가지 못하는 곳에서 하는 호출이라 …";
  Core `PermissionCardOptions.onceOnlyHelp`, Electron `gitNotices.onceOnlyHelp`). The clients show `committedIn` as a
  "커밋됨 <sha>" badge on the changed-file row (and in the diff header on the Mac) and the four §46 notices as gray rows
  (Core `GitNoticeText`, Electron `gitNotices.ts`; tests `Core/Tests/ReviewGateCoreTests/GitAutoTests.swift`,
  `clients/desktop/src/renderer/gitNotices.test.ts`).
- **Not Claude's edits.** The post-Bash snapshot of a git command that changes the working tree (`GIT_MUTATING_RE`, hooks.ts:
  `checkout`, `switch`, `reset`, `restore`, `stash` (not `list` / `show`), `clean`, `rebase`, `merge`, `apply`, `am`, `pull`,
  `cherry-pick`, `revert`, `bisect`, `gh pr checkout|merge`, with any option groups before the verb; git and gh by their
  name, §20: `git.exe merge`, `GIT pull`, `"C:\…\git.exe" rebase` — before, Windows' `git.exe merge` counted its incoming
  files as Claude's) (§31) reports no files
  (`tool_files`) and adds nothing to the per-turn budget — a merge may bring in seventy files from another branch. The
  snapshot still moves the next call's base, so Claude's next command is attributed as usual, and conflict resolutions made
  with `Edit` / `Write` count normally. MARK: r1-git — `commit` is not one any more: it changes no file, so what the same line
  edited (`sed -i … && git add … && git commit …`) is that call's (origin `bash`, not "outside the app"), and stays in the
  review with `committedIn` (below).
- **The review.** At a turn's collection, before A → B is diffed, what git brought in while it ran is carried into A and into
  the turn's own start (the "this turn" base, §34.1) — so neither the list nor `turn_end` / `turn_summary` show it as
  Claude's: (1) commits since `baseHead` (`git diff baseHead HEAD`, as §9's `followHead`; all trees or none — when they do not
  apply, A stays and `gate.headMoved` reports the move), then (2) the incoming side of a merge still in progress
  (`MERGE_HEAD` exists: `git diff $(git merge-base HEAD MERGE_HEAD) MERGE_HEAD`), applied with `git apply --cached --3way`
  where a file whose change conflicts keeps A's content — so a conflicted file shows ours → Claude's resolution, and every
  other incoming file is gone from the list. That carry happens once per `MERGE_HEAD` (`gate.baseMerge`, persisted with the
  review as `baseMerge`; a fresh A taken while a merge is under way already holds it); `followHead` (refresh, send on a
  standing review, restore) applies the same two steps. Commits are carried along first parents: a merge commit brings in
  only its other side (`merge-base(p1, p2)..p2`, conflicting files keeping A's content) — so a merge Claude commits in the
  turn leaves its resolutions and whatever else it staged in the review —, any other commit whole; when HEAD does not get
  back to `baseHead` along first parents (a checkout elsewhere, a rebase), the whole `baseHead..HEAD`. A file the patch
  cannot apply at all (the other side renamed a file ours changed, a deletion of a changed file) no longer stops the
  rest: each file is applied on its own and that one keeps A's content. A merge that ends without moving HEAD
  (`git merge --abort`) has its incoming side taken back out of A (the reverse patch, conflicts keeping A), and
  `baseMerge` is cleared. `head_moved` (§31.3) still follows a turn in which HEAD moved. The carry's `git diff` is
  plumbing-safe whatever the user's config (`--no-color`, explicit `a/` `b/` prefixes).
- **Claude's own commits stay in the review** (r1-git; before, an approved `git add -A && git commit` was carried whole into
  A and the turn listed nothing — the edited file vanished from the review, and a "branch / commit changed" bar showed for the
  commit the user had just approved). Before a Bash call whose git command may move HEAD (`commit`, `checkout`, `switch`,
  `reset`, `pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `bisect`, `update-ref`, `symbolic-ref`, `branch -m`,
  `gh pr checkout|merge`; git and gh by their name, §20) the hook reads HEAD and the newest HEAD reflog entry; after it,
  HEAD again and the reflog entries written since (`git log -g --date=unix`). The commits its `git commit` made
  (`commit:`, `commit (amend):`, `commit (initial):` — not `commit (merge):`, not a pull's, merge's, rebase's or
  cherry-pick's) written while the call ran (from
  PostToolUse − `duration_ms`, so not the user's own commit while a card waited — that makes the move `foreign`) are
  Claude's: the session reports `git_result {toolUseId, from, to, ownCommits, amended?, foreign?}` and the engine hands them
  to the gate (`ReviewGate.noteOwnCommits`, kept with the review as `ownCommits` until a fresh A). The carry walks
  `baseHead..HEAD` along first parents as before but leaves Claude's own commits out — A keeps the content from before them;
  every other commit (a pull, someone else's) is carried, merges by their other side. When HEAD does not get back to
  `baseHead` along first parents (a checkout elsewhere, an amend in a later turn) and Claude committed, the carry goes
  through their merge base: what only `baseHead` had is taken back out, what HEAD has brought in, Claude's commits neither
  way and a commit Claude's amend replaced (`amended`) not taken out. Any failure keeps today's fallback (the whole move;
  `headMoved`). A commit of Claude's that a rebase rewrote — `git pull --rebase` after a rejected push, `git rebase
  origin/main`, a cherry-pick, in the turn that committed or a later one — is found before the carry: an own commit no
  longer in HEAD's history whose copy is among the newest 300 commits of `baseHead..HEAD` (the same author, author time and
  subject, or else the same `git patch-id --stable`: a reworded copy) gives way to the copy, which is Claude's own from
  then on (and the rewritten one replaced). Before, the copy was carried into A like someone else's commit: the file
  vanished from the review while the row said "its files stay in the review" (same turn), or the carry failed and what the
  rebase brought in (`Up.java`) showed as Claude's change (a later turn). One that left HEAD's history with no copy (a
  squash, a checkout elsewhere) makes the move unexplained (§31.3: the bar, no `claude_committed` row) when a file it
  changed is no longer listed. A listed file one of Claude's commits changed (the newest still in HEAD's history) carries
  `committedIn: "<short sha>"` (`state.changedFiles[]`, set at every collection, refresh and restore). Rejecting it reverts
  the working tree to A as for any file — the commit stays, the file now differs from HEAD — and a gray row says so:
  `reject_committed` (`detail`: "App.java (abc1234)"). The app's `commit` of accepted paths leaves out a path with no change
  against HEAD any more (both names of a rename; `git status --porcelain`): it is not staged again (`git commit --only` of
  nothing fails) but leaves the review as committed in its own commit, and the reply says `alreadyCommitted: [paths]`; with
  nothing else to commit no commit is made and `sha` is HEAD's. Tests: `engine/test/gitResult.test.ts`.
- **A stash** (r1-git). Before a Bash call whose git command puts work away (`git stash`, `stash push` / `save`, `stash -u`, …;
  not `pop` / `apply` / `list`) the hook reads `git status --porcelain` of the checkpoint root; after it (PostToolUse or
  PostToolUseFailure — `postGitCommand`, next to `postBash`) again. The files that were dirty and are no longer are on no
  disk the review can see: the session reports them (`git_result {toolUseId, stashed}`) and the engine adds the notice
  `error{fatal: false, scope: "session", code: "git_stashed", detail: "<up to 10 files>[ (+N)]"}` — a gray row "stash에
  들어가 리뷰에서 빠진 파일: … (git stash pop으로 되돌림)", never `state.lastError`, never a stopped queue. The stash itself asks
  nothing (auto mode: the CLI's call); `stash drop` / `clear` have the card. Tests: `engine/test/gitResult.test.ts`.
- **Committing the merge.** git refuses a partial commit (`--only`) during a merge, so while `MERGE_HEAD` exists `commit`
  stages the accepted paths and commits the whole index — the merge's own staged files plus them — concluding the merge.
  Refused first with `merge_unresolved:<paths>` (`paths` too) when a path is still unmerged and not among the accepted
  ones, or a review file that is not accepted has its change staged (Claude's `git add`): it would go in unresolved or
  unreviewed. After a commit that alone moved HEAD (its first parent is `baseHead`), `baseHead` follows it and a concluded
  merge clears `baseMerge` — A already holds what the commit holds.
- **Claude's instruction.** The engine appends after the client's text (`GIT_INSTRUCTION`): when the user (or a skill they
  ran) asks to commit, branch, merge, pull, rebase, cherry-pick, stash, push or resolve conflicts, run git as in a terminal;
  ReviewGate asks only before reset --hard, clean -f, checkout / restore over files under review or uncommitted, branch -D,
  stash drop / clear and force pushes (r1-git; it said every such command got the approval card); files Claude commits stay
  in the review; "never run git
  commit / … " means not on Claude's own initiative; after resolving merge conflicts, leave the merge uncommitted and the
  resolutions unstaged unless the user asked to commit (the user reviews them and commits the merge from the app); a denied
  card means stop and ask; never a worktree, clone or copy of the project under /tmp, /private/tmp or /var/folders (macOS
  deletes files there not opened for a few days, `.git` included — a worktree made there lost its `.git` and most files, and
  every send failed `not a git repository`). The Mac window says so for a project in such a folder (`TransientProjectBanner`),
  and a git failure that is `not a git repository` reads as words (`EngineMessages.plainGitFailure`). The clients' default prompt now says
  to run them only when the user asks (Mac `AppSettings.defaultSystemPromptAppend`, Electron `DEFAULT_SYSTEM_PROMPT_APPEND`).
- **Compatibility.** One new `PermissionReason.code`; a client that does not know it shows `message` on an orange line
  (Electron, until it localizes it). The persisted review gains an optional `baseMerge`. r1-git: optional
  `changedFiles[].committedIn`, `head_moved.explainedBy` / `commits`, `committed.alreadyCommitted`, the persisted
  `ownCommits`, four notice codes (`git_stashed`, `claude_committed`, `claude_moved_head`, `reject_committed`) — an older
  client shows their English `message`.
- **Verified.** `engine/test/gitDestructive.test.ts` (r1-git: what asks and what does not, the scanner — here-documents,
  substitutions, wrappers, scripts, a shell's stdin, `submodule foreach` / `rebase --exec` / `bisect run`, git, gh, shells
  and wrappers by their name (`git.exe`, `GIT`, `"C:\…\git.exe"`, `bash.exe -c`, `xargs.exe`, `find.exe -exec`) —, checkout /
  restore over review and dirty files in a real repository, `~/…`, `~<you>/…` and `$HOME/…` targets read as the shell
  hands them to git, paths only the run knows (`$(…)`, `"$f"`, `~bob/…`, `{a,b}`, xargs, find -exec) asking with work and
  running without, `--abort` / `--skip` over a resolved conflict and after it, the hook
  in auto and default mode, a remembered `Bash:git push` against a force push and `Bash:git merge` against
  `git merge --abort`), `engine/test/gitResult.test.ts` (the stash row,
  Claude's own commits, amend, a rebase of them in the same and a later turn — reworded too —, one left behind by a
  checkout, a foreign move, reject, the app's commit after Claude's, `GH pr checkout` / `GIT.EXE stash` read like gh and
  git), `engine/test/platform.paths.test.ts` (`programName`), `sidecar/test/driver-gitauto.mjs`
  (real CLI 2.1.318 on sonnet in auto mode, a scratch repository with a local bare origin outside /tmp: "branch
  feature/acme-7, fix App.java, commit, push -u" asked nothing, the branch reached origin, App.java stayed pending with
  `committedIn` and origin not `external`, `head_moved.explainedBy: "claude_git"` and a `claude_committed` row, no bar;
  "git reset --hard origin/main" was exactly one `git_command` card (denied: HEAD stayed); a project skill with
  `allowed-tools: Bash(git add:*), Bash(git commit:*)` committed without a card and NOTES.md stayed with `committedIn` —
  three turns, about 35 s; not in `make verify-cli`, which runs haiku without auto mode),
  `engine/test/session.budget.test.ts` (the verb boundary, `pull` / `cherry-pick` / `revert`, `stash list`, git and gh
  by their name),
  `session.hooks.test.ts` (the card over an allow pattern; a merge's files neither reported nor counted, the next command
  attributed), `session.claudeConfig.test.ts` (`canUseTool` in auto mode with `autoAllowTools`, a pattern and a remembered
  key), `autoMode.test.ts` / `engine.modes.test.ts` (the card in auto mode, plan mode still denies), `review.gate.test.ts`
  (a merge committed in the turn: only Claude's edit listed, `turn_end.files` 1; an unfinished merge with a conflict: the
  resolution and Claude's new file only, carried once), `engine.staleReview.test.ts` (an unfinished merge found on
  restore, carried once over two restarts), Core `PermissionQueueTests` (the code, the line, red).

## 47. The code browser

The user reviews in a Java / Spring repository every day and could only see the files a turn changed ("코드 탐색 못하는거
너무 불편한데"). Any file of the project now opens read-only in the diff pane — found by name (Go to File, ⌘P) or by its
text (Find in Project, ⇧⌘F) — with the full file's rows: line numbers, syntax colours, wrap / sideways scroll, find, copy,
Open in Editor. Additive on the wire: two commands with one reply each. Nothing here writes a file.

```ts
// commands
project_file   { path: string }                                                          → project_file    // query lane
project_search { query: string; caseSensitive?: boolean; wholeWord?: boolean; limit?: number } → project_search  // lane "search"
// replies
type ProjectFileEvent   = { type: "project_file"; id?; path: string; lines: string[]; isBinary: boolean; truncated: boolean; size: number };
type ProjectSearchEvent = { type: "project_search"; id?; query: string; matches: ProjectSearchMatch[]; truncated: boolean; timedOut?: true };
type ProjectSearchMatch = { path: string; line: number; text: string };
```

- **Which files.** Go to File is `list_files` (§23) without its folders: `git ls-files --cached --others --exclude-standard`,
  the fuzzy ranking and the review's files first. `project_search` searches the same set: `git grep -n -z -I --untracked`
  (tracked files and untracked ones git does not ignore; binary files skipped), never `.git`, `.gitignore`d output or
  submodules.
- **`project_file`** (engine `files/browse.ts`): `path` is repo-relative (`list_files` / `project_search` paths);
  `repoRelativeInside` (§23) refuses `invalid_path` for an absolute path, `..`, a symlink leading out of the repository or
  anything under `.git`. Only a regular file is read, opened non-blocking and checked through its descriptor (a FIFO or a
  device never blocks the engine): `not_a_file`, `file_not_found`, `file_unreadable:<code>`. The worktree's bytes (what is
  on disk now, also an untracked file), split on `\r?\n`, the last empty line dropped. A NUL in the first 8 KB: `isBinary`,
  no lines. At most 2 MB and 20 000 lines are sent — beyond either, the first ones (a partial last line dropped) and
  `truncated`; `size` is the whole file's.
- **`project_search`**: the query is a fixed string (`-F`, never a regex; passed with `-e`, so `-n` is text), ignoring case
  unless `caseSensitive` (`-i`; `LC_ALL=C`, so only ASCII letters fold), `wholeWord` → `-w`. Refused `empty_query` (blank)
  and `invalid_query` (a control character — a newline would make git search each line — or over 500 characters). git's
  output is read as it streams, path verbatim (`-z`): the first `limit` matches (default 500, at most 2 000), then git is
  stopped and `truncated`; after 20 s likewise with `timedOut` (the matches found until then). A line over 400 characters
  comes back as 400 around its first match, "…" where cut. git failing otherwise: `search_failed:<its first line>`.
- **Lanes.** `project_file` is a read on the query lane (with `list_files`); `project_search` has a lane of its own
  (`search`) so a slow grep never holds up the composer's @-mention list, and nothing waits behind a turn or a commit.
- **Mac** (Core `Session/CodeBrowser.swift` — `CodeBrowserStore`, `CodeBrowserText`, `AppState.openProjectFile(path:line:)`;
  `Engine/CodeBrowserProtocol.swift`; App `UI/Browse/*`):
  - **Go to File** (⌘P, File menu in place of Print, the toolbar's `doc.text.magnifyingglass` button): a palette over the window; typing
    asks `list_files` (60 ms after the last key), ↑ / ↓ move, ↩ or a click opens, Esc closes. `Name.java:120` opens at line
    120. Empty, it lists the files opened lately (≤ 12, per project) and then the review's files.
  - **The file** shows in the diff pane (expanded if collapsed; a PR tab switches to Changes) under its name, folder, line
    count and "읽기 전용": the rows of the full file without the review's marks (`DiffLinesList`, `DiffCodeText`), syntax
    colours as one document (`SyntaxHighlighter.highlightDocument`, off the main thread), the opened line marked and centred.
    ⌘F (and ⌥⌘F) opens the find bar (`DiffFindBar`) over it — while a file is open the Edit menu's ⌘F is "Find in File…",
    Find in Chat stays in the menu without its key. A row's menu: Copy line, Copy path:line (`DiffLineCopyMenuItems`), Open in
    <editor> at this line, and "Find in Project" with the line's identifiers (3+ characters, keywords left out, ≤ 8; whole
    word, case-sensitive). The header: copy path, reload, wrap, find, Open in Editor (`ExternalEditor`, at the clicked line,
    else the opened one), "Back to review". The truncated banner names the line count and the size. A turn's end reads the
    file again (the lines stay on screen until the new ones arrive).
  - **What closes it**: "Back to review", a file picked in the Changes list, ⌘] / ⌘[, a link to a changed file
    (`selectFile(path:)`), a past round's or a live diff, another project. A turn that re-selects the review's file on its own
    leaves it open.
  - **Find in Project** (⇧⌘F, File menu; a fourth sidebar tab "Search"): the field searches 300 ms after typing stops (two
    characters or more; ↩ any), [Aa] match case, [W] whole word; "12 matches in 3 files" (with "only the first 500" / "stopped
    after 20 s"); the matches by file — the file's name, folder and count, then line number and the line without its indent,
    the query marked; a click opens the file at that line (the header at its first match), the open one is highlighted. A
    newer search drops an older reply; showing the tab again does not search again.
  - **For other views**: `AppState.openProjectFile(path:line:)` takes a repo-relative path or an absolute one inside the
    project (symlinks resolved, so `/tmp` and `/private/tmp` agree) and returns false for anything else — a chat link to a
    file can call it (after `selectFile(path:)` for a changed one).
- **Keeping up with 20 000 lines.** The rows' ids are the ForEach's own data (the line keys), never a `.id()` per row —
  which made the List build all 20 000 rows to learn their ids on every open (sampled ~0.9 s of the main thread, Debug).
  The transport's line reader scans each read for newlines once (a 1.5 MB reply used to be rescanned from its start on
  every 64 KB read, seconds of a reader thread). Colouring runs off the main thread as for the full file.
- **Compatibility.** An older engine refuses both `unknown_command`: the pane / the tab say to update ReviewGate. An older
  client never sends them. The Electron client does not have the browser yet.
- **Verified.** `engine/test/engine.browse.test.ts`; the bundled sidecar over stdio on a scratch Spring-like repository
  (search 65 ms, the 500 cap, a 25 000-line file sent as 20 000 + `truncated`, `../` refused); the Mac app (a scratch
  bundle id and data folders) driven through accessibility: Go to File → `cartserv:14` opens `CartService.java` at line
  14 (marked), the Search tab finds and opens a line of the truncated file, the main thread idle afterwards.
- **Security.** Reads only, inside the repository: no `..`, no symlink out, nothing under `.git`, no FIFO / device; git runs
  without a shell, the query as one `-e` argument. Nothing leaves the machine; the review gate, the budget and the git guard
  are unchanged.
- **Not in this pass.** A file tree, go to definition / references (Cmd+click on an identifier — the row's "Find in Project"
  stands in for it), regex search, include / exclude globs, search-and-replace, the Electron client, the shortcut table
  (docs/SHORTCUTS.md is held to both clients).
- Owner: code-browser (engine `files/browse.ts`, `engine.ts`, `protocol.ts`; Core `Engine/CodeBrowserProtocol.swift`,
  `Engine/EngineProtocol.swift`, `Engine/EngineTransport.swift`, `Session/CodeBrowser.swift`, `Session/AppState.swift`; Mac
  `UI/Browse/*`, `UI/MainWindow.swift`, `UI/MenuCommands.swift`). Tests: `engine/test/engine.browse.test.ts`,
  `Core/Tests/ReviewGateCoreTests/CodeBrowserTests.swift`, `EngineTransportTests.aHugeLineAndManyShortOnesArriveWhole`.

## 48. Releases and in-app updates

The user releases by building a DMG on their Mac. Until now nobody learned of a new one unless told, and a DMG downloaded
by a browser was refused by Gatekeeper (the app was signed with an "Apple Development" certificate, team QW7DJ7FBDT, not
notarized; from 0.5.7 on a release is signed with a Developer ID of the same team and notarized). A release is now a
GitHub release of `seunggulee1007/reviewgate-for-claude-code`, the app notices it and installs it on one click. Nothing
here touches the engine or the wire.

The app's bundle identifier is `io.github.seunggulee1007.reviewgate` from 0.5.6 on. The bundle gate below refuses a
download whose identifier differs from the running app's, so a build with an older identifier cannot update itself to
0.5.6: that one install is by hand.

- **Releasing** (`make release VERSION=X.Y.Z`, `scripts/release.sh`). Preconditions first: X.Y.Z newer than `VERSION`
  (or `VERSION` already X.Y.Z with `chore: X.Y.Z` at HEAD — a re-run after a later step failed), tracked files clean, on
  a branch, tag `vX.Y.Z` neither in the clone nor on origin, `gh` logged in to github.com, the tools and Node, a
  `Developer ID Application` identity in the keychain and a working notarytool keychain profile (`NOTARY_PROFILE`,
  default `reviewgate`). Then
  `VERSION` ← X.Y.Z, `make version`, commit `chore: X.Y.Z`; `make gen && make sidecar`; `xcodebuild … -configuration
  Release -derivedDataPath build build` in the foreground, started only once no other `xcodebuild` writes the same
  derived data (matched by `-derivedDataPath`, resolved against the other process's working folder) and checked again
  before packaging — a DMG was once packaged from a stale binary while a build still ran. The built app and, after
  `hdiutil create -volname "ReviewGate X.Y.Z" -srcfolder <.app + Applications link> -fs APFS -format UDZO`, the app inside
  the image attached read-only must both say X.Y.Z (`CFBundleShortVersionString`), carry project.yml's build number
  (`CFBundleVersion`), embed a sidecar whose `ENGINE_VERSION` is X.Y.Z and pass `codesign --verify --deep --strict`;
  anything else fails the release. Notarization: the built app must be signed by a `Developer ID Application` identity
  with the hardened runtime and a secure timestamp (project.yml, Release: `CODE_SIGN_IDENTITY`,
  `OTHER_CODE_SIGN_FLAGS=--timestamp`); a zip of it goes through `xcrun notarytool submit --wait` (anything but
  `Accepted` prints Apple's log and fails) and `stapler staple` puts the ticket into the app before it is packaged. The
  DMG is signed with the same identity, notarized and stapled the same way; Gatekeeper (`spctl -a -vv`) must accept the
  built app, the app inside the image and the image (`-t open --context context:primary-signature`) as
  `source=Notarized Developer ID`. `build/dist/ReviewGate-X.Y.Z.dmg.sha256` (`shasum -a 256`, of the stapled image)
  goes beside the DMG, the notes are the commit subjects since the previous `v*` tag (no tag yet: since the previous
  `chore: x.y.z`, at most 200, the version commit left out) with how to install. Last: `git tag vX.Y.Z`, `git push origin vX.Y.Z` (the branch is not
  pushed), `gh release create vX.Y.Z <dmg> <sha256> --repo github.com/seunggulee1007/reviewgate-for-claude-code --title "ReviewGate X.Y.Z"
  --notes-file … --verify-tag --latest`. `--dry-run` (`DRY_RUN=1`) runs everything local — the build, the notarizations,
  the DMG, its checks, the notes — puts the version files back and prints the commit, the tag, the push and the release instead; `--check`
  stops after the preconditions.
- **Checking** (Core `Session/AppUpdate.swift` — `AppUpdateChecker`, `AppRelease`, `SemanticVersion`). The app
  runs the user's own `gh api --hostname github.com
  repos/seunggulee1007/reviewgate-for-claude-code/releases/latest`. `gh` is the path an open window's engine resolved
  (`state.toolchain.gh`), else the first `gh` on the login shell's PATH (the window's, or the probe that finds `node`),
  else Homebrew's; it runs with that PATH, `GH_PROMPT_DISABLED`, without `GH_HOST` / `GH_REPO`. The reply's `tag_name`
  (`v0.5.5`; a draft, a pre-release or a tag that is not a version is refused) is compared with the running bundle's
  `CFBundleShortVersionString` as semver (numbers by value, a pre-release below its release). At launch (8 s after, so a
  window's engine has resolved `gh`), then every 6 hours while Settings › General › Updates › "Check for updates
  automatically" is on (default on; turning it on checks right away), and from ReviewGate › Check for Updates… or
  Settings' [Check Now]. `gh` missing (`ghMissing`), not logged in (exit 4 / "gh auth login" / 401 → `notLoggedIn`), GitHub
  unreachable (`offline`), 404 (`noRelease` — nothing published yet, or the account cannot see the repository) or an
  unreadable reply show no banner; the on-demand check says which in an alert, and Settings shows the last result.
- **The banner** (App `UI/AppUpdateViews.swift`, every window's banner stack: after the disk-image banner in an empty
  window, after the CLI version banner in a project window). "ReviewGate 0.5.5 is available" / "You have 0.5.4. Installing
  quits ReviewGate and opens the new version." with [Install and Restart] (off when the release lacks its DMG or
  checksum), [What's New] (the release notes as Markdown in a sheet, with "Open Release Page") and [×]. [×] remembers the
  version (`dismissedUpdateVersion`, the highest closed one): its banner does not come back, a newer release's does, and
  "Check for Updates…" finding the closed version brings it back. The on-demand check that finds a release says so in an
  alert with the notes and [Install and Restart] — also with no window open.
- **Installing** (Core `Session/AppUpdateInstall.swift` — `AppUpdateInstaller`, `UpdateChecksum`, `UpdateCodeSign`,
  `UpdateRestartGate`, `AppUpdateHelper`). Refused first when the app runs from a disk image or a translocated copy, or
  its folder is not writable. Then, each step named on the banner: `gh release download vX.Y.Z --repo
  github.com/seunggulee1007/reviewgate-for-claude-code -p 'ReviewGate-*.dmg*' -D <temp>/ReviewGate-update-<uuid>/download` (no quarantine,
  unlike a browser); the DMG's sha256 against the `.sha256` asset (its first word, for that file name) and against
  GitHub's own asset digest when the API reports one; `hdiutil attach -readonly -nobrowse -noautoopen -mountpoint …`; the
  new app passes `codesign --verify --deep --strict`, has the running app's TeamIdentifier (`codesign -dv`; a running app
  with none — ad-hoc — refuses) and bundle id, and says the tag's version. Any failure detaches the image, removes the
  folder and says why on the banner ([Try Again]); nothing of the installed app has been touched.
- **Restarting.** Never while a window has a turn running or a card waiting for the user (`closeGuardReason`, whatever
  "Ask before closing" says): the banner says "ReviewGate 0.5.5 is ready. Claude is working in 2 windows — ReviewGate
  restarts when they finish." with [Cancel] (detaches, removes the download) and restarts by itself once they are idle.
  Then a helper script written into the work folder starts detached (`/bin/sh <script> <pid> <new app> <bundle> <mount>
  <work> <log>`) and the app quits the usual way (the window list written, every engine stopped). The helper waits for
  that one pid to exit (at most 10 minutes — then it detaches and replaces nothing), `ditto`s the image's app to a sibling
  of `Bundle.main.bundleURL`, renames the old bundle aside and the copy into place (and back should the rename fail),
  removes the old one, detaches the image, reopens the bundle with `open` — the new version, or the previous one when
  anything failed — and removes the work folder; it logs to `~/Library/Logs/ReviewGate/update.log`. Nothing is killed by
  name (no `pkill` / `killall`). A quit cancelled at the last moment (a turn started meanwhile) terminates the helper by
  its pid and detaches the image; quitting while an update waits detaches it too.
  The quit is called from the run loop (`RunLoop.main.perform`), not from a main-queue job. Quit's `.terminateLater`
  waits for the engines' shutdown and its 6 s cap, and both need the main queue, which a nested run loop inside a
  main-queue job does not drain. 0.5.6–0.5.8 called it from the update's Task. With any project open, those apps hung
  in Quit (⌘Q did nothing either) until the helper gave up. To update from them: close every project window before
  **Install and Restart**, or force-quit the app (⌥⌘Esc) within the 10 minutes, and the helper finishes. "Move to
  Applications" (`AppMoveBanner`) had the same hang and quits from the run loop too.
- **Compatibility.** No wire change; the Electron client does not check for updates. Teammates' ad-hoc builds never
  install an update from the app (no team to compare); they install by hand as before.
- **Verified.** Core `AppUpdateTests`: semver parsing and order, the `releases/latest` reply (assets, digest, drafts,
  bad tags), the check's outcomes through a fake `gh` (available, up to date, not logged in, 404, offline, timeout, gh
  missing), the closed version, the checksum file and digest, the TeamIdentifier and the signature / team / bundle /
  version gate, the location check, the "Claude working → wait" decision, the pipeline with fake gh / hdiutil / codesign
  (a bad checksum never mounts; a refused app is detached and its folder removed), and the helper run for real against
  temporary folders with stub `hdiutil` / `open` (the bundle replaced, not merged; a failed copy keeps the old one; both
  reopen). `make release VERSION=0.5.5 DRY_RUN=1` end to end (Release build, a 25 MB DMG, both apps checked, notes, the
  version files put back), then the opt-in `AppUpdateTests.realImagePassesTheGatesAndTheHelperInstallsIt`
  (`RG_UPDATE_DMG` / `RG_UPDATE_RUNNING_APP`) on that DMG with the real hdiutil, codesign and ditto: checksum, mount,
  signature, team and version pass, the helper swaps a scratch bundle that still passes `codesign --verify --deep --strict`
  and detaches the image. Not exercised: a real `gh release download`, and the quit / relaunch of a running app.
- Owner: app-update (Core `Session/AppUpdate.swift`, `Session/AppUpdateInstall.swift`; App `UI/AppUpdateViews.swift`,
  `ReviewGateApp.swift`, `UI/MainWindow.swift`, `UI/Settings/SettingsView.swift`; `scripts/release.sh`, `Makefile`).
  Tests: `Core/Tests/ReviewGateCoreTests/AppUpdateTests.swift`.

## 49. Run as Task, and a chat column that fits a short window

The user works task by task (a tracker's task: a link or a key), each on a branch of its own. Asking for one in an open
chat made that chat create the worktree and branch itself and do the work there: the conversation filled up with an
unrelated task, and the review followed it around (§39.4). "Run as Task" starts the task where it belongs from the first
message: a new workbench (§36.12) whose window sends the task as the first message of a fresh chat. The chat it was typed
in sends nothing and keeps its context.

```ts
// command: workbench_create + task?: { text: string; mode?: PermissionMode }   // §36.12 / §36.14 fields as before
// event:   task_started { text: string; mode: PermissionMode; from: string; sent: boolean }   // in the new worktree's engine
// const:   MAX_TASK_TEXT = 100_000 (characters)
```

- **Create** (`workbench_create {task}`). The task is checked before anything else, and nothing is created when it is
  refused: `invalid_task` for an empty text (whitespace only) or one over `MAX_TASK_TEXT`, `invalid_mode` for a mode
  that is not one of the four. Once the worktree exists (before the setup of §36.12), the engine writes
  `<new worktree's git dir>/reviewgate/task-handoff.json` (`{version: 1, from: {path, name}, text, mode?, at}`). If that
  write fails, the create is refused with `task_handoff_failed:<why>` (code `task_handoff_failed`). The worktree stays
  and the workbench list is refreshed, and the client keeps the text. Nothing is sent from the creating chat.
- **Take** (`open_project` in the new worktree). The engine takes the handoff once and deletes it on read. A handoff
  that is malformed, has an empty text, has an unknown mode, or is more than 15 minutes old (or that far in the future)
  is ignored. A chat moved there (§39.4) or a plan handed there (§42.1) comes first, and the task's file stays for the
  next open. Otherwise a fresh chat becomes current, and the session starts in the task's `mode` (absent: the worktree's
  usual mode, `settings.permissionMode` or its stored one). Once the session runs, the task's text is sent as a normal
  `send` through the gate, and `task_started {text, mode, from, sent: true}` is emitted. When the session cannot take a
  message, nothing is sent: `task_started {…, sent: false}` hands the text back, and the client puts it into the
  composer.
- **Mac.** Settings › Workbenches › "업무로 실행" (`runAsTaskEnabled`, on by default) shows the entry in two places: a
  button in the composer's tools (next to 📎 and @), which takes the draft and its @ mentions as `@path` (images stay in
  this composer), and Workbenches › "업무로 실행…" (also in the sidebar's workbench section), which starts with an empty
  task. Both open the New Workbench sheet as "업무로 실행". It has the task (an editor) and the mode of the fresh chat
  (this chat's mode at first), then branch, base, folder and setup as before. The branch is suggested from the task until
  the user types one (`TaskBranchName.suggest`): a link's last path number (`…/issues/1502` → `task/1502`),
  `#project/123` → `task/project-123`, `ABC-123`, `#123`, else up to five ASCII words of the first line, else the date
  and time. The prefix is the one the last task branch used (`taskBranchPrefix`, `task/` at first), cleaned so the
  name stays valid. After a create, the new window opens. The composer empties its draft if it still holds the text it
  handed over. `task_started` remembers the mode for the new workbench. With `sent: false`, the text goes into that
  window's composer (`AppState.taskForComposer`, taken once).
- **Electron.** The same setting, dialog fields and fallback. The menu entry is File › "업무로 실행…" under "새 워크벤치…" (Electron has no Workbenches menu), plus the sidebar and the composer button. Electron keeps no per-project mode, so `task_started` only logs the mode: the engine remembers it for the worktree.

### 49.2 The chat column in a short window

A new workbench's window, a short screen, or a card above the composer that appears (the "터미널처럼 자동 모드로
시작할까요?" offer of §2.8, a plan, the peer inbox) pushed the HUD and the composer below the window's edge. The chat
column is now laid out bottom up (`ChatColumnLayout`):

- The composer and the HUD keep their own height at the bottom.
- The cards above the composer get theirs while the transcript keeps 80 pt. They never get less than 60% of what is left
  (`ChatColumnSplit`), and they scroll when it is not enough.
- The transcript takes the rest, down to nothing.
- The tab strip stays on top.

The column's minimum height is the tab strip, the HUD and the composer. Nothing above the composer can push it out of the
window. The mode offer's explanation is two lines at most (the whole text in its tooltip).

M27 (release 2): an open permission card is one of those cards — whole above the composer, oldest first (its command block
scrolls past ~130 pt), so its Allow button is never below the window's edge — and the transcript keeps one line per card:
"허용함 · Bash git commit -m …" (거부함 / 보냄 / 처리됨, the reason's icon kept), a click opens the whole card; while the card
waits the line says so and a click brings the card into view. The engine log is no line under every composer: the error
banner's "Show log" and Help › Show Engine Log open it, its × puts it away. The window's information banners (notifications
off, a new CLI not verified, an update, a failed workbench setup, a temporary folder) fold into one "알림 N개" chip with a
popover when two or more stand; Electron's (a new CLI not verified or a pin waiting for the next start, a notification the
OS did not show, a failed workbench setup) do the same (`WindowNotices`), each banner in the popover with its own buttons.
The layout check's composer steps add a permission card in the review state at 1000 × 637 (the cards' height shown vs
needed is logged: "whole" / "CUT").

The window's minimum is 900 × 460 pt (it was 1100 × 700). macOS fits a new window into the screen, so on a laptop screen it
came out smaller than that minimum (1000 × 637 in the report). SwiftUI then drew the content at its minimum size, centred.
That clipped all four sides: the tab strip, the HUD and the composer, and the left of the sidebar. None of it could be
scrolled into view. Now a window that small lays out like any other. The layout check (`SHOTS_LAYOUT=1`) shoots 1100 × 752,
1000 × 637 and 900 × 512, each with and without the mode offer. At 1000 × 637 it then fills the transcript with a long chat
and shoots it after every change around it: ⇧⇥ through the modes, the diff pane opened and closed (⌘⇧D), turns that end
into a review and reviews that end (`chat-*.png`; the log says how much of the transcript is drawn, `BLANK` for nothing).
A shot the check marks — TALLER, CUT, OUT OF THE WINDOW, LOST or BLANK in tour.log — fails the run: scripts/screenshots.sh
lists the lines and exits 1 (a BLANK beside Claude's question had passed unnoticed in most runs of the 0.5.11 work).

- **Send always in the window (r1-composer M11).** With files pending (almost always in auto mode) the diff pane opens
  beside the chat, and at 1000 × 637 the chat was ~311 pt wide: the composer's bottom row ([!] · Accept 2 & Send · model ·
  mode) pushed Send, 바로 보내기 and Stop past the window's edge. Now:
  - the send button (and Stop) keep their size; the secondary controls — 변경 요청 (N), Accept N & Send, the next
    message's model, the mode — fold into one "⋯" menu, the model and the mode staying as icons, when at their own width
    they would leave the hint less than 60 pt (Core `ComposerBarFit.compact`); the skills / commands / MCP caption is then
    an icon too (the counts in its tooltip, the warnings kept);
  - 변경 요청 (N) shows only with notes to send (`AppState.showsRequestChanges`; it can do nothing without);
  - beside the diff, the chat keeps 380 pt as long as the diff keeps 240 (the split's minimums are 420 / 380; below that
    they share the room in proportion as before — Core `PaneSplit.leadingWidth`);
  - the pending-review notice is one line, "검토 대기 N개 · 질문은 수락 없이 가능 ⓘ" (it took five lines of a narrow
    chat); its ⓘ popover says that sending never accepts or rejects a file and that Claude's new changes join this review.
  Mac: `ChatComposer` measures the row (its width, the secondary controls at their own width in a hidden copy that takes no
  key, Stop and the send button) and draws the full or the folded controls; `SplitPane(leadingFloor:)`. The layout check
  (`SHOTS_LAYOUT=1`) ends at 1000 × 637, dark then light: a review with two files pending beside the diff, a turn that runs
  on beside them (Stop and 바로 보내기) and Claude's question above the composer, with the send button's frame logged ("OUT
  OF THE WINDOW" when it is not inside) and the cards above the composer's shown and needed heights ("CUT" when it scrolls);
  then a message typed, the PRs tab and back ("LOST" when the draft is gone) — `composer-*.png`. Seen: the send button in
  the window in all six, the question card whole (266 of 266 pt), the draft kept both times.
  Verified: Core `ComposerLayoutTests` (the fold at the report's widths, the split at 677 / 557 / 1117 pt, the request
  button with no, sent and unsent notes).
- **Verified.** Engine `w49.task.test.ts`: the handoff written into the new worktree and taken once by its engine (the
  first message sent in the task's mode, `task_started` sent: true, the file gone, a second open plain), no mode (the
  default), a session that cannot start (`sent: false`, nothing sent), refusals before anything is created, and
  `takeTaskHandoff` on malformed, stale, future, empty and wrong-mode files. Core `RunAsTaskTests`: the task on the wire
  only when set, `task_started` with odd values, the composer fallback taken once, branch suggestions and prefixes, and
  the column's split.
- Owner: run-as-task (engine `review/taskHandoff.ts`, `engine.ts` `workbenchCreate` / `loadSessions` /
  `afterTaskReceived`, `protocol.ts`; Core `Session/AppState+Task.swift`, `Engine/WorkflowToolsProtocol.swift`; App
  `UI/Sidebar/WorkbenchSheets.swift`, `UI/Chat/ChatComposer.swift`, `UI/Chat/ChatView.swift`,
  `UI/Chat/DefaultModeOfferBanner.swift`, `UI/Settings/SettingsView.swift`, `UI/MenuCommands.swift`, `UI/MainWindow.swift`,
  `WorkbenchRegistry.swift`).

## 50. Send now: a message into the turn that runs

In the terminal, a message typed while Claude works reaches Claude as soon as the current tool call is done, in the same
turn. The app only offered "Add to queue" (sent after the turn) and "Stop and send". Verified with CLI 2.1.318 over
stream-json: a user message written while a `sleep` runs gets `command_lifecycle` frames `queued` → `started` (right after
the tool result, with its replay) → `completed`, all before the turn's single `result` (`num_turns` 2). The reply answers
both messages. The engine sends it with `priority: "next"`: without one the CLI's default (`next` or `later`) follows a
feature flag of its own, and on this machine both folded alike.

```ts
// command: steer { text: string; mentions?: string[] }      // refused steer_unavailable:<why> (code steer_unavailable)
// event:   user_message + steered?: true                      // the same `turn` as the message that started it
```

- **Engine.** `steer` is taken only while a turn of ours runs: `gate.running` and the session's turn active, not while
  the review is being collected or reverted, and not during another session's command. The refusals are
  `steer_unavailable:` `not_running`, `collecting`, `external_turn` or `no_session`. An empty text is `empty_message`.
  The text, with the mentions as the send appends them (`Referenced files: @path`), goes to the CLI with a uuid of ours
  (`ClaudeSession.steerUser`). Its row is recorded and emitted at once (`user_message {steered: true}`, this turn's
  number), and the chat's `lastUserText` follows it. Nothing else of the turn changes: no new snapshot A, no new record,
  and its changes are this turn's review.
- **The race with the turn's end.** The message is tracked like a released peer message (§29). If the turn's `result`
  comes before its command `started`, the CLI runs it as a command of its own. The turn's end then waits for it
  (`peerTurnWaits`): one review turn, its usage summed. If the frames never come, the turn ends after the usual gap.
- **Mac.** While Claude works and the message has no images, the primary button is "바로 보내기" (↩ / ⌘↩). Its menu has
  "대기열에 추가" (after the turn, as before) and "중단하고 보내기". The hint reads "… — ↩로 바로 보내기". A refused
  `steer` (the turn ended meanwhile, the review is being collected) puts the message in the queue instead, so it is never
  lost. A message with images is queued: the CLI takes images only with a message of its own.
- **Electron.** The same behavior.
- **An open question (r1-composer M08).** While Claude's `AskUserQuestion` waits, a message steered into the turn only
  waits behind it: typing "y" and ↩ left the turn stuck until the card was found and clicked. So the message box answers
  the question instead. The question it answers is the oldest open `AskUserQuestion` while no other card is open (⌘↩ /
  ⌘⌫ answer that one first) and the running chat is shown (Core `AppState.openQuestion`). A typed answer goes to the
  first question without an answer (`QuestionDraft.fill`): the option whose label it is (letter case aside), else that
  question's "Other…" text, next to what was picked ("Postgres, 번으로 해줘"). The card goes out (`permission_response
  {allow: true, updatedInput: {questions, answers}}`, as its own Answer button sends it) once every question has an
  answer; until then the card shows what was filled. 1…N in an empty box pick option N of that question (several
  answers: on and off), and ↩ in an empty box sends the card. Nothing changes on the wire.
  **Mac.** The card sits above the composer, in the cards' place of §49.2 (first, above a plan), with the question the
  box answers marked ("입력창으로 답하는 질문" when there are several) and its options numbered; with several questions
  the next one scrolls into view. Its foot says what the box does: "1–N로 고르거나 아래에 쓰기 · ↩ 답하기 · ⌥↩ 따로
  보내기" — at 1000 × 637 the row under the box has no room left for its own hint. The transcript keeps one line for it:
  "Claude의 질문: … — 아래에서 답해 주세요" while it waits, then "답함: 질문 → 답" (or 건너뜀 / 처리됨; every question
  and answer in the tooltip). The hint reads "Claude가 질문했어요 — ↩로 답하기 · ⌥↩ 질문과 별개로 보내기" (⌘↩ when ↩
  makes a new line), the placeholder "Claude의 질문에 답을 쓰세요 — 1–N로 고를 수도 있어요", and the primary button is
  "답하기" (⌘↩ answers too). Its menu sends the text apart from the question ("질문과 별개로 보내기", also ⌥↩: into the
  turn as above, where it is read once the question is answered), queues it or stops the turn first. A question open
  while another card waits, or behind an older question, stays a card in the transcript, as before.
  **Electron.** The same (`src/renderer/openQuestion.ts`, `QuestionCard.tsx` `QuestionSlot`, `sendNow.ts`): the card
  above the composer and the transcript's one line, ⌘↩ (Ctrl+Enter) answers — the primary button is "답하기" —, ⌥↩
  (Alt+Enter) sends the text apart from the question, 1…N in an empty box pick an option, and the card and the box share
  one draft (`useQuestionDrafts`). A card's answer is its picked options, then the "Other…" text, as on the Mac (with
  several answers it was the "Other…" text alone).
  **Verified.** Core `ComposerQuestionTests`: the open question with and without another card, a typed answer sent as
  the answer (nothing steered or queued), a label that picks its option, several questions answered in turn with the
  number keys, a note typed after a pick. Electron `openQuestion.test.ts` (the same cases), `sendNow.test.ts` (the M08
  block: 답하기, ⌘↩, ⌥↩, the hint in Korean and on Windows), `questionCard.test.ts` (the slot with numbered options, the
  one-line rows, a question behind another card). The layout check of §49.2 shows the card whole above the composer at
  1000 × 637.
- **Notes with an answer (r2-chats-cards M08b).** The CLI's `AskUserQuestion` takes, besides `answers`, an
  `annotations` object keyed by question text — `{ notes?: string; preview?: string }`: the user's notes on their answer
  and the preview of the option chosen when the question showed previews (its own prompt lets the user add one). The
  question card has "메모 추가" at the end of each question's "기타…" row (a field below it once used — no row of its own, so
  the card stays whole above the composer at 1000 × 637); the reply carries `updatedInput.annotations` for each answered
  question that has a note or a chosen option's preview (a single choice), nothing else changes on the wire — without
  notes or previews there is no `annotations`. The card and the message box share the note in the question's
  draft (`QuestionDraft.notes`). Mac: Core `AppState+CardAnswers.swift` (`answerQuestions(requestId:draft:)`,
  `AskUserQuestions.Annotation`, `QuestionDraft.annotations`), `QuestionCard.swift`; test `CardAnswersTests`. Electron:
  `src/renderer/questionNotes.ts` (`annotationsOf`, the notes per request and question, shared by the card and the box),
  `QuestionCard.tsx` ("메모 추가"), store `answerQuestions(…, annotations)`; tests `questionNotes.test.ts`,
  `permissionStore.test.ts`.
- **Verified.** Engine `session.peer.test.ts` (§50 block): folded into the turn (one `turn_end`), run as its own command
  after the result (the turn waits, usage summed, no unprompted turn), refused without a turn. `w50.steer.test.ts`: the
  session gets the text with the mentions, the row `steered` with the turn's number, refusals. Core `RunAsTaskTests`: the
  command's JSON, a refusal queues. Real CLI: `sidecar/test/driver-steer.mjs` (haiku, CLI 2.1.318). It sends a `sleep 10`
  request, then steers in a request for `note.txt` and a word in the reply. Observed: one `turn_end`, both rows turn 1
  (the second `steered`), `note.txt` in the review, the word in the reply.
- Owner: steer (engine `session/claude.ts` `steerUser`, `engine.ts` `steer`, `protocol.ts`; Core
  `Session/AppState+Task.swift`, `Engine/EngineProtocol.swift`; App `UI/Chat/ChatComposer.swift`;
  `sidecar/test/driver-steer.mjs`).

### 50.1 The queue keeps going

Messages queued while Claude works used to stop at almost any error — a failing PR list, a refresh, a commit, a file list:
"대기열 중지됨" and nothing ran until [재개], so coming back after a break nothing had happened. Client rules (Mac and
Electron the same); nothing changes on the wire, and a queued message passes the same gate as ever when it goes out.

- **What stops it.** Only an `error` about the queued message's own send or its session: `send_failed` / `lfs_missing`
  (the message goes back to the front, §35.1), `session_crashed`, `session_start_failed`, `session_id_in_use`,
  `cli_not_found` / `cli_not_executable`, `extensions_init_timeout`, `auth_required`, and any fatal error. It waits for
  [재개] as before. Everything else — `command_failed` (a PR list, a commit draft, a side question …), `refresh_failed`,
  `commit_failed`, `branch_failed`, `workbench_failed`, `revert_failed`, `mcp_failed`, `plan_followup_failed`, an error
  without a code — shows its banner and the queue goes on (a failed collection closes the gate by itself; a plan or a
  card waiting holds the queue as before). Notices never stopped it (§2.9, §30, §38.2, §39.5).
- **The API.** `api_error` / `rate_limited` (after the CLI's own retries) stop it for a while: it goes on by itself after
  30 s, then after 2 min while the API keeps failing; a turn the queue went on after starts over at 30 s. The queue bar
  says "대기열 중지됨: <이유> · 14:03에 다시 보내요" with [지금 보내기] (sends now).
- **The usage limit.** `usage_limit` stops it until a minute after its `resetAt` (§38.2's "풀리면 이어서 하기" delay); without
  `resetAt` it waits for [재개].
- **The tool-call limit.** A turn that stopped at the limit (§38.2) does not stop the queue (Electron stopped it at
  `stopReason: "error_max_turns"`).
- **Stop.** After the user's Stop the Mac's queue goes on as before; Electron's keeps its pause, now worded "멈춤 — 다음 메시지
  대기 중" with [보내기] (sends the next one), and still pauses after a turn that ended with another error (`stopReason`
  `error_…`, "턴이 오류로 끝났습니다"). A pause already set in the turn (an error above) keeps its reason and time.
- Code: Core `QueueStop` (`Session/SessionNotices.swift`), `AppState+QueueStop.swift`, `AppState.swift` `handleError` /
  `pauseQueue`; App `UI/Chat/ComposerQueueBar.swift`; Electron `sessionErrors.ts` `queueStopOf`, `sendQueue.ts`
  (`resumeAt`, `retries`, `afterStop`), the queue part of `store.ts`, `components/chat/QueueBar.tsx`. Tests: Core
  `QueueStopTests`; Electron `queueStopStore.test.ts`, `sessionErrors.test.ts`.

### 50.2 The queue, as the terminal shows it (composer)

The report: "메시지 바로 보내기, 대기열에 있는 거 보이는 거 — 그런 세세한 기능들이 안 돼". In the terminal a message typed
while Claude works waits above the input, can be edited or removed there, and can go at once. The app's queue bar had
edit, move and remove, but no way to send one message now: it waited for the turn and every message before it.

- **What waits in the turn (engine).** A message put into the turn (§50 `steer`) showed as a sent row at once, though
  Claude reads it only after the current step: nothing said it was still waiting. It now waits in
  `state.session.steering: [{id, text, mentions?}]` (oldest first) and has no row yet. When the CLI starts it
  (`command_lifecycle` `started`, or `completed` when it was folded in), the session emits `steer_read {uuid}`. Its
  `user_message {steered: true}` row is then recorded and emitted, with the number of the turn it went into, where
  Claude read it. What the CLI never started goes in with the turn's end (or the session's close), in order.
  `ClaudeSession.steerUser` returns the message's uuid (the `id`). Engine `flushSteering`; tests `w50.steer.test.ts`
  (it waits, then its row; several in order; the rest at the turn's end) and `session.peer.test.ts` (`steer_read` on
  `started`, not on `queued`). Real CLI 2.1.322 (`driver-steer.mjs`): right after the steer, `steering` had the message
  and there was one row. At the end nothing waited and both rows had turn 1.
- **Send now on each queued message.** Each queued message has "바로 보내기" (⏎). What it does depends on the turn
  (`queuedSendNow`). While a turn of ours runs and the message has no images, it goes into the turn (§50 `steer`, with
  its mentions) and leaves the queue. With images, or while the turn cannot take it (another session's turn), the turn
  stops and the message goes right after it (§28, "중단하고 보내기"). Otherwise (the queue paused or held) it goes first and
  the queue goes on now. The tooltip says which of the three it does. The other messages keep their order. Nothing
  changes on the wire.
- **Mac (Core).** `state.session.steering` decodes element by element (`SessionInfo.steering`,
  `AppState.steeringMessages`); `QueuedSendNow.action`, `AppState.queuedSendNowAction(id:)` / `sendQueuedNow(id:)`
  (`Session/QueueSendNow.swift`). A message sent with Stop and send takes the composer's one-message model, not the queued
  message's own. Test `QueueSendNowTests`: the lenient decode, the list shown and cleared, the decision, into the turn with
  its mentions, an image stops and sends, a paused queue sends that message first.
- **Mac.** The queue bar (`ComposerQueueBar`) shows while anything waits: the messages in Claude's turn first, as dashed
  chips with ↳ and no tools (the CLI has them: they cannot be edited or taken back), "Claude의 턴에 들어감 — 지금 단계가
  끝나면 Claude가 읽어요" when nothing else waits. Each queued chip has a paper plane ("바로 보내기"; its tooltip says
  which of the three it does), the context menu and the editor popover have "바로 보내기" too.
- **Electron.** `sendQueue.ts` `queuedSendNow`, store `sendQueuedNow`, `QueueBar.tsx` (the ⏎ button on each chip, its
  tooltip `sendNowHelp`). Test `queueSendNow.test.ts`: the decision; into the turn with the mentions; with an image, stop
  and send; a paused queue sends that message first.
- **Electron, what waits in the turn.** `QueueBar.tsx` shows `state.session.steering` first as dashed chips (↳, no tools)
  and the bar shows for them alone ("Claude의 턴에 들어감 — …"; Clear only with queued messages). Test
  `queueSendNow.test.ts` ("the queue bar").

## 51. The PR sheet: names on every field, and "AI로 채우기"

Three faults in the PR sheet came in one report:

- The assignee, label, reviewer and project fields showed only their placeholders ("쉼표로 구분"). Outside a Form, a
  macOS text field shows no name, so nothing said what each field was for.
- The title stayed empty, so `pr_create` went out with `--fill` and failed. The title field took focus and wrote back the
  same empty text, which marked it as typed, so `pr_draft`'s title never came in. `--fill` itself failed because gh ran
  outside the repository (§41.1).
- The description could only be filled from the commit list.

Now every field has its name on the left (`PRSheetRow`), and a write of unchanged text no longer counts as typing.
"AI로 채우기" has Claude write the title and description.

```ts
// command: pr_ai_draft { base: string; title?: string; body?: string }   // side lane; → pr_ai_draft
// reply:   pr_ai_draft { title: string; body: string }                    // title "" when the answer had none
// refused: empty_base · pr_ai_draft_failed:<why> (code pr_ai_draft_failed)
```

- **Engine** (`review/prAiDraft.ts`, `engine.ts` `prAiDraft`). This is a read-only, one-shot fork of the main session,
  like the commit draft (§36.11): no session file, no web, no thread, its cost on the side meter. It runs on the side
  lane, never behind the PR lane's `gh` calls.
- **The prompt** carries:
  - the branch's whole commit messages since `origin/<base>` (else `<base>`), oldest first, up to 12,000 chars;
  - `git diff --stat` and the diff of `<baseRef>...HEAD`, cut at 3,000 lines (the fork may read files for the rest);
  - the sheet's title and body, with "keep the title's prefix and issue key";
  - the repository's pull request template, up to 8,000 chars. It is looked for in `.github/`, the root and `docs/`, the
    name in any case, then in the first `.md` of `.github/PULL_REQUEST_TEMPLATE/`. Its sections are filled in, with
    their headings, checklists and order kept.
- **The prompt's rules.** Write in the language of the commits and the template. Without a template, write a summary,
  the changes and how it was checked. Invent nothing the commits, the diff or the conversation do not show. The answer
  is `TITLE: …` then `BODY:` and the text. A fence around the answer and bold labels are read too.
- **Refusals.** A base with no ref is `pr_ai_draft_failed:no <base> to compare with`. A branch with no commits since its
  base is `pr_ai_draft_failed:no commits since <baseRef>`. A failed fork and an empty answer are refused the same way.
  Nothing is committed, pushed or created.
- **Mac** (`CreatePRSheet`, `PRMetaFields`, `PRSheetRow`).
  - "AI로 채우기" sits under the description. It is greyed out without a base or without commits since the base, and its
    tooltip says why.
  - While Claude writes: "작성 중…", and Create PR waits.
  - The answer replaces the title (only when it has one) and the description. "원래대로 되돌리기" puts back what was
    there until a field is edited. A base picked afterwards keeps Claude's text.
  - A failure is one orange line in the user's words (`FlowText`).
  - The sheet is 560 pt wide.
- **Electron** (`CreatePRDialog`; logic `flowLogic.ts` `prSheetReduce` / `prAiDraftCommand` / `prFillBlocker`, store
  `fillPRWithClaude`). The same button and states. Its fields already showed their names; each row is now a `<label>`,
  so the name also names the field. React's `onChange` fires only on a real edit, so the empty-title fault never
  happened there; the reducer states the same rule anyway.
- **Verified.**
  - Engine `w51.prAiDraft.test.ts`: the fork's options and prompt (commits oldest first, the template, the diff, the
    sheet's draft), nothing committed, the cost on the side meter, every refusal; `parsePRAiDraft`, `findPRTemplate`'s
    order, `cutPatch`.
  - Core `PRAiDraftTests`: the command's JSON, the lenient reply, a refusal in words, a blank base not sent.
  - Electron (1,145 tests): the command (title / body only when non-empty), the reply applied (an empty title keeps the
    sheet's), the refusal texts, the reducer (`pr_draft` fills only untouched fields, Claude's text survives a base
    change, an edit drops "Restore"), and the names on the fields in Korean.
  - Layout check: the sheet with every name (`create-pr.png`).
  - Real CLI: `sidecar/test/driver-praidraft.mjs` (haiku, CLI 2.1.318). It used a branch `PAY-42: 장바구니 합계에
    할인 반영` and a Korean template. Observed: the title kept `PAY-42`, the template's three sections were filled in
    Korean, the missing tests were stated rather than invented, and HEAD and the worktree were unchanged.
- Owner: pr-ai-draft (engine `review/prAiDraft.ts`, `engine.ts` `prAiDraft` / `branchCommits`, `protocol.ts`; Core
  `Engine/CommitFormatProtocol.swift` `PRAiDraftReply`, `Engine/EngineProtocol.swift`, `Session/AppState+TeamFormat.swift`
  `writePRDraft`, `Session/WorkflowLogic.swift`; App `UI/Sidebar/WorkbenchSheets.swift` `CreatePRSheet`,
  `UI/Sidebar/TeamFormatViews.swift`; `sidecar/test/driver-praidraft.mjs`).

## 52. Background work and turns Claude starts itself

In the terminal, Claude can run a command in the background (`run_in_background`, Ctrl+B, Monitor, `/tasks`). When the
command ends, Claude goes on by itself. A `/loop` or cron job also starts turns on a schedule. The app turned all of this
off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, §13) and denied every change in a turn the CLI started itself (§18).
Now it works as in the terminal, and the review still sees everything.

Verified with CLI 2.1.318 over stream-json (haiku):

- **Background Bash.** It gives `task_started {task_type: "local_bash", is_backgrounded: true}`, an immediate tool result
  and the turn's `result`. When the command ends, the CLI sends `task_updated` → `task_notification` →
  `background_tasks_changed`. Then it runs a turn of its own **without** `command_lifecycle` frames: `system/init`, text
  and tools, then a `result` with `origin {kind: "task-notification"}`.
- **`/loop 1m …`.** It creates a `CronCreate` job. Each run is `command_lifecycle started` of a command that is not ours,
  with `wakeup_source: "schedule_wakeup"`, then `system/init`, the turn, `result` and `completed`.
- **Agent calls.** Without the variable, the CLI runs an `Agent` call in the background unless its input says
  `run_in_background: false`. A PreToolUse hook's `updatedInput` with that field keeps it in the turn
  (`is_backgrounded: false`, one `result`).

```ts
type BackgroundTask = {
  taskId: string;
  kind: "bash" | "monitor" | "agent" | "other";  // task_type local_bash / *monitor* / local_agent / anything else
  description: string;
  toolUseId: string | null;     // the call that started it
  turn: number | null;          // the transcript turn of that call
  startedAt: string;            // ISO-8601
  hasOutput: boolean;           // its output file is known (task_output)
};
type AutoTurnTrigger = "background" | "schedule" | "continue";
// settings.backgroundWork?: boolean                       // default true
// state.session.backgroundTasks: BackgroundTask[]         // the live ones, oldest first
// commands: task_stop { taskId } · task_background { toolUseId? } → { moved: boolean } · task_output { taskId } → task_output
// event / row: auto_turn { turn; trigger; task?: { taskId; description; status; summary? }; wakeupSource?: string }
// reply: task_output { taskId; text; truncated: boolean; running: boolean }
```

- **`settings.backgroundWork`** (default on). It applies at the next session start.
  - On: the session starts without `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`; an explicit value in the environment still
    wins.
  - Off: as before. The variable is `1`, and a turn the CLI starts is denied (§18).
- **Agents run as in the terminal** (§52.2). The CLI runs an `Agent` / `Task` call in the background unless its input
  says `run_in_background: false`; the main agent answers the user while the subagent works, and what the subagent
  changes still reaches a review. `settings.subagentsInTurn` (opt-in) keeps them in the turn as before: the PreToolUse
  hook gives every call `updatedInput {…, run_in_background: false}`.
- **`state.session.backgroundTasks`** follows `background_tasks_changed`.
  - Its `tasks` replace the list. `ambient` tasks are left out.
  - `task_started` adds `toolUseId`, `kind` and `turn`. The output file comes from the Bash call's result ("Output is
    being written to: …") or from `task_notification.output_file`.
  - The list is emptied when the CLI process ends, because the CLI's tasks end with it.
- **`task_stop {taskId}`** calls `Query.stopTask`. The task ends with `task_notification {status: "stopped"}`. It is
  refused `no_session`, `task_unknown` (not in the list) or `task_stop_failed:<why>`.
- **`task_background {toolUseId?}`** is Ctrl+B. It calls `Query.backgroundTasks(toolUseId)`: the running Bash call (all
  foreground tasks without an id) returns at once and keeps running in the background. The reply is `{moved}`. It is
  refused `no_session`, `background_off` (the setting, or the variable in the environment) or
  `task_background_failed:<why>`.
- **`task_output {taskId}`** replies with the last 64 KiB of the task's output file (`truncated` when cut;
  `running: false` once it has ended). It is refused `task_unknown` or `no_output`. Only a file the CLI named for that
  task is read.

### 52.1 A turn Claude starts itself is a review turn

With background work on, the engine takes such a turn as its own review turn, once a turn of ours has run in this CLI
process — r2-peers: or at once when the session resumed a conversation that had turns of ours (`SessionMeta.turns > 0`;
the engine passes `resumedWithTurns` with `resumeSessionId`), so a turn Claude starts right after a restart or a chat
switch is a review turn instead of being denied (§18):

- **Detection** (`ClaudeSession`):
  - `command_lifecycle started` of a command that is not ours, with `wakeup_source` → trigger **`schedule`** (`/loop`,
    cron, ScheduleWakeup). The command becomes ours, so its `result` is the turn's end. If it starts while a turn of ours
    runs, it joins that turn.
  - `system/init` while no turn of ours runs and no other command runs → trigger **`background`** when a background
    task's `task_notification` arrived since our last turn, otherwise **`continue`** (for example `/goal`).
  - A peer message's command (§29) is never taken this way.
- **Taking it.**
  - The session marks the turn active at once, so its text is not `unprompted`.
  - Every tool call waits in the PreToolUse hook (and `canUseTool`) until the engine is done.
  - The engine waits for a collection or revert in flight, then runs `peer_accept`'s steps (§29): `followHeadMove`,
    `prepareAnswer` (a standing review keeps A), snapshot A, `beginTurn` with no user message, the §31 / §32 turn-start
    state and a §26 checkpoint. The prompt is `[auto] <label>`.
  - It emits **`auto_turn`** and records its row, which opens the turn, like a peer message's row.
  - From there it is an ordinary turn: cards, budget, `turn_end`, collection, `turn_summary`.
  - A collection that failed holds it too (r2-peers) while its automatic retry (M30, §3) is still to run: its calls keep
    waiting, within the same 60 s as a collection in flight. With no retry left (it failed too, or the user's ran) the
    turn is taken at once and folds the failed one in, as a `send` does (§3).
  - When the gate cannot take it (the snapshot failing, no checkpoint), the session falls back to §18: its calls are
    denied with the usual notice.
- **Changes between turns.** While a background task is live after a turn's collection (or one ran since), the next
  turn of any kind keeps the last review's A (`prepareAnswer` even with nothing pending; accepted files whose patch is
  unchanged stay accepted). So what a background process wrote after B shows in that turn's review as `external`
  (§31.1), instead of becoming part of a fresh A. `finish_review` drops A, so a turn after it starts fresh — §52.2: unless
  background work runs (or ran since B): then the finished review's B is the next turn's A.
- **Labels.** `auto_turn.task` names the background task whose notification came last (description, `completed` /
  `failed` / `stopped`, the CLI's summary). `wakeupSource` is the lifecycle frame's own value.
- **Claude Code's own files.** `/loop` writes `.claude/scheduled_tasks.lock`. The CLI lists its runtime files in
  `.git/info/exclude` (`scheduled_tasks.lock` / `.json`, `checkpoints/`, `mailbox/`, `routines/.state/`,
  `agent-registry.json`, `agent-memory-local`, `first-run`, `assistant-daemon-state.json`), but the §32 mods capture
  force-added them, so the lock showed in the review. They are never mods now (`git/mods.ts` `isCliRuntimePath`).
- **Mac.**
  - A "백그라운드 N" chip in the HUD opens the list. Each task shows its description, kind, turn and time, with
    [출력 보기] (a sheet with the last 64 KB and 새로고침) and [중지].
  - A main-thread Bash row that still runs has [백그라운드로], which sends `task_background {toolUseId}`.
  - ⌃B in an empty message box while Claude works sends `task_background` without an id. With text typed, ⌃B still
    moves the caret back, as everywhere on the Mac. The row is in Help › Keyboard Shortcuts and docs/SHORTCUTS.md.
  - The `auto_turn` row sits where a user message would. Its title is one of "백그라운드 작업이 끝나 Claude가 이어서
    했어요" (실패해 / 멈춰 for the other statuses), "예약된 작업이 실행됐어요 (/loop)" or "Claude가 이어서 작업했어요".
    The task's description and the CLI's summary follow.
  - Settings › 세션 has "백그라운드 작업과 /loop 허용". It takes effect when the session restarts.
- **Electron.** The same chip, list, output dialog, row, button, Ctrl+B and setting.
- **Verified.**
  - Engine `w52.session.test.ts`, with the frames CLI 2.1.318 sends:
    - the task listed with its call and output file;
    - the notification turn taken, its calls waiting for the engine, its result a `turn_end`;
    - a `/loop` run offered, and when refused, §18 applies and it is someone else's command;
    - a short answer that ends before the engine is ready stays ended;
    - nothing taken before a turn of ours or with the setting off;
    - a dispose releases the waiting calls;
    - Agent calls keep their input (§52.2).
  - Engine `w52.background.test.ts`:
    - the list with the turn of its call;
    - `task_stop`, `task_background` and `task_output`, with their refusals;
    - an auto turn whose held text belongs to it, with `b.txt` (written by the build after B) `external` in its review and
      the accepted `a.txt` still accepted;
    - a scheduled run waiting for the collection;
    - a refused one;
    - a fresh A without background work.
  - Engine `git.mods.test.ts`: the runtime files are not mods.
  - Core `BackgroundWorkTests`: the lenient list, the commands' JSON, the replies and refusals in words, the event and the
    row (live once per turn, restored), the setting going out with `hello`.
  - Real CLI: `sidecar/test/driver-background.mjs`, with `RG_LOOP=1` (haiku, CLI 2.1.318).
    - The background `sleep 8; echo built > built.txt` was listed while it ran (kind `bash`, its call, turn 1).
      `task_output` answered.
    - The turn after it ended was `auto_turn {background}`. Its review held `after.txt` (`bash`) and `built.txt`
      (`external`). No unprompted text.
    - A `/loop 1m` run was `auto_turn {schedule}` with `tick.txt` in its review and no `.claude/` file.
  - Layout check at 1000 × 637: the chip and the auto-turn row (`background-1000x637.png`), the list
    (`background-tasks.png`).
- Owner: background-work (engine `session/background.ts`, `session/claude.ts` (§52 block), `session/hooks.ts`
  (`adoption`, `keepAgentsInTurn`), `engine.ts` (`onAutoTurnStart` / `adoptAutoTurn` / `task*`), `review/gate.ts`
  (`prepareAnswer(carry)`), `git/mods.ts`; Core `Engine/BackgroundProtocol.swift`, `Session/AppState+Background.swift`;
  App `UI/Chat/BackgroundViews.swift`; `sidecar/test/driver-background.mjs`).

### 52.2 Subagents work in the background, the main agent answers

Until 0.5.9 every `Agent` / `Task` call got `run_in_background: false` (§52), so the main turn waited for its subagents:
a message typed meanwhile sat in the CLI's queue (a skill that starts several reviewers left the user without an answer
for 25 minutes). In the terminal (CLI 2.1.318) the CLI runs an Agent call in the background and the main agent answers
while it works. The app does the same now, and the review still sees everything the subagent changes.

Seen with CLI 2.1.318 over stream-json (sonnet; default and auto mode, a project PreToolUse hook):

- The call is answered at once ("Async agent launched successfully. … agentId: …"), after `task_started {task_type:
  "local_agent", is_backgrounded: true, spawn_depth: 1}` and `background_tasks_changed`. The turn ends with its `result`.
- The subagent's tool calls carry `agent_id` (= its task id) in their hook input and `agentID` in `canUseTool`. A Bash
  call it makes is a `local_bash` task with `owned_by_subagent`, `parent_task_id`.
- A message sent meanwhile runs at once: `command_lifecycle started`, its answer, its `result` — the subagent goes on.
- When it ends: `task_updated {status}`, `task_notification {status, summary, output_file, usage}` — in auto mode the
  subagent reports through its `SubagentHandback` tool, and the notification says `handback: "send"` with
  `handback_report {text}` (its `summary` only points at the message). Then `background_tasks_changed`, and the CLI runs a
  turn itself (`system/init`, no lifecycle frame): the hand-back is replayed as a user message with `origin {kind: "peer",
  from: <task id>, senderTaskId, name: <agent type>, body, handback: true, handbackReportText}`, and the turn's `result`
  carries the same origin. Without a hand-back the turn's `result.origin` is `{kind: "task-notification"}`.

```ts
// settings.subagentsInTurn?: boolean                         // default false; next session start; only with backgroundWork
// tool_result + agentLaunched?: true                         // the call's answer when its agent went to the background
// tool_result + agentEnded?: true                            // that agent's own result when it ended (a second tool_result)
// auto_turn.task + kind?: "bash" | "monitor" | "agent" | "other"; toolUseId?: string   // summary: the agent's report
```

- **The call keeps its input** (hooks.ts). With `settings.subagentsInTurn` (opt-in, both clients' "서브에이전트가 턴
  안에서 끝나게") the PreToolUse hook still adds `run_in_background: false`, as before.
- **Its calls pass the §18 guard** (`hooks.ts unpromptedBlocked(…, agentId)`, `HookContext.backgroundAgent`). The session
  keeps the live background subagents (`ClaudeSession.bgAgents`): every `local_agent` task started with — or moved to
  (`task_updated {is_backgrounded: true}`) — the background, and every agent started under one of them (`parent_task_id`,
  else the subagent whose call started it), until its `task_notification` / a final `task_updated` status. A call whose
  hook input names one of them (or names an agent no task frame named while one of them works) is not denied while no turn
  of ours runs; `canUseTool` repeats the check with `agentID`. The main thread is guarded as before. Its card outlives
  the turn that started it: at `turn_end` the engine keeps a pending request whose subagent (`agent.agentToolUseId`)
  still works — pending, running or paused (`AgentTracker.isLive`) — so it can be answered between turns (the session
  holds it until then, or until `permission_cancelled`); every other request still ends with the turn. Before, the list
  was emptied there and the answer was refused `unknown_permission_request` while the subagent kept waiting.
- **What it changes reaches a review.** In a turn of ours its edits and commands are that turn's, like any call. While no
  turn of ours runs, the files its calls change (edit tools by their `file_path`, Bash by the post-Bash snapshot) are kept
  (`idleToolFiles`) and become the next turn's — the user's next message or the turn the CLI runs when the agent ends —
  whose review keeps A (§52.1), so they are in it with the agent's call as the cause (`origin: tool` / `bash`). A failed
  edit is no cause. An edit the review does not see — outside the project, in a nested repository or in Claude's memory
  (§8, §39.5: no card in auto mode) — made while no turn of ours runs is kept the same way (`idleChangedOutside`) and
  listed in the next turn's `changedOutside`; before, the turn's start dropped it. `finish_review` while background work runs (or ran since B) keeps that B for the next turn
  (`ReviewGate.finishReview(keepBase)`, `prepareAnswer(carry)`): what the agent writes after it is reviewed, not taken
  into a fresh A. That B keeps what the review knew of HEAD (§46: `baseHead`, a merge under way, Claude's own commits):
  when it becomes the next turn's A, what git brought in since — the user's pull, a commit outside the app — goes into it
  first, as `followHead` does for a standing review (Claude's own commits are not carried), so the turn does not list
  upstream's files as Claude's; commits that do not apply on it leave it as it is and `headMoved` says so. A commit the
  agent makes while no turn of ours runs is Claude's own too: its `git_result.ownCommits` go to the gate as a running
  turn's do (§46 `noteOwnCommits`; only background work runs git between turns), so the next review — standing, or
  finished meanwhile — keeps its files with `committedIn` instead of carrying the commit into A as someone else's.
- **The call's results.** The CLI's immediate answer is no report: the `tool_result` says `agentLaunched: true` (no
  `keptReport`, no `why` report). When the agent ends, the session sends a second `tool_result` for the same call with
  `agentEnded: true`: `preview` is its report (`handback_report.text`, else the notification's `summary`), `isError` when it
  failed or was stopped, `agentUsage` from the notification. It is recorded like any result, so the chat shows the agent's
  report under its group (the last result of a call is its result), `agent_report` answers with it, and §42.4 rebuilds the
  agent from the rows after a restart (a background agent with only its launch in the rows is still left out). The agent
  node's `summary` is the report too.
- **The hand-back is the agent's, not a peer's.** A replayed message whose origin has `handback: true` is never a
  `peer_delivered` (no "message from another session" card, no §18 episode) — `peerOriginOf` returns null, `handbackOf`
  reads it; it closes the call with its report when no notification did. A `result` with that origin is the end of the
  turn the engine took (§52.1), not an unprompted one. r2-peers: so is one whose `body` is the hand-back frame
  (`[Subagent hand-back] … The report follows:`) without the mark — the user's 0.5.9 records held such a "message from
  another session" from `general-purpose`, with [이 메시지 처리하기] sending the report back as a request — its report is
  the frame's text (`cleanAgentReport`). And any other peer-like message of the session's own subagent to the agent that
  started it (`senderTaskId`, else `from`, is a subagent task id this CLI process saw start — `ownSubagentOrigin`): no
  `peer_delivered`, and the turn the CLI runs for it is the auto turn it took (§52.1), its `result` that turn's end. A
  message from a session address or an unknown agent is a peer's as before.
- **The turn Claude runs after it** is `auto_turn {trigger: "background"}` as for a background command; `task.kind` is
  `agent`, `task.toolUseId` its call, `task.summary` its report.
- **A message of ours waiting behind such a turn.** When the user's message is queued in the CLI behind a turn the CLI
  runs itself (the hand-back came first), that turn's `result` does not end ours: the session waits for our command to
  start (`queuedOwn`, as for a message put into the turn, §50) and ends the turn with its `result` (both results' usage).
  Before, the first `result` closed the user's turn and the rest of it was guarded as unprompted (§18, "Limits").
- **The HUD and the agent panel.** A background subagent is in `hud.agents` (`isBackground: true`) while it works, across
  turns, and in "백그라운드 N" (§52, `kind: agent`) with [중지] (`task_stop`); the agent's own ■ (`stop_agent`, §36.2)
  stops it too. Either way it is stopped by the user: `task_stop` of an agent's task marks its node (`stoppedBy: "user"`,
  `AgentTracker.callOfTask`), and its result reads "사용자가 중지" instead of "에이전트 실패".
- **Mac.** Settings › 세션 "서브에이전트가 턴 안에서 끝나게" (`AppSettings.subagentsInTurnKey`, off; greyed out while
  background work is off; goes out with `hello` and, changed, with `set_settings` beside `backgroundWork`; next session
  start). An agent's group takes no report from the launch answer (`ToolResultInfo.agentLaunched`; its status comes from
  the node, else "running" while the turn runs) and shows the agent's own result when it ends (`agentEnded`, the call's
  last result) — "에이전트 보고" with the report, or "사용자가 중지". The auto-turn row says "백그라운드 에이전트가 끝나
  Claude가 이어서 했어요" (실패해 / 멈춰) with the agent's description and report (`AutoTurnInfo.Task.kind` / `toolUseId`;
  an odd kind reads as `other`).
- **Electron.** The same: Settings › General "서브에이전트가 턴 안에서 끝나게" (`settings.subagentsInTurn`, off, disabled
  while background work is off), the group without the launch's report (`agentMeta.shownAgentResult`), the agent's
  titles on the auto-turn row (`background.autoTurnTitle`).
- **Verified.** Engine `w52.agents.test.ts` (the session with CLI 2.1.318's frames: inputs kept / kept in the turn with
  the setting; the launch is no report; the subagent's calls pass the guard between turns — hook and `canUseTool` — the
  main thread's do not, nor its own after it ended; an agent it starts; its edits between turns in the next turn's
  `toolFiles`; its end as the call's result, once; no peer for the hand-back — nor for its frame without the mark, nor for
  another message of the agent to its parent, whose turn is ours (r2-peers); the hand-back turn ours; a stopped agent; our
  queued message's turn not ended by the CLI's), `w52.background.test.ts` (a finished review keeps its B while it works;
  as before without background work; stopped from the list, stopped by the user; its end recorded as the call's result,
  named on the auto turn, kept for `agent_report`), `session.agentHistoryRows.test.ts` (an ended background agent comes
  back after a restart); Core `BackgroundWorkTests` (the setting off by default, with `hello` and the toggle; the agent's
  auto turn and its titles; the launch is no result, the end is); Electron `background.test.ts`, `agentDetails.test.ts`,
  `backgroundSettings.test.ts` (the same).
  - Real CLI: `sidecar/test/driver-background.mjs` with `RG_AGENT=1 RG_ONLY=agent RG_MODE=auto RG_MODEL=sonnet` (CLI 2.1.318).
    The Agent call went to the background (Claude's own `run_in_background: true`; `agentLaunched`). "2+2" sent meanwhile was
    answered in 1.5 s with the agent still live (`backgroundTasks` `[agent]`). The subagent's Read of `big.txt`, denied by
    the project's read-budget hook, came back as `hookDenied {hook: "PreToolUse:Read"}` and no notice; it read in parts,
    slept 20 s and wrote `agent.txt` between turns — no §18 deny, no unprompted text, no peer card. Its end was the call's
    result with its hand-back report; the turn after it was `auto_turn {background}` with `task.kind: agent` and the report;
    `agent.txt` was in that review as `tool`, the agent's Write its cause.
  - Real CLI (r2-peers): `sidecar/test/driver-bgresume.mjs` (CLI 2.1.318) — a background subagent that replied, then
    continued with SendMessage ("sleep 12, then Write resumed.txt") while the main turn ended at once: the continued
    run's Bash and Write after that turn were not denied (no `unprompted_blocked`, no §18 reason in a result),
    `resumed.txt` was written after the turn and was pending in the next review (`tool`), the turns after each end were
    `auto_turn {background, agent}`, and no `peer_message` event or row came of any of it. haiku in the default mode
    (the Agent and SendMessage calls on cards, allowed); sonnet in auto mode: no card for the SendMessage to the
    session's own subagent (§33.2).
  - Real CLI (r2-peers): `sidecar/test/driver-agents.mjs` step d (`RG_ONLY=handback` runs it alone; CLI 2.1.319, haiku,
    the default mode) — one Agent call in the background that replied "ready": its first result was the launch
    (`agentLaunched`), its end the call's own result with the report (`agentEnded`, the node `completed`), the turn
    Claude ran after it `auto_turn {background, agent}`, and no `peer_message` event, no `state.session.peerInbox` entry
    and no `peer_message` row in the chat's record — nothing handled as unprompted. Steps a–c still expect subagents in
    the turn, as before §52.2 (on 2.1.319 step a sees one waiting agent where it expects two).

## 53. Commits in meaningful units

`commit` turns the accepted files into **one** commit, whole files only. The user commits in minimal meaningful units
(one behavior per commit, so any commit can be reverted or cherry-picked alone), and one file often holds changes of
two units. Now the commit sheet can split the accepted changes into several commits, down to hunks. Claude can propose
the split, the user adjusts it, and one command makes the commits in order. `commit` itself is unchanged.

```ts
type CommitHunk = { id: number; header: string; added: number; deleted: number; text: string };   // text: the lines after the header (+/-/space), ≤ 300
type CommitFile = { path: string; oldPath?: string; status: FileStatus; binary: boolean; hunks: CommitHunk[] };   // hunks [] → whole file only
type CommitPart = { path: string; hunks?: number[] };          // no `hunks` = the whole file
type CommitPlan = { message: string; parts: CommitPart[]; why?: string };
// command commit_hunks { paths? }            → reply commit_hunks { files: CommitFile[] }                       (git lane)
// command commit_split_draft { paths? }      → reply commit_split_draft { commits: CommitPlan[]; unassigned: CommitPart[] }   (side lane)
// command commit_series { commits: CommitPlan[]; push? } → reply committed_series { commits: { sha; shortSha; message; files: string[] }[]; branch; pushed }
// a failure after ≥ 1 commit: result { ok: false, error: "commit_failed:<git's words>", code: "commit_failed", partial: { commits, branch, pushed: false } }
```

- **Hunks** are those of `git diff HEAD -- <path>` (3 lines of context) — what a commit takes from the worktree — for
  accepted paths only (`paths` as `commit`: default `commit.acceptedPaths`, refused `nothing_to_commit` for any other).
  Ids are 0, 1, … in file order. An added, deleted, binary or renamed file, or one whose diff has a single hunk, can only
  go whole (`hunks: []`); so can a symlink, a submodule, a file whose mode changed and any file on an unborn branch.
- **`commit_split_draft`** is a read-only fork like `commit_draft` (§36.11, the same fork rules, refusals and side lane;
  `commit_split_failed:<why>`). It gets every hunk (path, id, header, text; cut at 3 000 lines in all, then the file list),
  the last 20 commit subjects, the branch and `settings.commitTemplate`, and the conversation's context. It is asked for
  the smallest meaningful commits in an order where each one builds: dependencies first, docs in the commit of the change
  they describe, an unrelated fix or a regenerated file in its own commit, each message in the project's format. It
  answers JSON (`{"commits":[{"message","why","parts":[{"path","hunks"}]}]}`; a code fence or a preamble around it is
  fine). The engine keeps only valid parts (a known accepted path, known hunk ids, no hunk twice — a later repeat is
  dropped; a whole-only file goes whole whatever hunks were named; a part naming every hunk is the whole file) and
  commits with a message and a part left. What is left over is `unassigned`. Nothing is committed. Besides the fork's
  own failure: `commit_split_failed:empty answer`, `…:no JSON plan in the answer`, `…:no valid commit in the answer`.
- **`commit_series`** makes the commits in order, then pushes once when `push` (default `settings.commitPushByDefault`).
  - Refusals:
    - like `commit`: `no_project`, `session_running`, `collect_failed`, `nothing_to_commit` (also: no commits, a commit
      without parts), `empty_message` (any commit), `git_identity_missing:…`, `merge_unresolved` (any merge in progress:
      a series cannot conclude it — `commit` does);
    - `invalid_part:<path>` (a path that is not accepted, an unknown hunk id, `hunks: []`, a whole-only file given hunks);
    - `hunk_twice:<path>#<id>` (a whole file includes every hunk; a whole-only file twice: `hunk_twice:<path>`);
    - `commit_failed:<git's words>`.
    A refusal before the first commit changes nothing.
  - Each commit is made with git's own `commit` on a temporary index (`GIT_INDEX_FILE`) that starts from `HEAD`, so the
    repository's hooks run as for `commit`. A file split by hunks gets HEAD's content with the hunks of this and the
    earlier commits applied (computed from the one `git diff HEAD` taken before the first commit). A whole-file part
    takes the worktree's content (or its deletion; a rename stages both paths). `settings.commitTrailer` is added as
    `commit` adds it.
  - The worktree is never written. The user's own index keeps everything except the committed paths, which are set to
    the new HEAD, as `commit --only` leaves them. A failure in the middle stops there and is refused
    `commit_failed:<words>`; when at least one commit was made, the refusal's `result` carries them as `partial`
    (`{ commits, branch, pushed: false }`, the shape of `committed_series`) and nothing is pushed. No
    `committed_series` event goes out then.
  - Afterwards A is rebuilt with the committed content of every touched path and B re-snapshotted, as after `commit`. A
    file with hunks left uncommitted stays in the review, accepted, with only those hunks in its diff. A file fully
    committed leaves it. `state.commit.lastCommit` is the last commit; each commit is a §38.3 history row.
- **Mac** (`CommitSheet`, `CommitSplitPanel`; Core `CommitSplitState`, `CommitSplitSession`, `CommitSplitText`).
  - "한 번에 커밋 / 나눠서 커밋" sits beside the sheet's title (off with no file ticked). "나눠서 커밋" takes the ticked files
    (`commit_hunks`) and starts as one card with everything and the sheet's message. The sheet is then 640 pt wide.
  - A card: "커밋 N" with ↑ / ↓ / ✕ (its parts go to "커밋하지 않음"), its message, then its files in diff order. A file
    shows "k of n parts" when the card has only some of its hunks. A hunk shows `#id`, its header and +/−, and its lines
    (as the engine sent them) on a click. A file and each hunk have a → menu: the other cards, then "커밋하지 않음".
    "커밋 추가" adds an empty card; "커밋하지 않음" lists what stays in the review.
  - "AI로 나누기" (`commit_split_draft`, side lane) shows "나누는 중…" while Claude works. Claude's cards replace the
    user's, each with its why under the message, and what none took goes to "커밋하지 않음". "원래대로 되돌리기" puts back the
    cards from before. A refusal is one orange line in words; an engine before §53 says to update ReviewGate.
  - "커밋 N개 만들기" (⌘↩; push as for one commit) says next to it why it is off: no card, a card without a message or
    changes, a turn running. A refusal is one red line in words. A series that stopped lists the commits it made (short
    sha, subject), then why; the button stays off ("이 창을 닫아 주세요 — …") and Cancel becomes Close.
  - A refused push after every commit closes the sheet, and the Changes banner offers "Push now", as after `commit`. After
    a series the banner's second line names its commits ("커밋 3개를 만들었어요 (…)").
  - `result.partial` reaches the request as `EngineClientError.refused(…, partial:)`.
  - Layout check at 1000 × 637 (`SHOTS_LAYOUT=1`): the sheet on the window with the user's cards and a hunk open
    (`commit-split-cards.png`), Claude's split (`commit-split-ai.png`), a series that stopped after its first commit
    (`commit-split-stopped.png`), and "한 번에 커밋" with the mode picker (`commit-single.png`).
- Owner (Mac): Core `Engine/CommitSeriesProtocol.swift`, `Engine/EngineClient.swift` (`refusal(of:)`),
  `Session/CommitSplit.swift`, `Session/AppState+CommitSeries.swift`; App `UI/Sidebar/CommitSheet.swift`,
  `UI/Sidebar/CommitSplitViews.swift`. Tests: `Core/Tests/ReviewGateCoreTests/CommitSeriesWireTests.swift`,
  `CommitSplitTests.swift`.

## 54. No change budget by default

The per-turn change budget (§4) stopped Claude in the middle of ordinary work. The clients' default append told Claude to
work in units of at most 10 files / 400 changed lines, then stop and wait for the user, and the hook denied every edit past
twice that — a Spring change that touches an entity, a DTO, a mapper, a service, a controller and their tests is past 10
files on its own, and a skill that writes a dozen files never got through. Claude Code in a terminal has no such limit.
The budget is now opt-in.

```ts
type Budget = { maxFiles: number; maxLines: number; hardMultiplier?: number };   // 0 = no limit on that count
// DEFAULT_SETTINGS.budget = { maxFiles: 0, maxLines: 0, hardMultiplier: 2.0 }  — no change budget
```

- **Off** — both counts 0 (or below, or not a number); the default, so a `hello` without `budget` runs without one. The
  hooks count nothing (no pre-edit estimate, no post-Bash numstat — the post-Bash snapshot still attributes files, §31),
  emit no `budget_event`, deny nothing and add no budget note after an edit;
  `state.budgetUsage` stays `{files: 0, lines: 0, denied: false}`. A budget turned off during a turn stops counting and
  denying at once.
- **On** — the client sent a limit: §4 as before. A count of 0 next to a limit on the other is no limit on that count (the
  deny reason then reads `files 12`, not `files 12/0`).
- **Told to Claude** — the §38.2 note covers a budget turned on or off while a session runs. Nothing about a budget
  reaches Claude while there is none.
- **Per turn, really.** The session's hooks get the turn's own start tree (§34.1), not A: a request-changes turn or a
  question keeps A for the review, and the post-Bash numstat used to count everything the review held since A — the
  earlier turns' lines too — against the new turn. A turn with no start of its own (no chat record) still gets A.
- **Lines as git counts them.** The pre-edit estimate of an `Edit` / `MultiEdit` is the file's content before vs after the
  edit(s), added + removed lines — it counted `old_string` and `new_string` whole, so the context they carry counted
  twice (a turn git measured at +153 lines was charged 765). Without the file, or when an `old_string` is not in it, each
  edit's own two strings are diffed (× occurrences with `replace_all`). A diff that takes over 500 ms counts both texts
  whole. `Write` diffs the old content as before; `NotebookEdit` counts `new_source`.
- **After a deny** only change attempts are refused for the rest of the turn: every edit, and a Bash command that writes
  files (`>` / `>>`, `tee`, `sed -i`, `rm`, `mv`, `cp`, `touch`, `mkdir`, `chmod`, `npm i`, `npx`, `pip install`) — a
  redirection into `/dev/null` or onto another stream (`2>&1`, `>&2`, `&>/dev/null`) writes nothing and no longer counts.
  Reads, searches, subagents and the to-do list are never counted or refused, and the turn is not interrupted: more than
  five tool calls of any kind after a deny used to stop it (`stopReason: "interrupted"`), and the clients' queue with it.
  A message put into a running turn (§50 `steer`) joins that turn and so its budget: nothing resets it.
- **No "stop after each unit" either.** An approved plan's follow-up (§11 `plan_response`, §42.1 into a new chat or
  workbench) said "Work in small units and stop after each unit for review.": Claude stopped after the first step of every
  plan. It is now just "Implement the approved plan at <path>." (the variants as before). With a budget on, the note after
  an edit at 100 % no longer ends "Finish only the current unit, then stop and report." (Claude stopped at the soft limit,
  half way to the deny); it reads `Budget note: 410/400 lines, 3/10 files used this turn — the user's change limit is
  reached; edits past 2× it are denied.` The deny's own reason (§4) still asks for a short report: nothing more can be
  edited then.
- **Wire decision.** Off is `{maxFiles: 0, maxLines: 0}`, not `budget: null`: `state.budget` stays an object (an older
  client decodes every state) and `set_settings{budget}` keeps meaning "replace it". An older client always sends its own
  budget (10 / 400 / 2.0 unless changed) with an append that tells Claude those numbers, so it keeps its budget on a newer
  engine — what Claude is told and what the hook enforces stay the same. A newer client never runs an older engine (both
  clients bundle theirs); an older engine would read `{0, 0}` as "deny every edit".
- **Clients.** The change limit is a switch, off by default; its numbers (files and lines, 10 / 400 until changed) reach
  the engine only while it is on — off, the clients send `{maxFiles: 0, maxLines: 0}`. The default append is now "You are
  working inside a review gate. Run git commands that change the repository (commit, merge, pull, checkout, reset, stash,
  …) only when the user or a skill they ran asks." — nothing about small units, stopping, waiting or 'REVIEW GATE', and
  (r1-git, §46) no promise of an approval card for each git command any more: only what throws work away or rewrites the
  remote asks, as the engine's own git instruction says; a skill's commits (`allowed-tools: Bash(git commit:*)`) are the
  user's request too. Its first text ("… only when the user asks — the app shows the user an approval card for each.") is
  an earlier built-in one now (Mac `AppSettings.legacySystemPromptAppends`, Electron `src/shared/systemPrompt.ts`
  `LEGACY_SYSTEM_PROMPT_APPENDS`). With the limit on it goes on "The user set a change limit of {maxFiles} files and about
  {maxLines} changed lines per reply: plan each reply to fit it. If an edit is denied with 'REVIEW GATE', report what you
  changed and what remains." A stored append equal to an earlier built-in one (the one before, or the one with "Never run
  git commit/checkout/reset/stash/clean"; surrounding whitespace aside) is the default: Settings' "Reset to default" used to
  store the text itself. An append of the user's own is untouched; its `{maxFiles}` / `{maxLines}` get the limit's numbers,
  on or off. Mac: Core `AppSettings` (`budgetEnabled`, `budget` — `Budget.off` while off —, `budgetLimits`,
  `renderedSystemPromptAppend`, `forgetLegacySystemPromptAppend` — it removes a stored earlier built-in text), `Budget.isOn`;
  tests `Core/Tests/ReviewGateCoreTests/ChangeLimitTests.swift`. Mac UI: Settings › 한도 has "응답당 변경 한도 두기" (off) above
  the two steppers, which are greyed out while it is off, and a note on what off means; a change goes to every open
  window's engine. While off the HUD shows no change-limit chip and the chat's empty state names no limit ("Claude가 바꾼
  내용은 계속하기 전에 리뷰하게 됩니다."). With it on a warn row reads "변경 한도 도달: …" and a deny row "변경 한도 초과 — 편집
  거부됨 (…)". The append's "Reset to default" removes the stored text, and the app drops a stored earlier built-in text at
  launch. The plan sheet's approve button no longer says "in small units" in its help. Electron: `settings.budgetEnabled`
  (absent: off; the renderer may write a boolean), main's `budgetOf` / `systemPromptOf`, the texts in
  `src/shared/systemPrompt.ts`; the settings file now keeps "" for the built-in append (it kept a copy of every default, so
  nearly every file holds the old text) and an earlier built-in text reads as "". Test:
  `clients/desktop/src/main/changeLimitSettings.test.ts`. Its renderer does what the Mac does — Settings › 한도 with the
  switch and greyed-out steppers, the append box showing the built-in text as its placeholder, no HUD chip and no limit in
  the empty chat while off, the rows' 변경 한도 words, the plan dialog's title without "in small units" (test:
  `clients/desktop/src/renderer/changeLimitView.test.ts`).
- Owner: engine `session/budget.ts` (`budgetIsOn`, `BudgetState.active`), `session/hooks.ts`, `session/longWork.ts`
  (`budgetChangeNote`). Tests: `engine/test/session.budget.test.ts`, `session.hooks.test.ts` (§54), `longWork.test.ts`,
  `engine.friction.test.ts` (the defaults).

## 55. Polish: the details of a Mac app

Every screen gets the small things a Mac app does without being asked: a button that answers the pointer, a tooltip that
shows soon and names its key, a copy that says it copied, a cut path or time that reads in full on hover, the reason a
button is off, Esc and Return in every dialog, and a question before the last window closes (the polish audit's areas P1–P5
and its critic's items). The polish lanes add them screen by screen, each in a subsection of its own here. No wire change:
clients only, unless a subsection says otherwise.

### 55.1 What every screen shares

The pieces the other lanes build on (lane p-foundation), and what they changed where they already show.

- **Icon buttons answer the pointer** (Mac). Every icon-only button (`IconButtonStyle`, App/UI/Appearance.swift: a banner's
  ✕, find ↑ ↓, a panel header's icons, the composer's 📎 and @, a chip's ×) shows a rounded wash while the pointer is over
  it — the label colour at 8 % (12 % in dark appearance, where the same alpha reads weaker) — and at 16 % while pressed,
  the glyph still dimming then; a disabled one shows none. The hover is the button's own state: a list of them never
  redraws for the pointer.
- **Tooltips show sooner** (Mac). After 0.4 s instead of macOS's 1.5 s, so one shows before the pointer moves on — the
  hover-only buttons (copy, edit, ■, 왜?) no longer need two long waits. `NSInitialToolTipDelay` = 400 is registered in
  the app's registration domain at launch (`AppDelegate.applicationWillFinishLaunching`): a value the user set (for the
  app or globally) still wins, and nothing global or another app's changes. A disabled control shows its tooltip too, so
  why it is off goes in that control's `.help` (no wrapper).
- **The Windows client's page speaks the UI's language** (Electron). `initI18n` sets `<html lang>` to the UI language
  ("ko" / "en"; it was always "en"): Narrator and NVDA read Korean with a Korean voice, and Chromium shapes and breaks
  Korean lines as Korean. `t()` spells ⇧⇥ (the permission mode's key) as Windows does, Shift+Tab, like ⇧↩ → Shift+Enter
  (§42.5).

### 55.2 The chat-move notice (lane r2-guards)

- **Its Dismiss says what it does** (Mac). The orange notice above the message box when a chat move was refused or failed
  (§39.4, `ChatMoveBar`): its 닫기 shows "이 알림 닫기" on hover (polish P4-composer-37; the other bars above the message box
  are their own lanes' parts of that item).

### 55.3 Messages between sessions (lane r2-peers)

- **The peer card's ⋯** says what it holds — tooltip "다른 세션 메시지 옵션 — 이 프로젝트는 받지 않기", VoiceOver "다른 세션
  메시지 옵션" (it was "More") — and while the messages are handed over [거절] and ⋯ are off and say why: "메시지를 넘기는
  중이에요" (polish P1-chrome-18, P4-composer-36). The tooltip sits on the menu, not on its item.
- **Peer rows** (delivered, dropped, read without being held) copy on right-click: 메시지 복사 (when there is a body) and
  보낸 세션 주소 복사, each with the "복사됨" toast — over the message's own text too, as over an answer (P4-composer-36).
- **The SendMessage card's receiving session**: the line under its name ("터미널 · ~/acme · 입력 대기") and its address
  are cut in the middle and show all of themselves on hover (P4-composer-24).
- **"다른 세션에 보이는 이 창 이름"**: the explanation is on the name, not on the whole row, so the copy button's own
  tooltip ("복사됨" once copied) shows; the copy also says "복사됨: …" in the toast (PX-03).
- Mac: `PeerViews.swift` (`PeerInboxCard`, `PeerMessageRow`), `PeerSessionViews.swift`, `PeerText.moreHelp` /
  `moreLabel` / `deliveringReason`.
- Electron: the same — `PeerCard` (⋯ is "⋯" with its `ariaLabel` and title; [거절]'s and ⋯'s title while the messages
  are handed over), `PeerMessageRow` (the right-click menu, `peerCopyItems`; the sender's address on hover over the name
  and the dropped line), `PeerRecipientLines` (the detail line's title); test `peerCardView.test.ts`.

### 55.4 Side questions (lane r2-skills-side)

The side panel (§21, §40.3) on both clients — no wire change.

- **Nothing typed is lost** (P3-transcript-28). The new-question text is kept per anchor (another "왜?" opens its own; it
  was cleared, and the Mac's 왜? on another line wiped what was being written) and each thread's follow-up per thread; both
  per chat — the Mac in its defaults (`sideDrafts.<chatId>`), the Windows client in `localStorage` (`rg.sideDrafts.<chatId>`,
  the drafts moved from the panel's component state into `storeSide`, so closing the panel, another thread or Esc kept
  nothing before). A chat switch brings the chat's own back, a restart too; asking empties that one (on the Mac also when
  the anchor was removed with × before asking). Since nothing is lost on close, the quit / close question (§55.1,
  P3-transcript-29) lists no line for them; it lists the send sheet while it is up (Mac, `registersUnsavedWork("sidePromote")`;
  the Windows client's promote dialog once its drafted text is there, `useUnsavedWork("sidePromote")`): "곁질문에서 정리한
  지시문이나 메모를 아직 보내지 않았어요. 닫으면 사라져요."
- **A skill goes to the main chat** (§21, r2 M18): the refusal `side_command` or an answer whose `Skill` call was denied
  shows "메인 대화에서만 실행돼요 …" with [질문을 메인 대화로 그대로 보내기] — named apart from the footer's [메인 대화로 보내기],
  which first turns the answer into an instruction — the question as typed, sent now or held by the composer queue (a
  running turn, a card, a session that is starting, a paused queue), the toast saying which as the queue itself decides;
  a denied `Skill` call's "read-only" mark says "스킬은 메인 대화에서만 실행돼요".
- **Keys and closing** (Mac, P3-transcript-15): Esc goes back from a thread or a new question to the list, then closes
  the panel; ↑ / ↓ pick a thread in the list (an accent outline) and ↩ opens it; the head has ✕ "곁질문 닫기 (⌥⌘S)"; the
  new-question buttons say "선택 항목에 대해 묻기 (⌥⌘/)" — the menu's name for that key (P3-transcript-31); the follow-up's
  send button is "묻기" to VoiceOver as in its tooltip; the send sheet's Send says what it does with its key ("메인 대화로
  보내기 (⌘↩)" / "리뷰 메모로 추가 (⌘↩)"). The Windows client already closed on Esc.
- **Copy** (P3-transcript-10, 11, 09): a finished answer has a hover copy button (both) and "답변 복사" in its right-click
  menu (Mac: the text's own menu too); the question bubble "질문 복사"; a list row "질문 복사" / "마지막 답변 복사" (Mac); on the
  Windows client the right-click on Claude's answer in the main chat starts with "복사" (the selection) and "메시지 복사".
- **Words for what a row is** (P3-transcript-07, PX-04, 31): a side answer's tool call says what it did in the tooltip on its
  name and detail (`ToolRowTooltip` / `toolRowTooltip`, "명령 실행: …", "파일 읽기: …" — the input as JSON before; the row-wide
  tooltip that hid the status mark's is gone), ✓ / ✕ are "도구 결과" / "도구 오류"; the Windows client's delete reads "이 곁질문
  삭제" with the trash glyph (it was "이 스레드 닫기" and 🗑).
- **Full values and times** (P3-transcript-22, 23, 24, 26, PX-21): an anchor chip, a tool call's rationale, a preview line and
  the send sheet's destination show in full on hover; "3분 전" keeps up and shows the exact time on hover (`RelativeTimeText` /
  `<RelTime>`); a failed thread's "실패" says why on hover.
- **Hover and input** (P3-transcript-19, PX-05): the suggestion chips answer the pointer (`hoverHighlight`, help "바로
  묻기"); the send sheet's editor keeps quotes and dashes as typed (`.plainTextInput()`), so code reaches Claude as is.

### 55.5 Reviewing and the message box (lane r2-review-flow)

The review list, its sheets and notices, the review menus and the message box (lane r2-review-flow, on top of §55.1's
pieces). Clients only.

- **The menu keys are rows of the shortcut table** (both apps, docs/SHORTCUTS.md). View › 변경사항 / 기록 / PR / 검색
  ⌥⌘1–4, 최신 메시지로 이동 ⌥⌘↓, 확대 ⌘+ / 축소 ⌘− / 실제 크기 ⌘0; Edit › 다음 찾기 ⌘G / 이전 찾기 ⇧⌘G; Review › 다음 변경
  ⌥⌘] / 이전 변경 ⌥⌘[, 에디터에서 열기 ⌘⇧E, 경로 복사 ⌥⌘C, 이 브랜치로 PR 만들기… ⌥⌘K. A key only the Mac app has shows "—"
  in the Windows column with "Mac 앱에만 있어요", and the key lookups (`ShortcutTable.windowsKey`, Electron `shortcutKeyOf`)
  name none for it — no tooltip of the Windows client spells a key it does not have.
- **View menu** (Mac). The sidebar's tabs from the keyboard (⌥⌘1–4; ⌘1–9 stay the chat tabs); 최신 메시지로 이동 ⌥⌘↓
  (the "↓ 최신" pill's action, `jumpToLatestTick`); the diff's 전체 파일 보기 / 공백 무시 / 줄바꿈 switches (`DiffPrefsKeys`,
  shared with the diff header, kept across files and launches); 확대 / 축소 / 실제 크기 — one text size for the app (0.8–1.6 in
  steps of 0.1, kept; `TextScale`), which the message box's font follows.
- **Edit menu** (Mac). 채팅에서 찾기 ⌘F finds where the user is: the History tab's search on that tab
  (`historySearchFocusTick`), the diff after a click in it (`lastFocusArea`), else the chat. 다음 찾기 ⌘G / 이전 찾기 ⇧⌘G step
  the chat's find (`transcriptFindNextTick` / `…PreviousTick`), its bar closed too; while the bar is open its own ⌘G buttons
  answer first.
- **Review menu** (Mac). 다음 변경 ⌥⌘] / 이전 변경 ⌥⌘[ move inside the file's diff (`nextChangeTick` /
  `previousChangeTick`; ⌘] / ⌘[ still move between files); 메모 추가… ⌥⌘N (`addNoteTick`, off while the diff cannot open a
  note — `canAddNote`); 에디터에서 열기 ⌘⇧E (the editor of Settings, else the first installed); 경로 복사 ⌥⌘C ("경로 복사됨");
  이 브랜치로 PR 만들기… ⌥⌘K (it was only in the branch menu and the commit banner). Workbenches › 워크벤치 새로고침 is no longer
  the same name as View › 새로고침 (⌘R).
- **Edit › 실행 취소 takes a review decision back** (Mac). An accept — from the menu, the diff header or the list's menu —
  registers "수락 실행 취소" (⌘Z): the file is pending again (accepting changed nothing on disk); "모두 수락" registers its own,
  for the files still accepted. A reject that the engine can still bring back registers "거절 실행 취소" — the reject banner's
  거절 취소; when the offer is gone it beeps. A reject that waits for the turn's end (§34.2) registers nothing. The stack is the
  window's, shared with its text fields, so the menu names what ⌘Z undoes.
- **The changed-files list says what each part is** (Mac). The status letter ("수정됨"), "+12 −3" ("12줄 추가, 3줄
  삭제"), a tool chip ("Claude가 Edit 도구로 바꿈"), the folder toggle, the summary ("다음 대기 파일 ⌘] · 이전 ⌘["), and why
  모두 수락 / 모두 거절 are off ("대기 중인 파일이 없어요"). The row no longer has a tooltip of its own — it hid every one inside
  it (the reviewed dot, notes, risk and author chips, 왜?); the path's tooltip is the full path, with a rename's old one. The
  hover-only 왜? is always laid out, shown on hover and on the selected row, so the counts no longer jump under the pointer.
- **The row's menu and ⌘C** (Mac). The menu shows the menu bar's keys (⌘⇧A / ⌘⇧U / ⌘⇧R) and has 경로 복사 and
  전체 경로 복사, each saying "경로 복사됨"; ⌘C (Edit › Copy) with a row selected copies its path.
- **The list's states** (Mac). Empty: "아직 리뷰할 변경이 없어요", what the list is for, and [지난 리뷰 보기] (the History
  tab). While the new turn's changes are collected the previous round's files carry a header line ("이전 라운드 — 새 턴의
  변경을 모으는 중이에요") instead of being drawn at half opacity (their gray text fell to 2.5:1). A failed collection has
  [오류 복사] beside [다시 시도].
- **Notices** (Mac). A notice's ✕ says when it comes back — "이번 턴 동안 숨기기", other sessions' "앱을 다시 열 때까지
  숨기기", the restored banner's "리뷰가 다시 복원되면 보여요". The integrity chips and their popover's path rows answer the
  pointer; a path row says "Finder에서 보기 — <path>" and has a menu (Finder에서 보기, 경로 복사, and 열기 for a file outside the
  project); a nested repository's listed files have the same menu.
- **The Accept all sheet** (Mac). The path's tooltip is the whole path and what a click does ("… — 눌러서 diff 보기"),
  on the path rather than the row, so the "sensitive" and "not viewed" chips' tooltips show; a tool chip names its tool.
- **The commit sheet** (Mac). The Commit button says what it does with its key ("체크한 파일을 커밋해요 (⌘↩)", "…커밋하고
  푸시해요") or why it is off (nothing ticked, no message, the lock's reason); "커밋하는 중…" / "커밋하고 푸시하는 중…" beside the
  spinner; a cut path reads in full on hover; a file's menu has its path, Finder, the editor and 리뷰에서 보기 (the sheet closes
  and the review selects it); the message is kept as typed (no curly quotes or em dashes).
- **"나눠서 커밋" keeps its cards** (Mac). Closing the sheet (Esc, Cancel) keeps the cards in the window
  (`WindowModel.commitSplitStash`); the next opening comes back in "나눠서 커밋" with them while their files are all still
  accepted, and turning the mode on for the same files restores them too. A series that ran (some commits made) is not kept.
- **The message box says what its controls do and why they are off** (Mac). Stop: "Claude 작업 중지 (⌘. · esc)"; the
  send buttons name the key in use (↩, or ⌘↩ with "↩로 메시지 보내기" off); the send menus show "중단하고 보내기 ⌥⌘↩" and "질문과
  별개로 보내기 ⌥↩" in their labels (a key equivalent there would fight the text view's). An off control says why: 보내기 (the
  engine's reason, or "메시지를 먼저 입력하세요"), 변경 요청 ("보낼 리뷰 메모가 없어요 — diff에서 메모를 먼저 남겨 주세요"),
  수락 후 보내기 (off with an empty box), 답하기, 다시 시작, @, 업무로 실행 ("실행 중인 채팅으로 돌아가야…"), 다음 메시지 모델
  ("모델 목록을 아직 받지 못했어요"). The pending-review banner's tooltip lists the review keys; the features caption counts with
  units ("스킬 12개 · 커맨드 30개 · MCP 서버 3개"), explains "(캐시됨)", and no longer has a tooltip over it all (it hid the
  warning dots' own).
- **Where typing goes, and room for it** (Mac). The message box has an accent border while it has the focus (a drop's
  dashes win). It grows with its text up to 40 % of the window (at least 128 pt); its top edge drags it taller — the dragged
  height is kept and is the box's least height, up to 60 % of the window — and a double-click on the edge gives it back its
  own height.
- **Closing names the attached images** (Mac). The window's close and quit question (§55.1's unsaved-work lines) says
  "첨부한 이미지 N개가 사라져요." while the box holds images — they are never saved; the text is (§42).
- **PageUp / PageDown page the conversation** (Mac). In the message box (no palette open) they post
  `transcriptPageUpTick` / `…DownTick`, which scroll the transcript a page, instead of moving the box's caret.
- **The @ and / palettes** (Mac). The pointer moves the selection as ↑ / ↓ do. A mention row's tooltip is its full
  path (the changed-files row: "현재 리뷰의 파일 N개를 한 번에 멘션해요"); VoiceOver reads rows as buttons; the header reads "↑↓
  이동 · ↩/⇥ 추가 · esc 닫기". A failed `list_files` is said — "파일 목록을 못 가져왔어요: <why>" with [다시 시도] — no longer
  "일치하는 파일 없음" (Core `listFilesResult`). A / command's tooltip carries its whole name (cut in the middle in the row) with
  its description, or says it has none ("/name — 설명이 없는 커맨드예요 · ↩로 입력란에 넣기").
- **Copying from the transcript** (Mac). An answer's menu has 텍스트로 복사 — as it reads, without the markdown's marks
  (Core `MarkdownBlocks.plainText`: headings and emphasis bare, "•" for bullets, code without fences, a table's cells by
  tabs); a proposed plan's row has 계획 복사. Both say "복사됨".
- **⌘F marks the words, rows tell their time** (Mac). A finished answer receives the find's match
  (`transcriptFindMatch`), so its words are marked, not only the row. An answer shows when Claude wrote it on hover — not one with
  tooltips of its own inside (a code block's Copy, the "ran without a request" badge), which an outer tooltip would hide — and
  a turn's end line starts with its time ("오후 3:42 · …", the full date on hover), from `RowClock`; a row without a time has
  no tooltip at all.
- **The change limit's rows have the way out** (Mac). A "change limit reached / exceeded" row has [한도 바꾸기…], which
  opens Settings (General holds the limit).
- **Restored rows at full contrast** (Mac). Rows restored from an earlier session are drawn as any other (at 0.6 their
  gray text fell to 2.6:1 in dark mode); the "이전 세션에서 복원됨" divider says where the past begins.
- **Enter sends as on the Mac** (Electron). With "Return sends the message" on (`AppSettings.returnSends`; absent: on)
  a plain Enter takes ⌘↩'s path (send, answer, into the turn, the queue — `composerEnter`), Shift+Enter is a new line, an
  empty box swallows Enter, and an open palette keeps its own Enter (`plainEnterAction`); off, Enter is a new line and
  ⌘↩ / Ctrl+Enter sends. The hint, the placeholder and the send buttons' tooltips name the key in use (`sendKeyLabel`,
  `workingHint`). On Windows a bare ↩ / ⇥ left in a text reads Enter / Tab.
- **The message box's names and reasons** (Electron). Stop has its key in the tooltip and a name for screen readers (■
  is hidden from them); ▾ "다른 보내기 옵션", the attach error's ×, the text area ("메시지") have names; an off control says why
  (첨부 and 업무로 실행 without a project or from another chat, 변경 요청 without notes, 답하기, 보내기); the mode suggestion's
  예 / 아니요 say what they do; the capabilities caption explains "(캐시됨)". The send menu works from the keyboard: it opens on
  its first item, ↑ / ↓ move, Enter / Space choose, Esc closes it and gives the focus back to ▾.
- **The message box grows with its text** (Electron), up to 40 % of the window, from the height it was last dragged to
  (its resize corner; kept in this computer's storage) — a long prompt is no longer typed in a 60 px slot.
- **Closing names what it would lose** (Electron). The window's close question (§55.1's unsaved-work lines) names the
  attached images and the message being typed (both live only in this window). The composer also reports, per chat, whether
  it holds a draft or images (`useComposerPresence`, storeComposer.ts) for the chat tabs to show.
- **The / palette follows the pointer** (Electron), as the mention popover does, and a command without a description
  says so in its tooltip ("/name — 설명이 없는 커맨드예요 · ↩로 입력란에 넣기").

### 55.6 Chats and cards (lane r2-chats-cards)

The permission, question and SendMessage cards, the composer's chips, the chat tabs, the history, the error banner and the
bar of a chat shown read-only. Both clients unless a bullet says otherwise; the Korean is the Mac's catalog's.

- **Permission cards** (polish P4-composer-24 / 25 / 27, PX-02 / 03 / 10). The command / input / message block has a copy
  button ("명령 복사", "입력 복사", "메시지 복사"; "복사됨") and the card a right-click menu: 명령 복사, 입력(JSON) 복사 and, with a
  file, 경로 복사 and Finder에서 보기 (탐색기에서 보기 on Windows). The title's tooltip says the keys while the card waits
  ("여기를 클릭하면 키보드로 답할 수 있어요: 1 또는 ⌘↩ 허용 · …") and the tool's own name only when the title reads otherwise
  ("도구: mcp__…"); none once it is answered, and the chips and buttons keep theirs. [거부], [거부하고 지시…] and a SendMessage
  card's [거절] / [보내기] say what they do and their key; the "항상 허용" preview takes ↩ (save and allow) and esc (back); a
  SendMessage card's recipient lines read in full on hover. A deny instruction being written is listed by the close / quit
  question (P4-composer-07). Mac: also the whole path on hover, the always-allow patterns as menu subtitles, the reason
  beside a disabled "이 프로젝트에서 항상 허용…", the "이미 처리된" toast as a button for VoiceOver and the agent panel's waiting
  command in full on hover.
- **Question cards** (polish P4-composer-26 / 27 / 42 / 07). [답하기] says why it waits ("모든 질문에 답하면 보낼 수 있어요 —
  남은 질문 2개") and [건너뛰기] what it tells Claude, each with its key; the number badge says the message box takes the
  number too and 기타… what it is for; what was picked, typed or noted is listed by the close / quit question. Electron uses
  the Mac's words ("Claude의 질문", "답변을 입력하세요") and [건너뛰기] is a plain button, as on the Mac. Mac: also an option row
  answers the pointer, and the focused card takes ↑ / ↓ (an option), space (pick it) and 1–9.
- **Composer chips and the image preview** (polish P4-composer-17 / 31 / 14 / 40 / 42, PX-02). A mention chip's × says
  "멘션 빼기" and an image chip that a click shows it larger ("… — 클릭하면 크게 봐요"); the preview's 복사 takes ⌘C / Ctrl+C
  (while no text is selected) and says "복사됨". Mac: also a mention chip's right-click menu (경로 복사, Finder에서 보기, 에디터에서
  열기, 멘션 빼기) with × as its own control and named action, an image chip's (미리보기, 이미지 복사, 이미지 빼기), a preview
  sheet that fits the window and keeps the size it was dragged to, an attach refusal with × that stays while it has several
  lines, and the composer's hint lines in full on hover.
- **Chat tabs** (polish P4-composer-33 / 34 / 08 / 05, PX-19 / 02 / 03). A tab's tooltip is its whole title and its key
  ("Mapper fix (⌘1)", "… — Claude 세션이 이 채팅에 있어요 (⌘1)"), on the title so the badges keep theirs; × says "탭 닫기
  (⌘⇧W) — 채팅은 채팅 기록에 남아요" (or why it is off) and is read with the tab's name ("‘…’ 탭 닫기"); ✎ marks a tab with an
  unsent draft ("보내지 않은 초안이 있어요"). Tabs drag to a new place, a middle click closes one, and the right-click menu
  has 이름 변경…, 탭 닫기, 다른 탭 닫기, 탭을 왼쪽 / 오른쪽으로 이동, 채팅 ID 복사, 채팅 기록에서 보기 and 보관. The tabs scroll on
  their own while +, the waiting chip and 채팅 기록… stay, and an end that hides tabs fades. A closed tab comes back with ⌘⇧T
  / Ctrl+Shift+T, and for 3 s the strip says "탭을 닫았어요 · 다시 열기"; a draft left in it is said to stay ("초안을 남겨
  뒀어요 — 채팅을 다시 열면 돌아와요"). ⌃⇥ / ⌃⇧⇥ (Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / PgUp on Windows) step through the
  tabs and ⌘Y / Ctrl+H opens the chat history. Electron: a tab is reached with Tab, ← / → move between the tabs and Enter
  shows one; 이름 변경… edits the title in the tab itself (↩ keeps it, esc leaves it); + and × are named for screen readers.
  Mac: the Chat menu has Claude 중지 (⌘., no longer only the button's key), 커맨드… (⌘/), 채팅 기록… (⌘Y), the next /
  previous tab, 채팅 이름 바꾸기…, 권한 모드 and 이미지 첨부…; the ⋯ menu lists the open tabs, says what it holds, and
  터미널에서 이어가기 says why it is off as its subtitle.
- **Chat history** (polish P4-composer-35 / 10, PX-08 / 17 / 18 / 21). A chat's "3분 전" keeps up while the window stays
  open and reads exactly on hover; ↩ / Enter opens the selected chat and ⌘C / Ctrl+C copies its title ("복사됨: …"); a cost
  reads with two decimals ("<$0.01" for a cent's fraction). Electron: ↑ / ↓ move through the list, and esc in a title being
  renamed ends the edit only, never the dialog. Mac: also ⌘⌫ asks to delete the selected chat, the row's ⋯ says what it
  holds, "삭제… (현재 채팅은 안 돼요)" says why in the item, "보관된 채팅 보기" is remembered, the list says it is loading
  instead of "아직 채팅이 없습니다", an archived chat reads dimmer with "보관됨" (no faded row), and the sheet fits a 1000 × 637
  window and keeps the size it was dragged to.
- **The error banner** (polish P1-chrome-29 / 34). "오류 복사" copies what a bug report needs — the message with its ×N, the
  CLI's words and the code — and says "복사됨"; the scope chip says what it means (앱 엔진, Claude Code 세션, git 명령,
  GitHub(gh)). Mac: also in the banner's right-click menu. Electron: the message's tooltip is on the
  message only (no longer over the banner's buttons) and it reads three lines before it is cut; [다시 시도] says it starts
  Claude Code again with the same settings, and ✕ is drawn from the icon set instead of a font's glyph.
- **The bar of a chat shown read-only** (polish P3-transcript-22, P4-composer-37). Its lines read in full on hover; [실행 중인
  채팅으로] says "실행 중인 채팅으로 돌아가요 — 이 채팅은 탭에 남아요"; [이 채팅으로 이어가기] shows "전환 중…" until the switch
  has landed, and while Claude works in the live chat it says it moves the session once Claude is done there (§9 "Held
  switches": the line then says what waits, and [취소] calls it off).

### 55.7 Closing, quitting and switching say what they stop

Lane p-lifecycle. Closing the last window or quitting (⌘Q, the Dock's Quit, Ctrl+Q / Alt+F4 on Windows) asks first, like
other Mac apps, and every question says — per window, under the project's name — what it would stop, what it would lose
and what stays. The decision and the words are one pure function on each client (Core `QuitGuard.swift`,
`clients/desktop/src/shared/closeGuard.ts`; the same English keys).

- **What a window has going on** (`QuitReason`). It *stops*: a turn running (`working`), a card waiting for the user
  (`waiting` — a permission, a question, a plan; it wins over working), §52 background commands, subagents still working
  after their turn (§52.2), side questions answering (§21), a workbench being created. It *loses*: images attached to
  the message being typed or to queued messages, PR review comments not submitted yet (the engine holds them in memory),
  and every line another part of the window registered (`WindowModel.unsavedWorkLines` / `unsavedWorkLines()`: a review
  note being written, an edited message, a commit in flight — "커밋/푸시가 아직 진행 중이에요"). It *stays*: files
  waiting for review and unsent notes (the review is saved), the queue (kept, back paused), the message being typed
  (saved per chat).
- **When it asks.** While something would stop or be lost, "Ask before closing while Claude works"
  (`confirmCloseWhileWorking`, default on) alone decides; otherwise "Ask before quitting" (`confirmQuit`, default on)
  does. "Don't ask again" shows on a quit only when nothing would stop or be lost, and turns off `confirmQuit` alone; on a
  window's close or a project's switch it turns off `confirmCloseWhileWorking`, as before. Something lost makes Cancel the
  default button. Both apps turn `confirmQuit` back on in Settings › General › "Ask before quitting" (그 질문의 "다시 묻지 않기"로 끈 뒤).
- **The quit question** ("ReviewGate를 종료할까요?"): "마지막 창을 닫으면 ReviewGate가 종료돼요." first for the last window's
  close; then what stops ("acme-api: Claude가 작업 중이에요 — 종료하면 이 턴이 멈춰요", "acme-api: 백그라운드 명령 2개가
  멈춰요"), what is lost, and what stays ("acme-api: 보내지 않은 메모 1개와 대기 중 파일 3개는 그대로 있어요 — 다시 열면 이어서
  볼 수 있어요", "보내지 않은 메모와 작성 중인 메시지는 그대로 남아요", "다음에 실행하면 프로젝트 2개가 다시 열려요"); with
  nothing running, "열린 프로젝트 2개의 Claude 세션이 끝나요." [종료] [취소].
- **One window that is not the last** asks only while something would stop or be lost. The title says why: "Claude가 작업
  중이에요", "Claude가 답을 기다리고 있어요", or "이 창을 닫을까요?" for the window's other work; then the other lines and
  "리뷰 대기·메모·작성 중인 메시지는 다시 열면 그대로 있어요." [닫기] [취소].
- **Switching or closing a window's project** (P1-chrome-03) stops its session the same way, so it asks the same way:
  "프로젝트를 바꾸면 이 턴이 멈춰요." / "프로젝트를 닫으면 이 턴이 멈춰요." [전환] / [프로젝트 닫기] [취소]. The pending-review
  question ("Switch project?") comes only when this one did not ask. The project already open in the window brings the
  window forward and says "acme-shop is already open in this window" ("acme-shop 프로젝트는 이미 이 창에 열려 있어요", a toast —
  0.5.12 did nothing at all, and the folder picker looked broken); one open in another window comes to the front instead,
  with the same words — a switch would stop this session for a lock it cannot take. Open in New Window… for a folder a
  window has open does the same.
  Mac: with a project open, ⌘O, the toolbar's folder, File › Open Recent, the recent list and a git candidate go through
  `ProjectOpener.requestSwitch` too (they used to open at once, past even the pending-review question), and Close Project
  through `requestClose`; the question is a sheet on the window. A new window is opened with the folder plus a fragment of
  its own (`ProjectOpener.newWindowValue`): SwiftUI brings forward the window it thinks shows a value, and a window closed
  earlier (AppKit keeps it, hidden) still matched the folders it had shown — Open in New Window… then opened nothing. An
  open aimed at a window that is gone (a menu that still names a closed window's store) opens in a window of its own. Windows client: the store's `requestSwitch` (File › Open / Open Recent / Switch Project…, the sidebar's projects) and
  `closeProject` ask main (`rg:confirmProjectChange`, with the page's facts), which shows the question as a message box on
  that window and answers `{asked, ok}`. The folder already open says so there too: a toast "acme-api is already open in
  this window" in the page, and from main's `focusProjectWindow` (the window holding it — another one, the one Open in New
  Window… finds, or the lock's owner — comes forward and says it). While `open_project` / `switch_project` is answered, the
  empty window shows "Opening acme-api…" (`openingPath`); `project_open_failed` has Reopen (`reopenLastProject`, the
  folder opened last). Test: `clients/desktop/src/renderer/openProject.test.ts`.
- **Mac.** The last workbench window's close (⌘W, the close button) asks the quit question as a sheet and then quits —
  its engine stops with the window, so nothing is left to keep the app running for
  (`applicationShouldTerminateAfterLastWindowClosed` is true). The window list is written before any engine stops, so the
  next launch reopens that project; a window list never shrinks to empty when the last window goes
  (`persistOpenWindows` keeps it). Once a quit goes ahead every window is hidden at once and the engines stop behind them
  (at most 6 s), so Quit never looks stuck. No question for the app's own quits (an update's restart — its wait already
  saw every window idle —, the move to Applications) nor for a logout, restart or shut down (`kAEQuitReason` of the Quit
  Apple event: `logo`, `rlgo`, `rrst`, `rest`, `rsdn`, `shut`), which a question would hold back.
- **Windows client.** The same questions as message boxes. The last window's ✕ / Alt+F4 is a quit: `before-quit` asks
  (with "마지막 창을 닫으면 ReviewGate가 종료돼요."), writes the window list while that window is still in it — so
  "Reopen last projects" finally works for the usual way to quit Windows apps — and stops every engine once; a window
  closing never writes an empty list. Before main decides it asks each window's page (`rg:closeGuardQuery`, answered on
  `rg:closeGuardExtras` within 0.6 s, bounded by `validExtras`) for what only the page knows: the registered lines, the
  message being typed, the queue and its images, side questions answering, a workbench being created. A quit that goes
  ahead hides every window at once and gives the engines at most 6 s. Windows' session end (`query-session-end` /
  `session-end`) asks nothing: the list is written and the engines get at most 3 s.
- **The queue is kept** (P4-composer-07). Closing the window, quitting or switching the window to another project used to
  drop the messages waiting in the queue. They are kept per project as the queue changes — their text, @ mentions and
  one-message model (images are not kept; the questions say so) — and come back, paused ("이전에 남겨 둔 메시지예요 —
  재개하면 보내요"), when that project opens again in a window whose queue is empty, so nothing goes out by surprise. A
  queue emptied by sending or by the user forgets them. Mac: `AppSettings.keptQueues` (at most 30 projects), written by
  the window as `AppState.queueKeep` changes (`queueKeepChanged`). Windows client: `localStorage` (every window of the app;
  it was the window's `sessionStorage`, gone with the window), the message being typed too (at most 50 drafts, the least
  recently typed dropped first) — the store's switch, open and close mark the project being left
  (`keepQueueWhileLeaving`), so the view emptying then keeps them, once.

### 55.8 The menu bar, the Dock and Help

Lane p-lifecycle. Every action is in the menu bar with its key, so a key can be found where Mac and Windows users look for
it, and an item that cannot run now is disabled instead of doing nothing.

- **Windows client — the Mac's menus** (P1-chrome-09, P2-review-28, P4-composer-06, P5-sheets-46, P1-chrome-20,
  P1-chrome-28, P1-chrome-06). File gets New Window (Ctrl+N), Go to File… (Ctrl+P) and Find in Project… (Ctrl+Shift+F) —
  their pages are lane p-window's (`quick_open` / `project_search`) — and Close Project (it asks first, §55.7). Edit gets
  Find in Chat… (Ctrl+F) and Find in Diff… (Ctrl+Alt+F); View the sidebar's tabs in the Mac's order, Changes / History /
  PRs (Ctrl+Alt+1–3). A Review menu (Accept, Reject, Next / Previous Pending File, Accept All…, Reject All…, Finish
  Review…, the review note on the selected line, Ask About Selection…, Request Changes, Commit Accepted…, Create PR from
  this branch…) and a Chat menu (New chat, Close Chat Tab, the open tabs at Ctrl+1…9 by their titles, Stop) list the
  Mac's items in its order. The page keeps its keys (`registerAccelerator: false`); a click does what the key does — the
  same keydown on the document (`pressKey`, src/renderer/menuActions.lifecycle.ts) or the store's action. The page says
  what the items can do now (`rg:menuState`, src/shared/menuState.ts `MenuEnabled`: the buttons' own rules, sent when it
  changes, at most every 250 ms); main builds the menu from the focused window's — again when the focus, that window's
  chat tabs or what it can do change, and only then.
- **Access keys** (PX-13, Windows). Alt+F opens File, Alt+R Review and so on — "파일(F)", "리뷰(R)", "&File" in English
  (`mn`); Open Project, Open Recent, Settings and Quit ("종료(X)", English "Exit") have theirs.
- **A right click on text** (P3-transcript-09, P4-composer-11, Windows client). Electron shows no menu of its own, so a right
  click did nothing: a text box now gets Undo / Redo · Cut / Copy / Paste · Select All (each enabled as Chromium says, the
  spelling suggestions first), selected text Copy, a web or mail link Copy Link Address ("링크 주소 복사"); plain text with
  nothing selected gets no menu. A part of the page with a menu of its own (the diff's lines, a tool row, the agents)
  prevents the default and keeps its own (src/main/contextMenu.ts).
- **Notifications already seen go** (PX-15). A window coming to the front closes the notifications it posted — the card
  or the summary they were about is in front of the user now, and a click on an old one later led to a card already
  answered. Windows client: on the window's `focus`, every notification it posted is closed (it used to clear only the
  badge, and the Action Center kept them). Mac: the window becoming key removes its cards' (a permission, a question, a
  plan) and its "작업이 끝났어요" from Notification Center, and a card answered anywhere — the window, the board, a rule —
  removes the cards' (Core `DeliveredNotifications`; one live notification per window and kind, "<project>#<kind>").
- **What the first screen checks** (P5-sheets-44, Windows client's main side; the empty window's checklist is lane
  p-window's). `readiness()` (`rg:readiness`) answers the Claude Code CLI (its version), the GitHub CLI's login on the
  settings' host (`gh auth status --hostname`, its account) and git's identity (`user.name` / `user.email`) — found the
  way an engine finds the tools (`locateToolchain`, the settings' overrides), each tool run without a shell for at most
  8 s, the answer kept a minute. A line not ok says "missing" (not installed), the git keys not set, or nothing (gh logged
  out) — src/main/readiness.ts.
- **The Windows client notices a new release** (P5-sheets-49). The Mac's §48 check in main (src/main/update.ts): the newest
  GitHub release that is neither a draft nor a pre-release, against the running version — read with `gh api
  repos/…/releases/latest` when the GitHub CLI is there (the user's login, as the Mac), else GitHub's public API over the
  system's proxy. At launch (after 8 s) and every 6 hours while `autoCheckUpdates` is on (absent = on; Settings › General's
  switch is lane p-settings'), and from Help › Check for Updates…, which always says the result in a message box (a
  version closed with Later comes back then). A newer release shows a banner in every window, also the empty one —
  "ReviewGate 0.6.0 버전이 나왔어요 · 이 앱은 0.5.10 버전이고, 최신 릴리스는 0.6.0 버전이에요." [릴리스 페이지 열기] (the
  installer is there; only a github.com page is opened) [나중에] (`dismissedUpdateVersion`: this version stays quiet, a
  newer one shows again). Nothing is installed by the app.
- **Help › Keyboard Shortcuts finds a key** (P1-chrome-10). A search field on top, focused when the window opens, narrows
  the table as the user types — every word, in any order, against the action and remark in the UI language, their
  English and the keys ("거절", "ctrl+shift+k"); a section's title keeps the whole section; nothing found says so. Esc
  empties the field first, then closes. Windows client: `filterShortcuts` (ShortcutsDialog.tsx); its Close is the dialog's
  bottom row (§55.10), so it stays in view while the table scrolls. Mac: Core
  `ShortcutTable.filtered` (the same rule; ⌘F puts the focus back in the field; the window closed on Esc only now).
- **Mac — File** (P1-chrome-06, P1-chrome-07, PX-16). New Window (⌘N) opens an empty window of its own — `replacing:
  .newItem` had taken SwiftUI's. Open Project… and Switch Project… with no workbench window in front (Settings or the
  shortcuts window in front) open a window of their own instead of doing nothing, and so does an Open Recent row (they
  were all disabled). Open Recent names a project by its folder with its icon, as the project menu does (it showed the
  whole path), its parent too when two share a name ("api — acme", Core `RecentMenu.titles`), the path in the row's
  tooltip; Clear Menu forgets the list (`AppSettings.clearRecentProjects`; the windows to reopen stay) and the Dock's.
  Every project opened is also told to macOS (`NSDocumentController.noteNewRecentDocumentURL`), so the Dock icon's right
  click lists the recent projects. Close Project is in File too (it asks first, §55.7).
- **Windows client — Open Recent and the jump list** (P1-chrome-07). Open Recent ends with Clear Menu, as on the Mac (the
  list, the empty window's and the OS's recent documents); the taskbar icon's right click lists the recent projects ("최근
  프로젝트", at most 10) — a pick starts ReviewGate with that folder, which the running one opens
  (src/main/singleInstance.ts). Packaged builds only.
- **Windows client — Help** (P1-chrome-08, P5-sheets-45, P1-chrome-13). The Mac's: ReviewGate Help (the README in the UI
  language), Keyboard Shortcuts, Release Notes, Report an Issue… (Copy Diagnostics first, then GitHub's new-issue page —
  src/main/links.ts), Check for Updates…, then the log and settings folders and Copy Diagnostics. Copy Diagnostics only
  wrote a log line; it now says so in the window (`rg:toast` → the page's toast, "진단 정보를 복사했어요 — 신고 글에 붙여
  넣으세요").
- **Mac — Help** (P1-chrome-08, P5-sheets-45, P1-chrome-13). SwiftUI's own "ReviewGate 도움말" only said that no help was
  available (there is no help book): the group is replaced by ReviewGate Help (the README, in the app's language), Keyboard
  Shortcuts, Release Notes (the releases page) and Report an Issue… (the diagnostics go on the clipboard first, then a new
  issue opens), then Open Log Folder and Copy Diagnostics. Copying the diagnostics says so — "진단 정보를 복사했어요 — 신고
  글에 붙여 넣으세요" (`Clipboard.copy`'s toast), from the error banner too. The Help menu's search field stays macOS's.
- **Mac — the Dock** (P1-chrome-11). Claude waiting for the user (a permission, a question, a plan) while the app is behind
  bounces the Dock icon once (`requestUserAttention(.informationalRequest)`, under the same switches as the notification) —
  a notification turned off in macOS left only the badge's number. The Dock icon's menu has New Window, Open Project… (the
  window in front, asked like ⌘O) and Open in New Window…, under the recent projects macOS lists.
- **When a closed banner comes back** (P1-chrome-18, Mac — the other banners' are their lanes'). The update banner's ✕ says
  "이 버전 알림 숨기기 — 다음 버전이 나오면 다시 알려요" (it said "닫기"), the disk image banner's Later "다음에 앱을 열 때 다시
  물어봐요".

### 55.9 Updates: stopping one, and the restart's wait

Lane p-lifecycle. Mac (§48's installer).

- **An install can be stopped while it downloads and checks** (P5-sheets-47). [Cancel] was offered only while the restart
  waited for Claude; it shows during the download and the checks too, and stops them: the task is cancelled, and
  `CommandRunner.run` now terminates (SIGTERM) the process of a cancelled task — gh's download, hdiutil, codesign — so the
  step fails and `prepare` removes what it made, as on any failure; nothing is said. While gh downloads, the banner says
  how much has come ("ReviewGate 0.6.0 다운로드 중… 12.4 / 48.0 MB" — `prepare`'s `received` hears the download folder's
  size every half second; the asset's size from the release).
- **The restart's wait says for whom, and never waits forever** (PX-update-wait, P5-sheets-48). The 0.5.9 report: the
  banner said Claude was working while nothing ran in any window, and could wait for ever. The wait now goes by window
  (Core `UpdateWait.decide` over every store that may own an engine — the closed windows' are gone from the registry):
  a turn running or a card waiting holds it, and the banner names each such window and why — "acme-api: Claude가 작업
  중이에요", "acme-ops: 답을 기다리는 카드가 있어요"; one is a link that brings that window to the front, more a menu of them
  ("창 2개를 기다려요"). A window "working" with no word from its engine for two minutes (`AppState.lastEngineEventAt`,
  stamped on every engine event) no longer holds it — a turn whose end was missed — and the banner says so ("acme-api: 2분
  넘게 소식이 없어 쉬는 것으로 봤어요"); a card waits for the user for as long as it takes. [지금 다시 시작] restarts anyway,
  asked once — "지금 다시 시작할까요?" with the windows it waits for and "작업 중인 턴은 멈춰요." — and the quit then asks
  nothing more.
- **The restart reopens the windows** (P5-sheets-48). An update's restart and the move to Applications are not the user's
  quit: they set `restoreOnceAfterRelaunch`, and the next launch reopens the last windows once even with "Reopen last
  projects" off (read and cleared at launch, `AppQuit.restoresOnce`).

### 55.10 The Windows client's menus, dialogs and styles

The pieces every Electron screen is made of (lane p-ui-kit): the dropdown menu, the dialog, the confirm, the shared
styles. A screen that uses them gets these without a change of its own.

- **A menu works from the keys** (Electron, `Menu` in components/Menu.tsx; components/menuKeys.ts). ↓, Enter or Space
  on its button opens it on the first item that can be chosen (↑: the last); ↓ ↑ go round the items, Home / End jump to
  the ends, a letter goes to the next item starting with it — a Hangul consonant to the next item whose first syllable
  starts with it (ㄱ → 감추기); Enter / Space choose (⌥ too: ⌥Enter on a recent project opens it in a new window, as
  ⌥-click does); Esc closes it — the menu's own, even inside a dialog, which stays open — and Tab leaves it for the
  control after the button. Focus goes back to the button. A click opens it with no item marked, as a native menu does;
  the item under the pointer is the marked one and the one the keys go on from, so the pointer and the keys never mark
  two. As in Windows' menus a disabled item can be focused and read, not chosen. The button says it opens a menu
  (`aria-haspopup`) and whether it is open (`aria-expanded`); the items are `menuitem`s (`menuitemradio` with
  `aria-checked` where one is checked) that Tab never stops on, and ▼ / ✓ are not read.
- **A menu's ▼ and ✓ are icons** (Electron). The chevron and the check of the shared icon set (icons.tsx, §55.1) instead
  of font glyphs whose size and weight changed with the font (Segoe UI Symbol on Windows); the chevron is as tall as
  the button's own text, so it fits the HUD's mode pill as well as the project name.
- **A dialog holds the focus and gives it back** (Electron, `Modal` in components/Menu.tsx; components/modalDom.ts). Every
  dialog is a modal dialog to a screen reader (`role="dialog"`, `aria-modal`, named by its title). It remembers where the
  focus was when it opened and gives it back when it closes — the menu button, the file row, the message box — unless
  what closed it put the focus somewhere; a dialog that took another's place (Reject all → its second confirm) gives it
  back to where the first one was opened from. Tab and ⇧Tab go round inside it (a radio group is one stop) instead of
  into the message box or the diff behind it, and a focus that wanders behind it (a pane focusing itself when a turn
  ends) comes back to the control it left. With no field asking for the focus (`autoFocus`) it takes it itself, so Esc
  and Tab work at once. Only the newest dialog does this: a confirm over Settings has the keys until it closes.
- **Esc closes only what it should** (Electron). Esc closes the newest dialog alone — a confirm over Settings closes,
  Settings stays (both closed before) — and not while it is busy, as before. The Esc that cancels a Korean composition
  keeps the dialog and the text being typed, and an Esc a field inside already answered (`preventDefault`: a rename that
  Esc cancels) is the field's alone. An open menu takes Esc before the dialog it is in.
- **A click past a dialog never throws typed text away** (Electron). A click on the dimmed backdrop closes a dialog only
  while the text in its fields is as it was when it opened (a commit message ReviewGate generated counts as the dialog's
  own); after typing — the commit message, the PR body, a review summary, a setting not yet saved — the dialog stays,
  pulses once (an outline with reduced motion), and the caret stays in the field. Checkboxes and choices are not typed
  text. `dismissOnBackdrop={false}` keeps a dialog from closing on the backdrop at all; Esc and its buttons close it.
- **⌘↩ presses a dialog's default button** (Electron; Ctrl+Enter on Windows). Anywhere in a dialog — the commit message,
  the PR title, a checkbox — ⌘↩ presses its default button: one marked `data-default`, else the primary button of its
  bottom row (`.actions`: Commit, Create PR, Submit review, Make commits, Compact, Done). The field being edited ends its
  editing first, as on the Mac (a setting that saves when it loses the focus saves), and gets the focus back if the
  dialog stays. A field's own ⌘↩ never runs as well, so nothing is sent twice. With the button off, none in the row, or
  a danger one as the strongest (a confirm to revert: Cancel has the focus), the key goes on as before; with ⌥ or ⇧ it is
  not this key, and the Enter that ends a Korean composition is not either. The lanes that own the dialogs put "(⌘↩)" in
  their buttons' tooltips.
- **A dialog's title and buttons stay where they are** (Electron). The title and the bottom button row (a last
  `<div className="actions">` child of `Modal`) stay put and only the body between them scrolls, so in a 637 px window
  Settings' tabs, Cancel and Commit never scroll out of sight (the whole dialog scrolled before). A thin line shows where
  content goes on under the title or the buttons, drawn from the body's own scroll position — none while nothing
  scrolls, none at the end it reached. A dialog whose last child is not that row (a split commit keeps its row inside)
  scrolls whole, as before.
- **A confirm to undo work opens on Cancel** (Electron, `ConfirmDialog`). A destructive confirm (`danger`: Reject,
  Revert them, Revert N parts, Revert anyway, Remove, Force remove, Initialize anyway) has Cancel focused, so Return or
  Space cancels and never runs the red button by itself — Tab reaches it (the red button had the focus, so one Return
  reverted). Any other confirm (Switch project, Accept and send, Take over) keeps its action focused, as before.
- **Buttons answer the press; list rows show the focus** (Electron, styles.css). A button held down — by the mouse, or
  Space on a focused one — is a shade darker than its hover (8 %), the primary one too (its hover brightens it), and a
  plain one is filled as on hover; one that is off (`disabled`, or `aria-disabled` with a reason to show) does not press.
  There was no pressed state at all. A list row (`.list li`) the keys reach shows a 2 px ring in the accent colour; a
  click does not ring it (`:focus-visible`).
- **Korean breaks between words** (Electron, styles.css). With the UI in Korean (`<html lang="ko">`, §55.1) a line
  breaks between words, as on the Mac — '리뷰 대기 파일' no longer ends a line as '리뷰 대기 파' in a sidebar, card,
  banner, permission card or chat message (a message, a side answer, an error row, a note: the prose rules that said
  `word-break: break-word` keep the words whole too); a word longer than its line still breaks, so nothing overflows
  where it wrapped before. English is as it was; code and paths keep their own breaking (`break-all`, `pre`).
- **Cut text reads in full on hover** (Electron, renderer/autoTitle.ts). Text cut short — a `.truncate`, anything styled
  `text-overflow: ellipsis`, or clamped to a few lines — shows its whole text as a tooltip while it is cut (a path, a
  branch, a command, an error), from one listener for the page (85 such places had none); when it fits again the
  tooltip goes. A tooltip a component set wins: on the element itself it is left alone; on a row around it, it stays
  under the whole text, or alone when it already holds that text. Fields, the code editor, an inline span (it cuts
  nothing) and `data-no-auto-title` get none.
