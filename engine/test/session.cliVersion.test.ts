import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliInfo, CLI_VERSIONS_FILE, isVerifiedCli, listCliVersions, noteCliVersion, parseCliVersion, VERIFIED_CLI_FILE, VERIFIED_CLI_RANGE, verifiedCliVersions } from "../src/session/cliVersion.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.8 (audit daily-06): the CLI version, the verified range, the app-wide record and the installed versions. */

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("versions (§36.8)", () => {
  it("parseCliVersion reads `claude --version` (only a Claude Code line) and system/init's plain version", () => {
    expect(parseCliVersion("2.1.309 (Claude Code)")).toBe("2.1.309");
    expect(parseCliVersion("v2.1.309 (Claude Code)")).toBe("2.1.309");
    expect(parseCliVersion("2.1.309", { plain: true })).toBe("2.1.309");
    // Something else's version line (tests run `node` / `true` as the CLI) is not a Claude Code version.
    expect(parseCliVersion("v24.12.0")).toBeNull();
    expect(parseCliVersion("")).toBeNull();
    expect(parseCliVersion(null)).toBeNull();
    expect(parseCliVersion("not a version", { plain: true })).toBeNull();
  });

  it("the verified range is inclusive; its top is the CLI the drivers last ran against", () => {
    expect(VERIFIED_CLI_RANGE).toEqual({ min: "2.1.301", max: "2.1.318" });
    expect(isVerifiedCli("2.1.301")).toBe(true);
    expect(isVerifiedCli("2.1.309")).toBe(true);
    expect(isVerifiedCli("2.1.318")).toBe(true); // §36.8: the drivers passed on CLI 2.1.318
    expect(isVerifiedCli("2.1.319")).toBe(false);
    expect(isVerifiedCli("2.1.300")).toBe(false);
    expect(isVerifiedCli("2.2.0")).toBe(false);
  });

  it("verified-cli.json: versions verified after the release count too (make verify-cli); a bad file is ignored", () => {
    const data = tmp("rg-cli-verified");
    expect(verifiedCliVersions(data)).toEqual([]); // no file: the built-in range alone
    writeFileSync(join(data, VERIFIED_CLI_FILE), JSON.stringify({
      version: 1,
      verified: [{ version: "2.1.320", engine: "0.5.5", at: "2026-11-02T02:00:00Z", drivers: ["crash"] }, { version: "x" }, null, { version: 7 }],
    }));
    const extra = verifiedCliVersions(data);
    expect(extra).toEqual(["2.1.320"]);
    expect(isVerifiedCli("2.1.320", VERIFIED_CLI_RANGE, extra)).toBe(true);
    expect(isVerifiedCli("2.1.319", VERIFIED_CLI_RANGE, extra)).toBe(false); // listed versions only, not a new range top
    expect(isVerifiedCli("2.1.320")).toBe(false);
    expect(cliInfo("2.1.320", null, data, extra).verified).toBe(true);
    const versions = tmp("rg-cli-verified-versions");
    for (const v of ["2.1.319", "2.1.320"]) writeFileSync(join(versions, v), "");
    expect(listCliVersions(versions, extra).map((e) => [e.version, e.verified])).toEqual([["2.1.320", true], ["2.1.319", false]]);
    // The notice for a newly seen version reads the list as well.
    writeFileSync(join(data, CLI_VERSIONS_FILE), JSON.stringify({ version: 1, last: "2.1.314", previous: null, updatedAt: "x" }));
    expect(noteCliVersion(data, "2.1.320").change).toEqual({ from: "2.1.314", to: "2.1.320", verified: true });
    for (const bad of ["{", JSON.stringify({ version: 2, verified: [{ version: "2.1.320" }] }), JSON.stringify({ version: 1, verified: "2.1.320" })]) {
      writeFileSync(join(data, VERIFIED_CLI_FILE), bad);
      expect(verifiedCliVersions(data)).toEqual([]);
    }
  });

  it("listCliVersions: the installer's version entries by name, newest first; anything else is skipped", () => {
    const dir = tmp("rg-cli-versions");
    for (const v of ["2.1.303", "2.1.309", "2.1.319", "2.1.304.exe"]) writeFileSync(join(dir, v), "");
    writeFileSync(join(dir, "README"), "");
    mkdirSync(join(dir, "2.1.305"));
    expect(listCliVersions(dir)).toEqual([
      { version: "2.1.319", path: join(dir, "2.1.319"), verified: false },
      { version: "2.1.309", path: join(dir, "2.1.309"), verified: true },
      { version: "2.1.304", path: join(dir, "2.1.304.exe"), verified: true },
      { version: "2.1.303", path: join(dir, "2.1.303"), verified: true },
    ]);
    expect(listCliVersions(join(dir, "missing"))).toEqual([]);
  });
});

describe("the app-wide record (§36.8)", () => {
  it("first sight records without a notice; a different version is a change once; previous is the version before", () => {
    const data = tmp("rg-cli-data");
    expect(noteCliVersion(data, "2.1.308")).toEqual({ change: null, previous: null });
    expect(noteCliVersion(data, "2.1.308")).toEqual({ change: null, previous: null });
    expect(noteCliVersion(data, "2.1.319")).toEqual({ change: { from: "2.1.308", to: "2.1.319", verified: false }, previous: "2.1.308" });
    // Once: the next session with the same version says nothing, and still knows the one before.
    expect(noteCliVersion(data, "2.1.319")).toEqual({ change: null, previous: "2.1.308" });
    const saved = JSON.parse(readFileSync(join(data, CLI_VERSIONS_FILE), "utf8")) as { version: number; last: string; previous: string };
    expect(saved).toMatchObject({ version: 1, last: "2.1.319", previous: "2.1.308" });
    // A broken record is a first sight.
    writeFileSync(join(data, CLI_VERSIONS_FILE), "{broken");
    expect(noteCliVersion(data, "2.1.309")).toEqual({ change: null, previous: null });
  });

  it("cliInfo: verified flag, range, previous with its path while it is still installed", () => {
    const versions = tmp("rg-cli-info");
    writeFileSync(join(versions, "2.1.308"), "");
    expect(cliInfo("2.1.309", "2.1.308", versions)).toEqual({
      version: "2.1.309",
      verified: true,
      verifiedRange: { min: "2.1.301", max: "2.1.318" },
      previous: { version: "2.1.308", path: join(versions, "2.1.308") },
    });
    expect(cliInfo("2.1.319", "2.1.307", versions)).toEqual({ version: "2.1.319", verified: false, verifiedRange: { min: "2.1.301", max: "2.1.318" }, previous: { version: "2.1.307", path: null } });
    expect(cliInfo("2.1.309", null, versions).previous).toBeNull();
  });
});
