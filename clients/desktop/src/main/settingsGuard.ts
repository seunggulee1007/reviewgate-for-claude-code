/**
 * Renderer → main settings validation (docs/M11-WINDOWS.md "Renderer trust"). `rg:setSettings` only
 * accepts the keys a Settings control writes, each with its type and range; everything else is
 * dropped and reported. The executable paths (`claudePath` / `ghPath` / `gitPath`) are NOT
 * renderer-writable: main spawns them, so they are set only through the native file dialog
 * (`rg:pickExecutable`) after `validateExecutable` — a compromised renderer cannot point main at an
 * arbitrary binary. Pure (no `electron`), so it is unit-tested (settingsGuard.test.ts).
 */
import { accessSync, constants, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { win32 } from "node:path";
import { isPeerInboundMode, isPermissionMode } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc.js";
import { isCommitTemplate, isPrRespondCommand, isProjectMap, isWorkbenchSetup } from "../shared/flowSettings.js"; // MARK: wave3 desktop-flow
import { PROJECT_HASH } from "./projectPatterns.js";
import { claudeHome, isClaudeVersionPath } from "./cliPin.js"; // MARK: wave3 desktop-session — §36.8
import { t } from "../renderer/i18n"; // MARK: wave4d w4d-windows

export type ExecutableKind = "claude" | "gh" | "git";
export const EXECUTABLE_KEYS: Record<ExecutableKind, "claudePath" | "ghPath" | "gitPath"> = { claude: "claudePath", gh: "ghPath", git: "gitPath" };
export const isExecutableKind = (v: unknown): v is ExecutableKind => v === "claude" || v === "gh" || v === "git";

const MAX_TEXT = 20_000;
type Check = (v: unknown) => boolean;

const bool: Check = (v) => typeof v === "boolean";
const int = (min: number, max: number): Check => (v) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const text = (max: number, opts: { singleLine?: boolean } = {}): Check => (v) =>
  typeof v === "string" && v.length <= max && !v.includes("\0") && (!opts.singleLine || !/[\r\n]/.test(v));
const oneOf = (...values: string[]): Check => (v) => typeof v === "string" && values.includes(v);

/** `github.example.com`, `ghe.local:8443` — or empty (= the default host). */
const host: Check = (v) => typeof v === "string" && (v === "" || (v.length <= 253 && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/.test(v.trim())));
/** "" (default), `~/…` or an absolute path. */
const folder: Check = (v) => {
  if (typeof v !== "string" || v.length > 4096 || v.includes("\0")) return false;
  const p = v.trim();
  return p === "" || p === "~" || p.startsWith("~/") || isAbsolute(p) || win32.isAbsolute(p);
};
/** `{ <8-hex project hash>: "<patterns, one per line>" }` (src/main/projectPatterns.ts). */
const projectPatterns: Check = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const entries = Object.entries(v);
  return entries.length <= 500 && entries.every(([k, p]) => PROJECT_HASH.test(k) && text(MAX_TEXT)(p));
};
/** MARK: wave3 desktop-session — `{ <8-hex project hash>: boolean }` (§36.6 `projectLoadLocalSettings`). */
const projectFlags: Check = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const entries = Object.entries(v);
  return entries.length <= 500 && entries.every(([k, b]) => PROJECT_HASH.test(k) && typeof b === "boolean");
};
/** MARK: wave6 w6-statusline — `{ <8-hex project hash>: <sha256 hex> }` (§44.2 `projectStatusLineAllowed`). */
const projectShas: Check = (v) => {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const entries = Object.entries(v);
  return entries.length <= 500 && entries.every(([k, s]) => PROJECT_HASH.test(k) && typeof s === "string" && /^[0-9a-f]{64}$/.test(s));
};
const pluginIds: Check = (v) => Array.isArray(v) && v.length <= 500 && v.every((p) => typeof p === "string" && p.length > 0 && p.length <= 300 && !p.includes("\0"));

/** Every key a renderer may write through `rg:setSettings`, with its check. */
const RENDERER_WRITABLE: { [K in keyof AppSettings]?: Check } = {
  appearance: oneOf("system", "light", "dark"),
  budgetMaxFiles: int(1, 1000),
  budgetMaxLines: int(1, 100_000),
  systemPromptAppend: text(MAX_TEXT),
  checkpointIgnorePatterns: text(MAX_TEXT),
  autoAllowBash: bool,
  autoAllowReadOnlyBash: bool,
  bashAllowPatterns: text(MAX_TEXT),
  projectBashAllowPatterns: projectPatterns,
  // MARK: wave3 desktop-flow — §36.11–36.14, per repository hash (src/shared/flowSettings.ts)
  projectCommitTemplate: (v) => isProjectMap(v, isCommitTemplate),
  projectWorkbenchSetup: (v) => isProjectMap(v, isWorkbenchSetup),
  projectPrRespondCommand: (v) => isProjectMap(v, isPrRespondCommand),
  preReviewEffort: oneOf("low", "medium", "high"),
  // MARK: wave1 desktop-perms (§33.4 / §33.5 / §33.7)
  allowWorktreeIsolation: bool,
  applyUserAllowRules: bool,
  persistSessionAllows: bool,
  notifications: bool,
  notificationSound: bool,
  loadUserSettings: bool,
  ghHost: host,
  worktreeRoot: folder,
  // MARK: §49 Run as Task — the switch, and the prefix the last task branch used ("" or path parts ending in `/`)
  runAsTaskEnabled: bool,
  taskBranchPrefix: (v) => text(200, { singleLine: true })(v) && /^(?:[A-Za-z0-9._-]+\/)*$/.test(v as string),
  preferredEditor: oneOf("auto", "vscode", "idea", "explorer"),
  commitPushByDefault: bool,
  commitTrailer: text(1000, { singleLine: true }),
  autoRestartSession: bool,
  permissionMode: (v) => isPermissionMode(v),
  disabledPlugins: pluginIds,
  disableUserHooks: bool,
  extensionsInitTimeoutMs: int(0, 600_000),
  sideModel: (v) => typeof v === "string" && v.length <= 100 && /^[A-Za-z0-9._:\[\]/-]*$/.test(v.trim()),
  sideAllowWeb: bool,
  reopenLastProjects: bool,
  // MARK: wave1 desktop-session — §29
  peerInbound: (v) => isPeerInboundMode(v),
  // MARK: wave3 check-clients — §34.9 one glob per line
  testCommandPatterns: text(MAX_TEXT),
  // MARK: wave4 w4-longwork — §38.2
  maxTurns: int(10, 1000),
  // MARK: wave4b w4b-bigturn — §39.1
  largeFileMB: int(1, 100_000),
  // MARK: wave3 desktop-session — §36.6
  projectLoadLocalSettings: (v) => projectFlags(v),
  // MARK: wave4 w4-safety — daily-12
  confirmCloseWhileWorking: bool,
  // MARK: wave4b w4b-tabs — market-12
  showExploreDetail: bool,
  // MARK: wave4b w4b-side — §40.3
  sideWeb: (v) => v === "off" || v === "rules" || v === "on",
  // MARK: wave5 w5-model — §43.4
  modelMode: (v) => v === "manual" || v === "auto",
  modelAutoPolicy: (v) => v === "cost" || v === "balanced" || v === "quality",
  // MARK: wave6 w6-statusline — §44.2
  showStatusLine: bool,
  // MARK: §52
  backgroundWork: bool,
  projectStatusLineAllowed: (v) => projectShas(v),
  // MARK: wave4b w4-notify — §39.6
  notifyWaiting: bool,
  notifyTurnEnd: bool,
  notifyOther: bool,
  notificationsHintDismissed: bool,
};

export type SanitizedPatch = { patch: Partial<AppSettings>; rejected: string[] };

/** Keeps the renderer-writable keys whose value passes its check; every other key is listed in `rejected`. */
export function sanitizeSettingsPatch(raw: unknown): SanitizedPatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    return { patch: {}, rejected: ["(not a plain object)"] };
  }
  const patch: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const check = Object.hasOwn(RENDERER_WRITABLE, key) ? RENDERER_WRITABLE[key as keyof AppSettings] : undefined;
    if (check && check(value)) patch[key] = Array.isArray(value) ? [...value] : typeof value === "object" && value !== null ? { ...value } : value;
    else rejected.push(key);
  }
  return { patch: patch as Partial<AppSettings>, rejected };
}

/** File names a picked executable may have, per platform (`claude`, `claude.exe`, `claude.cmd`, …). */
export function allowedNames(kind: ExecutableKind, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [kind];
  // npm installs `claude` as a `.cmd` shim (resolved to the real program by winClaude.ts); gh / git ship .exe files.
  return kind === "claude" ? ["claude.exe", "claude.cmd"] : [`${kind}.exe`];
}

type FsLike = { isFile(path: string): boolean; isExecutable(path: string): boolean };
const realFs: FsLike = {
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isExecutable: (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Null when `path` may be stored as the `kind` override: an absolute path to an existing regular
 * file whose name is the tool's (`allowedNames`) and — off Windows — that is executable. Otherwise
 * the reason it is refused.
 */
export function validateExecutable(path: unknown, kind: ExecutableKind, platform: NodeJS.Platform = process.platform, fs: FsLike = realFs, home: string = claudeHome(platform)): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0")) return "not a path";
  const abs = platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
  if (!abs) return "not an absolute path";
  const name = (platform === "win32" ? win32.basename(path) : basename(path)).toLowerCase();
  // MARK: wave3 desktop-session — §36.8: a pinned version of the native installer (`~/.local/share/claude/versions/<ver>`) is claude too.
  const pinned = kind === "claude" && isClaudeVersionPath(path, home, platform);
  if (!allowedNames(kind, platform).includes(name) && !pinned) return `the file must be named ${allowedNames(kind, platform).join(" or ")}`;
  if (!fs.isFile(path)) return "no such file";
  if (platform !== "win32" && !fs.isExecutable(path)) return "not executable";
  return null;
}

// MARK: wave4d w4d-windows — audit polish-07: the reason a picked program (`validateExecutable`) or a pinned CLI version
// (`pinnedVersionPath`) is refused, in the UI language for Settings' "Not used: …" line. The log keeps main's English reason.
export function refusalText(why: string, kind: ExecutableKind, platform: NodeJS.Platform = process.platform): string {
  if (why.startsWith("the file must be named")) return t("The file must be named {0}.", allowedNames(kind, platform).join(t(" or ")));
  switch (why) {
    case "not a path":
      return t("This is not a file path.");
    case "not an absolute path":
      return t("This is not a full path.");
    case "no such file":
      return t("The file does not exist.");
    case "not executable":
      return t("The file cannot be run (no execute permission).");
    case "not a version":
      return t("This is not a version name.");
    case "no such version":
      return t("That version is not installed.");
    default:
      return why;
  }
}
