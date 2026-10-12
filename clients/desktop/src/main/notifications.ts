/**
 * `rg:notify`: OS notifications for a window the user is not looking at, plus the attention badge
 * (dock / Unity count via `app.setBadgeCount`; on Windows the taskbar overlay dot and a frame flash).
 * The request is validated (src/main/notify.ts `validateNotify`: allowlisted kind, bounded text); a click
 * focuses the window that asked. Focusing a window clears its share of the badge.
 */
import { app, BrowserWindow, ipcMain, nativeImage, Notification, shell, type NativeImage } from "electron";
import { logLine } from "./log.js";
import { AttentionCounter, badgeDescription, Coalescer, dotBitmap, shouldNotify, validateNotify } from "./notify.js";
import { groupEnabled, notificationSettingsUrl, notifyGroupOf } from "./notify.js"; // MARK: wave4b w4-notify
import { loadSettings } from "./settings.js";
import type { NotificationClick } from "../shared/ipc.js";

type Deps = { focusWindow: (win: BrowserWindow) => void };

const counter = new AttentionCounter();
const coalescer = new Coalescer();
/** The notification currently shown per window + key — replaced (not stacked) by a newer one. */
const shown = new Map<string, Notification>();
const tracked = new WeakSet<BrowserWindow>();
let overlay: NativeImage | null = null;

function overlayIcon(): NativeImage {
  overlay ??= nativeImage.createFromBitmap(dotBitmap(16), { width: 16, height: 16 });
  return overlay;
}

function refreshBadge(win: BrowserWindow | null): void {
  const total = counter.total();
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      app.setBadgeCount(total);
    } catch {
      /* unsupported desktop */
    }
  }
  if (process.platform === "win32" && win && !win.isDestroyed()) {
    const n = counter.count(win.webContents.id);
    win.setOverlayIcon(n > 0 ? overlayIcon() : null, badgeDescription(n));
    win.flashFrame(n > 0);
  }
}

function track(win: BrowserWindow): void {
  if (tracked.has(win)) return;
  tracked.add(win);
  const id = win.webContents.id;
  win.on("focus", () => {
    if (counter.count(id) === 0) return;
    counter.clear(id);
    refreshBadge(win);
  });
  win.on("closed", () => {
    counter.clear(id);
    coalescer.forget(id);
    for (const [k, n] of shown) if (k.startsWith(`${id}\u0000`)) (n.close(), shown.delete(k));
    refreshBadge(null);
  });
}

export function installNotifications(deps: Deps): void {
  ipcMain.handle("rg:notify", (evt, raw: unknown) => {
    const req = validateNotify(raw);
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!req || !win || win.isDestroyed()) {
      if (!req) logLine(`w${evt.sender.id}`, "warn", "ipc: notify refused (invalid request)");
      return false;
    }
    track(win);
    const settings = loadSettings();
    if (!shouldNotify({ enabled: settings.notifications !== false, focused: win.isFocused(), supported: Notification.isSupported() })) return false;
    if (!groupEnabled(settings, notifyGroupOf(req.kind))) return false; // MARK: wave4b w4-notify — Settings › Notifications
    const id = win.webContents.id;
    if (!coalescer.admit(id, req.key)) return false;
    const slot = `${id}\u0000${req.key}`;
    shown.get(slot)?.close();
    const n = new Notification({ title: req.title, body: req.body, silent: settings.notificationSound === false });
    n.on("click", () => {
      if (win.isDestroyed()) return;
      deps.focusWindow(win);
      // MARK: wave4b w4-notify — §39.6: the window opens the chat and the card / summary the notification was about.
      const click: NotificationClick = { kind: req.kind, ...(req.target ? { target: req.target } : {}) };
      win.webContents.send("rg:notificationClick", click);
    });
    n.on("failed", (_e, error) => {
      // MARK: wave4b w4-notify — Windows refused it (no Start menu shortcut for the AUMID, notifications off for the app…).
      logLine(`w${id}`, "warn", `notification not shown: ${String(error)}`);
      if (!win.isDestroyed() && !troubled.has(id)) {
        troubled.add(id);
        win.webContents.send("rg:notificationTrouble");
      }
    });
    n.on("close", () => {
      if (shown.get(slot) === n) shown.delete(slot);
    });
    shown.set(slot, n);
    n.show();
    counter.add(id);
    refreshBadge(win);
    return true;
  });
  // MARK: wave4b w4-notify — §39.6: Settings' [알림 설정 열기]; the address is fixed per platform, never the renderer's.
  ipcMain.handle("rg:openNotificationSettings", async () => {
    const url = notificationSettingsUrl(process.platform);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });
}

/** Windows whose renderer was already told that a notification did not show (once each). */
const troubled = new Set<number>();
