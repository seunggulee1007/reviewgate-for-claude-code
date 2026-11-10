import { describe, expect, it } from "vitest";
import { compareVersions, createPlatform, locateToolchain, parseLoginShellProbe, type Platform } from "../src/platform/index.js";
import { Win32Platform } from "../src/platform/win32.js";
import { LinuxPlatform } from "../src/platform/linux.js";

describe("login shell probe parsing", () => {
  const names = ["node", "claude", "gh", "git"];

  it("parses probe output with noise", () => {
    const out = [
      "Welcome to zsh!",
      "/Users/x/.nvm/versions/node/v24.12.0/bin/node",
      "claude: aliased to /Users/x/.local/bin/claude --foo",
      "/opt/homebrew/bin/gh",
      "/usr/bin/git",
      "/Users/x/.nvm/versions/node/v24.12.0/bin:/opt/homebrew/bin:/usr/bin",
    ].join("\n");
    const r = parseLoginShellProbe(out, names);
    expect(r.found.node).toBe("/Users/x/.nvm/versions/node/v24.12.0/bin/node");
    expect(r.found.claude).toBe("/Users/x/.local/bin/claude");
    expect(r.found.gh).toBe("/opt/homebrew/bin/gh");
    expect(r.found.git).toBe("/usr/bin/git");
    expect(r.path).toBe("/Users/x/.nvm/versions/node/v24.12.0/bin:/opt/homebrew/bin:/usr/bin");
  });

  it("parses probe output when claude is missing", () => {
    const r = parseLoginShellProbe("/opt/homebrew/bin/node\n/opt/homebrew/bin:/usr/bin\n", names);
    expect(r.found.node).toBe("/opt/homebrew/bin/node");
    expect(r.found.claude).toBeUndefined();
    expect(r.path).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("ignores a shell function body and keeps the last occurrence", () => {
    const out = "claude () {\n\tcommand claude \"$@\"\n}\n/usr/local/bin/claude\n/Users/x/.local/bin/claude\n/usr/bin\n";
    const r = parseLoginShellProbe(out, names);
    expect(r.found.claude).toBe("/Users/x/.local/bin/claude");
    expect(r.path).toBe("/usr/bin");
  });

  it("empty output yields nothing", () => {
    expect(parseLoginShellProbe("", names)).toEqual({ found: {}, path: null });
    expect(parseLoginShellProbe("\n  \n", names)).toEqual({ found: {}, path: null });
  });

  it("version ordering", () => {
    expect(compareVersions("v24.12.0", "v22.17.0")).toBeGreaterThan(0);
    expect(compareVersions("v9.0.0", "v10.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("platform", () => {
  it("createPlatform picks the OS flavor", () => {
    expect(createPlatform("darwin").isWindows).toBe(false);
    expect(createPlatform("linux")).toBeInstanceOf(LinuxPlatform);
    expect(createPlatform("win32")).toBeInstanceOf(Win32Platform);
    expect(createPlatform("win32").isWindows).toBe(true);
  });

  it("ghConfigDir honors GH_CONFIG_DIR and per-OS defaults", () => {
    expect(createPlatform("darwin").ghConfigDir({ GH_CONFIG_DIR: "/tmp/ghcfg" })).toBe("/tmp/ghcfg");
    expect(createPlatform("darwin").ghConfigDir({})).toMatch(/\/\.config\/gh$/);
    expect(createPlatform("win32").ghConfigDir({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" })).toBe(
      "C:\\Users\\x\\AppData\\Roaming\\GitHub CLI",
    );
    expect(createPlatform("win32").ghConfigDir({ GH_CONFIG_DIR: "D:\\gh" })).toBe("D:\\gh");
    expect(createPlatform("linux").ghConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gh");
  });

  // POSIX fixtures (/usr/bin/git, /usr/bin/true); the resolution logic itself is the same on every OS.
  it.skipIf(process.platform === "win32")("locateToolchain resolves through the platform and reads versions", async () => {
    const fake: Platform = {
      name: "linux",
      isWindows: false,
      which: async (name) => (name === "git" ? "/usr/bin/git" : null),
      loginPATH: async () => "/usr/bin:/bin",
      openTerminal: async () => undefined,
      killTree: async () => undefined,
      ghConfigDir: () => "/tmp/gh",
      tmpDir: () => "/tmp",
    };
    const tc = await locateToolchain(fake, { PATH: "/nowhere" });
    expect(tc.git).toBe("/usr/bin/git");
    expect(tc.gitVersion).toMatch(/^git version \d/);
    expect(tc.claude).toBeNull();
    expect(tc.claudeVersion).toBeNull();
    expect(tc.gh).toBeNull();
    expect(tc.path).toBe("/usr/bin:/bin");

    // an override that does not exist is ignored; one that exists wins over `which`
    const withOverride = await locateToolchain(fake, {}, { git: "/usr/bin/true", claude: "/nope/claude" });
    expect(withOverride.git).toBe("/usr/bin/true");
    expect(withOverride.claude).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("darwin which finds git via the login shell", async () => {
    const p = createPlatform("darwin");
    const git = await p.which("git");
    expect(git).toMatch(/\/git$/);
    expect(await p.loginPATH()).toContain("/usr/bin");
  });
});
