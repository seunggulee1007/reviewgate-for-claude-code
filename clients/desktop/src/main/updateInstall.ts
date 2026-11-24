/**
 * The Windows in-app update from [Install and Restart] to the next launch (docs/PROTOCOL.md §48, Windows) — the Mac's
 * `AppUpdateController` steps: downloading → checking → (waiting for Claude) → ready → the quit; a failure says why and
 * keeps the release page one click away. Electron-free: main passes the download, the checks, the windows Claude works in
 * and the quit (src/main/update.ts).
 *
 * The installer is electron-builder's assisted NSIS installer. Run with `INSTALLER_ARGS` it installs silently for the
 * current user over the installed version (its uninstaller is run with --updated: settings and shortcuts stay) and starts
 * the app when it is done (`--force-run`, honoured by the assisted installer only together with `/S`). An install for all
 * users (under Program Files) gets `ELEVATED_INSTALLER_ARGS`, started through Windows PowerShell's `Start-Process -Verb
 * RunAs`: Windows asks once for administrator rights (UAC); declined, the update says so after the relaunch.
 */
import { dirname, join, win32 } from "node:path";
import { compareVersions } from "@reviewgate/engine";
import { t } from "../renderer/i18n";
import type { InstallerAssets } from "./updateVerify.js";

/** `/S` silent · `/currentuser` the per-user install, never elevated · `--updated` an update (no "app is running" box, the
 * old uninstaller keeps app data) · `--force-run` start ReviewGate when done (with `--updated` passed to it). */
export const INSTALLER_ARGS: readonly string[] = ["/S", "/currentuser", "--updated", "--force-run"];
/** The same for an install for all users (`/allusers`), run elevated. */
export const ELEVATED_INSTALLER_ARGS: readonly string[] = ["/S", "/allusers", "--updated", "--force-run"];
/** How long "Ready — ReviewGate closes and reopens as X" shows before the quit. */
export const READY_MS = 2000;
/** While Claude works the windows are looked at again this often. */
export const WAIT_POLL_MS = 1000;

/** Written before the quit (settings `pendingUpdateInstall`), taken once by the next launch. `why`: the installer did not start. */
export type UpdateRecord = { from: string; to: string; why?: string };
/** What the next launch says once: the version now running, or why the update did not install. */
export type UpdateNotice = { kind: "updated"; version: string; from: string } | { kind: "failed"; version: string; why: string };

const VERSION = /^\d+\.\d+\.\d+$/;

/** The record as the next launch reads it (anything else: none). */
export function validRecord(raw: unknown): UpdateRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const from = r["from"];
  const to = r["to"];
  if (typeof from !== "string" || typeof to !== "string" || !VERSION.test(from) || !VERSION.test(to)) return null;
  const why = typeof r["why"] === "string" && r["why"].trim() !== "" ? r["why"].slice(0, 300) : undefined;
  return why ? { from, to, why } : { from, to };
}

/** The running version is `to` or newer → updated; still older → did not install. Said once: the caller removes the record. */
export function noticeOf(raw: unknown, running: string): UpdateNotice | null {
  const r = validRecord(raw);
  if (!r) return null;
  if (compareVersions(running, r.to) >= 0) return { kind: "updated", version: running, from: r.from };
  return { kind: "failed", version: r.to, why: r.why ?? t("ReviewGate {0} is still installed.", running) };
}

/** How this copy updates itself: this user's install, an install for all users (Windows asks for administrator rights
 * once), or why it cannot. */
export type InstallMode = { kind: "user" } | { kind: "elevated" } | { kind: "refused"; why: string };

/**
 * Only the packaged app on Windows installed by the NSIS installer (its uninstaller beside it); under Program Files it is
 * an install for all users, updated elevated.
 */
export function installMode(o: { platform: NodeJS.Platform; packaged: boolean; execPath: string; env: Record<string, string | undefined>; exists: (p: string) => boolean }): InstallMode {
  const refused = (why: string): InstallMode => ({ kind: "refused", why });
  if (o.platform !== "win32") return refused(t("Installing from the app is for the Windows installer — download the new version from the release page."));
  if (!o.packaged) return refused(t("This is a development build — it does not install updates."));
  const dir = win32.dirname(win32.resolve(o.execPath));
  if (!o.exists(win32.join(dir, "Uninstall ReviewGate.exe"))) return refused(t("ReviewGate was not installed by its installer here — download the new version from the release page."));
  const machine = [o.env["ProgramFiles"], o.env["ProgramW6432"], o.env["ProgramFiles(x86)"]].filter((p): p is string => !!p).map((p) => win32.resolve(p).toLowerCase().replace(/\\?$/, "\\"));
  return machine.some((root) => (dir.toLowerCase() + "\\").startsWith(root)) ? { kind: "elevated" } : { kind: "user" };
}

/** A window the restart waits for. */
export type Blocker = { id: number; name: string; reason: "working" | "waiting" };

/** "acme-api: Claude is working" / "acme-api: a card waits for your answer" (a window without a project is "ReviewGate"). */
export function blockerLine(b: Blocker): string {
  const name = b.name || "ReviewGate";
  return b.reason === "working" ? t("{0}: Claude is working", name) : t("{0}: a card waits for your answer", name);
}

export type InstallView =
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "verifying" }
  | { kind: "waiting"; blockers: Blocker[] }
  | { kind: "ready" }
  | { kind: "failed"; why: string };

export type InstallTarget = { version: string; assets: InstallerAssets };
export type Prepared = { file: string; folder: string };

export type InstallDeps = {
  current: string;
  /** Both assets into a new folder; the checksum file's text with them. Throws with the reason (a cancel: anything). */
  download(target: InstallTarget, signal: AbortSignal, progress: (received: number, total: number | null) => void): Promise<Prepared & { checksumText: string }>;
  /** Why the installer is refused; null when it passes. */
  verify(target: InstallTarget, prepared: Prepared, checksumText: string): Promise<string | null>;
  /** Removes a download folder (quietly). */
  discard(folder: string): void;
  /** The windows where Claude works or a card waits. */
  blockers(): Blocker[];
  /** [Restart Now] while Claude works: "The turns that run are stopped." — true to go on. */
  confirmRestartNow(blockers: Blocker[]): Promise<boolean>;
  saveRecord(record: UpdateRecord | null): void;
  /** Quit; main runs the installer once every engine has stopped (src/main/update.ts `afterEnginesStopped`). */
  quit(prepared: Prepared): void;
  changed(): void;
};

/** One install at a time: start → download → verify → wait for Claude → ready (2 s) → record + quit. */
export class UpdateInstaller {
  view: InstallView | null = null;
  target: InstallTarget | null = null;
  private abort: AbortController | null = null;
  private prepared: Prepared | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private quitting = false;

  constructor(private readonly deps: InstallDeps) {}

  /** From the click to the quit (a failure is not under way). */
  get busy(): boolean {
    return this.view !== null && this.view.kind !== "failed";
  }

  async start(target: InstallTarget): Promise<void> {
    if (this.busy) return;
    const abort = new AbortController();
    this.abort = abort;
    this.target = target;
    this.set({ kind: "downloading", received: 0, total: target.assets.installer.size });
    let got: Prepared & { checksumText: string };
    try {
      got = await this.deps.download(target, abort.signal, (received, total) => {
        if (!abort.signal.aborted) this.set({ kind: "downloading", received, total });
      });
    } catch (e) {
      if (!abort.signal.aborted) this.set({ kind: "failed", why: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (abort.signal.aborted) return this.deps.discard(got.folder);
    this.set({ kind: "verifying" });
    let why: string | null;
    try {
      why = await this.deps.verify(target, got, got.checksumText);
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    if (abort.signal.aborted) return this.deps.discard(got.folder);
    if (why) {
      this.deps.discard(got.folder);
      this.set({ kind: "failed", why });
      return;
    }
    this.prepared = { file: got.file, folder: got.folder };
    this.proceed();
  }

  /** No window holds the restart → "Ready" for 2 s (looked at once more) → the quit; else wait and look again. */
  private proceed(): void {
    this.clearTimer();
    const blockers = this.deps.blockers();
    if (blockers.length > 0) {
      this.set({ kind: "waiting", blockers });
      this.timer = setTimeout(() => this.proceed(), WAIT_POLL_MS);
      return;
    }
    this.set({ kind: "ready" });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.deps.blockers().length > 0) return this.proceed();
      this.restart();
    }, READY_MS);
  }

  /** [Restart Now]: while Claude works, asked first ("The turns that run are stopped."); "Ready" goes straight on. */
  async restartNow(): Promise<void> {
    const v = this.view;
    if (!this.prepared || (v?.kind !== "waiting" && v?.kind !== "ready")) return;
    if (v.kind === "waiting" && !(await this.deps.confirmRestartNow(v.blockers))) return;
    if (!this.prepared || (this.view?.kind !== "waiting" && this.view?.kind !== "ready")) return; // cancelled meanwhile
    this.restart();
  }

  private restart(): void {
    if (this.quitting || !this.prepared || !this.target) return;
    this.clearTimer();
    this.quitting = true;
    this.set({ kind: "ready" });
    this.deps.saveRecord({ from: this.deps.current, to: this.target.version });
    this.deps.quit(this.prepared);
  }

  /** [Cancel]: the download stops, or the prepared installer is removed; the banner is the release's again. */
  cancel(): void {
    if (!this.busy || this.quitting) return;
    this.abort?.abort();
    this.clearTimer();
    if (this.prepared) this.deps.discard(this.prepared.folder);
    this.prepared = null;
    this.set(null);
  }

  /** [×] on a failure: back to the release's banner. */
  dismissFailure(): void {
    if (this.view?.kind === "failed") this.set(null);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(view: InstallView | null): void {
    this.view = view;
    this.deps.changed();
  }
}

/** A detached child that outlives the app (Node's `spawn`, narrowed). */
export type SpawnInstaller = (file: string, args: readonly string[], options: { detached: true; stdio: "ignore"; cwd: string; windowsHide: boolean }) => {
  once(event: "spawn", cb: () => void): unknown;
  once(event: "error", cb: (e: Error) => void): unknown;
  once(event: "exit", cb: (code: number | null) => void): unknown;
  unref(): void;
};

/** A PowerShell single-quoted string: each quote character PowerShell reads as one (' ‘ ’ ‚ ‛) doubled. */
export const psQuote = (s: string): string => `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

/**
 * What starts the installer: the installer itself for this user's install; for all users Windows PowerShell (by its full
 * path, never PATH) running `Start-Process -Verb RunAs` — the UAC prompt — given as -EncodedCommand (UTF-16LE, base64),
 * so no command-line quoting is involved: only the script's single-quoted strings. Its exit code is 0 once the installer
 * runs elevated, 1 when it did not (the prompt declined, or the start failed).
 */
export function installerCommand(file: string, mode: "user" | "elevated", systemRoot = "C:\\Windows"): { command: string; args: readonly string[] } {
  if (mode === "user") return { command: file, args: INSTALLER_ARGS };
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `try { Start-Process -FilePath ${psQuote(file)} -ArgumentList ${ELEVATED_INSTALLER_ARGS.map(psQuote).join(",")} -WorkingDirectory ${psQuote(win32.dirname(file))} -Verb RunAs } catch { exit 1 }`,
    "exit 0",
  ].join("\n");
  return { command: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
}

/**
 * Starts the installer, detached; resolves null once it runs, else why it could not start. Elevated: once PowerShell
 * ends — the UAC prompt answered.
 */
export function launchInstaller(file: string, spawn: SpawnInstaller, mode: "user" | "elevated" = "user", systemRoot?: string): Promise<string | null> {
  return new Promise((done) => {
    try {
      const { command, args } = installerCommand(file, mode, systemRoot);
      const child = spawn(command, args, { detached: true, stdio: "ignore", cwd: dirname(file), windowsHide: mode === "elevated" });
      if (mode === "user")
        child.once("spawn", () => {
          child.unref();
          done(null);
        });
      else child.once("exit", (code) => done(code === 0 ? null : t("Administrator rights were not given — the installer did not run.")));
      child.once("error", (e) => done(t("The installer could not start: {0}", e.message)));
    } catch (e) {
      done(t("The installer could not start: {0}", e instanceof Error ? e.message : String(e)));
    }
  });
}

/** `<userData>/updates` — every download folder lives there; the next launch removes what is left. */
export const updatesFolder = (userData: string): string => join(userData, "updates");
