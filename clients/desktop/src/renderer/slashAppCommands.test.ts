// b-slash: the terminal's built-ins typed in a classic chat (docs/PROTOCOL.md §56.5) — what each does, the user's own
// command of the same name winning, the built-ins only a terminal chat has, and the palette's lines. As Core
// SlashAppCommandsTests on the Mac.
import { beforeAll, describe, expect, it } from "vitest";
import type { SessionCapabilities } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { APP_COMMAND_NAMES, appCommandDescription, parseSlashAppCommand, terminalOnlyDescription, type SlashAppCommand } from "./slashAppCommands";
import { flattenSections, slashEntries, slashSections, type SlashEntry } from "./slashCommands";

beforeAll(() => initI18n("en", "darwin"));

const caps = (commands: SessionCapabilities["commands"]): SessionCapabilities =>
  ({ slashCommands: [], skills: [], plugins: [], mcpServers: [], commands, state: "ready" }) as unknown as SessionCapabilities;

describe("parseSlashAppCommand", () => {
  it("parses each app command", () => {
    const expected: Record<string, SlashAppCommand> = {
      "/model": { kind: "model", name: "" }, "/resume": { kind: "resume" }, "/rewind": { kind: "rewind" }, "/context": { kind: "context" },
      "/cost": { kind: "cost" }, "/permissions": { kind: "permissions" }, "/agents": { kind: "agents" }, "/memory": { kind: "memory" },
      "/config": { kind: "config" }, "/help": { kind: "help" }, "/status": { kind: "status" }, "/exit": { kind: "exit" }, "/rename": { kind: "rename" },
      "/add-dir": { kind: "addDir", path: "" },
    };
    for (const [text, cmd] of Object.entries(expected)) expect(parseSlashAppCommand(text, []), text).toEqual(cmd);
    expect(new Set(APP_COMMAND_NAMES)).toEqual(new Set(Object.keys(expected).map((k) => k.slice(1))));
  });

  it("gives /model its argument", () => {
    expect(parseSlashAppCommand("/model sonnet", [])).toEqual({ kind: "model", name: "sonnet" });
    expect(parseSlashAppCommand("  /model   opus  ", [])).toEqual({ kind: "model", name: "opus" });
    expect(parseSlashAppCommand("/MODEL", [])).toEqual({ kind: "model", name: "" });
  });

  it("maps the terminal's other names", () => {
    expect(parseSlashAppCommand("/quit", [])).toEqual({ kind: "exit" });
    expect(parseSlashAppCommand("/continue", [])).toEqual({ kind: "resume" });
    expect(parseSlashAppCommand("/settings", [])).toEqual({ kind: "config" });
    expect(parseSlashAppCommand("/checkpoint", [])).toEqual({ kind: "rewind" });
    expect(parseSlashAppCommand("/allowed-tools", [])).toEqual({ kind: "permissions" });
  });

  it("keeps a built-in only the terminal has out of the chat", () => {
    expect(parseSlashAppCommand("/hooks", [])).toEqual({ kind: "terminalOnly", name: "hooks" });
  });

  it("§67.1: /add-dir is the app's own — with its path, or alone for the folder picker", () => {
    expect(parseSlashAppCommand("/add-dir ../other", [])).toEqual({ kind: "addDir", path: "../other" });
    expect(parseSlashAppCommand("  /add-dir   C:\\work\\shared lib  ", [])).toEqual({ kind: "addDir", path: "C:\\work\\shared lib" });
    expect(parseSlashAppCommand("/ADD-DIR", [])).toEqual({ kind: "addDir", path: "" });
    expect(parseSlashAppCommand("/add-dir a\nb", [])).toBeNull();
    expect(parseSlashAppCommand("/add-dirs", [])).toBeNull();
  });

  it("sends everything else to Claude as before", () => {
    for (const text of ["/clear", "/compact focus", "/btw what?", "/mcp", "/init", "/review", "/my-skill arg", "hello /model", "/", "/model\nsecond", "/modelx", "plain"]) {
      expect(parseSlashAppCommand(text, []), text).toBeNull();
    }
  });

  it("lets the user's own command of the same name win", () => {
    const own: SlashEntry[] = [
      { name: "status", description: "", argumentHint: "", isSkill: false, aliases: [], group: { kind: "project" } },
      { name: "hooks", description: "", argumentHint: "", isSkill: false, aliases: [], group: { kind: "mine" } },
      { name: "model", description: "", argumentHint: "", isSkill: false, aliases: [], group: { kind: "plugin", name: "acme" } },
      { name: "help", description: "", argumentHint: "", isSkill: false, aliases: [], group: { kind: "builtin" } },
    ];
    expect(parseSlashAppCommand("/status", own)).toBeNull();
    expect(parseSlashAppCommand("/hooks", own)).toBeNull();
    expect(parseSlashAppCommand("/model", own)).toBeNull();
    expect(parseSlashAppCommand("/help", own)).toEqual({ kind: "help" });
  });
});

describe("the palette", () => {
  it("lists the app commands with what they do here", () => {
    const entries = slashEntries(caps([
      { name: "model", description: "Set the AI model", argumentHint: "", source: "builtin" },
      { name: "hooks", description: "Manage hook configurations", argumentHint: "", source: "builtin" },
      { name: "status", description: "Project status", argumentHint: "", source: "project" },
    ] as SessionCapabilities["commands"]), true);
    const by = new Map(entries.map((e) => [e.name, e]));
    for (const name of APP_COMMAND_NAMES.filter((n) => n !== "status")) {
      expect(by.get(name)?.group, name).toEqual({ kind: "builtin" });
      expect(by.get(name)?.description, name).toBe(appCommandDescription(name));
    }
    expect(by.get("model")?.argumentHint).toBe("[model]");
    expect(by.get("add-dir")?.argumentHint).toBe("[path]"); // §67.1
    expect(by.get("add-dir")?.description).toBe("Let Claude work in a directory outside the project too");
    expect(by.get("exit")?.aliases).toEqual(["quit"]);
    expect(by.get("status")?.group).toEqual({ kind: "project" });
    expect(by.get("status")?.description).toBe("Project status");
    expect(by.get("hooks")?.description).toBe(terminalOnlyDescription("Manage hook configurations"));
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
  });

  it("leaves them out unless asked (a terminal chat has the TUI's own)", () => {
    const entries = slashEntries(caps([{ name: "hooks", description: "Manage hooks", argumentHint: "", source: "builtin" }] as SessionCapabilities["commands"]));
    expect(entries.some((e) => e.name === "model")).toBe(false);
    expect(entries.find((e) => e.name === "hooks")?.description).toBe("Manage hooks");
  });

  it("finds /exit by the terminal's /quit", () => {
    const shown = flattenSections(slashSections(slashEntries(caps([]), true), "quit", []));
    expect(shown[0]?.name).toBe("exit");
  });
});
