import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLI_VERSIONS_FILE, VERIFIED_CLI_RANGE } from "../src/session/cliVersion.js";
import { makeHarness, testSettings, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.8 (audit daily-06) at the engine: `session.cli`, the `cli_version_changed` notice, `cli_versions`, pinning. */
const dirs: string[] = [];
const harnesses: Harness[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = tmp("rg-cli-repo");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@e.com");
  sh(dir, "config", "user.name", "T");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

async function sessionInfo(h: Harness, version: string): Promise<void> {
  await h.engine.handle({ type: "send", text: "hi" });
  h.session().emitSessionInfo({ cliVersion: version });
  h.session().emitTurnEnd();
  await h.waitFor((s) => s.gate.phase === "idle" && s.session.cli?.version === version, `session.cli ${version}`);
}

describe("session.cli and the version notice (§36.8)", () => {
  it("a version different from the last one seen: the notice once (a chat row), previous pinnable while installed", async () => {
    const dir = makeRepo();
    const data = tmp("rg-cli-data");
    const versions = tmp("rg-cli-versions");
    writeFileSync(join(versions, "2.1.308"), "");
    writeFileSync(join(data, CLI_VERSIONS_FILE), JSON.stringify({ version: 1, last: "2.1.308", previous: null, updatedAt: "x" }));
    const h = harness({ dataDir: data, cliVersionsDir: versions });
    await h.hello();
    const opened = await h.open(dir);
    // The fake CLI reports no version until session_info (a real one: `claude --version` at the start).
    expect(opened.session.cli ?? null).toBeNull();
    await sessionInfo(h, "2.1.309");
    const s = h.engine.state;
    expect(s.session.cli).toEqual({ version: "2.1.309", verified: true, verifiedRange: VERIFIED_CLI_RANGE, previous: { version: "2.1.308", path: join(versions, "2.1.308") } });
    const notices = h.ofType("error").filter((e) => e.code === "cli_version_changed");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ fatal: false, scope: "session", cli: { from: "2.1.308", to: "2.1.309", verified: true } });
    expect(notices[0]!.message).toContain("2.1.308");
    expect(notices[0]!.message).toContain("2.1.309");
    expect(s.lastError).toBeNull();

    // A restart (and another engine) on the same version says nothing more.
    await h.engine.request({ type: "restart_session" });
    await sessionInfo(h, "2.1.309");
    const h2 = harness({ dataDir: data, cliVersionsDir: versions });
    await h2.hello();
    await h2.open(makeRepo());
    await sessionInfo(h2, "2.1.309");
    expect(h.ofType("error").filter((e) => e.code === "cli_version_changed")).toHaveLength(1);
    expect(h2.ofType("error").filter((e) => e.code === "cli_version_changed")).toHaveLength(0);
    expect(h2.engine.state.session.cli?.previous).toEqual({ version: "2.1.308", path: join(versions, "2.1.308") });
  });

  it("an unverified version reads verified: false; the very first version seen is recorded without a notice", async () => {
    const dir = makeRepo();
    const data = tmp("rg-cli-data2");
    const h = harness({ dataDir: data, cliVersionsDir: tmp("rg-cli-empty") });
    await h.hello();
    await h.open(dir);
    await sessionInfo(h, "2.1.400");
    expect(h.engine.state.session.cli).toEqual({ version: "2.1.400", verified: false, verifiedRange: VERIFIED_CLI_RANGE, previous: null });
    expect(h.ofType("error").filter((e) => e.code === "cli_version_changed")).toHaveLength(0);
  });
});

describe("cli_versions and pinning (§36.8)", () => {
  it("lists the installed versions newest first with the current one and the pinned path — also without a project", async () => {
    const versions = tmp("rg-cli-list");
    for (const v of ["2.1.307", "2.1.309", "2.1.315"]) writeFileSync(join(versions, v), "");
    const h = harness({ dataDir: tmp("rg-cli-data3"), cliVersionsDir: versions });
    await h.hello();
    const before = await h.engine.request({ type: "cli_versions" });
    expect(before).toMatchObject({
      type: "cli_versions",
      versions: [
        { version: "2.1.315", path: join(versions, "2.1.315"), verified: false },
        { version: "2.1.309", path: join(versions, "2.1.309"), verified: true },
        { version: "2.1.307", path: join(versions, "2.1.307"), verified: true },
      ],
      current: null,
      pinnedPath: testSettings.claudePath,
    });
    await h.open(makeRepo());
    await sessionInfo(h, "2.1.309");
    expect((await h.engine.request({ type: "cli_versions" })).current).toBe("2.1.309");
    // Unpinned: no pinned path.
    await h.engine.handle({ type: "set_settings", settings: { claudePath: "" } });
    expect((await h.engine.request({ type: "cli_versions" })).pinnedPath).toBeNull();
  });

  it("set_settings claudePath re-locates the toolchain right away (the next start uses it)", async () => {
    const h = harness({ dataDir: tmp("rg-cli-data4"), cliVersionsDir: tmp("rg-cli-none") });
    await h.hello();
    await h.waitFor((s) => s.toolchain.claude === testSettings.claudePath, "located");
    await h.engine.handle({ type: "set_settings", settings: { claudePath: process.execPath } });
    await h.waitFor((s) => s.toolchain.claude === process.execPath, "re-located");
  });
});
