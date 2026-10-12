import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.9 (§31): a file of a restored review that changed while the app was closed — the user went on in
 * IntelliJ — holds Claude's change *and* the user's. Live, such an edit refuses `reject` / `reject_all` with
 * `file_changed_since_review` (its content is not what was reviewed); after a restart the restored review compared the
 * disk with a fresh snapshot instead, so "Reject all" — "only Claude's changes" — silently reverted the user's work too.
 * The restored review now compares those files with the B it was saved with.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-restedit"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "a\n");
  write(dir, "b.txt", "b\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}

/** Claude edits a.txt and b.txt; the review is left pending and the app quits. */
async function leftPending(dir: string): Promise<void> {
  const h = harness();
  await h.hello();
  await h.open(dir);
  await h.engine.handle({ type: "send", text: "edit a and b" });
  write(dir, "a.txt", "a by claude\n");
  write(dir, "b.txt", "b by claude\n");
  h.session().emitTurnEnd({
    toolFiles: [
      { path: join(dir, "a.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] },
      { path: join(dir, "b.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e2"] },
    ],
  });
  await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");
  await h.engine.dispose();
}

async function restored(dir: string): Promise<Harness> {
  const h = harness();
  await h.hello();
  const s = await h.open(dir);
  expect(s.gate.restored).toBe(true);
  return h;
}

describe("a restored review keeps the user's edits made while the app was closed (§35.9)", () => {
  it("reject_all refuses file_changed_since_review for such a file (nothing reverted); force reverts; untouched files go back as before", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    await leftPending(dir);
    write(dir, "a.txt", "a by claude\nand the user's own line from IntelliJ\n");
    const h = await restored(dir);
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state, f.origin])).toEqual([
      ["a.txt", "pending", "tool"],
      ["b.txt", "pending", "tool"],
    ]);

    const e = (await h.engine.request({ type: "reject_all" }).catch((x: unknown) => x)) as Error;
    expect(e.message).toBe("file_changed_since_review:a.txt");
    expect([read(dir, "a.txt"), read(dir, "b.txt")]).toEqual(["a by claude\nand the user's own line from IntelliJ\n", "b by claude\n"]);

    // A file nobody touched since goes back as before.
    await h.engine.request({ type: "reject", paths: ["b.txt"] });
    expect(read(dir, "b.txt")).toBe("b\n");
    // The user chooses to overwrite their own edit.
    await h.engine.request({ type: "reject", paths: ["a.txt"], force: true });
    expect(read(dir, "a.txt")).toBe("a\n");
    expect(h.engine.state.changedFiles).toEqual([]);
  });

  it("a refresh takes the user's edit into the review (as live): reject then reverts what the refreshed diff shows", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    await leftPending(dir);
    write(dir, "a.txt", "a by claude\nuser line\n");
    const h = await restored(dir);
    await h.engine.request({ type: "refresh", scope: ["review"] });
    await h.engine.request({ type: "reject_all" });
    expect([read(dir, "a.txt"), read(dir, "b.txt")]).toEqual(["a\n", "b\n"]);
  });
});
