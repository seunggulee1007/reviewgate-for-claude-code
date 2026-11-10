import { describe, expect, it } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import { COMMAND_DESCRIPTION_MAX, cachedCommands, toCommandInfos } from "../src/session/commands.js";
import type { SessionEvent } from "../src/session/events.js";

describe("ClaudeSession → commands_info (§36.5)", () => {
  it("initialize's commands go out as soon as it answered (no message); every commands_changed replaces them", async () => {
    const events: SessionEvent[] = [];
    let resolveInit: (v: unknown) => void = () => {};
    const init = new Promise((r) => (resolveInit = r));
    let end: () => void = () => {};
    const ended = new Promise<void>((r) => (end = r));
    const query = (() =>
      ({
        async next() {
          await ended;
          return { done: true, value: undefined };
        },
        async return() {
          end();
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        initializationResult: () => init,
      }) as unknown as Query) as never;
    const s = new ClaudeSession({
      cwd: "/tmp",
      settings: { budget: { maxFiles: 5, maxLines: 200 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "" },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false },
      emit: (e) => events.push(e),
      log: () => {},
      queryFn: query,
    });
    await s.start();
    expect(events.filter((e) => e.type === "commands_info")).toEqual([]);
    const commands = [{ name: "mcp", description: "Manage MCP servers", argumentHint: "", builtin: true }];
    resolveInit({ commands, agents: [], models: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.filter((e) => e.type === "commands_info")).toEqual([{ type: "commands_info", commands }]);
    const changed = [...commands, { name: "rg-new", description: "Found while working (project)", argumentHint: "" }];
    (s as unknown as { handleSdkMessage(m: SDKMessage): void }).handleSdkMessage({ type: "system", subtype: "commands_changed", commands: changed, uuid: "u", session_id: "s" } as unknown as SDKMessage);
    expect(events.filter((e) => e.type === "commands_info").at(-1)).toEqual({ type: "commands_info", commands: changed });
    await s.dispose();
  });
});

/**
 * docs/PROTOCOL.md §36.5 (audit SME-03): the palette's commands with description, argument hint and source, from the
 * CLI's `SlashCommand`s. The shapes below are what CLI 2.1.309 sends (probed: `initializationResult().commands`).
 */

describe("toCommandInfos (§36.5)", () => {
  it("classifies built-in, user, project, plugin and MCP commands the way CLI 2.1.309 marks them", () => {
    const infos = toCommandInfos([
      { name: "mcp", description: "Manage MCP servers", argumentHint: "[reconnect|enable|disable [<server>|all]]", builtin: true },
      { name: "code-review", description: "Review the current diff", argumentHint: "[low|medium|high]", aliases: ["review"], builtin: true },
      { name: "rg-user-cmd", description: "A user command for the probe (user)", argumentHint: "<ticket>" },
      { name: "rg-proj-skill", description: "A project skill for the probe (project)", argumentHint: "" },
      { name: "sub:rg-nested", description: "A nested project command (project)", argumentHint: "" },
      { name: "writer-kit:writer-deck", description: "슬라이드 초안 작성", argumentHint: "<주제>", aliases: ["writer-deck"] },
      { name: "rgprobe:greet (MCP)", description: "Greets someone by name", argumentHint: "" },
      { name: "plugin:omc:t:review (MCP)", description: "A plugin server's prompt", argumentHint: "" },
      { name: "deep-research", description: "Deep research harness (dynamic workflow)", argumentHint: "", builtin: true },
      { name: "managed-thing", description: "Something a policy installed", argumentHint: "" },
      { name: "docx", description: "Use this skill whenever the user wants Word documents (claude.ai sync)", argumentHint: "", aliases: ["anthropic-skills:docx"] },
      { name: "morning", description: "Render the morning brief (claude.ai sync)", argumentHint: "" },
    ]);
    expect(infos).toEqual([
      { name: "mcp", description: "Manage MCP servers", argumentHint: "[reconnect|enable|disable [<server>|all]]", source: "builtin" },
      { name: "code-review", description: "Review the current diff", argumentHint: "[low|medium|high]", source: "builtin", aliases: ["review"] },
      { name: "rg-user-cmd", description: "A user command for the probe", argumentHint: "<ticket>", source: "user" },
      { name: "rg-proj-skill", description: "A project skill for the probe", argumentHint: "", source: "project" },
      // A command in a subfolder of .claude/commands is `<folder>:<name>` — the "(project)" suffix decides, not the colon.
      { name: "sub:rg-nested", description: "A nested project command", argumentHint: "", source: "project" },
      { name: "writer-kit:writer-deck", description: "슬라이드 초안 작성", argumentHint: "<주제>", source: "plugin", plugin: "writer-kit", aliases: ["writer-deck"] },
      // An MCP prompt is listed as "<server>:<prompt> (MCP)" but invoked as /mcp__<server>__<prompt> (system/init's spelling).
      { name: "mcp__rgprobe__greet", description: "Greets someone by name", argumentHint: "", source: "mcp", server: "rgprobe" },
      // A plugin's MCP server is `plugin:<plugin>:<server>`: the prompt follows the last colon (named like its tools).
      { name: "mcp__plugin_omc_t__review", description: "A plugin server's prompt", argumentHint: "", source: "mcp", server: "plugin:omc:t" },
      // Only " (user)" / " (project)" are source marks; other parentheses belong to the description.
      { name: "deep-research", description: "Deep research harness (dynamic workflow)", argumentHint: "", source: "builtin" },
      { name: "managed-thing", description: "Something a policy installed", argumentHint: "", source: "unknown" },
      // A skill of the user's claude.ai account (CLI 2.1.309: " (claude.ai sync)"): grouped under its alias's set.
      { name: "docx", description: "Use this skill whenever the user wants Word documents", argumentHint: "", source: "plugin", plugin: "anthropic-skills", aliases: ["anthropic-skills:docx"] },
      { name: "morning", description: "Render the morning brief", argumentHint: "", source: "plugin", plugin: "claude.ai" },
    ]);
  });

  it("a CLI that does not mark its own commands: plain names are built-in", () => {
    const infos = toCommandInfos([
      { name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>" },
      { name: "rg-user-cmd", description: "Mine (user)", argumentHint: "" },
      { name: "omc:plan", description: "Plan", argumentHint: "" },
    ]);
    expect(infos!.map((c) => [c.name, c.source])).toEqual([
      ["compact", "builtin"],
      ["rg-user-cmd", "user"],
      ["omc:plan", "plugin"],
    ]);
  });

  it("one line of description, bounded; junk hints and entries are dropped; first spelling of a name wins", () => {
    const long = "x".repeat(COMMAND_DESCRIPTION_MAX + 50);
    const infos = toCommandInfos([
      { name: "/slashed", description: "First line\nsecond line", argumentHint: "  <a>  " },
      { name: "long", description: long, argumentHint: "[object Object]", builtin: true },
      { name: "", description: "nameless" },
      null,
      42,
      { name: "dup", description: "one", argumentHint: "", builtin: true },
      { name: "dup", description: "two", argumentHint: "", builtin: true },
      { name: "weird", description: 7, argumentHint: ["a"], aliases: ["w", 3, "", "w"], builtin: true },
    ]);
    expect(infos).toEqual([
      { name: "slashed", description: "First line", argumentHint: "<a>", source: "unknown" },
      { name: "long", description: `${"x".repeat(COMMAND_DESCRIPTION_MAX - 1)}…`, argumentHint: "", source: "builtin" },
      { name: "dup", description: "one", argumentHint: "", source: "builtin" },
      { name: "weird", description: "", argumentHint: "", source: "builtin", aliases: ["w"] },
    ]);
    expect(toCommandInfos(undefined)).toBeNull();
    expect(toCommandInfos({})).toBeNull();
    expect(toCommandInfos([])).toEqual([]);
  });

  it("cachedCommands re-validates what capabilities.json kept (older caches: none)", () => {
    expect(cachedCommands(undefined)).toBeUndefined();
    expect(cachedCommands("x")).toBeUndefined();
    expect(
      cachedCommands([
        { name: "mcp", description: "Manage MCP servers", argumentHint: "", source: "builtin" },
        { name: "writer-kit:writer-deck", description: "d", argumentHint: "<n>", source: "plugin", plugin: "writer-kit", aliases: ["writer-deck"] },
        { name: "bad-source", description: "d", argumentHint: "", source: "elsewhere" },
        { name: 3, description: "d", argumentHint: "", source: "user" },
      ]),
    ).toEqual([
      { name: "mcp", description: "Manage MCP servers", argumentHint: "", source: "builtin" },
      { name: "writer-kit:writer-deck", description: "d", argumentHint: "<n>", source: "plugin", plugin: "writer-kit", aliases: ["writer-deck"] },
      { name: "bad-source", description: "d", argumentHint: "", source: "unknown" },
    ]);
  });
});
