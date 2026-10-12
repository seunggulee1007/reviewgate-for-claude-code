/**
 * MARK: wave4b w4b-follow — docs/PROTOCOL.md §39.4 in the main process: a window's engine handed its chat to another
 * worktree (`chat_moved`). The window that already has that worktree open comes to the front and takes the chat (its
 * renderer sends `chat_receive` and says why when that is refused, as the Mac's `receiveMovedChat`); otherwise a new
 * window opens it (its `open_project` takes the chat). The source window stays as it is.
 */
import type { BrowserWindow } from "electron";
import type { ChatMovedEvent } from "@reviewgate/engine";
import type { MenuAction } from "../shared/ipc.js";
import { logLine } from "./log.js";

type Target = { win: BrowserWindow };
export type ChatMoveDeps = {
  findWindowFor: (path: string) => Target | undefined;
  focusWindow: (win: BrowserWindow) => void;
  openWindow: (path: string) => unknown;
};

export function routeMovedChat(from: Target, ev: ChatMovedEvent, deps: ChatMoveDeps): "received" | "opened" {
  const target = deps.findWindowFor(ev.path);
  if (target && target !== from && !target.win.isDestroyed() && !target.win.webContents.isDestroyed()) {
    logLine("main", "main", `chat ${ev.sessionId} moved to ${ev.path}: the window that has it open takes it`);
    deps.focusWindow(target.win);
    const take: MenuAction = { type: "chat_receive" };
    target.win.webContents.send("rg:menu", take);
    return "received";
  }
  logLine("main", "main", `chat ${ev.sessionId} moved to ${ev.path}: opening a window for it`);
  deps.openWindow(ev.path);
  return "opened";
}
