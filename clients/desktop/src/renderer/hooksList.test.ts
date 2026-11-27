// docs/PROTOCOL.md §72.1: `/hooks` — the grouping and the words of the hooks dialog. As Core HooksListTests on the Mac.
import { beforeAll, describe, expect, it } from "vitest";
import type { HookEntry } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { HOOK_EVENTS, hookDetails, hookOpenHelp, hookSourceLabel, hooksByEvent, hooksOffText, matcherLabel } from "./hooksList";
import { parseSlashAppCommand, TERMINAL_ONLY } from "./slashAppCommands";

beforeAll(() => initI18n("en", "win32"));

const hook = (event: string, text: string, extra: Partial<HookEntry> = {}): HookEntry => ({ event, matcher: "", type: "command", text, source: "user", path: "C:\\Users\\dev\\.claude\\settings.json", ...extra });

describe("§72.1 hooks", () => {
  it("groups by event in the engine's order; all events lists the empty ones too", () => {
    const groups = hooksByEvent([hook("PreToolUse", "a"), hook("PreToolUse", "b", { source: "project" }), hook("Custom", "c")]);
    expect(groups.map((g) => g.event)).toEqual(["PreToolUse", "Custom"]);
    expect(groups[0]!.hooks.map((h) => h.text)).toEqual(["a", "b"]);
    const all = hooksByEvent([hook("Custom", "c")], true);
    expect(all).toHaveLength(HOOK_EVENTS.length + 1);
    expect(all[0]).toEqual({ event: "SessionStart", hooks: [] });
    expect(all.at(-1)!.event).toBe("Custom");
  });

  it("says where each is defined, its matcher and what else it carries", () => {
    expect(hookSourceLabel("plugin", "fmt")).toBe("Plugin fmt");
    expect(hookSourceLabel("local")).toBe("Local settings");
    expect(matcherLabel("")).toBe("Any");
    expect(matcherLabel("Edit|Write")).toBe("Edit|Write");
    expect(hookDetails(hook("PreToolUse", "x", { if: "Bash(rm *)", timeout: 30, async: true, statusMessage: "Checking" }))).toBe("if Bash(rm *) · 30 s timeout · runs in the background · “Checking”");
    expect(hookDetails(hook("Stop", "x"))).toBe("");
    expect(hooksOffText(null)).toBeNull();
    for (const off of ["app", "settings", "managed_only", "managed"] as const) expect(hooksOffText(off)).toBeTruthy();
    expect(hookOpenHelp("C:\\x.json", false)).toBe("C:\\x.json does not exist yet — this chat would read it");
  });

  it("/hooks is the app's own now", () => {
    expect(parseSlashAppCommand("/hooks", [])).toEqual({ kind: "hooks" });
    expect(TERMINAL_ONLY.has("hooks")).toBe(false);
  });
});
