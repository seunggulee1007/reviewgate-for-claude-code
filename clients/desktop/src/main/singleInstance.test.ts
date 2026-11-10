import { describe, expect, it } from "vitest";
import { secondInstanceAction } from "./singleInstance.js";

describe("secondInstanceAction (daily-19)", () => {
  const dirs = new Set(["/work/acme", "/home/me/proj", "C:\\work\\acme"]);
  const isDir = (p: string) => dirs.has(p);
  /** A macOS / Linux launch, whatever the host the tests run on (a Windows runner resolves "/home/me" onto its drive). */
  const posix = { platform: "darwin" as const };

  it("opens the project the second launch was given", () => {
    expect(secondInstanceAction(["/app/ReviewGate"], "/", { project: "/work/acme" }, isDir, posix)).toEqual({ kind: "open", path: "/work/acme" });
    expect(secondInstanceAction(["/app/ReviewGate", "--original-process-start-time=1", "/work/acme"], "/", {}, isDir, posix)).toEqual({ kind: "open", path: "/work/acme" });
    // Relative to the second launch's working directory.
    expect(secondInstanceAction(["/app/ReviewGate", "proj"], "/home/me", null, isDir, posix)).toEqual({ kind: "open", path: "/home/me/proj" });
    expect(secondInstanceAction(["C:\\Programs\\ReviewGate.exe", "C:\\work\\acme"], "C:\\", undefined, isDir, { platform: "win32" })).toEqual({ kind: "open", path: "C:\\work\\acme" });
    expect(secondInstanceAction(["C:\\Programs\\ReviewGate.exe", "acme"], "C:\\work", undefined, isDir, { platform: "win32" })).toEqual({ kind: "open", path: "C:\\work\\acme" });
  });

  it("otherwise just focuses a window", () => {
    expect(secondInstanceAction(["/app/ReviewGate"], "/", {}, isDir, posix)).toEqual({ kind: "focus" });
    expect(secondInstanceAction(["/app/ReviewGate", "-psn_0_1234", "--flag"], "/", { project: "  " }, isDir, posix)).toEqual({ kind: "focus" });
    expect(secondInstanceAction(["/app/ReviewGate", "/no/such/dir"], "/", {}, isDir, posix)).toEqual({ kind: "focus" });
  });

  it("skips the app folder of `electron <folder>` (dev)", () => {
    expect(secondInstanceAction(["/x/electron", "/work/acme"], "/", {}, isDir, { ...posix, firstUserArg: 2 })).toEqual({ kind: "focus" });
    expect(secondInstanceAction(["/x/electron", "/work/acme", "/home/me/proj"], "/", {}, isDir, { ...posix, firstUserArg: 2 })).toEqual({ kind: "open", path: "/home/me/proj" });
  });
});
