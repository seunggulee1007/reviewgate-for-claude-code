import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "./i18n";
import { errorCopyText, scopeHelp } from "./errorCopy";

/**
 * r2-chats-cards — polish P1-chrome-29 / 34 (docs/PROTOCOL.md §55.6), in English so the words do not wait for ko.json:
 * "오류 복사" puts the message, the CLI's words and the code on the clipboard for a bug report; the scope chip says what it
 * means; the message's tooltip sits on the message only (not over the banner's buttons) and it reads three lines.
 */
async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin", openLog: async () => undefined },
  };
  const { useStore } = await import("./store");
  const { ErrorBanner } = await import("./components/ErrorBanner");
  return { useStore, ErrorBanner };
}

describe("the error banner's details (§55.6)", () => {
  beforeAll(() => initI18n("en", "darwin"));

  it("what 오류 복사 copies, and what the scope chip means", () => {
    expect(errorCopyText("Claude Code stopped", "exit 1: rate limited", "cli_exit", "×3")).toBe("Claude Code stopped ×3\nexit 1: rate limited\ncode: cli_exit");
    expect(errorCopyText("git add -A failed", "git add -A failed", null)).toBe("git add -A failed");
    expect(scopeHelp("engine")).toBe("The app's engine");
    expect(scopeHelp("session")).toBe("The Claude Code session");
    expect(scopeHelp("git")).toBe("A git command");
    expect(scopeHelp("pr")).toBe("GitHub (gh)");
    expect(scopeHelp("client")).toBe("The app");
  });

  it("the tooltip is on the message, which reads three lines, and the banner has 오류 복사", async () => {
    const m = await load();
    Object.assign(m.useStore.getInitialState(), { errorBanner: { message: "Could not read the worktree", detail: "EACCES /work/acme/.git/index", scope: "git", fatal: false } });
    const out = renderToStaticMarkup(createElement(m.ErrorBanner));
    expect(out).not.toMatch(/data-testid="Error banner"[^>]*title=/);
    expect(out).toMatch(/class="grow clamp-3" title="Could not read the worktree\n\nEACCES \/work\/acme\/.git\/index"/);
    expect(out).toContain('title="A git command"');
    expect(out).toContain('aria-label="Copy the error"');
  });
});
