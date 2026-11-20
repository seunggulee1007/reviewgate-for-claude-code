import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hookSettings, hooksDisabled, isCliSessionId, MIN_TERMINAL_CLI, TERMINAL_SYSTEM_APPEND, terminalArgv, terminalEnv } from "../src/session/terminalSpec.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

// docs/PROTOCOL.md §57.3: the terminal's --settings, argv and the hooks-disabled preflight.

const dirs: string[] = [];
const temp = (p: string): string => {
  const d = makeTempDir(p);
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const URL = "http://127.0.0.1:43210/hook";

describe("hookSettings", () => {
  it("posts every event to the local server with the token header from the env; onFailure only on UPS and PreToolUse", () => {
    const s = hookSettings(URL);
    const H = (timeout: number, block = false) => ({
      type: "http",
      url: URL,
      headers: { "X-ReviewGate-Token": "${RG_HOOK_TOKEN}" },
      allowedEnvVars: ["RG_HOOK_TOKEN"],
      timeout,
      ...(block ? { onFailure: "block" } : {}),
    });
    expect(s).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [H(120, true)] }],
        PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [H(60, true)] }],
        PostToolUse: [{ hooks: [H(120)] }],
        PostToolUseFailure: [{ hooks: [H(120)] }],
        CwdChanged: [{ hooks: [H(10)] }],
        Stop: [{ hooks: [H(30)] }],
        StopFailure: [{ hooks: [H(30)] }],
        Notification: [{ hooks: [H(10)] }],
        SessionEnd: [{ hooks: [H(5)] }],
      },
    });
    // Never "block" on Stop: there it means "keep Claude going".
    expect(JSON.stringify(s.hooks.Stop)).not.toContain("onFailure");
    expect(JSON.stringify(s)).not.toMatch(/localhost|0\.0\.0\.0/);
    expect(MIN_TERMINAL_CLI).toBe("2.1.295");
    // §57.15: PermissionRequest only for a client that answers it — every tool, no onFailure (the TUI's dialog stays).
    const bridged = hookSettings(URL, { permissionRequest: true });
    expect(bridged.hooks.PermissionRequest).toEqual([{ hooks: [H(600)] }]);
    expect(Object.keys(bridged.hooks)).toEqual(["UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "CwdChanged", "Stop", "StopFailure", "Notification", "SessionEnd"]);
    expect(s.hooks.PermissionRequest).toBeUndefined();
    const failing = Object.entries(bridged.hooks).filter(([, m]) => JSON.stringify(m).includes("onFailure")).map(([k]) => k);
    expect(failing).toEqual(["UserPromptSubmit", "PreToolUse"]);
  });
});

describe("terminalArgv / terminalEnv", () => {
  const settingsJson = JSON.stringify(hookSettings(URL));
  it("a fresh chat starts with --session-id=<id>, a known one resumes (--resume=<id>); the token is never in argv", () => {
    const token = "ab".repeat(32);
    const fresh = terminalArgv({ claude: "/usr/local/bin/claude", id: "chat-1", resume: false, settingsJson });
    expect(fresh).toEqual(["/usr/local/bin/claude", "--session-id=chat-1", "--settings", settingsJson, "--append-system-prompt", TERMINAL_SYSTEM_APPEND]);
    const resumed = terminalArgv({ claude: "claude", id: "cli-2", resume: true, settingsJson });
    expect(resumed.slice(0, 2)).toEqual(["claude", "--resume=cli-2"]);
    // An id that looks like a flag stays the flag's value: no argv element of its own.
    const odd = terminalArgv({ claude: "claude", id: "--dangerously-skip-permissions", resume: true, settingsJson });
    expect(odd).not.toContain("--dangerously-skip-permissions");
    expect(odd[1]).toBe("--resume=--dangerously-skip-permissions");
    for (const argv of [fresh, resumed]) {
      expect(argv.join(" ")).not.toContain(token);
      expect(argv).not.toContain("--model");
      expect(argv).not.toContain("--permission-mode");
      expect(argv).not.toContain("--setting-sources");
    }
    expect(TERMINAL_SYSTEM_APPEND).toContain("[Review gate]");
  });

  it("isCliSessionId: a UUID only", () => {
    expect(isCliSessionId("0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a")).toBe(true);
    expect(isCliSessionId("0B7E3C1A-5D2F-4E8B-9A6C-1F2E3D4C5B6A")).toBe(true);
    for (const v of ["--dangerously-skip-permissions", "cli-2", "", " 0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a", "0b7e3c1a-5d2f-4e8b-9a6c-1f2e3d4c5b6a\n--x", 42, null, undefined]) {
      expect(isCliSessionId(v), String(v)).toBe(false);
    }
  });

  it("only RG_ and CLAUDE_CODE_ keys reach the PTY env", () => {
    expect(terminalEnv({ RG_HOOK_TOKEN: "t", CLAUDE_CODE_X: "1", CLAUDE_CONFIG_DIR: "/x", PATH: "/bin", HOME: "/Users/dev" })).toEqual({ RG_HOOK_TOKEN: "t", CLAUDE_CODE_X: "1" });
  });
});

describe("hooksDisabled", () => {
  function setup(): { configDir: string; projectDir: string } {
    const configDir = temp("rg-term-config");
    const projectDir = temp("rg-term-project");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    return { configDir, projectDir };
  }

  it("null when nothing turns hooks off (missing, unreadable or other settings)", () => {
    const { configDir, projectDir } = setup();
    expect(hooksDisabled({ configDir, projectDir, managed: null })).toBeNull();
    writeFileSync(join(configDir, "settings.json"), "{ not json");
    writeFileSync(join(projectDir, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: false, hooks: {} }));
    expect(hooksDisabled({ configDir, projectDir, managed: { allowManagedHooksOnly: false } })).toBeNull();
  });

  for (const where of ["user", "project", "local"] as const) {
    it(`disableAllHooks in the ${where} settings`, () => {
      const { configDir, projectDir } = setup();
      const file = where === "user" ? join(configDir, "settings.json") : join(projectDir, ".claude", where === "project" ? "settings.json" : "settings.local.json");
      writeFileSync(file, JSON.stringify({ disableAllHooks: true }));
      expect(hooksDisabled({ configDir, projectDir, managed: null })).toBe("disableAllHooks");
    });
  }

  it("the managed tier: disableAllHooks, allowManagedHooksOnly", () => {
    const { configDir, projectDir } = setup();
    expect(hooksDisabled({ configDir, projectDir, managed: { disableAllHooks: true } })).toBe("disableAllHooks");
    expect(hooksDisabled({ configDir, projectDir, managed: { allowManagedHooksOnly: true } })).toBe("allowManagedHooksOnly");
  });
});
