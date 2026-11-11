import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanUseTool, HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { BudgetState } from "../src/session/budget.js";
import { ClaudeSession } from "../src/session/claude.js";
import type { SessionEvent } from "../src/session/events.js";
import { buildHooks, CLAUDE_CONFIG_ASK_REASON, type HookContext } from "../src/session/hooks.js";
import { settingsEditRisk } from "../src/session/settingsDiff.js";
import { makeRepo, makeTempDir, removeDir, write } from "./helpers/repo.js";
import { WAIT_MS } from "./helpers/wait.js";

/**
 * M22 — docs/PROTOCOL.md §33.9: in auto mode an edit of Claude Code's settings.json / settings.local.json is decided by what
 * it changes. Keys that run code or widen what Claude may do (hooks, permissions, MCP servers, apiKeyHelper, statusLine, …,
 * and `env` variables such as NODE_OPTIONS / LD_* / DYLD_* / PATH) take effect before the review could reject them and keep
 * the card, naming them; any other change (an env line, the model) is the CLI's call and reviewed after.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

const opts = { signal: new AbortController().signal };
const FILE = "/repo/.claude/settings.json";

/** `settingsEditRisk` of a Write over `before` (missing file: ""). */
const write1 = (after: unknown, before = "") => settingsEditRisk("Write", { file_path: FILE, content: JSON.stringify(after, null, 2) }, FILE, () => before);

describe("settingsEditRisk (M22)", () => {
  it("harmless keys: an env line, the model, attribution — nothing to ask", () => {
    expect(write1({ env: { MAVEN_OPTS: "-Xmx2g", SPRING_PROFILES_ACTIVE: "local" } })).toEqual([]);
    expect(write1({ model: "sonnet", includeCoAuthoredBy: false, respectGitignore: true })).toEqual([]);
    expect(write1({ $schema: "https://json.schemastore.org/claude-code-settings.json", outputStyle: "Explanatory" })).toEqual([]);
    // Only what differs counts: the hooks that were there stay as they were.
    const before = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "make lint" }] }] }, env: { A: "1" } });
    expect(write1({ hooks: { Stop: [{ hooks: [{ type: "command", command: "make lint" }] }] }, env: { A: "2", B: "x" } }, before)).toEqual([]);
    // Formatting alone changes nothing.
    expect(write1({ env: { A: "1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "make lint" }] }] } }, before)).toEqual([]);
  });

  it("keys that run code, widen permissions or start servers — the card names them", () => {
    expect(write1({ hooks: { PreToolUse: [] } })).toEqual(["hooks"]);
    expect(write1({ permissions: { allow: ["WebFetch(domain:evil.example)"] } })).toEqual(["permissions"]);
    for (const key of ["mcpServers", "enabledMcpjsonServers", "enableAllProjectMcpServers", "apiKeyHelper", "statusLine", "awsAuthRefresh", "otelHeadersHelper", "sandbox", "enabledPlugins", "disableAllHooks", "plansDirectory", "someFutureKey"]) {
      expect(write1({ [key]: key === "enableAllProjectMcpServers" ? true : "x" }), key).toEqual([key]);
    }
    expect(write1({ env: { NODE_OPTIONS: "--require /tmp/x.js", MAVEN_OPTS: "-Xmx2g" } })).toEqual(["env.NODE_OPTIONS"]);
    expect(write1({ env: { PATH: "/tmp/bin:/usr/bin", LD_PRELOAD: "x", DYLD_INSERT_LIBRARIES: "y", ANTHROPIC_BASE_URL: "https://proxy.example", HTTPS_PROXY: "http://192.0.2.7:8080" } })).toEqual([
      "env.PATH", "env.LD_PRELOAD", "env.DYLD_INSERT_LIBRARIES", "env.ANTHROPIC_BASE_URL", "env.HTTPS_PROXY",
    ]);
    // Release-2 review: variables that run code, find credentials or send data elsewhere when the CLI next starts.
    const risky: Record<string, string> = {
      CLAUDE_ENV_FILE: "./x.sh",
      CLAUDE_CODE_GIT_BASH_PATH: "C:\\w\\evil.exe",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://tasks.example.com",
      OTEL_LOG_USER_PROMPTS: "1",
      AWS_CONFIG_FILE: "./aws.cfg",
      GOOGLE_APPLICATION_CREDENTIALS: "./cred.json",
      CLOUDSDK_CONFIG: "./gcloud",
      HOME: "/work/acme/fakehome",
      XDG_CONFIG_HOME: "/work/acme/.cfg",
      TMPDIR: "/work/acme/tmp",
      EDITOR: "./evil.sh",
      PAGER: "./evil.sh",
      BROWSER: "./evil.sh",
      NPM_CONFIG_REGISTRY: "https://tasks.example.com/npm",
      PIP_INDEX_URL: "https://tasks.example.com/pypi",
      PYTHONUSERBASE: "./py",
      SSH_AUTH_SOCK: "/tmp/agent",
    };
    expect(write1({ env: { ...risky, MAVEN_OPTS: "-Xmx2g" } })).toEqual(Object.keys(risky).map((k) => `env.${k}`));
    // Claude Code's own variables that only limit or quiet it stay harmless, as do a project's own.
    expect(write1({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", BASH_DEFAULT_TIMEOUT_MS: "600000", NODE_ENV: "test", SPRING_PROFILES_ACTIVE: "local" } })).toEqual([]);
    // Taking hooks away is a change of what runs too.
    expect(write1({}, JSON.stringify({ hooks: { Stop: [] }, model: "opus" }))).toEqual(["hooks"]);
    // The CLI deletes older chat transcripts by it when it next starts (every one at 0) — maybe before the review.
    expect(write1({ cleanupPeriodDays: 0, model: "sonnet" }, JSON.stringify({ cleanupPeriodDays: 30 }))).toEqual(["cleanupPeriodDays"]);
  });

  it("Edit / MultiEdit are applied to the file as it is; what cannot be told keeps the card (null)", () => {
    const before = '{\n  "env": {\n    "A": "1"\n  },\n  "permissions": {\n    "allow": []\n  }\n}\n';
    const read = () => before;
    expect(settingsEditRisk("Edit", { file_path: FILE, old_string: '"A": "1"', new_string: '"A": "2"' }, FILE, read)).toEqual([]);
    expect(settingsEditRisk("Edit", { file_path: FILE, old_string: '"allow": []', new_string: '"allow": ["Bash(rm:*)"]' }, FILE, read)).toEqual(["permissions"]);
    expect(settingsEditRisk("MultiEdit", { file_path: FILE, edits: [{ old_string: '"A": "1"', new_string: '"A": "2"' }, { old_string: '"env"', new_string: '"model": "sonnet",\n  "env"' }] }, FILE, read)).toEqual([]);
    // The text is not there, not unique, the result is no JSON: unknown.
    expect(settingsEditRisk("Edit", { file_path: FILE, old_string: '"B": "1"', new_string: '"B": "2"' }, FILE, read)).toBeNull();
    expect(settingsEditRisk("Edit", { file_path: FILE, old_string: '"', new_string: "'" }, FILE, read)).toBeNull();
    expect(settingsEditRisk("Edit", { file_path: FILE, old_string: '"A": "1"', new_string: '"A": 1,' }, FILE, read)).toBeNull();
    // Files whose content is all servers / hooks, and any other file, are not compared.
    expect(settingsEditRisk("Write", { file_path: "/repo/.mcp.json", content: "{}" }, "/repo/.mcp.json", () => "")).toBeNull();
    expect(settingsEditRisk("Write", { file_path: "/repo/settings.json", content: "{}" }, "/repo/settings.json", () => "")).toBeNull();
    expect(settingsEditRisk("Write", { file_path: "/repo/.claude/settings.local.json", content: '{"env":{"X":"1"}}' }, "/repo/.claude/settings.local.json", () => "")).toEqual([]);
  });
});

function ctx(root: string, over: Partial<HookContext> = {}): HookContext & { outside: string[] } {
  const outside: string[] = [];
  return {
    budget: new BudgetState({ maxFiles: 0, maxLines: 0 }),
    cwd: root,
    root,
    ignorePatterns: [],
    autoAllowTools: new Set(),
    emit: () => {},
    log: () => {},
    onOutsideEdit: (f) => outside.push(f),
    outside,
    ...over,
  };
}

async function pre(c: HookContext, toolName: string, input: Record<string, unknown>, id: string): Promise<{ decision?: string; reason?: string }> {
  const hook = buildHooks(c).PreToolUse![0]!.hooks[0] as HookCallback;
  const out = (await hook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, session_id: "s", transcript_path: "", cwd: c.cwd, tool_use_id: id } as unknown as HookInput, id, opts)) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return { decision: out.hookSpecificOutput?.permissionDecision, reason: out.hookSpecificOutput?.permissionDecisionReason };
}

describe("the edit hook and canUseTool (M22, §33.9)", () => {
  it("auto mode: an env line runs (reviewed after); hooks keep the card with the keys; the default mode keeps every card", async () => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    write(root, ".claude/settings.json", JSON.stringify({ env: { A: "1" } }, null, 2));
    const file = join(root, ".claude", "settings.json");
    const auto = ctx(root, { permissionMode: "auto" });
    expect(await pre(auto, "Write", { file_path: file, content: JSON.stringify({ env: { A: "1", MAVEN_OPTS: "-Xmx2g" } }) }, "w1")).toEqual({});
    expect(await pre(auto, "Edit", { file_path: file, old_string: '"A": "1"', new_string: '"A": "2"' }, "w2")).toEqual({});
    expect(await pre(auto, "Write", { file_path: file, content: JSON.stringify({ env: { A: "1" }, hooks: { Stop: [] } }) }, "w3")).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
    expect(auto.scopeReasons?.get("w3")).toMatchObject({ code: "claude_config", path: file, keys: ["hooks"] });
    expect(auto.scopeReasons?.get("w3")?.message).toContain("(.claude/settings.json: hooks)");
    // Not in changedOutside: the review lists it (mods group).
    expect(auto.outside).toEqual([]);
    const byDefault = ctx(root);
    expect(await pre(byDefault, "Write", { file_path: file, content: JSON.stringify({ env: { A: "1", MAVEN_OPTS: "-Xmx2g" } }) }, "d1")).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
    // A file that cannot be compared (.mcp.json: all servers) keeps the card in auto mode.
    expect(await pre(auto, "Write", { file_path: join(root, ".mcp.json"), content: "{}" }, "w4")).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
  });

  it("auto mode outside the project (the user's ~/.claude/settings.json): an env line is the CLI's and listed outside the review; permissions ask", async () => {
    const root = realpathSync(makeRepo());
    const home = realpathSync(makeTempDir("rg-home"));
    dirs.push(root, home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    const file = join(home, ".claude", "settings.json");
    const auto = ctx(root, { permissionMode: "auto" });
    expect(await pre(auto, "Write", { file_path: file, content: JSON.stringify({ env: { FOO: "1" } }) }, "o1")).toEqual({});
    expect(await pre(auto, "Write", { file_path: file, content: JSON.stringify({ permissions: { allow: ["Bash"] } }) }, "o2")).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
  });

  it("canUseTool in auto mode: a harmless change is allowed like any edit in the project; a risky one is the card with its keys", async () => {
    const root = realpathSync(makeRepo());
    dirs.push(root);
    write(root, ".claude/settings.local.json", "{}\n");
    const file = join(root, ".claude", "settings.local.json");
    const events: SessionEvent[] = [];
    const s = new ClaudeSession({
      cwd: root,
      settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", permissionMode: "auto" },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false },
      emit: (e) => events.push(e),
      log: () => {},
    });
    (s as unknown as { setTurnActive(a: boolean): void }).setTurnActive(true);
    const canUseTool = (s as unknown as { canUseTool: CanUseTool }).canUseTool;
    expect(await canUseTool("Write", { file_path: file, content: '{"env":{"GRADLE_OPTS":"-Xmx2g"}}' }, { ...opts, toolUseID: "c1" } as never)).toMatchObject({ behavior: "allow" });
    const hooks = (s as unknown as { hookCtx: HookContext }).hookCtx;
    const risky = { file_path: file, content: '{"permissions":{"allow":["WebFetch(domain:evil.example)"]}}' };
    expect(await pre(hooks, "Write", risky, "c2")).toEqual({ decision: "ask", reason: CLAUDE_CONFIG_ASK_REASON });
    void canUseTool("Write", risky, { ...opts, toolUseID: "c2" } as never);
    for (const end = Date.now() + WAIT_MS; Date.now() < end && !events.some((e) => e.type === "permission_request"); ) await new Promise((r) => setTimeout(r, 10));
    const req = events.find((e): e is Extract<SessionEvent, { type: "permission_request" }> => e.type === "permission_request")!;
    expect(req.reason).toMatchObject({ code: "claude_config", path: file, keys: ["permissions"] });
    await s.dispose();
  });
});
