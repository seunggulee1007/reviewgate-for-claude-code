import { describe, expect, it } from "vitest";
import type { MenuAction } from "../shared/ipc";
import { registerMenuAction, runMenuAction } from "./menuActions";

// polish p-foundation — P1-chrome-09: a menu action App.tsx has no case for reaches the handler a lane registered.

describe("menu actions", () => {
  it("runs the registered handler with its action; none: false", () => {
    const seen: MenuAction[] = [];
    expect(runMenuAction({ type: "refresh" })).toBe(false);
    const off = registerMenuAction("open_recent", (a) => seen.push(a));
    expect(runMenuAction({ type: "open_recent", path: "/work/acme" })).toBe(true);
    expect(seen).toEqual([{ type: "open_recent", path: "/work/acme" }]);
    off();
    expect(runMenuAction({ type: "open_recent", path: "/work/acme" })).toBe(false);
  });

  it("the latest registration of a type wins; an old removal leaves it", () => {
    const calls: string[] = [];
    const offFirst = registerMenuAction("shortcuts", () => calls.push("first"));
    const offSecond = registerMenuAction("shortcuts", () => calls.push("second"));
    runMenuAction({ type: "shortcuts" });
    offFirst();
    runMenuAction({ type: "shortcuts" });
    offSecond();
    expect(runMenuAction({ type: "shortcuts" })).toBe(false);
    expect(calls).toEqual(["second", "second"]);
  });
});
