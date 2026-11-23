/**
 * docs/PROTOCOL.md §55.11 — Settings' tabs, the search across them and when a change applies, as Core `SettingsCatalog`
 * does for the Mac: every setting's tab, section, title and explanation (English keys, `t()`-localized by the caller),
 * and when a change takes effect. Plus what a Claude session read when it started, so Settings can say which changes
 * wait for a restart.
 */
import type { AppSettings } from "../shared/ipc";
import { renderSystemPrompt } from "../shared/systemPrompt";

export type SettingsTab = "general" | "permissions" | "session" | "review" | "git" | "tasks" | "project" | "accounts" | "advanced";

/** In tab order, with the English key of each name. */
export const SETTINGS_TABS: { id: SettingsTab; title: string }[] = [
  { id: "general", title: "General" },
  { id: "permissions", title: "Permissions" },
  { id: "session", title: "Session" },
  { id: "review", title: "Review" },
  { id: "git", title: "Git & Workbenches" },
  { id: "tasks", title: "Tasks" }, // MARK: task-start (§63)
  { id: "project", title: "Project" },
  { id: "accounts", title: "Accounts" },
  { id: "advanced", title: "Advanced" },
];

/** A stored or requested tab; unknown → General. */
export function settingsTabOf(raw: unknown): SettingsTab {
  return SETTINGS_TABS.find((tab) => tab.id === raw)?.id ?? "general";
}

/** When a changed setting takes effect: no badge — at once; the others say which. */
export type SettingApplies = "immediately" | "nextSession" | "newProject";

export function appliesBadge(applies: SettingApplies): string | null {
  return applies === "nextSession" ? "Next session" : applies === "newProject" ? "New projects" : null;
}

export function appliesHelp(applies: SettingApplies): string | null {
  return applies === "nextSession"
    ? "Takes effect when this window's Claude session restarts or a new chat starts"
    : applies === "newProject"
      ? "Projects opened for the first time start with it; a project you opened before keeps its own"
      : null;
}

export interface SettingEntry {
  /** The row's anchor (`data-setting`), usually the settings key. */
  id: string;
  tab: SettingsTab;
  section: string;
  title: string;
  info?: string;
  applies: SettingApplies;
}

const e = (id: string, tab: SettingsTab, section: string, title: string, info?: string, applies: SettingApplies = "immediately"): SettingEntry => ({
  id,
  tab,
  section,
  title,
  ...(info ? { info } : {}),
  applies,
});

/** Every setting the search finds, in tab order. */
export const SETTINGS_INDEX: SettingEntry[] = [
  // General
  e("appearance", "general", "Appearance", "Theme", "System follows the OS setting. Applies immediately to every window, including the title bar and menus."),
  e("reopenLastProjects", "general", "Appearance", "Reopen last projects on launch"),
  e("showExploreDetail", "general", "Typing and the chat", "Show exploration rows in detail", "Off: reads, searches and read-only commands in a row fold into one line in the chat (click it to open)."),
  e("confirmQuit", "general", "Closing and quitting", "Ask before quitting"),
  e("confirmCloseWhileWorking", "general", "Closing and quitting", "Ask before closing while Claude works"),
  e("notifications", "general", "Notifications", "Notify me when ReviewGate is in the background"),
  e("notificationSound", "general", "Notifications", "Play a sound"),
  e("autoCheckUpdates", "general", "Updates", "Check for updates automatically"),
  // Permissions
  e("permissionMode", "permissions", "Starting mode", "Starting mode", "New projects start in this mode; each project then keeps the mode you pick.", "newProject"),
  e("autoAllowBash", "permissions", "Asking for permission", "Auto-allow Bash", "Off: every shell command asks for permission in the chat. Edits are always auto-allowed (within the change limit, when it is on).", "nextSession"),
  e("autoAllowReadOnlyBash", "permissions", "Asking for permission", "Auto-allow read-only Bash", "Commands that only read (git status, ls, cat, grep, …) with no redirection or chaining run without asking."),
  e("bashAllowPatterns", "permissions", "Allow patterns", "Allow patterns"),
  e("persistSessionAllows", "permissions", "Allowed for the session", "Keep \"Allow for session\" for this repository"),
  e("applyUserAllowRules", "permissions", "Claude Code allow rules (terminal)", "Apply terminal allow rules (lookup and read tools)"),
  e("applyUserBashRules", "permissions", "Claude Code allow rules (terminal)", "Also apply the terminal's Bash allow rules"),
  e("allowWorktreeIsolation", "permissions", "Agents and worktrees", "Allow agents that work in another worktree (isolation)", "In auto mode they run without a card; otherwise each asks with a card. A row afterwards says where they worked.", "nextSession"),
  // Session
  e("terminalChatPreview", "session", "Terminal", "Terminal chat (preview)"),
  e("terminalFullRepaint", "session", "Terminal", "Repaint the whole screen each frame (recommended on Windows)", undefined, "nextSession"),
  e("terminalShell", "session", "Terminal", "Default shell"),
  e("autoRestartSession", "session", "Session", "Auto-restart session"),
  e("backgroundWork", "session", "Session", "Allow background tasks and /loop", undefined, "nextSession"),
  e("subagentsInTurn", "session", "Session", "Subagents finish inside the turn", undefined, "nextSession"),
  e("loadUserSettings", "session", "Extensions", "Load user settings (skills, plugins, MCP, hooks from ~/.claude)", "Skills, plugins, MCP servers and hooks from ~/.claude. Bash and other non-edit tools still require approval here.", "nextSession"),
  e("budgetEnabled", "session", "Limits", "Limit changes per reply"),
  e("maxTurnsLimit", "session", "Limits", "Limit tool calls per message", undefined, "nextSession"),
  e("sideModel", "session", "Side questions", "Side question model"),
  e("sideWeb", "session", "Side questions", "Web in side questions"),
  e("peerInbound", "session", "Messages from other sessions", "When another session sends a message"),
  e("showStatusLine", "session", "Claude Code status line", "Show the Claude Code status line"),
  e("systemPromptAppend", "session", "System prompt append", "System prompt append", "Added to Claude's system prompt in every session. Placeholders {maxFiles} and {maxLines} are substituted.", "nextSession"),
  // Review
  e("reviewFirst", "review", "Review first", "Claude waits for your review before its next work", "Until you accept or reject Claude's changes, it can answer questions, read and plan, but its edits and commands that change files are blocked — in chats and in terminal chats. Block prompts too: a new message waits until the review is done (Accept & Send accepts first). Turn off: a message during a review may change files, as before."),
  e("checkpointIgnorePatterns", "review", "Checkpoint ignore patterns", "Checkpoint ignore patterns"),
  e("testCommandPatterns", "review", "Test command patterns", "Test command patterns"),
  e("navCtrlClick", "review", "Code navigation", "Ctrl+click a name", "Peek shows the definition under the line, without leaving the diff (Alt+F12 does it too); Go to opens it. F12 always goes to it."), // §65.8
  e("largeFileMB", "review", "Disk space", "Leave untracked files out of snapshots from", "Such a file (a heap dump, an archive) stays in the review list but its content is not stored: it cannot be reverted and the app does not commit it. Files git tracks are always stored."),
  e("historyCleanup", "review", "Disk space", "Clean Up Old Review History…"),
  // Git & Workbenches
  e("worktreeRoot", "git", "Workbenches", "Worktree folder", "New workbenches are created under this folder as <repo>-<hash>/<branch>. Never inside the repository."),
  e("runAsTaskEnabled", "git", "Workbenches", "Run as Task"),
  e("commitPushByDefault", "git", "Commit", "Push by default"),
  e("commitTrailer", "git", "Commit", "Commit trailer"),
  // Tasks — MARK: task-start (§63), the Mac's SettingsCatalog rows
  e("skipStartScreen", "tasks", "Start screen", "Show the start screen when a project opens", "When a project opens in a window: start straight away, start from a task, or continue a recent chat (1 / 2 / 3, Esc starts straight away). Off: the window opens into its chat."),
  e("taskPlatform", "tasks", "Start from a task", "Task platform", "GitHub Issues are read with the GitHub CLI (gh). Jira, Linear and other trackers are read by Claude through the MCP server below — ReviewGate never calls the tracker and keeps no token."),
  e("taskBranchPrefix", "tasks", "Start from a task", "Branch prefix", "The task's branch is <prefix><id>-<title words>, e.g. feature/ACME-123-fix-cart-total. {type} becomes fix, docs, chore or feature from the issue's labels."),
  e("taskStartLocation", "tasks", "Start from a task", "Start in", "A new branch in this window (your uncommitted changes come along), or a new workbench — its own folder, branch and window."),
  e("taskMcpServer", "tasks", "Start from a task", "MCP server for tasks", "The MCP server Claude reads Jira, Linear and other tasks with (its mcp__<server>__* tools). The list is this project's servers; you can type another name."),
  e("taskPromptTemplate", "tasks", "First prompt", "First prompt template", "The first message, put into the message box (or the terminal's prompt) and never sent by itself. {id}, {title}, {url}, {body} are the task's; {mcp} is how Claude reads it. A line whose placeholders are all empty is left out."),
  // Project · Accounts
  e("commitTemplate", "project", "Commit message template", "Commit message template"),
  e("workbenchSetup", "project", "Workbench setup", "Workbench setup"),
  e("prRespondCommand", "project", "PR comments", "Command for PR comments"),
  e("githubAccounts", "accounts", "GitHub accounts", "GitHub accounts"),
  e("addHost", "accounts", "Add a host", "Add a host"),
  // Advanced
  e("toolchain", "advanced", "Toolchain", "Toolchain"),
  e("claudePath", "advanced", "Toolchain overrides", "claude path", undefined, "nextSession"),
  e("ghPath", "advanced", "Toolchain overrides", "gh path"),
  e("gitPath", "advanced", "Toolchain overrides", "git path"),
  e("cliPin", "advanced", "Pin CLI version", "Pin CLI version", undefined, "nextSession"),
];

export function settingEntry(id: string): SettingEntry | undefined {
  return SETTINGS_INDEX.find((entry) => entry.id === id);
}

export function settingApplies(id: string): SettingApplies {
  return settingEntry(id)?.applies ?? "immediately";
}

const fold = (text: string) => text.normalize("NFKC").toLowerCase();

/**
 * The entries `query` finds: every word, in any order and case, in the title, section, explanation or tab name — the
 * English key and its `localize`d words. An empty query finds nothing.
 */
export function searchSettings(query: string, localize: (key: string) => string = (k) => k, index: SettingEntry[] = SETTINGS_INDEX): SettingEntry[] {
  const words = fold(query).split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const tabTitle = (tab: SettingsTab) => SETTINGS_TABS.find((x) => x.id === tab)?.title ?? tab;
  return index.filter((entry) => {
    const hay = [entry.title, entry.section, entry.info, tabTitle(entry.tab)]
      .filter((x): x is string => typeof x === "string")
      .flatMap((x) => [x, localize(x)])
      .map(fold)
      .join("\n");
    return words.every((w) => hay.includes(w));
  });
}

// MARK: What waits for a restart

/** What the engine reads when a Claude session starts, from these settings (keys of `SETTINGS_INDEX`). */
export function sessionStartValues(s: AppSettings): Record<string, string> {
  const own = typeof s.systemPromptAppend === "string" ? s.systemPromptAppend.trim() : "";
  const limits = { maxFiles: s.budgetMaxFiles, maxLines: s.budgetMaxLines };
  return {
    autoAllowBash: String(s.autoAllowBash === true),
    allowWorktreeIsolation: String(s.allowWorktreeIsolation !== false),
    backgroundWork: String(s.backgroundWork !== false),
    subagentsInTurn: String(s.subagentsInTurn === true),
    maxTurnsLimit: s.maxTurnsLimit === true ? String(s.maxTurns) : "off",
    // The built-in append gets the limit's sentence while the limit is on (§54); the user's own text its numbers.
    systemPromptAppend: own ? renderSystemPrompt(own, limits) : s.budgetEnabled === true ? `default:${limits.maxFiles}/${limits.maxLines}` : "default",
    loadUserSettings: String(s.loadUserSettings !== false),
    terminalFullRepaint: String(s.terminalFullRepaint !== false),
    claudePath: (s.claudePath ?? "").trim(),
  };
}

/** The ids of what differs from what the session started with, in index order. */
export function changedSince(start: Record<string, string>, now: Record<string, string>): string[] {
  return SETTINGS_INDEX.map((entry) => entry.id).filter((id) => id in now && start[id] !== now[id]);
}

/**
 * What the window's session read when it started, after a state change: taken when a session starts (`starting` rises — a
 * restart, a new chat) or the first time an open one is seen with the settings loaded; dropped when none is open.
 */
export function nextSessionStart(
  prev: { open: boolean; starting: boolean } | null,
  next: { open: boolean; starting: boolean },
  settings: AppSettings | null,
  start: Record<string, string> | null,
): Record<string, string> | null {
  if (!next.open) return null;
  if (!settings) return start;
  if (start === null || (next.starting && !(prev?.starting ?? false))) return sessionStartValues(settings);
  return start;
}
