// MARK: polish p-lifecycle — P5-sheets-49: the Windows client notices a new release (the Mac's §48 check).
import { describe, expect, it, vi } from "vitest";

const settings: Record<string, unknown> = {};
const sent: unknown[] = [];
vi.mock("electron", () => ({
  app: { getVersion: () => "0.5.10" },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_c: string, s: unknown) => sent.push(s) } }], getFocusedWindow: () => null },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { handle: () => undefined },
  net: { fetch: async () => ({ ok: false, status: 500 }) },
  shell: { openExternal: async () => undefined },
}));
vi.mock("./settings.js", () => ({ loadSettings: () => settings, saveSettings: (p: Record<string, unknown>) => Object.assign(settings, p) }));
vi.mock("./log.js", () => ({ logLine: () => undefined }));

import { checkOnce, outcomeOf, parseRelease, updateStatus } from "./update";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, html_url: `https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/tag/${tag}`, draft: false, prerelease: false, ...extra });

describe("the update check (P5-sheets-49)", () => {
  it("reads the release and compares it with the running version", () => {
    expect(parseRelease(release("v0.6.0"))).toEqual({ version: "0.6.0", tag: "v0.6.0", page: "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/tag/v0.6.0" });
    expect(parseRelease(release("v0.6.0", { prerelease: true }))).toBeNull();
    expect(parseRelease(release("nightly"))).toBeNull();
    // A page that is not GitHub's is never opened: the releases page of the tag instead.
    expect(parseRelease(release("v0.6.0", { html_url: "https://tasks.example.com/x" }))?.page).toBe("https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/tag/v0.6.0");
    expect(outcomeOf(release("v0.5.11"), "0.5.10")).toMatchObject({ kind: "available", release: { version: "0.5.11" } });
    expect(outcomeOf(release("v0.5.10"), "0.5.10")).toEqual({ kind: "upToDate", latest: "0.5.10" });
    expect(outcomeOf({ message: "Not Found" }, "0.5.10").kind).toBe("unavailable");
  });

  it("a newer release reaches every window's banner; Later for it keeps it quiet, a newer one shows again", async () => {
    expect(await checkOnce(async () => ({ ok: true, json: release("v0.6.0") }))).toMatchObject({ kind: "available" });
    expect(updateStatus()).toEqual({ version: "0.6.0", current: "0.5.10", page: expect.stringContaining("/v0.6.0") });
    expect(sent.at(-1)).toMatchObject({ version: "0.6.0" });
    settings["dismissedUpdateVersion"] = "0.6.0";
    expect(updateStatus()).toBeNull();
    await checkOnce(async () => ({ ok: true, json: release("v0.6.1") }));
    expect(updateStatus()?.version).toBe("0.6.1");
    // Up to date again (a reinstall): no banner.
    await checkOnce(async () => ({ ok: true, json: release("v0.5.10") }));
    expect(updateStatus()).toBeNull();
  });

  it("a failed check keeps what an earlier one found and says why", async () => {
    await checkOnce(async () => ({ ok: true, json: release("v0.6.2") }));
    const failed = await checkOnce(async () => ({ ok: false, why: "GitHub could not be reached. Check the network connection and try again." }));
    expect(failed).toEqual({ kind: "unavailable", why: "GitHub could not be reached. Check the network connection and try again." });
    expect(updateStatus()?.version).toBe("0.6.2");
  });
});
