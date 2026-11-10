// MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the managed settings tier as Claude Code reads it (temp folders and
// seams for the plist and the registry; never this machine's own managed settings).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HKCU_KEY, HKLM_KEY, readManagedPolicy, registrySettingsValue, resetManagedCache, type ManagedReadOptions } from "../src/statusline/managed.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

const dirs: string[] = [];
beforeEach(() => resetManagedCache());
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function tmp(prefix: string): string {
  const d = makeTempDir(prefix);
  dirs.push(d);
  return d;
}

const absent = (): never => {
  throw Object.assign(new Error("no such file"), { code: "ENOENT" });
};
const regAnswer = (key: string, json: string) => `\r\n${key}\r\n    Settings    REG_SZ    ${json}\r\n\r\n`;

/** Linux-like defaults: a temp config folder and managed folder, no plist / registry. */
function opts(o: Partial<ManagedReadOptions> = {}): ManagedReadOptions {
  return { platform: "linux", configDir: tmp("rg-mp-config"), managedDir: tmp("rg-mp-managed"), plistToJson: absent, regQuery: () => null, ...o };
}

describe("managed settings (§44.2)", () => {
  it("nothing present: no managed tier, nothing failed", () => {
    expect(readManagedPolicy(opts())).toEqual({ settings: null, sources: [], failed: null });
    expect(readManagedPolicy(opts({ managedDir: null }))).toEqual({ settings: null, sources: [], failed: null });
  });

  it("the managed file, then its drop-ins (sorted, .json, no dotfiles) merged over it", () => {
    const o = opts();
    writeFileSync(join(o.managedDir!, "managed-settings.json"), JSON.stringify({ statusLine: { command: "base.sh" }, a: 1 }));
    mkdirSync(join(o.managedDir!, "managed-settings.d"));
    writeFileSync(join(o.managedDir!, "managed-settings.d", "20-b.json"), JSON.stringify({ a: 2 }));
    writeFileSync(join(o.managedDir!, "managed-settings.d", "10-a.json"), JSON.stringify({ statusLine: { padding: 2 }, a: 9 }));
    writeFileSync(join(o.managedDir!, "managed-settings.d", ".hidden.json"), JSON.stringify({ a: 3 }));
    writeFileSync(join(o.managedDir!, "managed-settings.d", "notes.txt"), "a: 4");
    const p = readManagedPolicy(o);
    expect(p.settings).toEqual({ statusLine: { command: "base.sh", padding: 2 }, a: 2 });
    expect(p.sources).toEqual([{ kind: "file", path: join(o.managedDir!, "managed-settings.json") }]);
    expect(p.failed).toBeNull();
  });

  it("drop-ins alone make the managed tier too", () => {
    const o = opts();
    mkdirSync(join(o.managedDir!, "managed-settings.d"));
    writeFileSync(join(o.managedDir!, "managed-settings.d", "x.json"), JSON.stringify({ disableAllHooks: true }));
    expect(readManagedPolicy(o).settings).toEqual({ disableAllHooks: true });
  });

  it("server-managed settings come first (keys starting with $ dropped but $schema); first-wins takes the highest alone", () => {
    const o = opts();
    writeFileSync(join(o.configDir, "remote-settings.json"), JSON.stringify({ $schema: "s", $internal: 1, statusLine: { command: "remote.sh" } }));
    writeFileSync(join(o.managedDir!, "managed-settings.json"), JSON.stringify({ statusLine: { command: "file.sh" }, disableAllHooks: true }));
    const p = readManagedPolicy(o);
    expect(p.settings).toEqual({ $schema: "s", statusLine: { command: "remote.sh" } });
    expect(p.sources.map((s) => s.kind)).toEqual(["remote", "file"]);
  });

  it("merge: every source deep-merged, the highest on top, a restrictive switch on when any source turns it on", () => {
    const o = opts();
    writeFileSync(join(o.configDir, "remote-settings.json"), JSON.stringify({ managedSourcesBehavior: "merge", statusLine: { command: "remote.sh" }, disableAllHooks: false }));
    writeFileSync(join(o.managedDir!, "managed-settings.json"), JSON.stringify({ statusLine: { padding: 3, command: "file.sh" }, disableAllHooks: true, allowManagedHooksOnly: false }));
    expect(readManagedPolicy(o).settings).toEqual({
      managedSourcesBehavior: "merge",
      statusLine: { command: "remote.sh", padding: 3 },
      disableAllHooks: true,
      allowManagedHooksOnly: false,
    });
  });

  it("macOS: the user's managed preferences before the device's — the first with content", () => {
    const seen: string[] = [];
    const plist = (answers: Record<string, string>) => (path: string) => {
      seen.push(path);
      return path in answers ? answers[path]! : absent();
    };
    const user = "/Library/Managed Preferences/alice/com.anthropic.claudecode.plist";
    const device = "/Library/Managed Preferences/com.anthropic.claudecode.plist";
    const both = readManagedPolicy(opts({ platform: "darwin", username: "alice", plistToJson: plist({ [user]: '{"statusLine":{"command":"mine"}}', [device]: '{"statusLine":{"command":"device"}}' }) }));
    expect(both.settings).toEqual({ statusLine: { command: "mine" } });
    expect(both.sources).toEqual([{ kind: "plist", path: user }]);
    seen.length = 0;
    const emptyUser = readManagedPolicy(opts({ platform: "darwin", username: "alice", plistToJson: plist({ [user]: "{}", [device]: '{"allowManagedHooksOnly":true}' }) }));
    expect(emptyUser.settings).toEqual({ allowManagedHooksOnly: true });
    expect(seen).toEqual([user, device]);
  });

  it("Windows: HKLM's Settings value; HKCU only when no admin source is present", () => {
    const reg = (answers: Record<string, string>) => (key: string) => answers[key] ?? null;
    const hklm = readManagedPolicy(opts({ platform: "win32", regQuery: reg({ [HKLM_KEY]: regAnswer(HKLM_KEY, '{"statusLine":{"command":"corp"}}'), [HKCU_KEY]: regAnswer(HKCU_KEY, '{"a":1}') }) }));
    expect(hklm.settings).toEqual({ statusLine: { command: "corp" } });
    expect(hklm.sources.map((s) => s.kind)).toEqual(["hklm"]);
    const hkcu = readManagedPolicy(opts({ platform: "win32", regQuery: reg({ [HKCU_KEY]: regAnswer(HKCU_KEY, '{"disableAllHooks":true}') }) }));
    expect(hkcu.settings).toEqual({ disableAllHooks: true });
    const o = opts({ platform: "win32", regQuery: reg({ [HKCU_KEY]: regAnswer(HKCU_KEY, '{"disableAllHooks":true}') }) });
    writeFileSync(join(o.managedDir!, "managed-settings.json"), JSON.stringify({ a: 1 }));
    expect(readManagedPolicy(o).settings).toEqual({ a: 1 });
  });

  it("the registry answer: REG_SZ and REG_EXPAND_SZ, nothing without the value", () => {
    expect(registrySettingsValue(regAnswer(HKLM_KEY, '{"a":1}'))).toBe('{"a":1}');
    expect(registrySettingsValue(`\r\n${HKLM_KEY}\r\n    Settings    REG_EXPAND_SZ    {"b":2}\r\n`)).toBe('{"b":2}');
    expect(registrySettingsValue(`\r\n${HKLM_KEY}\r\n    Other    REG_SZ    x\r\n`)).toBeNull();
  });

  it("fails closed: a source that exists but does not parse or cannot be read is told, whatever the others say", () => {
    const o = opts();
    writeFileSync(join(o.managedDir!, "managed-settings.json"), "{ nope");
    expect(readManagedPolicy(o).failed).toMatchObject({ kind: "file", path: join(o.managedDir!, "managed-settings.json") });
    const remote = readManagedPolicy(opts({ readText: (p) => (p.endsWith("remote-settings.json") ? { error: "unreadable", detail: "EACCES" } : { error: "absent" }) }));
    expect(remote.failed).toEqual({ kind: "remote", path: expect.stringContaining("remote-settings.json"), reason: "unreadable (EACCES)" });
    const plist = readManagedPolicy(opts({ platform: "darwin", username: "alice", plistToJson: () => { throw new Error("plutil: bad"); } }));
    expect(plist.failed).toMatchObject({ kind: "plist", reason: "plutil could not read it" });
    const reg = readManagedPolicy(opts({ platform: "win32", regQuery: (k) => (k === HKLM_KEY ? regAnswer(HKLM_KEY, "[1,2]") : null) }));
    expect(reg.failed).toMatchObject({ kind: "hklm", reason: "not a JSON object" });
  });

  it("an edited managed file is read again (the cache follows its time and size)", () => {
    const o = opts();
    const file = join(o.managedDir!, "managed-settings.json");
    writeFileSync(file, JSON.stringify({ a: 1 }));
    expect(readManagedPolicy(o).settings).toEqual({ a: 1 });
    writeFileSync(file, JSON.stringify({ a: 22, b: true }));
    expect(readManagedPolicy(o).settings).toEqual({ a: 22, b: true });
  });
});
