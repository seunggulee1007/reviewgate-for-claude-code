/**
 * MARK: polish p-lifecycle — P5-sheets-49: the Windows client notices a new release — the Mac's §48 check (the newest GitHub
 * release that is neither a draft nor a pre-release, against the running version). At launch (after 8 s) and every 6 hours
 * while Settings › Updates "Check for updates automatically" (`autoCheckUpdates`, absent = on) is on, from Help › Check for
 * Updates…, which always says the result, and from Settings' [Check Now]. A newer release shows a banner in every window
 * (UpdateBanner). Read with the GitHub CLI when it is there (as the Mac does), else GitHub's public API.
 *
 * §48 Windows — the in-app install: [Install and Restart] downloads the release's `ReviewGate-Setup-X.Y.Z.exe` and its
 * `.sha256` (src/main/updateDownload.ts — GitHub hosts only, capped), checks them (src/main/updateVerify.ts), waits for
 * Claude, records {from, to} and quits; once every engine has stopped the installer runs silently and reopens the app
 * (src/main/updateInstall.ts). The next launch says "Updated to X" or why it did not install, once. [Download Page] is
 * always there.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, net, shell } from "electron";
import { compareVersions, createPlatform, locateToolchain } from "@reviewgate/engine";
import { REPOSITORY } from "./links.js";
import { logLine } from "./log.js";
import { loadSettings, saveSettings } from "./settings.js";
import { t } from "../renderer/i18n";
import type { UpdateStatus } from "../shared/ipc.js";
import { downloadTo, MAX_CHECKSUM_BYTES, MAX_INSTALLER_BYTES, type HttpGet } from "./updateDownload.js";
import { installerAssets, verifyInstaller, type InstallerAssets } from "./updateVerify.js";
import { blockerLine, installRefusal, launchInstaller, noticeOf, updatesFolder, UpdateInstaller, validRecord, type Blocker, type Prepared, type SpawnInstaller, type UpdateNotice } from "./updateInstall.js";

export type ReleaseInfo = { version: string; tag: string; page: string; notes: string; assets: InstallerAssets | null };
export type UpdateOutcome = { kind: "available"; release: ReleaseInfo } | { kind: "upToDate"; latest: string } | { kind: "unavailable"; why: string };

export const FIRST_CHECK_MS = 8_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;
const MAX_NOTES = 100_000;

/** A release reply (`releases/latest`, `releases/tags/vX`) → the release, null when it is not one (a draft or pre-release never is). */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const r = json as Record<string, unknown>;
  const tag = typeof r["tag_name"] === "string" ? r["tag_name"] : "";
  const version = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version) || r["draft"] === true || r["prerelease"] === true) return null;
  const page = typeof r["html_url"] === "string" && r["html_url"].startsWith("https://github.com/") ? r["html_url"] : `${RELEASES_PAGE}/tag/${tag}`;
  const notes = typeof r["body"] === "string" ? r["body"].slice(0, MAX_NOTES) : "";
  return { version, tag, page, notes, assets: installerAssets(json, version) };
}

/** The reply against the running version. */
export function outcomeOf(json: unknown, current: string): UpdateOutcome {
  const release = parseRelease(json);
  if (!release) return { kind: "unavailable", why: t("GitHub's reply could not be read ({0}).", "releases/latest") };
  return compareVersions(release.version, current) > 0 ? { kind: "available", release } : { kind: "upToDate", latest: release.version };
}

export type FetchLatest = () => Promise<{ ok: true; json: unknown } | { ok: false; why: string }>;

/** `gh api repos/…/<path>` with the user's login (the Mac's way), else GitHub's public API over the system's proxy. */
async function fetchRelease(path: string): Promise<{ ok: true; json: unknown } | { ok: false; why: string }> {
  const s = loadSettings();
  const tc = await locateToolchain(createPlatform(process.platform), process.env as Record<string, string>, { gh: s.ghPath }).catch(() => null);
  if (tc?.gh) {
    const viaGh = await new Promise<{ ok: true; json: unknown } | null>((resolve) => {
      execFile(tc.gh!, ["api", "--hostname", "github.com", `repos/${REPOSITORY}/${path}`], { env: { ...process.env, PATH: tc.path, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }, timeout: 30_000, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve({ ok: true, json: JSON.parse(String(stdout)) });
        } catch {
          resolve(null);
        }
      });
    });
    if (viaGh) return viaGh;
  }
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": `ReviewGate/${app.getVersion()}` } });
    if (res.status === 404) return { ok: false, why: t("No release was found — none is published yet, or this GitHub account cannot see {0}.", REPOSITORY) };
    if (!res.ok) return { ok: false, why: t("The update check failed: {0}", `HTTP ${res.status}`) };
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, why: t("GitHub could not be reached. Check the network connection and try again.") };
  }
}

export const fetchLatest: FetchLatest = () => fetchRelease("releases/latest");

/** Electron's `net` (the system's proxy), redirects not followed: `downloadTo` checks each hop's host first. */
const electronGet: HttpGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: "manual", useSessionCookies: false, cache: "no-store" });
    req.setHeader("User-Agent", `ReviewGate/${app.getVersion()}`);
    req.setHeader("Accept", "application/octet-stream");
    signal.addEventListener("abort", () => req.abort(), { once: true });
    req.on("redirect", (status, _method, location) => resolve({ status, location, length: 0, body: (async function* () {})(), discard: () => req.abort() }));
    req.on("response", (res) => {
      const h = res.headers["content-length"];
      const len = Array.isArray(h) ? h[0] : h;
      resolve({ status: res.statusCode, length: len === undefined ? null : Number(len), body: res as unknown as AsyncIterable<Uint8Array>, discard: () => req.abort() });
    });
    req.on("error", reject);
    req.on("abort", () => reject(new Error("aborted")));
    req.end();
  });

let found: ReleaseInfo | null = null;
let checking: Promise<UpdateOutcome> | null = null;
let lastCheck: { at: number; text: string } | null = null;
let notice: UpdateNotice | null = null;
/** The notes of the version the launch's "Updated to X" is about (null: offline, none). */
let noticeNotes: string | null = null;
/** Set by the quit for an update; run by `afterEnginesStopped`. */
let pendingInstaller: Prepared | null = null;
/** The launch's removal of earlier downloads; a new download waits for it. */
let cleaned: Promise<void> = Promise.resolve();

export type UpdateHooks = {
  /** The windows where Claude works or a card waits (src/shared/closeGuard.ts `closeGuardReason`). */
  blockers: () => Blocker[];
  /** Quit without the "Quit ReviewGate?" question (the wait already saw every window idle, or the user said Restart Now). */
  quit: () => void;
  focus: (windowId: number) => void;
};
let hooks: UpdateHooks = { blockers: () => [], quit: () => app.quit(), focus: () => undefined };

const discard = (folder: string) => void rm(folder, { recursive: true, force: true }).catch(() => undefined);

/** Calls `progress` at most every 200 ms, and with the last byte. */
function throttled(progress: (received: number, total: number | null) => void): (received: number, total: number | null) => void {
  let last = 0;
  return (received, total) => {
    const now = Date.now();
    if (now - last < 200 && received !== total) return;
    last = now;
    progress(received, total);
  };
}

const installer = new UpdateInstaller({
  current: app.getVersion(),
  download: async (target, signal, progress) => {
    await cleaned;
    const folder = join(updatesFolder(app.getPath("userData")), `${target.version}-${randomUUID().slice(0, 8)}`);
    await mkdir(folder, { recursive: true });
    try {
      const { installer: exe, checksum } = target.assets;
      const sumFile = join(folder, checksum.name);
      await downloadTo(checksum.url, sumFile, { get: electronGet, signal, maxBytes: MAX_CHECKSUM_BYTES });
      const checksumText = await readFile(sumFile, "utf8");
      const file = join(folder, exe.name);
      await downloadTo(exe.url, file, { get: electronGet, signal, maxBytes: MAX_INSTALLER_BYTES, expectedSize: exe.size, onProgress: throttled(progress) });
      return { file, folder, checksumText };
    } catch (e) {
      discard(folder);
      throw e;
    }
  },
  verify: (target, prepared, checksumText) =>
    verifyInstaller({ file: prepared.file, name: target.assets.installer.name, version: target.version, current: app.getVersion(), checksumText, digest: target.assets.installer.digest }),
  discard,
  blockers: () => hooks.blockers(),
  confirmRestartNow: async (blockers) => {
    const owner = BrowserWindow.getFocusedWindow();
    const o: Electron.MessageBoxOptions = { type: "warning", message: t("Restart now?"), detail: [t("The turns that run are stopped."), ...blockers.map(blockerLine)].join("\n"), buttons: [t("Restart Now"), t("Cancel")], defaultId: 1, cancelId: 1, noLink: true };
    return (await (owner ? dialog.showMessageBox(owner, o) : dialog.showMessageBox(o))).response === 0;
  },
  saveRecord: (record) => saveSettings({ pendingUpdateInstall: record ?? undefined, restoreOnceAfterRelaunch: record ? true : undefined }),
  quit: (prepared) => {
    pendingInstaller = prepared;
    logLine("main", "main", `update: quitting to install ${installer.target?.version ?? "?"}`);
    hooks.quit();
  },
  changed: () => broadcast(),
});

/** Why the found release cannot be installed from the app; null: it can. */
function refusal(release: ReleaseInfo): string | null {
  const why = installRefusal({ platform: process.platform, packaged: app.isPackaged, execPath: process.execPath, env: process.env, exists: existsSync });
  if (why) return why;
  return release.assets ? null : t("The release has no Windows installer with its checksum yet — try again later, or download it from the release page.");
}

/** What every window's banner and Settings › Updates show. */
export function updateStatus(): UpdateStatus {
  const dismissed = loadSettings().dismissedUpdateVersion;
  const quiet = found !== null && installer.view === null && !!dismissed && compareVersions(found.version, dismissed) <= 0;
  const view = installer.view;
  const installing = installer.target?.version ?? found?.version ?? "";
  const shownVersion = view ? installing : (found?.version ?? (notice ? notice.version : null));
  return {
    current: app.getVersion(),
    release: found && !quiet ? { version: found.version, page: found.page, hasNotes: found.notes.trim() !== "", why: refusal(found) } : null,
    install: view ? { ...(view.kind === "waiting" ? { kind: "waiting", blockers: view.blockers.map((b) => ({ id: b.id, line: blockerLine(b) })) } : view), version: installing } : null,
    notice: notice ? (notice.kind === "updated" ? { ...notice, hasNotes: noticeNotes !== null && noticeNotes.trim() !== "" } : notice) : null,
    downloadPage: shownVersion ? `${RELEASES_PAGE}/tag/v${shownVersion}` : RELEASES_PAGE,
    lastCheck,
    checking: checking !== null,
  };
}

function broadcast(): void {
  const status = updateStatus();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send("rg:updateStatus", status);
}

/** One check (a second while one runs joins it). */
export function checkOnce(fetch: FetchLatest = fetchLatest): Promise<UpdateOutcome> {
  if (checking) return checking;
  checking = (async () => {
    await Promise.resolve(); // `checking` is set before the windows are told
    broadcast();
    const r = await fetch();
    const outcome = r.ok ? outcomeOf(r.json, app.getVersion()) : ({ kind: "unavailable", why: r.why } as const);
    if (outcome.kind === "available") found = outcome.release;
    else if (outcome.kind === "upToDate") found = null;
    lastCheck = { at: Date.now(), text: outcome.kind === "available" ? t("ReviewGate {0} is available", outcome.release.version) : outcome.kind === "upToDate" ? t("ReviewGate is up to date") : outcome.why };
    logLine("main", "main", `update check: ${outcome.kind}${outcome.kind === "available" ? ` ${outcome.release.version}${outcome.release.assets ? "" : " (no Windows installer yet)"}` : ""}`);
    return outcome;
  })().finally(() => {
    checking = null;
    broadcast();
  });
  return checking;
}

/** [Install and Restart] / [Try Again]: the found release (looked up first when no check has found one). */
export async function installNow(): Promise<void> {
  if (installer.busy) return;
  if (!found || compareVersions(found.version, app.getVersion()) <= 0) await checkOnce();
  const release = found;
  const why = release ? refusal(release) : t("No newer release was found.");
  if (!release || !release.assets || why) {
    // The launch's "did not install" keeps its place and says why this try did not start either.
    if (notice?.kind === "failed") notice = { ...notice, why: why ?? notice.why };
    else lastCheck = { at: Date.now(), text: why ?? "" };
    broadcast();
    return;
  }
  if (notice?.kind === "failed") notice = null;
  if (loadSettings().dismissedUpdateVersion) saveSettings({ dismissedUpdateVersion: undefined });
  logLine("main", "main", `update: installing ${release.version}`);
  await installer.start({ version: release.version, assets: release.assets });
  if (installer.view?.kind === "failed") logLine("main", "error", `update: ${installer.view.why}`);
}

/**
 * main's quit, once every engine has stopped: the installer prepared for this quit starts (detached) and the app exits.
 * It could not start → the record says why and the app reopens (the previous version, which says so).
 */
export async function afterEnginesStopped(spawnInstaller: SpawnInstaller = spawn as unknown as SpawnInstaller): Promise<void> {
  const ready = pendingInstaller;
  if (!ready) return;
  pendingInstaller = null;
  const why = await launchInstaller(ready.file, spawnInstaller);
  if (why === null) {
    logLine("main", "main", `update: installer started (${ready.file})`);
    return;
  }
  logLine("main", "error", `update: ${why}`);
  const record = validRecord(loadSettings().pendingUpdateInstall);
  saveSettings({ pendingUpdateInstall: record ? { ...record, why } : undefined });
  app.relaunch();
}

/** Help › Check for Updates…: the result is always said; a version closed with Later comes back. */
export async function checkForUpdatesNow(): Promise<void> {
  const owner = BrowserWindow.getFocusedWindow();
  const show = (o: Electron.MessageBoxOptions) => (owner ? dialog.showMessageBox(owner, o) : dialog.showMessageBox(o));
  if (installer.busy) {
    await show({ type: "info", message: t("Installing ReviewGate {0}", installer.target?.version ?? ""), detail: t("The update is being installed — the banner at the top of the window shows its progress."), buttons: [t("Close")], noLink: true });
    return;
  }
  const outcome = await checkOnce();
  if (outcome.kind === "available") {
    if (loadSettings().dismissedUpdateVersion) {
      saveSettings({ dismissedUpdateVersion: undefined });
      broadcast();
    }
    const why = refusal(outcome.release);
    const buttons = why ? [t("Download Page"), t("Later")] : [t("Install and Restart"), t("Download Page"), t("Later")];
    const detail = [t("This app is {0}; the latest release is {1}.", app.getVersion(), outcome.release.version), ...(why ? [why] : [])].join("\n\n");
    const r = await show({ type: "info", message: t("ReviewGate {0} is available", outcome.release.version), detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
    const picked = buttons[r.response];
    if (picked === t("Install and Restart")) void installNow();
    else if (picked === t("Download Page")) void shell.openExternal(outcome.release.page);
  } else if (outcome.kind === "upToDate") {
    const current = app.getVersion();
    await show({ type: "info", message: t("ReviewGate is up to date"), detail: compareVersions(current, outcome.latest) === 0 ? t("{0} is the latest release.", current) : t("This app is {0}; the latest release is {1}.", current, outcome.latest), buttons: [t("Close")], noLink: true });
  } else {
    await show({ type: "warning", message: t("Could not check for updates"), detail: outcome.why, buttons: [t("Close")], noLink: true });
  }
}

/** The launch: what the last update did (said once), earlier downloads removed; checks at launch and every 6 hours; the banner's answers. */
export function installUpdates(h: UpdateHooks): void {
  hooks = h;
  const record = loadSettings().pendingUpdateInstall;
  if (record !== undefined) {
    saveSettings({ pendingUpdateInstall: undefined });
    notice = noticeOf(record, app.getVersion());
    logLine("main", "main", `update: after the restart — ${notice ? (notice.kind === "updated" ? `updated to ${notice.version}` : `${notice.version} did not install: ${notice.why}`) : "an unreadable record"}`);
    if (notice?.kind === "updated") {
      const version = notice.version;
      void fetchRelease(`releases/tags/v${version}`).then((r) => {
        const release = r.ok ? parseRelease(r.json) : null;
        if (release && release.version === version && notice?.kind === "updated") {
          noticeNotes = release.notes;
          broadcast();
        }
      });
    }
  }
  cleaned = rm(updatesFolder(app.getPath("userData")), { recursive: true, force: true }).catch(() => undefined);

  ipcMain.handle("rg:updateStatus", () => updateStatus());
  ipcMain.handle("rg:openUpdate", () => void shell.openExternal(updateStatus().downloadPage));
  ipcMain.handle("rg:dismissUpdate", () => {
    if (!found || installer.busy) return;
    saveSettings({ dismissedUpdateVersion: found.version });
    broadcast();
  });
  ipcMain.handle("rg:installUpdate", () => installNow());
  ipcMain.handle("rg:cancelUpdate", () => installer.cancel());
  ipcMain.handle("rg:restartNowForUpdate", () => installer.restartNow());
  ipcMain.handle("rg:dismissUpdateNotice", (_e, which: unknown) => {
    if (which === "install") installer.dismissFailure();
    else notice = null;
    broadcast();
  });
  ipcMain.handle("rg:checkUpdatesNow", async () => void (await checkOnce()));
  ipcMain.handle("rg:focusUpdateBlocker", (_e, id: unknown) => {
    if (typeof id === "number" && Number.isInteger(id)) hooks.focus(id);
  });
  ipcMain.handle("rg:updateNotes", (_e, version: unknown) => {
    if (typeof version !== "string") return null;
    if (found?.version === version) return found.notes;
    if (notice?.kind === "updated" && notice.version === version) return noticeNotes;
    return null;
  });
  const auto = () => loadSettings().autoCheckUpdates !== false;
  setTimeout(() => {
    if (auto()) void checkOnce();
    setInterval(() => {
      if (auto()) void checkOnce();
    }, CHECK_EVERY_MS).unref();
  }, FIRST_CHECK_MS).unref();
}
