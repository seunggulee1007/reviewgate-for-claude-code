/**
 * MARK: polish p-lifecycle — P5-sheets-49: the Windows client notices a new release — the Mac's §48 check (the newest GitHub
 * release that is neither a draft nor a pre-release, against the running version). At launch (after 8 s) and every 6 hours
 * while Settings › General "Check for updates automatically" (`autoCheckUpdates`, absent = on) is on, and from Help › Check
 * for Updates…, which always says the result. A newer release shows a banner in every window (BannerStack's
 * UpdateBanner): [Open Release Page] (the installer is there), [Later] (this version stays quiet; a newer one shows
 * again). Read with the GitHub CLI when it is there (as the Mac does), else GitHub's public API.
 */
import { execFile } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, net, shell } from "electron";
import { compareVersions, createPlatform, locateToolchain } from "@reviewgate/engine";
import { REPOSITORY } from "./links.js";
import { logLine } from "./log.js";
import { loadSettings, saveSettings } from "./settings.js";
import { t } from "../renderer/i18n";
import type { UpdateStatus } from "../shared/ipc.js";

export type ReleaseInfo = { version: string; tag: string; page: string };
export type UpdateOutcome = { kind: "available"; release: ReleaseInfo } | { kind: "upToDate"; latest: string } | { kind: "unavailable"; why: string };

export const FIRST_CHECK_MS = 8_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;

/** `releases/latest` → the release, null when the reply is not one (a draft or pre-release never is). */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const r = json as Record<string, unknown>;
  const tag = typeof r["tag_name"] === "string" ? r["tag_name"] : "";
  const version = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version) || r["draft"] === true || r["prerelease"] === true) return null;
  const page = typeof r["html_url"] === "string" && r["html_url"].startsWith("https://github.com/") ? r["html_url"] : `${RELEASES_PAGE}/tag/${tag}`;
  return { version, tag, page };
}

/** The reply against the running version. */
export function outcomeOf(json: unknown, current: string): UpdateOutcome {
  const release = parseRelease(json);
  if (!release) return { kind: "unavailable", why: t("GitHub's reply could not be read ({0}).", "releases/latest") };
  return compareVersions(release.version, current) > 0 ? { kind: "available", release } : { kind: "upToDate", latest: release.version };
}

export type FetchLatest = () => Promise<{ ok: true; json: unknown } | { ok: false; why: string }>;

/** `gh api repos/…/releases/latest` with the user's login (the Mac's way), else GitHub's public API over the system's proxy. */
export const fetchLatest: FetchLatest = async () => {
  const s = loadSettings();
  const tc = await locateToolchain(createPlatform(process.platform), process.env as Record<string, string>, { gh: s.ghPath }).catch(() => null);
  if (tc?.gh) {
    const viaGh = await new Promise<{ ok: true; json: unknown } | null>((resolve) => {
      execFile(tc.gh!, ["api", "--hostname", "github.com", `repos/${REPOSITORY}/releases/latest`], { env: { ...process.env, PATH: tc.path, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }, timeout: 30_000, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
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
    const res = await net.fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { headers: { Accept: "application/vnd.github+json", "User-Agent": `ReviewGate/${app.getVersion()}` } });
    if (res.status === 404) return { ok: false, why: t("No release was found — none is published yet, or this GitHub account cannot see {0}.", REPOSITORY) };
    if (!res.ok) return { ok: false, why: t("The update check failed: {0}", `HTTP ${res.status}`) };
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, why: t("GitHub could not be reached. Check the network connection and try again.") };
  }
};

let found: ReleaseInfo | null = null;
let checking: Promise<UpdateOutcome> | null = null;

/** What the banner shows: a newer release, unless the user said Later for that version. */
export function updateStatus(): UpdateStatus | null {
  if (!found) return null;
  const dismissed = loadSettings().dismissedUpdateVersion;
  if (dismissed && compareVersions(found.version, dismissed) <= 0) return null;
  return { version: found.version, current: app.getVersion(), page: found.page };
}

function broadcast(): void {
  const status = updateStatus();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send("rg:updateStatus", status);
}

/** One check (a second while one runs joins it). */
export function checkOnce(fetch: FetchLatest = fetchLatest): Promise<UpdateOutcome> {
  checking ??= (async () => {
    const r = await fetch();
    const outcome = r.ok ? outcomeOf(r.json, app.getVersion()) : ({ kind: "unavailable", why: r.why } as const);
    if (outcome.kind === "available") found = outcome.release;
    else if (outcome.kind === "upToDate") found = null;
    logLine("main", "main", `update check: ${outcome.kind}${outcome.kind === "available" ? ` ${outcome.release.version}` : ""}`);
    broadcast();
    return outcome;
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/** Help › Check for Updates…: the result is always said; a version closed with Later comes back. */
export async function checkForUpdatesNow(): Promise<void> {
  const outcome = await checkOnce();
  const owner = BrowserWindow.getFocusedWindow();
  const show = (o: Electron.MessageBoxOptions) => (owner ? dialog.showMessageBox(owner, o) : dialog.showMessageBox(o));
  if (outcome.kind === "available") {
    if (loadSettings().dismissedUpdateVersion) {
      saveSettings({ dismissedUpdateVersion: undefined });
      broadcast();
    }
    const r = await show({ type: "info", message: t("ReviewGate {0} is available", outcome.release.version), detail: t("This app is {0}; the latest release is {1}.", app.getVersion(), outcome.release.version), buttons: [t("Open Release Page"), t("Later")], defaultId: 0, cancelId: 1, noLink: true });
    if (r.response === 0) void shell.openExternal(outcome.release.page);
  } else if (outcome.kind === "upToDate") {
    const current = app.getVersion();
    await show({ type: "info", message: t("ReviewGate is up to date"), detail: compareVersions(current, outcome.latest) === 0 ? t("{0} is the latest release.", current) : t("This app is {0}; the latest release is {1}.", current, outcome.latest), buttons: [t("Close")], noLink: true });
  } else {
    await show({ type: "warning", message: t("Could not check for updates"), detail: outcome.why, buttons: [t("Close")], noLink: true });
  }
}

/** At launch and every 6 hours while automatic checks are on; the banner's answers. */
export function installUpdates(): void {
  ipcMain.handle("rg:updateStatus", () => updateStatus());
  ipcMain.handle("rg:openUpdate", () => {
    if (found) void shell.openExternal(found.page);
  });
  ipcMain.handle("rg:dismissUpdate", () => {
    if (!found) return;
    saveSettings({ dismissedUpdateVersion: found.version });
    broadcast();
  });
  const auto = () => loadSettings().autoCheckUpdates !== false;
  setTimeout(() => {
    if (auto()) void checkOnce();
    setInterval(() => {
      if (auto()) void checkOnce();
    }, CHECK_EVERY_MS).unref();
  }, FIRST_CHECK_MS).unref();
}
