/**
 * Renderer ↔ main contract. The engine protocol itself is docs/PROTOCOL.md (`@reviewgate/engine`
 * types); this file only adds the client-side settings shape, the `window.rg` bridge and the
 * menu → renderer messages.
 */
import type { EngineCommand, EngineEvent, PartialSeries, PeerInboundMode, PermissionMode, ReplyFor, SessionCapabilities } from "@reviewgate/engine";
import type { PickedImage } from "./attachments.js";
// MARK: wave3 desktop-flow
import type { PreReviewEffort, WorkbenchSetup } from "@reviewgate/engine";
import type { WorkbenchSetupReport } from "./flowSettings.js";
import type { CloseGuardExtras } from "./closeGuard.js"; // MARK: polish p-lifecycle (P1-chrome-01)
import type { MenuEnabled } from "./menuState.js"; // MARK: polish p-lifecycle (P1-chrome-09)

/** M18: UI theme. "system" follows the OS (`nativeTheme` in main, `prefers-color-scheme` in the renderer). */
export type Appearance = "system" | "light" | "dark";

/** Same keys as the Mac app's `AppSettings` (Core/Sources/ReviewGateCore/Session/AppSettings.swift). */
export type AppSettings = {
  /** M18: "system" | "light" | "dark" (default "system"); drives `nativeTheme.themeSource` and `<html data-theme>`. */
  appearance: Appearance;
  /** §54: the change limit is on (absent / false: off — the engine gets no budget); the numbers apply only then. */
  budgetEnabled?: boolean;
  budgetMaxFiles: number;
  budgetMaxLines: number;
  /** "" = the built-in append (§54: an earlier built-in text stored here reads as "" too). */
  systemPromptAppend: string;
  /** One pattern per line. */
  checkpointIgnorePatterns: string;
  autoAllowBash: boolean;
  /** M16: read-only shell commands (ls, git status, …) never ask (default true). */
  autoAllowReadOnlyBash: boolean;
  /** M16: Claude-style allow patterns, one per line (`Bash(npm test:*)`, `Bash(git *)`). */
  bashAllowPatterns: string;
  /**
   * Per-project allow patterns (same format), keyed by `projectRootHash(root)` — written by the permission
   * card's "Always allow in this project"; the engine gets the global lines plus the open project's.
   */
  projectBashAllowPatterns: Record<string, string>;
  // MARK: wave3 desktop-flow — per repository (the hash of its main worktree's folder; src/shared/flowSettings.ts)
  /** §36.11: the commit message template ("" / absent = none); the engine gets it as `settings.commitTemplate`. */
  projectCommitTemplate?: Record<string, string>;
  /** §36.12: how a new workbench is prepared (absent = defaults); the engine gets it as `settings.workbenchSetup`. */
  projectWorkbenchSetup?: Record<string, WorkbenchSetup>;
  /** §36.14: the command "Send to Claude" on PR comments starts with (`{pr}` = the number) — client only, never sent to the engine. */
  projectPrRespondCommand?: Record<string, string>;
  /** §36.13: the effort "AI pre-review" runs with (default medium). */
  preReviewEffort?: PreReviewEffort;
  // MARK: wave1 desktop-perms — Settings › Permissions (docs/PROTOCOL.md §33.4–33.7); optional so older settings files stay valid.
  /**
   * §33.4: agents that work in another worktree (`isolation`, a Workflow whose agents use it) may run — a card outside auto
   * mode — instead of a deny (M05b: default true, absent = on; next session start).
   */
  allowWorktreeIsolation?: boolean;
  /** §33.5: the user's Claude Code allow rules apply to tools that cannot change files (default true; live). */
  applyUserAllowRules?: boolean;
  /** MARK: r2-skills-side — §33.5 (M20): the user's `Bash(…)` allow rules count like app patterns (default true; live). */
  applyUserBashRules?: boolean;
  /** §33.7: "Allow for session" keys are kept per repository and restored on open (default true since r2 M21). */
  persistSessionAllows?: boolean;
  /**
   * MARK: r2-skills-side — the defaults this file was last saved with (main's `DEFAULTS_VERSION`): an older file's value that
   * was only the default then gives way to a changed default (`persistSessionAllows` false → true). Main writes it, never a renderer.
   */
  defaultsVersion?: number;
  /** OS notifications while the window is in the background (turn done, permission, plan, question, errors). Default true. */
  notifications: boolean;
  /** Play the system sound with those notifications. Default true. */
  notificationSound: boolean;
  loadUserSettings: boolean;
  ghHost: string;
  /** "" → `~/.reviewgate/worktrees`. */
  worktreeRoot: string;
  // MARK: §49 Run as Task
  /** "업무로 실행" in the composer's tools, File › and the sidebar's workbench section (absent = on). */
  runAsTaskEnabled?: boolean;
  /** The branch prefix "Run as Task" suggests — the one the last task branch used (absent: `task/`). */
  taskBranchPrefix?: string;
  claudePath: string;
  ghPath: string;
  gitPath: string;
  /** Most recent first. */
  recentProjects: string[];
  preferredEditor: "auto" | "vscode" | "idea" | "explorer";
  /** M12: "Push to origin" default in the commit dialog. */
  commitPushByDefault: boolean;
  /** M12: trailer line appended to every commit message ("" → none). */
  commitTrailer: string;
  /** Restart the Claude session once (2 s backoff, at most once per turn) when it dies unexpectedly (default true; §8). */
  autoRestartSession: boolean;
  /** M20: permission mode a NEW session starts in (docs/M20-MODES.md); the live session is switched with `set_permission_mode`. */
  permissionMode: PermissionMode;
  cachedCapabilities: SessionCapabilities | null;
  /** §16: plugins kept off (`name@marketplace`); applied at the next session start (`restart_session`). */
  disabledPlugins: string[];
  /** §16: turn off every settings-file and plugin hook (ReviewGate's own hooks keep running); next session start. */
  disableUserHooks: boolean;
  /** §16: restart without user settings when the CLI has not initialized after this many ms (0 = off; default 20000). */
  extensionsInitTimeoutMs: number;
  /** §21: model of side-question sessions ("" = the main session's model). */
  sideModel?: string;
  /** §21: side questions may use WebFetch / WebSearch (default true). */
  sideAllowWeb?: boolean;
  /** M19: the windows open at the last quit, in order — reopened on launch (docs/M19-MULTIPROJECT.md). */
  openWindows: OpenWindow[];
  /** M19: reopen those windows on launch (default true). */
  reopenLastProjects: boolean;
  /** M15: per-project UI preferences keyed by `projectRootHash(root)` (src/shared/hash.ts). */
  ui?: Record<string, ProjectUI>;
  // MARK: wave1 desktop-session
  /** §29: messages from the user's other Claude sessions — "ask" (default), "auto" (run when idle) or "off"; a project's own choice (`peer_set`) wins. */
  peerInbound?: PeerInboundMode;
  // MARK: wave3 check-clients
  /** §34.9: the user's own test commands, one glob per line (`*` any run, `?` one char); live through `set_settings`. */
  testCommandPatterns?: string;
  // MARK: wave4 w4-longwork
  /** §38.2: the tool-call limit is on (absent / false: off — no limit, the engine gets 0); `maxTurns` applies only then. */
  maxTurnsLimit?: boolean;
  /** §38.2: the tool-call limit's number (10–1000, default 200; kept while off; the engine uses it at the next session start). */
  maxTurns?: number;
  // MARK: wave4b w4b-bigturn
  /** §39.1: untracked files at least this large (MB, 1–100000, default 50) are stubs in snapshots; live. */
  largeFileMB?: number;
  // MARK: wave3 desktop-session
  /**
   * §36.6: "Load local settings (settings.local.json)" per project, keyed by `projectRootHash(root)`; absent = on. Sent as
   * `settings.loadLocalSettings` before the project's `open_project` (src/main/sessionSettings.ts); next session start.
   */
  projectLoadLocalSettings?: Record<string, boolean>;
  // MARK: wave4 w4-safety
  /** daily-12: ask before closing a window / quitting while Claude works or waits for an answer (absent = on). */
  confirmCloseWhileWorking?: boolean;
  // MARK: wave4b w4b-tabs
  /** market-12 (§39.2): every exploration row in the chat instead of one folded "탐색: …" line per run (absent = off). */
  showExploreDetail?: boolean;
  // MARK: wave4b w4-notify
  /** §39.6: one switch per group below `notifications` (absent = on): permission requests · questions · plans / finished work / the rest. */
  notifyWaiting?: boolean;
  notifyTurnEnd?: boolean;
  notifyOther?: boolean;
  /** §39.6: the window's "the OS did not show a notification" banner was closed (Settings keeps the hint). */
  notificationsHintDismissed?: boolean;
  // MARK: wave4b w4b-side
  /** §40.3: side questions on the web — "off" (absent: the default), "rules" (the sites the user's Claude Code rules allow), "on" (any site). */
  sideWeb?: "off" | "rules" | "on";
  // MARK: wave5 w5-model
  /** §43.4: "auto" picks the model of every message (absent / unknown: "manual", the chip's model); live. */
  modelMode?: "manual" | "auto";
  /** §43.4: how auto picks — "cost", "balanced" (absent / unknown), "quality"; live. */
  modelAutoPolicy?: "cost" | "balanced" | "quality";
  // MARK: §52
  /** §52: background commands and /loop as in the terminal (absent = on); the engine uses it at the next session start. */
  backgroundWork?: boolean;
  /** §52.2: subagents finish inside the turn that started them, as before 0.6 (absent = off); next session start. */
  subagentsInTurn?: boolean;
  // MARK: wave6 w6-statusline
  /** §44.2: the user's Claude Code status line under the composer (default true; live). */
  showStatusLine?: boolean;
  /**
   * §44.2: the project's own statusLine command (code from the repository) the user allowed there — `{ <projectRootHash(root)>:
   * <sha256 of that command> }`; absent = none of its own runs. Sent as `settings.allowedProjectStatusLine` with the
   * project's settings (src/main/sessionSettings.ts); a changed command no longer matches and is asked about again; live.
   */
  projectStatusLineAllowed?: Record<string, string>;
  // MARK: polish p-foundation — settings the polish lanes add switches for (Settings › 일반) and read
  /** P1-chrome-01: closing the last window or quitting asks first (absent = on; the Mac's `AppSettings.confirmQuit`). */
  confirmQuit?: boolean;
  /** P4-composer-13: Enter sends the message and Shift+Enter starts a new line, as on the Mac (absent = on). */
  returnSends?: boolean;
  /** P5-sheets-49: look for a new release at launch and every 6 hours (absent = on). */
  autoCheckUpdates?: boolean;
  /** MARK: polish p-lifecycle (P5-sheets-49): the release whose banner the user closed with Later (main writes it). */
  dismissedUpdateVersion?: string;
  /** Filled by the main process (not persisted): the OS locale for `t()`. */
  locale?: string;
};

// MARK: wave4 w4-install
/** Audit daily-17: one recent project as the menus show it (temporary folders already dropped). */
export type RecentProjectEntry = { path: string; exists: boolean };

/**
 * Pane widths (px), sidebar tab, last selected review file and the diff-pane toggle (M16: undefined = auto —
 * collapsed while there is nothing to review), remembered per project.
 */
export type ProjectUI = {
  sidebarWidth?: number;
  chatWidth?: number;
  tab?: "changes" | "prs" | "history";
  selectedPath?: string | null;
  diffCollapsed?: boolean;
  /** M19: the window frame this project was last seen with (clamped to a visible display on restore). */
  bounds?: WindowBounds;
};

/** M19: a window frame in screen coordinates. */
export type WindowBounds = { x: number; y: number; width: number; height: number };

/** M19: one entry of `AppSettings.openWindows` — the project to reopen and the frame it had. */
export type OpenWindow = { path: string; bounds?: WindowBounds };

export type EditorKind = AppSettings["preferredEditor"];

/** The tools whose path can be overridden — only through `pickExecutable` (main's native file dialog). */
export type ExecutableKind = "claude" | "gh" | "git";

export type MenuAction =
  | { type: "open_project" }
  | { type: "open_recent"; path: string }
  | { type: "switch_project" }
  | { type: "new_workbench" }
  // MARK: §49 — File › "업무로 실행…": the New Workbench sheet as "Run as Task" with an empty task
  | { type: "run_as_task" }
  | { type: "settings" }
  | { type: "toggle_sidebar" }
  | { type: "refresh" }
  // MARK: wave3 desktop-flow — §36.14: PR comments handed over by another window ("Send to Claude"), for the composer
  | { type: "composer_draft"; text: string }
  // MARK: wave4b w4b-follow — §39.4: a chat was handed to this window's worktree: take it (`chat_receive`; a refusal is shown here)
  | { type: "chat_receive" }
  // MARK: wave4d w4d-windows — polish-08: Help › Keyboard Shortcuts and the Mac's View menu toggles (keys: docs/SHORTCUTS.md)
  | { type: "shortcuts" }
  | { type: "toggle_diff_pane" }
  | { type: "toggle_agent_panel" }
  | { type: "toggle_side_panel" }
  // MARK: wave5 w5-board — §43.1: View › Agent Board (Ctrl+Alt+B)
  | { type: "toggle_board" }
  // MARK: r2-review-flow — M27: Help › Show Engine Log (the engine log is no line under every composer any more)
  | { type: "show_engine_log" }
  // MARK: polish p-lifecycle — P1-chrome-09 / P2-review-28 / P4-composer-06 / P5-sheets-46: the Mac's Review and Chat menus and
  // Edit › find (a click does what the key does — src/renderer/menuActions.lifecycle.ts)
  | { type: "accept" }
  | { type: "reject" }
  | { type: "next_pending" }
  | { type: "prev_pending" }
  | { type: "accept_all" }
  | { type: "reject_all" }
  | { type: "finish_review" }
  | { type: "add_note" }
  | { type: "ask_selection" }
  | { type: "request_changes" }
  | { type: "commit" }
  | { type: "create_pr" }
  | { type: "new_chat" }
  | { type: "close_chat_tab" }
  | { type: "chat_tab"; index: number }
  | { type: "stop" }
  | { type: "find_chat" }
  | { type: "find_diff" }
  // P1-chrome-20: View › the sidebar's tabs (Ctrl+Alt+1–3)
  | { type: "sidebar_tab"; tab: "changes" | "history" | "prs" }
  // P1-chrome-28: File › Go to File… (Ctrl+P) / Find in Project… (Ctrl+Shift+F) — handled by lane p-window
  | { type: "quick_open" }
  | { type: "project_search" }
  // P1-chrome-06: File › Close Project (it asks first — P1-chrome-03)
  | { type: "close_project" };

// MARK: polish p-foundation — P5-sheets-44
/**
 * One line of the empty window's checklist: `ok`, or what is missing; `detail` — a version, an account, why it failed.
 * MARK: polish p-lifecycle (P5-sheets-44, src/main/readiness.ts): ok → the Claude Code version ("2.1.31"), the gh account
 * ("dev"), git's "Name <email>"; not ok → "missing" (not installed), the git keys not set ("user.name, user.email"), or none
 * (gh is installed but not logged in).
 */
export type ReadinessCheck = { ok: boolean; detail?: string };
/** What ReviewGate needs before a project opens: the Claude Code CLI, the GitHub CLI's login (PRs, updates), git's identity (commits). */
export type Readiness = { claude: ReadinessCheck; ghLogin: ReadinessCheck; gitIdentity: ReadinessCheck };

// MARK: polish p-lifecycle — P5-sheets-49
/** A newer release than the running one (src/main/update.ts): the banner of every window. */
export type UpdateStatus = { version: string; current: string; page: string };

/** `rg:notify` (src/main/notify.ts validates it): what needs the user while the window is in the background. */
export type NotifyKind = "turn_done" | "permission" | "plan" | "question" | "error" | "side_answer" | "peer_message" | "agents_done"; // wave3 desktop-agents: agents_done = §36.4
/** `key` coalesces repeats (the same key within a few seconds is shown once). */
export type NotifyRequest = { kind: NotifyKind; title: string; body: string; key: string; target?: NotifyTarget }; // wave4b w4-notify: target
// MARK: wave4b w4-notify
/** §39.6: where a click lands — the chat tab (`state.sessions.currentId` when posted) and the permission / question card. */
export type NotifyTarget = { chatId?: string; requestId?: string };
/** `rg:notificationClick` (main → the window that posted it, already in front): the notification the user clicked. */
export type NotificationClick = { kind: NotifyKind; target?: NotifyTarget };

export type ToolchainInfo = { platform: NodeJS.Platform; electron: string; node: string; chrome: string };

/** `window.rg` — what the preload exposes (src/preload.ts). */
/** §56.3: the external editor opened (`name`; `waits`: its closing ends the editing), or why not. */
export type DraftEditStart = { ok: true; id: string; name: string; waits: boolean } | { ok: false; error: string };
/** §56.3: a save of the draft `id` (`text`), the editor closed (`done`), or it failed to start (`error`). */
export type DraftEditEvent = { id: string; text?: string; done?: true; error?: string };

export type RGBridge = {
  send(cmd: EngineCommand): void;
  request<C extends EngineCommand>(cmd: C): Promise<ReplyFor<C>>;
  /**
   * Like `request`, but a refusal resolves `{ok:false}` with the `result`'s `code` / `paths` (docs/PROTOCOL.md §19.6) —
   * an Error thrown across the context bridge keeps only its message. The renderer wraps it (src/renderer/engineRequest.ts).
   */
  requestDetailed<C extends EngineCommand>(cmd: C): Promise<{ ok: true; reply: ReplyFor<C> } | { ok: false; error: string; code?: string; paths?: string[]; partial?: PartialSeries }>;
  onEvent(cb: (ev: EngineEvent) => void): () => void;
  onMenu(cb: (action: MenuAction) => void): () => void;
  chooseDirectory(): Promise<string | null>;
  openInEditor(path: string, line: number | null, editor?: EditorKind): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  /** Opens the main process log folder (userData/logs) in the file manager. */
  openLog(): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  /** MARK: wave4d w4d-config — §42.3: a Markdown file in the system's default app; "" when opened, else why not. */
  openMarkdown?(path: string): Promise<string>;
  /** MARK: wave5 w5-graph — §43.3: graphify's graph.html in the default browser; "" when opened, else why not. */
  openGraphHtml?(path: string): Promise<string>;
  getSettings(): Promise<AppSettings>;
  /** Main keeps only the renderer-writable keys with valid values (src/main/settingsGuard.ts); `claudePath` / `ghPath` / `gitPath` are ignored. */
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Main shows a file dialog for `kind`, validates the file and stores it; null when cancelled, rejects when the file is refused. */
  pickExecutable(kind: ExecutableKind): Promise<AppSettings | null>;
  /** Clears the `kind` override (back to auto-detection). */
  clearExecutable(kind: ExecutableKind): Promise<AppSettings>;
  // MARK: wave3 desktop-session
  /**
   * §36.8: pins the native installer's `~/.local/share/claude/versions/<version>` as `claudePath` — main builds and checks
   * the path (the renderer never sends one); rejects with the reason ("no such version", …). Unpin: `clearExecutable("claude")`.
   */
  pinClaudeVersion(version: string): Promise<AppSettings>;
  /** Merges `patch` into `settings.ui[hash]` (no engine `set_settings`, no menu rebuild). */
  setUI(hash: string, patch: ProjectUI): Promise<void>;
  /**
   * Opens `path` in a new workbench window (or focuses the window that has it). wave3 desktop-flow (§36.12): `setupReport` —
   * the new workbench's setup failed; that window shows the exit and the log (`takeWorkbenchSetupReport`).
   */
  openWorkbenchWindow(path: string, setupReport?: WorkbenchSetupReport): Promise<void>;
  // MARK: wave3 desktop-flow
  /** §36.12: the failed setup's report of this window's new workbench (any of `paths` = its folder), once; null when none. */
  takeWorkbenchSetupReport?(paths: string[]): Promise<WorkbenchSetupReport | null>;
  /** §36.14: puts `text` into the composer of the window that has `path` open (it comes to the front); false when no other window has it. */
  composeInWindow?(path: string, text: string): Promise<boolean>;
  /** M19: opens `path` — or a folder the user picks — in a NEW window; focuses the window that already has it. */
  openInNewWindow(path?: string): Promise<void>;
  /** M19: focuses another of our windows that has `path` open; false when no other window has it. */
  focusProjectWindow(path: string): Promise<boolean>;
  /** Asks the main process to close this window's project in another window (workbench removal). */
  closeProjectInWindow(path: string): Promise<boolean>;
  toolchainInfo(): Promise<ToolchainInfo>;
  /** Writes a renderer error (ErrorBoundary, window.onerror) to the main process log. */
  logError(message: string): Promise<void>;
  /** Shows an OS notification for this window when it is not focused and notifications are on; true when shown. */
  notify(req: NotifyRequest): Promise<boolean>;
  // MARK: wave4b w4-notify
  /** §39.6: one of this window's notifications was clicked (main has already brought the window forward). */
  onNotificationClick?(cb: (click: NotificationClick) => void): () => void;
  /** §39.6: the OS did not show one of this window's notifications (Windows' `failed`: no Start menu shortcut, Focus assist…). */
  onNotificationTrouble?(cb: () => void): () => void;
  /** §39.6: opens the OS notification settings (a fixed address per platform); false when there is none. */
  openNotificationSettings?(): Promise<boolean>;
  // MARK: wave4 w4-install
  /** daily-17: the recent list without temporary folders, each row saying whether its folder still exists. */
  recentProjects?(): Promise<RecentProjectEntry[]>;
  /** daily-17: drops `path` (or, with no path, every folder that is gone) from the recent list; resolves the new settings. */
  removeRecentProject?(path: string | null): Promise<AppSettings>;
  /** Puts text on the system clipboard (main's `clipboard`; works without a secure-context Clipboard API). */
  copyText(text: string): Promise<void>;
  // MARK: composer parity — §56.3 Ctrl+G (optional: a test's bridge stub has none)
  /** Writes the draft to a temp .md file and opens it in the external editor; each save comes back by `onDraftEdit`. */
  draftEditStart?(text: string): Promise<DraftEditStart>;
  /** Done / Cancel: stops watching that draft and removes its file. */
  draftEditFinish?(id: string): Promise<void>;
  onDraftEdit?(cb: (ev: DraftEditEvent) => void): () => void;
  // MARK: polish p-foundation — seeds (optional: a test's bridge stub has none)
  /** P1-chrome-24: where a dropped `File` is on disk (`webUtils.getPathForFile`; "" for one that is not a file on disk). */
  pathForFile?(file: File): string;
  /** P4-composer-40: puts an image the renderer shows (`data:image/…;base64,…`) on the clipboard; false when it is none. */
  copyImage?(dataUrl: string): Promise<boolean>;
  /** P5-sheets-44: what the first screen checks before a project is open (main detects it; p-lifecycle). */
  readiness?(): Promise<Readiness>;
  // MARK: polish p-lifecycle
  /**
   * P1-chrome-01: main is about to ask before closing this window or quitting — `provide` says what only the page knows (the
   * lines its parts registered, the message being typed, the queue, side questions answering, a workbench being created).
   */
  onCloseGuardQuery?(provide: () => CloseGuardExtras): () => void;
  /**
   * P1-chrome-03: switching (`"switch"`) or closing (`"close"`) this window's project stops its session — main asks first when
   * a turn runs, a card waits or work would stop or be lost (a message box, the Mac's words). `asked`: a question was shown;
   * `ok`: go ahead.
   */
  confirmProjectChange?(change: "switch" | "close", extras: CloseGuardExtras): Promise<{ asked: boolean; ok: boolean }>;
  /** P1-chrome-09: what this window's Review and Chat menu items can do now (main builds the menu with the focused window's). */
  reportMenuState?(state: MenuEnabled): void;
  /** P1-chrome-13: main says something it did happened (Help › Copy Diagnostics → "진단 정보를 복사했어요 — …"). */
  onToast?(cb: (text: string) => void): () => void;
  /** P5-sheets-49: a newer release (null: none, or closed with Later), and when that changes; its page; Later. */
  updateStatus?(): Promise<UpdateStatus | null>;
  onUpdateStatus?(cb: (status: UpdateStatus | null) => void): () => void;
  openUpdate?(): Promise<void>;
  dismissUpdate?(): Promise<void>;
  /** §24 attach button: main's image file dialog (png / jpeg / gif / webp, ≤ 5) — each file read and checked in main. [] when cancelled. */
  pickImages(): Promise<PickedImage[]>;
  /** OS path separator ("\\" on Windows) — for display only; paths are sent to the engine as given. */
  sep: string;
  locale: string;
  platform: NodeJS.Platform;
  /** `--e2e` mode (src/main/e2e.ts): null when not running the scripted sequence. */
  e2e: { role: "primary" | "secondary"; project: string } | null;
  e2eReport(result: unknown): void;
  e2eReadFile(path: string): Promise<string | null>;
  e2eScreenshot(name: string): Promise<string>;
  e2eOpenSecondary(): Promise<unknown>;
  /** `git log -1 --format=%H%n%s` of the e2e project (null when git fails). */
  e2eGitLog(): Promise<string | null>;
};

declare global {
  interface Window {
    rg: RGBridge;
  }
}
