// §48 Windows — the installer's own account (build/installer.nsh → %TEMP%\ReviewGate-update.log) read by the next launch.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { INSTALLER_LOG_NAME, installerLogLines, installerLogWhy, MAX_INSTALLER_LOG_BYTES, takeInstallerLog } from "./updateInstallerLog";

const utf16 = (s: string) => Buffer.from(s, "utf16le");
const dir = mkdtempSync(join(tmpdir(), "rg-installer-log-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// What the silent installer run by a 0.5.28 app wrote on windows-latest with resources\app.asar held open by another program.
const heldRun = [
  "0.5.35 start \"C:\\Users\\dev\\AppData\\Roaming\\ReviewGate\\updates\\0.5.35-ab12cd34\\ReviewGate-Setup-0.5.35.exe\" /S /currentuser --updated --force-run",
  "0.5.35 mode CurrentUser C:\\Users\\dev\\AppData\\Local\\Programs\\ReviewGate",
  "0.5.35 uninstall-old failed 2",
  "0.5.35 uninstall-old retry: 2",
  "0.5.35 failed uninstall-old 2 resources\\app.asar (in use by pwsh.exe 2004)",
  "0.5.35 reopened C:\\Users\\dev\\AppData\\Local\\Programs\\ReviewGate\\ReviewGate.exe (ok)",
];

describe("the installer's log", () => {
  it("is UTF-16LE lines (a BOM or not, CRLF), a cut first byte dropped, the last 60 kept", () => {
    expect(installerLogLines(utf16("\uFEFF0.5.35 start x\r\n0.5.35 installed C:\\RG\r\n"))).toEqual(["0.5.35 start x", "0.5.35 installed C:\\RG"]);
    expect(installerLogLines(Buffer.concat([Buffer.from([0x41]), utf16("0.5.35 start ü\r\n")]))).toEqual(["0.5.35 start ü"]);
    const many = Array.from({ length: 80 }, (_, i) => `0.5.35 step ${i}`).join("\r\n");
    expect(installerLogLines(utf16(many))).toHaveLength(60);
    expect(installerLogLines(new Uint8Array())).toEqual([]);
  });

  it("says why the last run did not install: a file another program holds, with the file and the program", () => {
    expect(installerLogWhy(heldRun)).toBe("A file of ReviewGate was in use by another program — resources\\app.asar (in use by pwsh.exe 2004). Close that program or restart Windows, then try again.");
    expect(installerLogWhy(["0.5.35 start x", "0.5.35 failed uninstall-old 2 no file in use now"])).toBe("The old version could not be removed — a file of ReviewGate was in use. Restart Windows, then try again.");
    expect(installerLogWhy(["0.5.35 start x", "0.5.35 failed uninstall-old 2"])).toBe("The old version could not be removed — a file of ReviewGate was in use. Restart Windows, then try again.");
  });

  it("says another installer was still open; only the last run counts", () => {
    expect(installerLogWhy([...heldRun, "0.5.35 start y", "0.5.35 failed another-installer", "0.5.35 reopened C:\\RG\\ReviewGate.exe (ok)"])).toMatch(/^Another ReviewGate installer was still open/);
    expect(installerLogWhy([...heldRun, "0.5.35 start y", "0.5.35 mode CurrentUser C:\\RG", "0.5.35 installed C:\\RG"])).toBeNull();
  });

  it("a run that never got to its end: the step it stopped after; nothing written: nothing to say", () => {
    expect(installerLogWhy(["0.5.35 start x", "0.5.35 mode CurrentUser C:\\RG"])).toBe("The installer stopped before it finished (its last step: mode).");
    expect(installerLogWhy([])).toBeNull();
  });

  it("is taken once from each temp folder: read and removed; none is no lines, an unreadable one is said", () => {
    const file = join(dir, INSTALLER_LOG_NAME);
    writeFileSync(file, utf16(heldRun.join("\r\n") + "\r\n"));
    // Node's and Electron's temp folders, the same one spelled twice: read once.
    expect(takeInstallerLog([join(dir, "missing"), dir, dir.toUpperCase()])).toEqual({ lines: heldRun, problems: [] });
    expect(existsSync(file)).toBe(false);
    expect(takeInstallerLog([dir])).toEqual({ lines: [], problems: [] });
    // A huge one is read from its end.
    writeFileSync(file, Buffer.concat([utf16("x".repeat(MAX_INSTALLER_LOG_BYTES)), Buffer.from([0x41]), utf16("\r\n0.5.35 start z\r\n0.5.35 installed C:\\RG\r\n")]));
    expect(takeInstallerLog([dir]).lines.slice(-2)).toEqual(["0.5.35 start z", "0.5.35 installed C:\\RG"]);
    // A folder where a file is expected: said, not thrown.
    mkdirSync(join(dir, "odd", INSTALLER_LOG_NAME), { recursive: true });
    expect(takeInstallerLog([join(dir, "odd")]).problems).toEqual([expect.stringMatching(/ReviewGate-update\.log: E[A-Z]+$/)]);
  });
});
