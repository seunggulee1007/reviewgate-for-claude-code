/**
 * §48 Windows: the update banner as it renders (react-dom/server, props only) at each step — available, downloading,
 * checking, waiting for Claude, ready, failed, and the launch's "Updated to" / "did not install" — with the Download Page
 * always there but in the "Ready" moment, tooltips on every button and the progress bar's accessible name.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UpdateStatus } from "../../shared/ipc";
import type { UpdateActions } from "./UpdateBanner";
import { received } from "../updateWords";

let View: FunctionComponent<{ status: UpdateStatus; actions: UpdateActions }>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = { matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), rg: { platform: "win32" } };
  View = (await import("./UpdateBanner")).UpdateBannerView;
});

const noop = () => undefined;
const actions: UpdateActions = { install: noop, cancel: noop, restartNow: noop, later: noop, dismiss: noop, openPage: noop, focus: noop, notes: noop };
const base: UpdateStatus = { current: "0.5.17", release: null, install: null, notice: null, downloadPage: "https://github.com/acme/app/releases/tag/v0.6.0", lastCheck: null, checking: false };
const release = { version: "0.6.0", page: "https://github.com/acme/app/releases/tag/v0.6.0", hasNotes: true, why: null };
const html = (s: Partial<UpdateStatus>) => renderToStaticMarkup(createElement(View, { status: { ...base, ...s }, actions }));
const testIds = (h: string) => [...h.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);
const amp = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("the update banner (§48 Windows)", () => {
  it("nothing to say → nothing", () => {
    expect(html({})).toBe("");
  });

  it("available: Install and Restart, What's New, Download Page, Later — each with its tooltip", () => {
    const h = amp(html({ release }));
    expect(h).toContain("ReviewGate 0.6.0 is available");
    expect(h).toContain("This app is 0.5.17; the latest release is 0.6.0.");
    expect(testIds(h)).toEqual(["Update banner", "Install update", "Update notes", "Open release page", "Dismiss update"]);
    expect(h).toContain('title="Downloads the installer from GitHub, checks its checksum, then quits ReviewGate, installs the new version and reopens it"');
    expect(h).toContain('title="Opens the release page — download the installer there and run it by hand"');
    expect(h).toContain('title="Hide this version — the next one is announced again"');
    expect(h).not.toMatch(/data-testid="Install update"[^>]*disabled|disabled=""[^>]*data-testid="Install update"/);
  });

  it("a release the app cannot install: the button is off and says why; the download page stays", () => {
    const h = amp(html({ release: { ...release, hasNotes: false, why: "The release has no Windows installer with its checksum yet — try again later, or download it from the release page." } }));
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*title="The release has no Windows installer/);
    expect(testIds(h)).toEqual(["Update banner", "Install update", "Open release page", "Dismiss update"]);
  });

  it("downloading: the title says installing, the line the megabytes, a bar named Download progress; Cancel and Download Page", () => {
    const h = amp(html({ release, install: { kind: "downloading", received: 12_400_000, total: 115_300_000, version: "0.6.0" } }));
    expect(h).toContain("Installing ReviewGate 0.6.0");
    expect(h).toContain("Downloading 12.4 / 115.3 MB");
    expect(h).toContain('role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="11" aria-valuetext="Downloading 12.4 / 115.3 MB"');
    expect(testIds(h)).toEqual(["Update banner", "Update progress", "Cancel update", "Open release page"]);
    expect(h).toContain('title="Stops the update — the download is removed"');
    // The release's own banner is not shown beside it.
    expect(h).not.toContain("is available");
    expect(amp(html({ install: { kind: "downloading", received: 0, total: null, version: "0.6.0" } }))).toContain("Downloading ReviewGate 0.6.0…");
  });

  it("checking: a spinner named by the step", () => {
    const h = amp(html({ install: { kind: "verifying", version: "0.6.0" } }));
    expect(h).toContain('class="spinner" role="img" aria-label="Checking the download\'s checksum…"');
    expect(testIds(h)).toEqual(["Update banner", "Update progress", "Cancel update", "Open release page"]);
  });

  it("waiting for Claude: the windows (each brings its window forward), Restart Now, Cancel", () => {
    const one = amp(html({ install: { kind: "waiting", blockers: [{ id: 4, line: "acme-api: Claude is working" }], version: "0.6.0" } }));
    expect(one).toContain("ReviewGate 0.6.0 is ready. Claude is working — ReviewGate restarts when the turn finishes.");
    expect(one).toContain('title="Brings that window to the front" data-testid="Update waits for">acme-api: Claude is working');
    expect(testIds(one)).toEqual(["Update banner", "Update waits for", "Restart now for update", "Cancel update", "Open release page"]);
    const two = amp(html({ install: { kind: "waiting", blockers: [{ id: 4, line: "acme-api: Claude is working" }, { id: 5, line: "acme-web: a card waits for your answer" }], version: "0.6.0" } }));
    expect(two).toContain("Claude is working in 2 windows — ReviewGate restarts when they finish.");
  });

  it("ready: says the app closes and reopens as the new version; nothing to click", () => {
    const h = amp(html({ install: { kind: "ready", version: "0.6.0" } }));
    expect(h).toContain("Ready — ReviewGate closes and reopens as 0.6.0");
    expect(testIds(h)).toEqual(["Update banner", "Update progress"]);
  });

  it("failed: why, Try Again, the Download Page and ×", () => {
    const h = amp(html({ release, install: { kind: "failed", why: "The download does not match its checksum — nothing was installed.", version: "0.6.0" } }));
    expect(h).toContain("Could not install ReviewGate 0.6.0");
    expect(h).toContain("The download does not match its checksum — nothing was installed.");
    expect(testIds(h)).toEqual(["Update banner", "Install update", "Open release page", "Dismiss update failure"]);
    expect(h).toContain('aria-label="Hide this notice"');
  });

  it("after the restart: Updated to X (What's New only with notes), or why it did not install with Try Again and the Download Page", () => {
    const ok = amp(html({ notice: { kind: "updated", version: "0.6.0", from: "0.5.17", hasNotes: true } }));
    expect(ok).toContain("Updated to ReviewGate 0.6.0");
    expect(ok).toContain("Previously 0.5.17.");
    expect(testIds(ok)).toEqual(["Update result", "Installed update notes", "Dismiss update result"]);
    const offline = html({ notice: { kind: "updated", version: "0.6.0", from: "0.5.17", hasNotes: false } });
    expect(testIds(offline)).toEqual(["Update result", "Dismiss update result"]);
    const failed = amp(html({ release, notice: { kind: "failed", version: "0.6.0", why: "ReviewGate 0.5.17 is still installed." } }));
    expect(failed).toContain("The update to 0.6.0 did not install — ReviewGate 0.5.17 is still installed.");
    // One banner for that release: the notice's Try Again, not a second "is available".
    expect(testIds(failed)).toEqual(["Update result", "Retry update", "Open release page", "Dismiss update result"]);
  });

  it("megabytes", () => {
    expect(received(12_400_000, 24_000_000)).toBe("12.4 / 24.0 MB");
    expect(received(30_000_000, 24_000_000)).toBe("24.0 / 24.0 MB");
    expect(received(1_500_000, null)).toBe("1.5 MB");
  });
});
