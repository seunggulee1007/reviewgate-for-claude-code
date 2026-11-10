// MARK: polish p-lifecycle — P5-sheets-44: the first screen's checklist facts (Claude Code, gh's login, git's identity).
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: () => undefined } }));
vi.mock("./settings.js", () => ({ loadSettings: () => ({ claudePath: "", ghPath: "", gitPath: "", ghHost: "" }) }));

import { readinessOf, versionNumber, type ToolRun } from "./readiness";

const tc = { claude: "/usr/local/bin/claude", gh: "/usr/local/bin/gh", git: "/usr/bin/git", claudeVersion: "2.1.31 (Claude Code)", path: "/usr/bin" };

function runner(answers: Record<string, { code: number; stdout?: string; stderr?: string }>): ToolRun {
  return async (exe, args) => {
    const a = answers[`${exe.split("/").pop()} ${args.join(" ")}`] ?? { code: 1 };
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
}

describe("readiness (P5-sheets-44)", () => {
  it("everything there: the version, the account, the identity", async () => {
    const run = runner({
      "gh auth status --hostname github.com": { code: 0, stderr: "github.com\n  ✓ Logged in to github.com account dev (keyring)\n" },
      "git config --get user.name": { code: 0, stdout: "Dev\n" },
      "git config --get user.email": { code: 0, stdout: "dev@example.com\n" },
    });
    expect(await readinessOf(tc, run)).toEqual({
      claude: { ok: true, detail: "2.1.31" },
      ghLogin: { ok: true, detail: "dev" },
      gitIdentity: { ok: true, detail: "Dev <dev@example.com>" },
    });
  });

  it("says what is missing: a tool not installed, gh logged out, the git keys not set", async () => {
    const run = runner({ "gh auth status --hostname tasks.example.com": { code: 1, stderr: "You are not logged into any GitHub hosts." }, "git config --get user.name": { code: 0, stdout: "Dev" } });
    expect(await readinessOf({ ...tc, claude: null }, run, "tasks.example.com")).toEqual({
      claude: { ok: false, detail: "missing" },
      ghLogin: { ok: false },
      gitIdentity: { ok: false, detail: "user.email" },
    });
    expect(await readinessOf({ ...tc, gh: null, git: null }, runner({}))).toMatchObject({ ghLogin: { ok: false, detail: "missing" }, gitIdentity: { ok: false, detail: "missing" } });
  });

  it("reads the version number out of the CLI's line", () => {
    expect(versionNumber("2.1.31 (Claude Code)")).toBe("2.1.31");
    expect(versionNumber(null)).toBeUndefined();
  });
});
