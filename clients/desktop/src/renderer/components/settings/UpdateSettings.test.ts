/**
 * §48 Windows: Settings › General › Updates as it renders (react-dom/server, props only) — the version, a release with
 * [Install and Restart], the install's step with its bar and [Cancel], the wait with [Restart Now], [Check Now] off while
 * checking or installing, and the last result.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateStatus } from "../../../shared/ipc";
import type { UpdateActions } from "../UpdateBanner";

let View: FunctionComponent<{ status: UpdateStatus; actions: UpdateActions; checkNow: () => void }>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = { matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), rg: { platform: "win32" } };
  View = (await import("./UpdateSettings")).UpdateSettingsView;
});

const noop = () => undefined;
const actions: UpdateActions = { install: noop, cancel: noop, restartNow: noop, later: noop, dismiss: noop, openPage: noop, checkAgain: noop, focus: noop, notes: noop };
const base: UpdateStatus = { current: "0.5.17", release: null, install: null, notice: null, downloadPage: "https://github.com/acme/app/releases", lastCheck: null, checking: false };
const release = { version: "0.6.0", page: "https://github.com/acme/app/releases/tag/v0.6.0", hasNotes: false, why: null, pending: false, elevated: false };
const html = (s: Partial<UpdateStatus>) => renderToStaticMarkup(createElement(View, { status: { ...base, ...s }, actions, checkNow: noop })).replace(/&#x27;/g, "'");
const testIds = (h: string) => [...h.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);

describe("Settings › Updates (§48 Windows)", () => {
  it("up to date: the version, Check Now, the download page and the last result", () => {
    const h = html({ lastCheck: { at: Date.UTC(2026, 10, 20, 5, 3), text: "ReviewGate is up to date" } });
    expect(h).toContain("This is ReviewGate 0.5.17.");
    expect(testIds(h)).toEqual(["Update install status", "Check for updates now", "Settings open release page", "Last update check"]);
    expect(h).toMatch(/Last checked .+ — ReviewGate is up to date/);
  });

  it("checking: Check Now off, a spinner and its words", () => {
    const h = html({ checking: true });
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*data-testid="Check for updates now"/);
    expect(h).toContain("Checking for updates…");
  });

  it("a release: Install and Restart", () => {
    const h = html({ release });
    expect(h).toContain("ReviewGate 0.6.0 is available");
    expect(testIds(h)).toEqual(["Update install status", "Settings install update", "Check for updates now", "Settings open release page"]);
  });

  it("Install off: why under the status; the Download Page leads unless the installer is only not attached yet", () => {
    const pending = html({ release: { ...release, why: "The Windows installer is still being uploaded — ReviewGate checks again by itself.", pending: true } });
    expect(testIds(pending)).toEqual(["Update install status", "Settings update reason", "Settings install update", "Check for updates now", "Settings open release page"]);
    expect(pending).toContain("The Windows installer is still being uploaded — ReviewGate checks again by itself.");
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*data-testid="Settings install update"/);
    expect(pending).toContain('class="small" title="Opens the release page');
    const refused = html({ release: { ...release, why: "This is a development build — it does not install updates." } });
    expect(refused).toContain("This is a development build — it does not install updates.");
    expect(refused).toContain('class="small primary" title="Opens the release page');
    const elevated = html({ release: { ...release, elevated: true } });
    expect(elevated).toContain("ReviewGate is installed for all users — Windows asks once for administrator rights.");
    expect(elevated).not.toMatch(/disabled=""[^>]*data-testid="Settings install update"/);
    // While installing, the line is the install's own.
    expect(testIds(html({ release: { ...release, elevated: true }, install: { kind: "verifying", version: "0.6.0" } }))).not.toContain("Settings update reason");
  });

  it("downloading: the banner's title, line and bar; Cancel; Check Now off", () => {
    const h = html({ release, install: { kind: "downloading", received: 50_000_000, total: 100_000_000, version: "0.6.0" } });
    expect(h).toContain("Installing ReviewGate 0.6.0");
    expect(h).toContain("Downloading 50.0 / 100.0 MB");
    expect(h).toContain('aria-valuenow="50"');
    expect(testIds(h)).toEqual(["Update install status", "Update progress", "Settings cancel update", "Check for updates now", "Settings open release page"]);
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*data-testid="Check for updates now"/);
  });

  it("waiting for Claude: Restart Now and Cancel; a failure: Try Again", () => {
    expect(testIds(html({ release, install: { kind: "waiting", blockers: [{ id: 1, line: "acme: Claude is working" }], version: "0.6.0" } }))).toContain("Settings restart now for update");
    const failed = html({ release, install: { kind: "failed", why: "The download failed: HTTP 404", version: "0.6.0" } });
    expect(failed).toContain("Could not install ReviewGate 0.6.0");
    expect(failed).toContain(">Try Again<");
  });
});
