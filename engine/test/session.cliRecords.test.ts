import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliProjectDirName, cliSessionExists, cliSessionFile, codeOfStartFailure, redactDetail } from "../src/session/cliRecords.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §30: where the Claude CLI keeps a conversation (`<config>/projects/<cwd key>/<id>.jsonl`) and how
 * its start fails. The key rule is the CLI's own (2.1.308: `replace(/[^a-zA-Z0-9]/g, "-")`, paths longer than 200
 * chars cut at 200 + `-` + base-36 of the Java string hash of the NFC cwd); the long-path expectation below is what
 * CLI 2.1.308 actually created for that directory (scratch probe, no model call).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("CLI project folder key", () => {
  it("replaces every non-alphanumeric character with '-' (NFC first, so a Hangul syllable is one '-')", () => {
    expect(cliProjectDirName("/Users/dev/src/acme", {})).toBe("-Users-dev-src-acme");
    expect(cliProjectDirName("/private/tmp/claude-501/-Users-x/scratch.d/repo_1", {})).toBe("-private-tmp-claude-501--Users-x-scratch-d-repo-1");
    const nfc = "/tmp/한글/repo";
    expect(cliProjectDirName(nfc.normalize("NFD"), {})).toBe(cliProjectDirName(nfc, {}));
    expect(cliProjectDirName(nfc, {})).toBe("-tmp----repo");
  });

  it("a key longer than 200 chars is cut at 200 and suffixed with the base-36 Java hash of the cwd (verified, CLI 2.1.308)", () => {
    const cwd =
      "/private/tmp/claude-501/-Users-dev-src-reviewgate/00000000-0000-4000-8000-000000000001/scratchpad/wave1/session/probe/" +
      "long-directory-name-for-the-cli-project-key-hash-check-0123456789-abcdefghijklmnopqrstuvwxyz-한글폴더";
    expect(cliProjectDirName(cwd, {})).toBe(
      "-private-tmp-claude-501--Users-dev-src-reviewgate-00000000-0000-4000-8000-000000000001-scratchpad-wave1-session-probe-long-directory-name-for-the-cli-project-key-hash-check-0123456789-abcdefghijklmnop-scw7m1",
    );
  });

  it("CLAUDE_CODE_PROJECT_DIR_NAME overrides the key only together with CLAUDE_CONFIG_DIR (and only a safe name)", () => {
    expect(cliProjectDirName("/a/b", { CLAUDE_CODE_PROJECT_DIR_NAME: "fixed" })).toBe("-a-b");
    expect(cliProjectDirName("/a/b", { CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_PROJECT_DIR_NAME: "fixed_1-x" })).toBe("fixed_1-x");
    expect(cliProjectDirName("/a/b", { CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_PROJECT_DIR_NAME: "../x" })).toBe("-a-b");
    expect(cliProjectDirName("/a/b", { CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_PROJECT_DIR_NAME: "con" })).toBe("-a-b");
  });

  it("cliSessionExists finds <config>/projects/<key>/<id>.jsonl for the cwd as given or resolved through symlinks", () => {
    const root = realpathSync(makeTempDir("rg-clirec"));
    dirs.push(root);
    const config = join(root, "config");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const link = join(root, "link");
    symlinkSync(repo, link);
    const env = { CLAUDE_CONFIG_DIR: config };
    const id = "86281b8f-1ea4-4073-a0fb-63afefff9b81";
    expect(cliSessionExists(repo, id, env)).toBe(false);
    expect(cliSessionFile(repo, id, env)).toBe(join(config, "projects", cliProjectDirName(repo, env), `${id}.jsonl`));
    mkdirSync(join(config, "projects", cliProjectDirName(repo, env)), { recursive: true });
    writeFileSync(cliSessionFile(repo, id, env), ""); // an empty record still makes `--session-id` collide
    expect(cliSessionExists(repo, id, env)).toBe(true);
    expect(cliSessionExists(link, id, env)).toBe(true); // the CLI keys its folder by the real cwd
    expect(cliSessionExists(repo, "00000000-0000-4000-8000-000000000000", env)).toBe(false);
    expect(cliSessionExists(repo, "../escape", env)).toBe(false);
  });
});

describe("start failure classification", () => {
  it("reads the CLI's own words (stderr / the SDK's error text)", () => {
    expect(codeOfStartFailure("Error: Session ID 86281b8f-1ea4-4073-a0fb-63afefff9b81 is already in use.\n")).toBe("session_id_in_use");
    expect(codeOfStartFailure("No conversation found with session ID: 9db4cb56-0000-4000-8000-000000000000")).toBe("resume_not_found");
    expect(codeOfStartFailure("Claude Code returned an error result: No conversation found with session ID: x")).toBe("resume_not_found");
    expect(codeOfStartFailure("Failed to resume session 9db4cb56-0000-4000-8000-000000000000: bad json")).toBe("resume_failed");
    expect(codeOfStartFailure("Claude Code process exited with code 1")).toBeNull();
    expect(codeOfStartFailure("")).toBeNull();
    expect(codeOfStartFailure(undefined)).toBeNull();
  });

  it("detail: the first non-empty line, home folder as ~, secrets masked, ids kept, ≤ 300 chars", () => {
    const home = "/Users/dev";
    expect(redactDetail("\n  Error: Session ID 86281b8f-1ea4-4073-a0fb-63afefff9b81 is already in use.\nmore", home)).toBe(
      "Error: Session ID 86281b8f-1ea4-4073-a0fb-63afefff9b81 is already in use.",
    );
    expect(redactDetail("Invalid settings in /Users/dev/.claude/settings.json: x", home)).toBe("Invalid settings in ~/.claude/settings.json: x");
    // Only the home folder itself: another user's folder that starts with the same name stays as it is.
    expect(redactDetail("cannot read /Users/devx/a and /Users/dev.old/b from /Users/dev/c or /Users/dev", home)).toBe("cannot read /Users/devx/a and /Users/dev.old/b from ~/c or ~");
    expect(redactDetail("C:\\Users\\me (1)\\x and C:\\Users\\me (1)2\\y", "C:\\Users\\me (1)")).toBe("~\\x and C:\\Users\\me (1)2\\y");
    expect(redactDetail("auth failed for sk-ant-api03-AbCdEf_123-xyz token", home)).toBe("auth failed for sk-ant-*** token");
    expect(redactDetail("request with Authorization: Bearer abc.def.ghi failed", home)).toBe("request with Authorization: Bearer *** failed");
    expect(redactDetail("env CLAUDE_CODE_OAUTH_TOKEN=abcdef123456 api_key: \"qq\"", home)).toBe("env CLAUDE_CODE_OAUTH_TOKEN=*** api_key: \"***\"");
    expect(redactDetail("blob QmFzZTY0QmFzZTY0QmFzZTY0QmFzZTY0QmFzZTY0QQ== end", home)).toBe("blob *** end");
    expect(redactDetail("word ".repeat(100), home)).toHaveLength(300);
    expect(redactDetail("", home)).toBe("");
  });
});
