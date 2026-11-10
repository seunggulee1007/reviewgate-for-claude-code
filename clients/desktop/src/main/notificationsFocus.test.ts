// MARK: polish p-lifecycle — PX-15: a window coming to the front closes the notifications it posted (the Action Center
// keeps none the user has already seen in the window).
import { describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (evt: unknown, raw: unknown) => unknown>();
const made: { closed: boolean; shown: boolean }[] = [];
vi.mock("electron", () => {
  class Notification {
    closed = false;
    shown = false;
    private listeners = new Map<string, () => void>();
    static isSupported = () => true;
    constructor() {
      made.push(this);
    }
    on(event: string, cb: () => void) {
      this.listeners.set(event, cb);
    }
    show() {
      this.shown = true;
    }
    close() {
      this.closed = true;
      this.listeners.get("close")?.();
    }
  }
  return {
    app: { setBadgeCount: () => undefined },
    BrowserWindow: { fromWebContents: (wc: { win: unknown }) => wc.win },
    ipcMain: { handle: (channel: string, fn: (evt: unknown, raw: unknown) => unknown) => handlers.set(channel, fn) },
    nativeImage: { createFromBitmap: () => ({}) },
    Notification,
    shell: { openExternal: async () => undefined },
  };
});
vi.mock("./settings.js", () => ({ loadSettings: () => ({ notifications: true }) }));
vi.mock("./log.js", () => ({ logLine: () => undefined }));

function fakeWindow(id: number) {
  const on = new Map<string, () => void>();
  let focused = false;
  const win = {
    webContents: { id, send: () => undefined },
    isDestroyed: () => false,
    isFocused: () => focused,
    on: (event: string, cb: () => void) => on.set(event, cb),
    setOverlayIcon: () => undefined,
    flashFrame: () => undefined,
  };
  return { win, focus: () => ((focused = true), on.get("focus")?.()) };
}

describe("notifications of a window in front (PX-15)", () => {
  it("are closed when it gets the focus; another window's stay", async () => {
    const { installNotifications } = await import("./notifications");
    installNotifications({ focusWindow: () => undefined });
    const notify = handlers.get("rg:notify")!;
    const a = fakeWindow(1);
    const b = fakeWindow(2);
    const req = (key: string) => ({ kind: "permission", title: "Permission needed", body: "Bash: npm test", key });
    expect(await notify({ sender: { id: 1, win: a.win } }, req("perm:1"))).toBe(true);
    expect(await notify({ sender: { id: 1, win: a.win } }, req("turn:2"))).toBe(true);
    expect(await notify({ sender: { id: 2, win: b.win } }, req("perm:3"))).toBe(true);
    expect(made.map((n) => n.shown)).toEqual([true, true, true]);
    a.focus();
    expect(made.map((n) => n.closed)).toEqual([true, true, false]);
  });
});
