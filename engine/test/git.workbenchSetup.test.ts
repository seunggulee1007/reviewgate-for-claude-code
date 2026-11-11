import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  branchTail,
  copyFiles,
  copyPatterns,
  filesToCopy,
  runSetupCommand,
  siblingPath,
  worktreeIncludePatterns,
} from "../src/git/workbenchSetup.js";
import { createPlatform } from "../src/platform/index.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.12 (market-02): what a new workbench gets copied and how its setup command runs. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
const posix = process.platform !== "win32";

describe("copy patterns", () => {
  it("copy globs are repo-relative (anchored); '..', absolute and empty ones are dropped", () => {
    expect(copyPatterns(["mvnw", ".mvn/", "**/dev-certs.yml", "./scripts/*.sh", "a\\b.txt", "!keep.me"])).toEqual([
      "/mvnw", "/.mvn/", "/**/dev-certs.yml", "/scripts/*.sh", "/a/b.txt", "!/keep.me",
    ]);
    expect(copyPatterns(["", "  ", "../secret", "a/../../b", "/etc/passwd", "C:\\x", "\\\\server\\share", 3 as never])).toEqual([]);
  });

  it(".worktreeinclude is gitignore syntax: comments and blank lines skipped, '..' lines dropped, the rest as written", () => {
    expect(worktreeIncludePatterns("# local files\n.env\n\n!.env.example\n/config/local.yml\n../outside\n**/target/\r\n\\#hash\n")).toEqual([
      ".env", "!.env.example", "/config/local.yml", "**/target/", "\\#hash",
    ]);
  });
});

describe("sibling folder", () => {
  it("<parent of the main worktree>/<repo>-<branch tail>", () => {
    expect(branchTail("feature/PAY-1600")).toBe("PAY-1600");
    expect(branchTail("main")).toBe("main");
    expect(branchTail("fix/a b")).toBe("a-b");
    expect(branchTail("feature/")).toBe("feature");
    expect(siblingPath(join("/Users", "me", "acme"), "feature/PAY-1600")).toBe(join("/Users", "me", "acme-PAY-1600"));
  });
});

function repoWithLocalFiles(): string {
  const dir = tmp("rg-wbs");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "T");
  write(dir, ".gitignore", "*.local.yml\nconfig/local/dev-certs.yml\ntarget/\n");
  write(dir, "tracked.txt", "t\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  write(dir, "mvnw", "#!/bin/sh\necho mvnw\n");
  chmodSync(join(dir, "mvnw"), 0o755);
  write(dir, ".mvn/wrapper/maven-wrapper.properties", "distributionUrl=x\n");
  write(dir, "config/local/dev-certs.yml", "ssl: true\n");
  write(dir, "app.local.yml", "local: 1\n");
  write(dir, "target/classes/A.class", "bin");
  write(dir, "notes.txt", "untracked notes\n");
  return dir;
}

describe("filesToCopy", () => {
  it("lists the untracked or ignored regular files the globs / .worktreeinclude match — never a tracked file, a symlink or a nested repository", async () => {
    const dir = repoWithLocalFiles();
    write(dir, ".worktreeinclude", "*.local.yml\n../escape\n");
    if (posix) symlinkSync("/etc/hosts", join(dir, "hosts.local.yml"));
    mkdirSync(join(dir, "nested"));
    sh(join(dir, "nested"), "init", "-q");
    write(dir, "nested/n.local.yml", "n\n");
    const list = await filesToCopy(dir, { copy: ["mvnw", ".mvn", "**/dev-certs.yml", "tracked.txt", "nested", "../x"] });
    expect(list.map((f) => f.path)).toEqual([".mvn/wrapper/maven-wrapper.properties", "app.local.yml", "config/local/dev-certs.yml", "mvnw"]);
    expect(list.find((f) => f.path === "mvnw")?.bytes).toBe(statSync(join(dir, "mvnw")).size);
    // .worktreeinclude off: only the globs.
    const globsOnly = await filesToCopy(dir, { copy: ["mvnw"], useWorktreeInclude: false });
    expect(globsOnly.map((f) => f.path)).toEqual(["mvnw"]);
    // Nothing configured, no .worktreeinclude: nothing.
    expect(await filesToCopy(dir, { useWorktreeInclude: false })).toEqual([]);
    expect(await filesToCopy(dir, undefined)).toEqual([{ path: "app.local.yml", bytes: 9 }]);
  });
});

describe("copyFiles", () => {
  it("copies with the file mode, leaves an existing destination alone and never writes through a symlinked folder", async () => {
    const src = repoWithLocalFiles();
    const dst = tmp("rg-wbs-dst");
    write(dst, "notes.txt", "already here\n");
    const outside = tmp("rg-wbs-outside");
    if (posix) symlinkSync(outside, join(dst, "config"));
    const items = [{ path: "mvnw", bytes: 0 }, { path: ".mvn/wrapper/maven-wrapper.properties", bytes: 0 }, { path: "notes.txt", bytes: 0 }, { path: "config/local/dev-certs.yml", bytes: 0 }];
    const r = await copyFiles(src, dst, items);
    expect(readFileSync(join(dst, "mvnw"), "utf8")).toBe("#!/bin/sh\necho mvnw\n");
    if (posix) expect(statSync(join(dst, "mvnw")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dst, ".mvn/wrapper/maven-wrapper.properties"), "utf8")).toBe("distributionUrl=x\n");
    expect(readFileSync(join(dst, "notes.txt"), "utf8")).toBe("already here\n");
    expect(r.copied).toBe(posix ? 2 : 3);
    expect(r.skipped).toContain("notes.txt");
    if (posix) {
      expect(existsSync(join(outside, "local"))).toBe(false);
      expect(r.skipped).toContain("config/local/dev-certs.yml");
    }
  });
});

describe("runSetupCommand", () => {
  const platform = createPlatform();
  const env = { ...process.env, SHELL: posix ? "/bin/sh" : process.env.SHELL } as Record<string, string | undefined>;

  it("runs through the login shell in the folder, streams the output tail and returns the exit code", async () => {
    const dir = tmp("rg-setup");
    const ticks: string[] = [];
    const ok = await runSetupCommand(posix ? "echo hello from $(pwd) && echo second >&2" : "echo hello", dir, env, { platform, onOutput: (tail) => ticks.push(tail), throttleMs: 0 });
    expect(ok.exitCode).toBe(0);
    expect(ok.logTail).toContain("hello");
    if (posix) {
      expect(ok.logTail).toContain(dir);
      expect(ok.logTail).toContain("second");
    }
    expect(ticks.length).toBeGreaterThan(0);
    const bad = await runSetupCommand("exit 3", dir, env, { platform, onOutput: () => {} });
    expect(bad.exitCode).toBe(3);
  });

  it("a command past its limit is killed with its children: exitCode null", async () => {
    const dir = tmp("rg-setup");
    const started = Date.now();
    const r = await runSetupCommand(posix ? "sleep 60" : "ping -n 60 127.0.0.1 > nul", dir, env, { platform, onOutput: () => {}, timeoutMs: 300 });
    expect(r.exitCode).toBeNull();
    // the command outlives the bound, so only the kill can end it in time (Windows' taskkill alone may take 10 s)
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(r.logTail).toMatch(/timed out/);
  });

  it.runIf(posix)("a shell that cannot start ends the run (exitCode null) with the reason in the log", async () => {
    const dir = tmp("rg-setup");
    const r = await runSetupCommand("echo never", dir, { ...env, SHELL: "/nonexistent/sh" }, { platform, onOutput: () => {} });
    expect(r.exitCode).toBeNull();
    expect(r.logTail).toMatch(/ENOENT|nonexistent/);
  });

  it("keeps only the last 4 000 chars of a long log", async () => {
    const dir = tmp("rg-setup");
    const r = await runSetupCommand(posix ? "i=0; while [ $i -lt 400 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done" : "for /L %i in (1,1,400) do @echo line-%i-xxxxxxxxxxxxxxxxxxxx", dir, env, { platform, onOutput: () => {} });
    expect(r.exitCode).toBe(0);
    expect(r.logTail.length).toBeLessThanOrEqual(4000);
    expect(r.logTail).toContain("line-399");
    expect(r.logTail).not.toContain("line-0-");
  });
});
