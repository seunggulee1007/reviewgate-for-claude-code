/** wave4b w4b-follow — §39.4: the window that has the target worktree open takes the moved chat; otherwise one opens. */
import { describe, expect, it, vi } from "vitest";

vi.mock("./log.js", () => ({ logLine: () => undefined }));

import { routeMovedChat, type ChatMoveDeps } from "./chatMove";

type Win = { isDestroyed: () => boolean; webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } };
const win = (destroyed = false): Win => ({ isDestroyed: () => destroyed, webContents: { isDestroyed: () => destroyed, send: vi.fn() } });
const target = (w: Win) => ({ win: w });

describe("routeMovedChat (§39.4)", () => {
  const ev = { type: "chat_moved" as const, sessionId: "s1", path: "/w/wt2", name: "wt2", baseline: "head" as const, interrupted: true };

  it("fronts the window that has the worktree open and asks its renderer to take the chat", () => {
    const from = target(win());
    const to = target(win());
    const deps = { findWindowFor: vi.fn(() => to), focusWindow: vi.fn(), openWindow: vi.fn() };
    expect(routeMovedChat(from as never, ev, deps as unknown as ChatMoveDeps)).toBe("received");
    expect(deps.focusWindow).toHaveBeenCalledWith(to.win);
    expect(to.win.webContents.send).toHaveBeenCalledWith("rg:menu", { type: "chat_receive" });
    expect(from.win.webContents.send).not.toHaveBeenCalled();
    expect(deps.openWindow).not.toHaveBeenCalled();
  });

  it("opens a window for the worktree when none has it (or only the source / a closed one)", () => {
    const from = target(win());
    for (const found of [undefined, from, target(win(true))]) {
      const deps = { findWindowFor: vi.fn(() => found), focusWindow: vi.fn(), openWindow: vi.fn() };
      expect(routeMovedChat(from as never, ev, deps as unknown as ChatMoveDeps)).toBe("opened");
      expect(deps.openWindow).toHaveBeenCalledWith("/w/wt2");
      expect(deps.focusWindow).not.toHaveBeenCalled();
    }
  });
});
