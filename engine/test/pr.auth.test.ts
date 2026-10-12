import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, onTestFinished, test } from "vitest";
import { makeFakeExe } from "./helpers/fakeGh.js";
import {
  TIMED_OUT_DETAIL,
  ghConfigDir,
  isValidHost,
  loginCommand,
  parseHostsYAML,
  parseStatusJSON,
  status,
} from "../src/pr/auth.js";

const statusJSON = readFileSync(join(__dirname, "fixtures", "gh", "auth-status.json"));

// Port of Core/Tests/ReviewGateCoreTests/GHAuthTests.swift (7 cases) + ghConfigDir.
describe("GHAuth", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });
  const makeHome = () => {
    const home = mkdtempSync(join(tmpdir(), "rg-home-"));
    temps.push(home);
    return home;
  };

  /** Shape of a real `~/.config/gh/hosts.yml` with two hosts. */
  test("parsesHostsYAML", () => {
    const yaml = [
      "github.com:",
      "    git_protocol: https",
      "    users:",
      "        seunggulee1007:",
      "    user: seunggulee1007",
      "ghe.example.com:",
      "    git_protocol: https",
      "    users:",
      "        enterprise-user:",
      "    user: enterprise-user",
    ].join("\n");
    const hosts = parseHostsYAML(yaml);
    expect(hosts.map((h) => h.host)).toEqual(["github.com", "ghe.example.com"]);
    expect(hosts.map((h) => h.login)).toEqual(["seunggulee1007", "enterprise-user"]);
    expect(parseHostsYAML("")).toEqual([]);
    expect(parseHostsYAML("# nothing\n")).toEqual([]);
    // a host without a `user:` line still counts (login unknown)
    expect(parseHostsYAML("ghe.example:\n    git_protocol: ssh\n").map((h) => h.login)).toEqual([null]);
  });

  /** A duplicated host block: the first occurrence wins and no duplicate entry is produced. */
  test("parseHostsYAMLSkipsDuplicateHosts", () => {
    const yaml = [
      "github.com:",
      "    git_protocol: https",
      "    user: first-login",
      "ghe.example.com:",
      "    git_protocol: https",
      "    user: other",
      "github.com:",
      "    git_protocol: https",
      "    user: second-login",
    ].join("\n");
    const hosts = parseHostsYAML(yaml);
    expect(hosts.map((h) => h.host)).toEqual(["github.com", "ghe.example.com"]);
    expect(hosts.find((h) => h.host === "github.com")?.login).toBe("first-login");
  });

  /** Fixture: docs/gh-auth-status.json (the shape of `gh auth status --json hosts` output, GHE timing out). */
  test("parsesAuthStatusJSON", () => {
    const ok = parseStatusJSON(statusJSON, "github.com")!;
    expect(ok).not.toBeNull();
    expect(ok.ok).toBe(true);
    expect(ok.login).toBe("seunggulee1007");
    expect(ok.detail).toContain("seunggulee1007");
    expect(ok.detail).toContain("repo");

    const timeout = parseStatusJSON(statusJSON, "ghe.example.com")!;
    expect(timeout.ok).toBe(false);
    expect(timeout.login).toBe("enterprise-user");
    expect(timeout.detail).toBe(TIMED_OUT_DETAIL);

    expect(parseStatusJSON(statusJSON, "unknown.host")).toBeNull();
    expect(parseStatusJSON("not json", "github.com")).toBeNull();

    const e = parseStatusJSON('{"hosts":{"h":[{"state":"error","error":"token invalid","login":"x"}]}}', "h")!;
    expect(e.ok).toBe(false);
    expect(e.detail).toBe("token invalid");
  });

  test("loginCommand", () => {
    expect(loginCommand("ghe.example.com")).toBe("gh auth login --hostname 'ghe.example.com' --web --git-protocol https");
  });

  test("loginCommandValidatesHost", () => {
    expect(loginCommand("github.com")).toBe("gh auth login --hostname 'github.com' --web --git-protocol https");
    expect(loginCommand("github.example.com:8443")).toBe("gh auth login --hostname 'github.example.com:8443' --web --git-protocol https");
    expect(loginCommand("foo; rm -rf ~")).toBeNull();
    expect(isValidHost("foo; rm -rf ~")).toBe(false);
  });

  test("ghConfigDir", () => {
    expect(ghConfigDir("darwin", { GH_CONFIG_DIR: "/x/gh", HOME: "/h" })).toBe("/x/gh");
    expect(ghConfigDir("darwin", { HOME: "/h" })).toBe("/h/.config/gh");
    expect(ghConfigDir("linux", { HOME: "/h" })).toBe("/h/.config/gh");
    expect(ghConfigDir("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" })).toBe("C:\\Users\\x\\AppData\\Roaming\\GitHub CLI");
    expect(ghConfigDir("win32", { GH_CONFIG_DIR: "D:\\gh" })).toBe("D:\\gh");
  });

  /** No hosts.yml under HOME → no probes, no throw. */
  test("statusWithoutHostsFileIsEmpty", async () => {
    const home = makeHome();
    const accounts = await status("/usr/bin/false", { HOME: home, PATH: "/usr/bin:/bin" }, "darwin");
    expect(accounts).toEqual([]);
  });

  /** A `gh` that never answers is cut off by the per-host timeout and reported as timed out. */
  test("hungGHIsReportedAsTimedOut", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "ghe.example:\n    user: me\n");
    // The blocked process *is* the child exec() kills (a forked grandchild would keep the stdout pipe open).
    const fake = makeFakeExe(home, "gh", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);");
    onTestFinished(fake.restore);
    const fakeGH = fake.path;

    const start = Date.now();
    const accounts = await status(fakeGH, { HOME: home, PATH: "/usr/bin:/bin" }, "darwin");
    expect(Date.now() - start).toBeLessThan(12_000);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].host).toBe("ghe.example");
    expect(accounts[0].login).toBe("me");
    expect(accounts[0].ok).toBe(false);
    expect(accounts[0].detail).toBe(TIMED_OUT_DETAIL);
  });

  /** A fake `gh` answering with the fixture → parsed per host, hosts.yml order preserved. */
  test("statusParsesFakeGHOutput", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "ghe.example.com:\n    user: enterprise-user\ngithub.com:\n    user: seunggulee1007\n");
    writeFileSync(join(home, "status.json"), statusJSON);
    const fake = makeFakeExe(home, "gh", `fs.writeSync(1, fs.readFileSync(${JSON.stringify(join(home, "status.json"))}));`);
    onTestFinished(fake.restore);
    const fakeGH = fake.path;

    const accounts = await status(fakeGH, { HOME: home, PATH: "/usr/bin:/bin" }, "darwin");
    expect(accounts.map((a) => a.host)).toEqual(["ghe.example.com", "github.com"]);
    expect(accounts[0].ok).toBe(false);
    expect(accounts[0].detail).toBe(TIMED_OUT_DETAIL);
    expect(accounts[1].ok).toBe(true);
    expect(accounts[1].login).toBe("seunggulee1007");
  });
});
