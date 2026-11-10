import { describe, expect, it } from "vitest";
import { redactLog } from "./logRedact.js";

// wave3 check-clients — the daily log file and "Copy Diagnostics" mask what must not leave the machine with the Mac's
// LogRedactor rules (Core EngineLogTests: the same cases).
describe("redactLog (the Mac's LogRedactor rules)", () => {
  const home = "/Users/me";

  it("masks the home folder, keys, bearer tokens, secret values and long opaque runs", () => {
    expect(redactLog("open /Users/me/work/repo", home, "darwin")).toBe("open ~/work/repo");
    expect(redactLog("cd /Users/me; ls /Users/meme/x", home, "darwin")).toBe("cd ~; ls /Users/meme/x");
    expect(redactLog("key sk-ant-api03-AbC_def-123 used", home, "darwin")).toBe("key sk-ant-*** used");
    expect(redactLog("Authorization: Bearer abc.def.ghi", home, "darwin")).toBe("Authorization: Bearer ***");
    expect(redactLog("GITHUB_TOKEN=ghp_123 run", home, "darwin")).toBe("GITHUB_TOKEN=*** run");
    expect(redactLog("password: hunter2", home, "darwin")).toBe("password: ***");
    expect(redactLog("blob QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890abcdefXYZ end", home, "darwin")).toBe("blob *** end");
  });

  it("keeps ids, paths and git object ids readable, and every line of a multi-line entry", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(redactLog(`session ${uuid}`, home, "darwin")).toBe(`session ${uuid}`);
    const sha = "a1b2c3d4e5".repeat(4);
    expect(redactLog(`tree ${sha}`, home, "darwin")).toBe(`tree ${sha}`);
    expect(redactLog(`tree ${"a1b2c3d4".repeat(8)}`, home, "darwin")).toBe(`tree ${"a1b2c3d4".repeat(8)}`);
    expect(redactLog("/opt/some/very/long/path/that/goes/on/and/on/forever.txt", home, "darwin")).toBe("/opt/some/very/long/path/that/goes/on/and/on/forever.txt");
    expect(redactLog("Error: boom\n    at /Users/me/app/x.js:1\napi_key=abc", home, "darwin")).toBe("Error: boom\n    at ~/app/x.js:1\napi_key=***");
  });

  it("on Windows: the home folder with either separator, any case, and as JSON writes it (Copy Diagnostics)", () => {
    const win = "C:\\Users\\me";
    expect(redactLog("open C:\\Users\\me\\work\\repo", win, "win32")).toBe("open ~\\work\\repo");
    expect(redactLog("open C:/Users/me/work/repo", win, "win32")).toBe("open ~/work/repo");
    expect(redactLog("open c:\\users\\ME\\x", win, "win32")).toBe("open ~\\x");
    expect(redactLog(JSON.stringify({ root: "C:\\Users\\me\\repo" }), win, "win32")).toBe('{"root":"~\\\\repo"}');
    expect(redactLog("ls C:\\Users\\meme\\x", win, "win32")).toBe("ls C:\\Users\\meme\\x");
  });

  it("leaves the text alone without a usable home folder", () => {
    expect(redactLog("/x/y", "", "darwin")).toBe("/x/y");
    expect(redactLog("/x/y", "/", "darwin")).toBe("/x/y");
  });
});
