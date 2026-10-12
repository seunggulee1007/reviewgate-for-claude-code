import { chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODS_MAX_BYTES } from "../src/git/mods.js";
import type { ToolFileEntry } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * `reject_all` with files whose content no snapshot captured (§32: a mods stub, a skipped unreadable file) among its
 * targets (docs/PROTOCOL.md §35.2, wave-2 follow-up): the revertible files are reverted and the uncaptured ones are
 * skipped — `result{ok:true, skipped:[{path, code:"not_captured"}]}` — instead of the whole batch being refused. Only a
 * reject_all with nothing revertible is still refused `not_captured`; `reject {paths}` is unchanged (an explicit choice).
 */

const BIG = MODS_MAX_BYTES + 1;

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-rskip"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, ".gitignore", ".claude/\n");
  write(dir, "README.md", "readme\n");
  write(dir, "b.txt", "b\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  write(dir, ".claude/agent-memory.log", "x".repeat(BIG));
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const edit = (dir: string, rel: string, id: string): ToolFileEntry => ({ path: join(dir, rel), tools: ["Edit"], count: 1, toolUseIds: [id] });
const bash = (dir: string, rel: string, id: string): ToolFileEntry => ({ path: join(dir, rel), tools: ["Bash"], count: 1, toolUseIds: [id] });

async function reviewing(mutate: (dir: string) => void, toolFiles: (dir: string) => ToolFileEntry[], before?: (dir: string) => void): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  before?.(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello();
  await h.open(dir);
  await h.engine.request({ type: "send", text: "work" });
  mutate(dir);
  h.session().emitTurnEnd({ toolFiles: toolFiles(dir) });
  await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");
  return { h, dir };
}

describe("reject_all skips the files it cannot put back (§35.2)", () => {
  it("reverts the revertible files and says which uncaptured ones it left (skipped); they stay pending, untouched", async () => {
    const { h, dir } = await reviewing(
      (d) => {
        write(d, "README.md", "readme changed\n");
        write(d, ".claude/agent-memory.log", "y".repeat(BIG + 10));
      },
      (d) => [edit(d, "README.md", "e1"), bash(d, ".claude/agent-memory.log", "b1")],
    );
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.uncaptured ?? false])).toEqual([
      [".claude/agent-memory.log", true],
      ["README.md", false],
    ]);
    const reply = await h.engine.request({ type: "reject_all" });
    expect(reply).toMatchObject({ type: "result", ok: true, skipped: [{ path: ".claude/agent-memory.log", code: "not_captured" }] });
    expect(read(dir, "README.md")).toBe("readme\n");
    expect(read(dir, ".claude/agent-memory.log")).toBe("y".repeat(BIG + 10));
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([[".claude/agent-memory.log", "pending"]]);
    expect(h.engine.state.gate.lastReviewSummary).toMatch(/Rejected .*README\.md/);
  });

  it("nothing revertible: still refused not_captured with the paths (nothing changes)", async () => {
    const { h, dir } = await reviewing((d) => write(d, ".claude/agent-memory.log", "y".repeat(BIG + 10)), (d) => [bash(d, ".claude/agent-memory.log", "b1")]);
    const e = await h.engine.request({ type: "reject_all" }).catch((x: unknown) => x);
    expect(String(e)).toMatch(/not_captured:\.claude\/agent-memory\.log/);
    expect(read(dir, ".claude/agent-memory.log")).toBe("y".repeat(BIG + 10));
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual([".claude/agent-memory.log"]);
  });

  it("a revertible file edited since the review still refuses the batch (file_changed_since_review), the uncaptured one is not among its paths", async () => {
    const { h, dir } = await reviewing(
      (d) => {
        write(d, "README.md", "readme changed\n");
        write(d, "b.txt", "b changed\n");
        write(d, ".claude/agent-memory.log", "y".repeat(BIG + 10));
      },
      (d) => [edit(d, "README.md", "e1"), edit(d, "b.txt", "e2"), bash(d, ".claude/agent-memory.log", "b1")],
    );
    write(dir, "b.txt", "b changed by the user afterwards\n");
    const e = (await h.engine.request({ type: "reject_all" }).catch((x: unknown) => x)) as Error;
    expect(e.message).toBe("file_changed_since_review:b.txt");
    expect(read(dir, "README.md")).toBe("readme changed\n");
    // Forced: both revertible files go back, the uncaptured one is skipped.
    const reply = await h.engine.request({ type: "reject_all", force: true });
    expect(reply).toMatchObject({ ok: true, skipped: [{ path: ".claude/agent-memory.log", code: "not_captured" }] });
    expect([read(dir, "README.md"), read(dir, "b.txt")]).toEqual(["readme\n", "b\n"]);
  });

  it("reject {paths} is unchanged: the revertible ones alone go back; naming an uncaptured file refuses the batch", async () => {
    const { h, dir } = await reviewing(
      (d) => {
        write(d, "README.md", "readme changed\n");
        write(d, ".claude/agent-memory.log", "y".repeat(BIG + 10));
      },
      (d) => [edit(d, "README.md", "e1"), bash(d, ".claude/agent-memory.log", "b1")],
    );
    const e = await h.engine.request({ type: "reject", paths: ["README.md", ".claude/agent-memory.log"] }).catch((x: unknown) => x);
    expect(String(e)).toMatch(/not_captured:\.claude\/agent-memory\.log/);
    expect(read(dir, "README.md")).toBe("readme changed\n");
    const reply = await h.engine.request({ type: "reject", paths: ["README.md"] });
    expect(reply).toEqual({ type: "result", id: expect.any(String), ok: true });
    expect(read(dir, "README.md")).toBe("readme\n");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file that became unreadable during the turn (§32.3) is skipped by reject_all too", async () => {
    let locked = "";
    const { h, dir } = await reviewing(
      (d) => {
        write(d, "README.md", "readme changed\n");
        locked = join(d, "cache", "state.txt");
        chmodSync(locked, 0o000);
      },
      (d) => [edit(d, "README.md", "e1"), bash(d, "cache/state.txt", "b1")],
      (d) => write(d, "cache/state.txt", "readable at the start\n"),
    );
    try {
      expect(h.engine.state.changedFiles.map((f) => [f.path, f.uncaptured ?? false])).toEqual([
        ["README.md", false],
        ["cache/state.txt", true],
      ]);
      const reply = await h.engine.request({ type: "reject_all" });
      expect(reply).toMatchObject({ ok: true, skipped: [{ path: "cache/state.txt", code: "not_captured" }] });
      expect(read(dir, "README.md")).toBe("readme\n");
    } finally {
      chmodSync(locked, 0o644);
    }
  });
});
