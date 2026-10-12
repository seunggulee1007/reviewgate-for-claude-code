// MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: which `statusLine` runs (never the developer's own ~/.claude).
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_MANAGED_POLICY, type ManagedPolicy } from "../src/statusline/managed.js";
import { commandSha256, resolveStatusLine } from "../src/statusline/settings.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

const CONFIG = join("/cfg", ".claude");
const CWD = join("/work", "repo");
const USER = join(CONFIG, "settings.json");
const PROJECT = join(CWD, ".claude", "settings.json");
const LOCAL = join(CWD, ".claude", "settings.local.json");
const MANAGED = join("/managed", "managed-settings.json");

const managed = (settings: Record<string, unknown> | null, failed: ManagedPolicy["failed"] = null): ManagedPolicy => ({
  settings,
  sources: settings ? [{ kind: "file", path: MANAGED }] : [],
  failed,
});

type Opts = { allowedProjectSha?: string | null; cwd?: string | null; disableAllHooks?: boolean; loadLocal?: boolean; managed?: ManagedPolicy };

function resolveWith(files: Record<string, unknown>, opts: Opts = {}) {
  const read = (p: string) => (p in files ? (typeof files[p] === "string" ? (files[p] as string) : JSON.stringify(files[p])) : null);
  return resolveStatusLine({
    configDir: CONFIG,
    cwd: opts.cwd === undefined ? CWD : opts.cwd,
    managed: opts.managed ?? NO_MANAGED_POLICY,
    allowedProjectSha: opts.allowedProjectSha ?? null,
    loadLocal: opts.loadLocal,
    disableAllHooks: opts.disableAllHooks,
    read,
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("statusLine settings (§44.2)", () => {
  it("runs the user's statusLine with its padding, refresh interval, timeout and shell", () => {
    const r = resolveWith({ [USER]: { statusLine: { type: "command", command: "~/bin/line.sh", padding: 2, refreshInterval: 5, timeout: 3, shell: "powershell" } } });
    expect(r.config).toEqual({ command: "~/bin/line.sh", padding: 2, refreshIntervalMs: 5000, timeoutMs: 3000, shell: "powershell", source: "user", path: USER });
    expect(r.project).toBeNull();
    expect(r.disabled).toBeNull();
    expect(r.outputStyle).toBe("default");
  });

  it("nothing configured, or not a command: no config", () => {
    expect(resolveWith({}).config).toBeNull();
    expect(resolveWith({ [USER]: { statusLine: { type: "static", command: "x" } } }).config).toBeNull();
    expect(resolveWith({ [USER]: { statusLine: { type: "command", command: "   " } } }).config).toBeNull();
    expect(resolveWith({ [USER]: "{ not json" }).config).toBeNull();
  });

  it("a project's statusLine is told with its command's sha256 and runs only when the user allowed that very command", () => {
    const files = {
      [USER]: { statusLine: { type: "command", command: "user.sh", padding: 1 } },
      [PROJECT]: { statusLine: { type: "command", command: "project.sh" } },
    };
    const sha = commandSha256("project.sh");
    const off = resolveWith(files);
    expect(off.config).toMatchObject({ command: "user.sh", source: "user", padding: 1 });
    expect(off.project).toEqual({ path: PROJECT, command: "project.sh", sha256: sha, allowed: false });

    const on = resolveWith(files, { allowedProjectSha: sha });
    // The CLI merges the object field by field: the user's padding stays under the project's command.
    expect(on.config).toMatchObject({ command: "project.sh", source: "project", path: PROJECT, padding: 1 });
    expect(on.project).toEqual({ path: PROJECT, command: "project.sh", sha256: sha, allowed: true });

    // A pull that changes the command: allowed no more, until the user allows the new one.
    const changed = resolveWith({ ...files, [PROJECT]: { statusLine: { type: "command", command: "project.sh --upload" } } }, { allowedProjectSha: sha });
    expect(changed.config).toMatchObject({ command: "user.sh" });
    expect(changed.project).toMatchObject({ command: "project.sh --upload", allowed: false, sha256: commandSha256("project.sh --upload") });
  });

  it("local over project — and no settings.local.json when the project's local settings are off", () => {
    const files = {
      [PROJECT]: { statusLine: { type: "command", command: "project.sh" } },
      [LOCAL]: { statusLine: { type: "command", command: "local.sh" }, outputStyle: "Local style" },
    };
    const local = resolveWith(files, { allowedProjectSha: commandSha256("local.sh") });
    expect(local.config).toMatchObject({ command: "local.sh", source: "local", path: LOCAL });
    expect(local.outputStyle).toBe("Local style");
    const noLocal = resolveWith(files, { allowedProjectSha: commandSha256("local.sh"), loadLocal: false });
    expect(noLocal.project).toMatchObject({ command: "project.sh", path: PROJECT, allowed: false });
    expect(noLocal.config).toBeNull();
    expect(noLocal.outputStyle).toBe("default");
  });

  it("only a project defines one and it is not allowed: nothing runs", () => {
    const r = resolveWith({ [PROJECT]: { statusLine: { type: "command", command: "evil.sh" } } });
    expect(r.config).toBeNull();
    expect(r.project).toMatchObject({ path: PROJECT, command: "evil.sh", allowed: false });
  });

  it("managed settings win; allowManagedHooksOnly leaves only theirs and says so when it hides the user's", () => {
    const user = { statusLine: { type: "command", command: "user.sh" } };
    expect(resolveWith({ [USER]: user }, { managed: managed({ statusLine: { type: "command", command: "corp.sh" } }) }).config).toMatchObject({ command: "corp.sh", source: "managed", path: MANAGED });
    const only = resolveWith({ [USER]: user, [PROJECT]: { statusLine: { type: "command", command: "p.sh" } } }, { managed: managed({ allowManagedHooksOnly: true }), allowedProjectSha: commandSha256("p.sh") });
    expect(only).toMatchObject({ config: null, disabled: "managed_policy" });
    expect(only.project).toMatchObject({ command: "p.sh", allowed: false });
    expect(resolveWith({}, { managed: managed({ allowManagedHooksOnly: true }) }).disabled).toBeNull(); // nothing hidden
    const corp = resolveWith({ [USER]: user }, { managed: managed({ allowManagedHooksOnly: true, statusLine: { command: "corp.sh" } }) });
    expect(corp).toMatchObject({ config: { command: "corp.sh", source: "managed" }, disabled: null });
  });

  it("a managed source that cannot be read runs nothing (fail closed)", () => {
    const r = resolveWith({ [USER]: { statusLine: { command: "user.sh" } } }, { managed: { settings: null, sources: [], failed: { kind: "plist", path: "/Library/Managed Preferences/x.plist", reason: "plutil could not read it" } } });
    expect(r).toMatchObject({ config: null, disabled: "managed_policy" });
  });

  it("disableAllHooks: the policy's runs nothing; anywhere else (or ReviewGate's hooks-off) only the managed one runs", () => {
    const user = { statusLine: { type: "command", command: "user.sh" } };
    expect(resolveWith({ [USER]: user }, { managed: managed({ disableAllHooks: true, statusLine: { command: "corp.sh" } }) })).toMatchObject({ config: null, disabled: "disable_all_hooks" });
    expect(resolveWith({ [USER]: { ...user, disableAllHooks: true } })).toMatchObject({ config: null, disabled: "disable_all_hooks" });
    expect(resolveWith({ [USER]: user, [PROJECT]: { disableAllHooks: true } })).toMatchObject({ config: null, disabled: "disable_all_hooks" });
    expect(resolveWith({ [USER]: user }, { disableAllHooks: true })).toMatchObject({ config: null, disabled: "disable_all_hooks" });
    // The CLI's Oy(): the user's disableAllHooks leaves the organization's own hooks (and status line) running.
    expect(resolveWith({ [USER]: { ...user, disableAllHooks: true } }, { managed: managed({ statusLine: { command: "corp.sh" } }) })).toMatchObject({ config: { command: "corp.sh" }, disabled: null });
    // Merged as the CLI merges: a higher layer's false over a lower one's true leaves it on.
    expect(resolveWith({ [USER]: { ...user, disableAllHooks: true }, [PROJECT]: { disableAllHooks: false } })).toMatchObject({ config: { command: "user.sh" }, disabled: null });
    expect(resolveWith({ [USER]: { ...user, disableAllHooks: true } }, { managed: managed({ disableAllHooks: false }) })).toMatchObject({ config: { command: "user.sh" }, disabled: null });
    expect(resolveWith({ [USER]: user, [LOCAL]: { disableAllHooks: true } }, { loadLocal: false })).toMatchObject({ config: { command: "user.sh" } });
  });

  it("padding is clamped to 0–20, the refresh interval to 1 s – 1 day, the timeout to 10 minutes", () => {
    expect(resolveWith({ [USER]: { statusLine: { command: "a", padding: -3, refreshInterval: 0.2 } } }).config).toMatchObject({ padding: 0, refreshIntervalMs: 1000 });
    expect(resolveWith({ [USER]: { statusLine: { command: "a", padding: 99 } } }).config).toMatchObject({ padding: 20, refreshIntervalMs: null, timeoutMs: null, shell: null });
    // Beyond 2^31 − 1 ms a Node timer fires at once: a refresh would spin and every run would time out at once.
    expect(resolveWith({ [USER]: { statusLine: { command: "a", refreshInterval: 1e9, timeout: 1e9 } } }).config).toMatchObject({ refreshIntervalMs: 86_400_000, timeoutMs: 600_000 });
  });

  it("without a project only the user's and the managed files are read; outputStyle merges like the CLI", () => {
    const r = resolveWith({ [USER]: { outputStyle: "Explanatory", statusLine: { command: "u.sh" } }, [PROJECT]: { outputStyle: "Learning" } }, { cwd: null });
    expect(r.outputStyle).toBe("Explanatory");
    expect(r.config).toMatchObject({ command: "u.sh" });
    expect(resolveWith({ [USER]: { outputStyle: "Explanatory" }, [PROJECT]: { outputStyle: "Learning" } }).outputStyle).toBe("Learning");
    expect(resolveWith({ [USER]: { outputStyle: "Explanatory" } }, { managed: managed({ outputStyle: "Corp" }) }).outputStyle).toBe("Corp");
  });

  it("strings reach the clients well formed (a lone surrogate half becomes U+FFFD); the hash is of the command as written", () => {
    const raw = "x\udc00";
    const r = resolveWith({ [USER]: { statusLine: { command: raw }, outputStyle: "s\ud800" }, [PROJECT]: { statusLine: { command: raw } } });
    expect(r.config?.command).toBe("x�");
    expect(r.outputStyle).toBe("s�");
    expect(r.project).toMatchObject({ command: "x�", sha256: commandSha256(raw) });
  });

  it.skipIf(process.platform === "win32")("a repository's settings.json that is /dev/zero or a FIFO is not read (no hang, no memory blow-up)", () => {
    const repo = makeTempDir("rg-sl-dev");
    dirs.push(repo);
    mkdirSync(join(repo, ".claude"));
    symlinkSync("/dev/zero", join(repo, ".claude", "settings.json"));
    execFileSync("mkfifo", [join(repo, ".claude", "settings.local.json")]);
    const cfg = makeTempDir("rg-sl-cfg");
    dirs.push(cfg);
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ statusLine: { command: "u.sh" } }));
    const r = resolveStatusLine({ configDir: cfg, cwd: repo, managed: NO_MANAGED_POLICY });
    expect(r.config).toMatchObject({ command: "u.sh", source: "user" });
    expect(r.project).toBeNull();
  });
});
