/**
 * Navigation lockdown (docs/M11-WINDOWS.md "Renderer trust"): a ReviewGate window only ever shows
 * its own renderer — `dist/renderer/index.html` (file:) or, under `npm run dev`, the vite dev
 * server. Any other navigation / redirect is cancelled (http(s) links go to the OS browser through
 * the same allowlist as `rg:openExternal`), new windows are denied, and `<webview>` never attaches.
 */
import { app, shell, type WebContents } from "electron";
import { isAppURL, isSafeExternalURL, type AppOrigin } from "./ipcGuard.js";
import { logLine } from "./log.js";

function guardNavigation(contents: WebContents, origin: AppOrigin): void {
  const prefix = `w${contents.id}`;
  contents.on("will-navigate", (e, url) => {
    if (isAppURL(url, origin)) return;
    e.preventDefault();
    if (isSafeExternalURL(url)) void shell.openExternal(url);
    else logLine(prefix, "warn", `blocked navigation to ${url}`);
  });
  contents.on("will-redirect", (e, url) => {
    if (isAppURL(url, origin)) return;
    e.preventDefault();
    logLine(prefix, "warn", `blocked redirect to ${url}`);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalURL(url)) void shell.openExternal(url);
    else logLine(prefix, "warn", `blocked window.open to ${url}`);
    return { action: "deny" };
  });
}

/** Every webContents the app creates (installed before the first window): app-only navigation, no popups, no webviews. */
export function installNavigationGuards(origin: AppOrigin): void {
  app.on("web-contents-created", (_e, contents) => {
    guardNavigation(contents, origin);
    contents.on("will-attach-webview", (e) => {
      e.preventDefault();
      logLine(`w${contents.id}`, "warn", "blocked <webview> attach");
    });
  });
}
