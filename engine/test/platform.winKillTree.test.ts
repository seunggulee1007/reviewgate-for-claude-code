// MARK: wave4 w4-install — audit robustness-12 on Windows: the forced stop is `taskkill /pid <pid> /T /F` (the whole tree,
// forced); a failure (already gone) is swallowed.
import { describe, expect, it, vi } from "vitest";

const calls: { exe: string; args: string[] }[] = [];
vi.mock("../src/util/exec.js", async (orig) => {
  const real = await orig<typeof import("../src/util/exec.js")>();
  return {
    ...real,
    exec: vi.fn(async (exe: string, args: string[]) => {
      calls.push({ exe, args });
      if (args.includes("404")) throw new Error("ERROR: The process \"404\" not found.");
      return { stdout: Buffer.from(""), stderr: "", status: 0, signal: null, timedOut: false };
    }),
  };
});

describe("Win32Platform.killTree", () => {
  it("runs taskkill over the whole tree, forced, and ignores a process that is already gone", async () => {
    const { Win32Platform } = await import("../src/platform/win32.js");
    const platform = new Win32Platform();
    await platform.killTree(1234);
    expect(calls).toEqual([{ exe: "taskkill", args: ["/pid", "1234", "/T", "/F"] }]);
    await expect(platform.killTree(404)).resolves.toBeUndefined();
  });
});
