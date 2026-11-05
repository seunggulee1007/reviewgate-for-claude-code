/**
 * JSON settings in `app.getPath("userData")/settings.json` — the same keys as the Mac app's
 * `AppSettings` — and the `Settings` payload for `hello` / `set_settings`.
 */
import { app, nativeTheme } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createPlatform, isPeerInboundMode, isPermissionMode } from "@reviewgate/engine";
import type { Settings, SessionCapabilities } from "@reviewgate/engine";
import type { AppSettings, Appearance, ProjectUI } from "../shared/ipc.js";
import { logLine } from "./log.js";
import { linesOf, mergedAllowPatterns } from "./projectPatterns.js";
import { testCommandPatternsOf } from "../shared/testCommands.js";
import { EXECUTABLE_KEYS, validateExecutable, type ExecutableKind } from "./settingsGuard.js";
import { resolveWindowsClaude, type WinFs } from "./winClaude.js";
import { allowedProjectStatusLineFor, loadLocalSettingsFor } from "./sessionSettings.js"; // MARK: wave3 desktop-session, wave6 w6-statusline
import { BUDGET_PROMPT_SENTENCE, DEFAULT_SYSTEM_PROMPT_APPEND, isLegacySystemPromptAppend, renderSystemPrompt } from "../shared/systemPrompt.js"; // §54
import { isTransientProjectPath } from "./recentProjects.js"; // MARK: wave4 w4-install

export const DEFAULT_WORKTREE_ROOT = "~/.reviewgate/worktrees";
export const DEFAULT_MAX_FILES = 10;
export const DEFAULT_MAX_LINES = 400;
export const HARD_MULTIPLIER = 2.0;
export const DEFAULT_GH_HOST = "github.com";
export const DEFAULT_IGNORE_PATTERNS = [".omc/", ".claude/settings.local.json"];
export const MAX_RECENT_PROJECTS = 10;

export { DEFAULT_SYSTEM_PROMPT_APPEND, renderSystemPrompt };

export const DEFAULTS: AppSettings = {
  appearance: "system",
  budgetEnabled: false, // §54: the change limit is opt-in
  budgetMaxFiles: DEFAULT_MAX_FILES,
  budgetMaxLines: DEFAULT_MAX_LINES,
  // §54: "" is the built-in append (DEFAULT_SYSTEM_PROMPT_APPEND) — the file no longer keeps a copy of a default that changes.
  systemPromptAppend: "",
  checkpointIgnorePatterns: DEFAULT_IGNORE_PATTERNS.join("\n"),
  autoAllowBash: false,
  autoAllowReadOnlyBash: true,
  bashAllowPatterns: "",
  projectBashAllowPatterns: {},
  // MARK: wave1 desktop-perms (§33.4 / §33.5 / §33.7)
  allowWorktreeIsolation: false,
  applyUserAllowRules: true,
  persistSessionAllows: false,
  notifications: true,
  notificationSound: true,
  loadUserSettings: true,
  ghHost: DEFAULT_GH_HOST,
  worktreeRoot: "",
  // MARK: §49 Run as Task
  runAsTaskEnabled: true,
  taskBranchPrefix: "task/",
  claudePath: "",
  ghPath: "",
  gitPath: "",
  recentProjects: [],
  preferredEditor: "auto",
  commitPushByDefault: false,
  commitTrailer: "",
  autoRestartSession: true,
  permissionMode: "default",
  cachedCapabilities: null,
  disabledPlugins: [],
  disableUserHooks: false,
  extensionsInitTimeoutMs: 20000,
  sideModel: "",
  sideAllowWeb: true,
  openWindows: [],
  reopenLastProjects: true,
  ui: {},
  // MARK: wave1 desktop-session
  peerInbound: "ask",
  // MARK: wave3 check-clients — §34.9
  testCommandPatterns: "",
  // MARK: wave4 w4-safety — daily-12
  confirmCloseWhileWorking: true,
  // MARK: wave4 w4-longwork — §38.2
  maxTurns: 200,
  // MARK: wave4b w4b-bigturn — §39.1
  largeFileMB: 50,
  // MARK: wave6 w6-statusline — §44.2
  showStatusLine: true,
  // MARK: §52
  backgroundWork: true,
};

let cache: AppSettings | null = null;

function file(): string {
  return join(app.getPath("userData"), "settings.json");
}

export function loadSettings(): AppSettings {
  if (cache) return cache;
  let stored: Partial<AppSettings> = {};
  try {
    if (existsSync(file())) stored = JSON.parse(readFileSync(file(), "utf8")) as Partial<AppSettings>;
  } catch {
    stored = {};
  }
  // §54: an earlier built-in append, stored because the file kept every default, is the built-in one now.
  if (isLegacySystemPromptAppend(stored.systemPromptAppend)) stored.systemPromptAppend = "";
  cache = { ...DEFAULTS, ...stored, locale: app.getLocale() };
  // Executable overrides are spawned by main: a stored value that is not a valid tool path
  // (hand-edited, or written before the native-dialog flow) is ignored, not trusted.
  for (const [kind, key] of Object.entries(EXECUTABLE_KEYS) as [ExecutableKind, (typeof EXECUTABLE_KEYS)[ExecutableKind]][]) {
    const v = cache[key];
    if (typeof v !== "string") cache[key] = "";
    else if (v !== "") {
      const why = validateExecutable(v, kind);
      if (why) {
        logLine("main", "warn", `settings: ignoring ${key} ${JSON.stringify(v)} (${why})`);
        cache[key] = "";
      }
    }
  }
  return cache;
}

/** Stores (or with "" clears) one executable override; callers validate first (`rg:pickExecutable`). */
export function setExecutablePath(kind: ExecutableKind, path: string): AppSettings {
  return saveSettings({ [EXECUTABLE_KEYS[kind]]: path } as Partial<AppSettings>);
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch };
  cache = next;
  const { locale: _locale, ...persisted } = next;
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(file(), JSON.stringify(persisted, null, 2) + "\n", "utf8");
  return next;
}

/**
 * M18: the OS-level chrome (titlebar, menus, native dialogs, default form controls) follows the
 * `appearance` setting. "system" hands control back to the OS. Called at startup and on every
 * `rg:setSettings` so the whole window changes with the renderer.
 */
export function applyAppearance(a: Appearance = loadSettings().appearance): void {
  nativeTheme.themeSource = a === "light" || a === "dark" ? a : "system";
}

export function addRecentProject(path: string): void {
  const p = resolve(path);
  if (isTransientProjectPath(p)) return; // MARK: wave4 w4-install (daily-17): scratch / test folders stay out, as on the Mac
  const s = loadSettings();
  const list = [p, ...s.recentProjects.filter((x) => x !== p)].slice(0, MAX_RECENT_PROJECTS);
  saveSettings({ recentProjects: list });
}

/** M15: per-project pane widths / sidebar tab / last file under `ui.<projectRootHash>`. */
export function saveProjectUI(hash: string, patch: ProjectUI): void {
  const ui = { ...(loadSettings().ui ?? {}) };
  ui[hash] = { ...ui[hash], ...patch };
  saveSettings({ ui });
}

export function setCachedCapabilities(caps: SessionCapabilities): void {
  saveSettings({ cachedCapabilities: caps });
}

export function expandTilde(p: string): string {
  return p.startsWith("~/") || p === "~" ? join(homedir(), p.slice(1)) : p;
}

/** The change limit's numbers as set in Settings (10 / 400 until changed), whether the limit is on or not. */
export function budgetLimitsOf(s: AppSettings) {
  return {
    maxFiles: s.budgetMaxFiles > 0 ? s.budgetMaxFiles : DEFAULT_MAX_FILES,
    maxLines: s.budgetMaxLines > 0 ? s.budgetMaxLines : DEFAULT_MAX_LINES,
    hardMultiplier: HARD_MULTIPLIER,
  };
}

/** `settings.budget`: the limits while the change limit is on, else none — 0 / 0, the engine counts nothing (§54). */
export function budgetOf(s: AppSettings) {
  return s.budgetEnabled === true ? budgetLimitsOf(s) : { maxFiles: 0, maxLines: 0 };
}

/**
 * The append as Claude gets it (§54): the user's own text, else the built-in one — followed by the limit's sentence while
 * the limit is on — with `{maxFiles}` / `{maxLines}` replaced by the limit's numbers (on or off).
 */
export function systemPromptOf(s: AppSettings): string {
  const own = typeof s.systemPromptAppend === "string" && s.systemPromptAppend.trim().length > 0 && !isLegacySystemPromptAppend(s.systemPromptAppend);
  const template = own ? s.systemPromptAppend : s.budgetEnabled === true ? `${DEFAULT_SYSTEM_PROMPT_APPEND} ${BUDGET_PROMPT_SENTENCE}` : DEFAULT_SYSTEM_PROMPT_APPEND;
  return renderSystemPrompt(template, budgetLimitsOf(s));
}


export const ignorePatternsOf = (s: AppSettings): string[] => linesOf(s.checkpointIgnorePatterns);

const winFs: WinFs = {
  exists: existsSync,
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
};
/** win32: `claude` found on PATH at startup, already resolved past a `.cmd` shim (src/main/winClaude.ts). */
let windowsClaude: string | null = null;

/** win32 only, once before the first window: locate `claude` like the engine does and resolve an npm `.cmd` shim to a spawnable program. */
export async function detectWindowsClaude(): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const found = await createPlatform("win32").which("claude", process.env);
    windowsClaude = found ? resolveWindowsClaude(found, winFs, process.env) : null;
    logLine("main", "main", `claude on PATH: ${found ?? "none"}${windowsClaude && windowsClaude !== found ? ` → ${windowsClaude}` : ""}`);
  } catch (e) {
    logLine("main", "warn", `claude detection failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The claude path handed to the engine: the override, else (win32) the detected one — on win32 never a bare `.cmd` shim when a real program exists. */
function claudeFor(s: AppSettings): string | undefined {
  const override = s.claudePath.trim().length > 0 ? s.claudePath.trim() : undefined;
  if (process.platform !== "win32") return override;
  const p = override ?? windowsClaude ?? undefined;
  return p ? resolveWindowsClaude(p, winFs, process.env) : undefined;
}

/**
 * The `hello` / `set_settings` payload (mirror of `AppSettings.engineSettings`). `projectRoot`: the window's open
 * project — its own allow patterns (`projectBashAllowPatterns`) are appended to the global ones.
 */
export function engineSettings(s: AppSettings = loadSettings(), projectRoot?: string | null): Settings {
  const opt = (v: string) => (v.trim().length > 0 ? v.trim() : undefined);
  // `commitPushByDefault` / `commitTrailer` (docs/M12-COMMIT.md) — the cast tolerates an engine without them yet.
  return {
    budget: budgetOf(s),
    ignorePatterns: ignorePatternsOf(s),
    autoAllowTools: s.autoAllowBash ? ["Bash"] : [],
    autoAllowReadOnlyBash: s.autoAllowReadOnlyBash !== false,
    bashAllowPatterns: mergedAllowPatterns(s.bashAllowPatterns ?? "", s.projectBashAllowPatterns, projectRoot),
    // MARK: wave1 desktop-perms (§33.4 / §33.5 / §33.7)
    allowWorktreeIsolation: s.allowWorktreeIsolation === true,
    applyUserAllowRules: s.applyUserAllowRules !== false,
    persistSessionAllows: s.persistSessionAllows === true,
    loadUserSettings: s.loadUserSettings,
    systemPromptAppend: systemPromptOf(s),
    claudePath: claudeFor(s),
    ghPath: opt(s.ghPath),
    gitPath: opt(s.gitPath),
    ghHost: s.ghHost.trim().length > 0 ? s.ghHost.trim() : DEFAULT_GH_HOST,
    worktreeRoot: expandTilde(s.worktreeRoot.trim().length > 0 ? s.worktreeRoot.trim() : DEFAULT_WORKTREE_ROOT),
    commitPushByDefault: s.commitPushByDefault === true,
    commitTrailer: s.commitTrailer.trim(),
    autoRestartSession: s.autoRestartSession !== false,
    permissionMode: isPermissionMode(s.permissionMode) ? s.permissionMode : "default",
    disabledPlugins: Array.isArray(s.disabledPlugins) ? s.disabledPlugins.filter((p) => typeof p === "string" && p.trim().length > 0) : [],
    disableUserHooks: s.disableUserHooks === true,
    extensionsInitTimeoutMs: Number.isFinite(s.extensionsInitTimeoutMs) && s.extensionsInitTimeoutMs >= 0 ? s.extensionsInitTimeoutMs : 20000,
    ...(typeof s.sideModel === "string" && s.sideModel.trim().length > 0 ? { sideModel: s.sideModel.trim() } : {}),
    sideAllowWeb: s.sideAllowWeb !== false,
    // MARK: wave1 desktop-session — §29 (a project's own `peer_set` wins; a bad stored value falls back to the engine's "ask")
    ...(isPeerInboundMode(s.peerInbound) ? { peerInbound: s.peerInbound } : {}),
    // MARK: wave3 check-clients — §34.9 the user's test commands (live; [] clears them)
    testCommandPatterns: testCommandPatternsOf(typeof s.testCommandPatterns === "string" ? s.testCommandPatterns : ""),
    // MARK: wave4 w4-longwork — §38.2 the tool-call limit (next session start; older engines keep 60)
    maxTurns: typeof s.maxTurns === "number" && Number.isFinite(s.maxTurns) ? Math.min(1000, Math.max(10, Math.round(s.maxTurns))) : 200,
    // MARK: wave4b w4b-bigturn — §39.1 the large-file limit (live; older engines ignore it)
    largeFileMB: typeof s.largeFileMB === "number" && Number.isFinite(s.largeFileMB) ? Math.min(100_000, Math.max(1, Math.round(s.largeFileMB))) : 50,
    // MARK: wave4b w4b-side — §40.3 side questions on the web (absent / unknown: off; `sideAllowWeb` no longer turns it on)
    sideWeb: s.sideWeb === "rules" || s.sideWeb === "on" ? s.sideWeb : "off",
    // MARK: wave5 w5-model — §43.4 auto model (live; absent / unknown: manual, balanced — auto is off unless chosen)
    modelMode: s.modelMode === "auto" ? "auto" : "manual",
    modelAutoPolicy: s.modelAutoPolicy === "cost" || s.modelAutoPolicy === "quality" ? s.modelAutoPolicy : "balanced",
    // MARK: wave6 w6-statusline — §44.2 the user's status line (live; on unless turned off) and this project's own command
    // when the user allowed that very one here ("" none; older engines ignore it)
    showStatusLine: s.showStatusLine !== false,
    // MARK: §52 background commands and /loop (next session start; older engines ignore it)
    backgroundWork: s.backgroundWork !== false,
    allowedProjectStatusLine: allowedProjectStatusLineFor(s.projectStatusLineAllowed, projectRoot),
    // MARK: wave3 desktop-session — §36.6 this project's "Load local settings" (next session start; older engines ignore it)
    loadLocalSettings: loadLocalSettingsFor(s.projectLoadLocalSettings, projectRoot),
  } as Settings;
}
