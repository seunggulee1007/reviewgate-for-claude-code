/**
 * wave3 check-clients — where Electron now follows the Mac's rules (the two clients behave the same): the permission
 * card's §33.3 warning tone (PermissionReasonText.level on the Mac) and the card the shortcuts answer when the oldest
 * request is a question (AppState.shortcutPermission).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@reviewgate/engine";
import { deriveAllowPattern } from "./bashPattern";
import { initI18n, t } from "./i18n";
import { denyKeyHint } from "./permissionKeys";
import { alwaysAllowChoices, oldestRequestId, reasonView, shortcutTargetId, showsAlwaysAllow } from "./permissionQueue";

const req = (requestId: string, toolName = "Bash"): PermissionRequest => ({ requestId, toolName, input: {} });
const queue = (...list: PermissionRequest[]) => ({ session: { pendingPermission: list[0] ?? null, pendingPermissions: list } });

describe("Windows shortcut hints spell Backspace out (⌫ is a Mac glyph)", () => {
  beforeAll(() => initI18n("en", "win32"));
  afterAll(() => initI18n("en", "darwin"));

  it("rewrites ⌘⌫ and a built Ctrl+⌫ hint", () => {
    expect(t("Deny ({0})", "Ctrl+⌫")).toBe("Deny (Ctrl+Backspace)");
    expect(t("Deny this call (⌘⌫ with an empty composer)")).toBe("Deny this call (Ctrl+Backspace with an empty composer)");
    expect(denyKeyHint(false)).toBe("Ctrl+Backspace");
    expect(denyKeyHint(true)).toBe("⌘⌫");
  });

  it("leaves the Mac's glyphs alone on a Mac", () => {
    initI18n("en", "darwin");
    expect(t("Deny ({0})", "⌘⌫")).toBe("Deny (⌘⌫)");
    initI18n("en", "win32");
  });
});

describe("'always allow in this project' follows the Mac (PermissionCardOptions.showsAlwaysAllow)", () => {
  const offer = (request: Pick<PermissionRequest, "toolName" | "input" | "reason" | "allowPatterns">) => {
    const command = request.toolName === "Bash" ? (request.input["command"] as string) : null;
    const choices = alwaysAllowChoices(request, command === null ? null : deriveAllowPattern(command));
    return { shown: showsAlwaysAllow(request, choices), enabled: choices.length > 0 };
  };

  it("a chained Bash command keeps the control, disabled (no safe pattern), instead of hiding it", () => {
    expect(offer({ toolName: "Bash", input: { command: "npm test && git push" } })).toEqual({ shown: true, enabled: false });
    expect(offer({ toolName: "Bash", input: { command: "sudo make install" } })).toEqual({ shown: true, enabled: false });
    expect(offer({ toolName: "Bash", input: { command: "npm test" } })).toEqual({ shown: true, enabled: true });
  });

  it("other tools show it only with patterns; a reason or SendMessage never", () => {
    expect(offer({ toolName: "Edit", input: {} })).toEqual({ shown: false, enabled: false });
    expect(offer({ toolName: "mcp__github__get_issue", input: {}, allowPatterns: ["mcp__github__get_issue"] })).toEqual({ shown: true, enabled: true });
    expect(offer({ toolName: "Bash", input: { command: "npm test" }, reason: { code: "other_worktree", message: "m" } }).shown).toBe(false);
    expect(offer({ toolName: "SendMessage", input: {} }).shown).toBe(false);
  });
});

describe("the card the shortcuts answer follows the Mac (AppState.shortcutPermission)", () => {
  it("skips a question card — it has its own keys — and aims at the oldest ordinary card after it", () => {
    expect(shortcutTargetId(queue(req("q1", "AskUserQuestion"), req("bash"), req("edit", "Edit")))).toBe("bash");
    expect(shortcutTargetId(queue(req("q1", "AskUserQuestion"), req("q2", "AskUserQuestion")))).toBeNull();
    expect(shortcutTargetId(queue(req("old"), req("q", "AskUserQuestion")))).toBe("old");
  });

  it("the HUD's 권한 대기 still jumps to the request that has waited longest, a question included", () => {
    expect(oldestRequestId(queue(req("q1", "AskUserQuestion"), req("bash")))).toBe("q1");
    expect(oldestRequestId(queue())).toBeNull();
  });
});

describe("the permission card's warning tone follows the Mac (PermissionReasonText.level)", () => {
  const tone = (code: string) => reasonView({ code, message: "m", path: "/repo/x" })!.tone;

  it("is red where work leaves this window's review for good or cannot be reverted", () => {
    // a new worktree, an isolated agent, Claude Code's own settings files
    expect(tone("worktree_command")).toBe("red");
    expect(tone("worktree_isolation")).toBe("red");
    expect(tone("claude_config")).toBe("red");
  });

  it("is orange for a place this window's review does not see, and for a code a later engine adds", () => {
    expect(tone("outside_project")).toBe("orange");
    expect(tone("nested_repository")).toBe("orange");
    expect(tone("other_worktree")).toBe("orange");
    expect(tone("brand_new")).toBe("orange");
  });
});
