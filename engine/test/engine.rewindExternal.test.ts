import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RewoundKeptEvent } from "../src/protocol.js";
import type { ToolFileEntry } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.11 (§26 × §31): a file rewind restores *Claude's* changes from a turn on. A file nothing of Claude's
 * explains in those turns — the user's IntelliJ save while Claude worked, another session's write (origin `external`) —
 * was in the turn's diff all the same and went back to the turn's start: the user's work was lost. Such files are now left
 * as they are (like "Reject all", §31.2) and listed in `rewound.keptFiles`.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-rewext"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "a\n");
  write(dir, "u.txt", "u\n");
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

let seq = 0;
/** One collected turn: `mutate` writes the worktree; `claude` = the repo-relative files Claude's Edit calls wrote. */
async function turn(h: Harness, dir: string, text: string, mutate: () => void, claude: string[]): Promise<void> {
  const before = h.engine.state.hud.turnCount;
  await h.engine.handle({ type: "send", text });
  const s = h.session();
  const id = s.opts.settings.resumeSessionId ?? s.opts.settings.sessionId!;
  s.emitSessionInfo({ sessionId: id });
  mutate();
  const toolFiles: ToolFileEntry[] = claude.map((rel) => ({ path: join(dir, rel), tools: ["Edit"], count: 1, toolUseIds: [`e${++seq}`] }));
  s.emitTurnEnd({ sessionId: id, lastUuid: `uuid-${seq}`, toolFiles });
  await h.waitFor((st) => st.hud.turnCount > before && st.gate.phase !== "running" && st.gate.phase !== "collecting", "turn collected");
  await h.settle();
}

describe("a file rewind leaves the changes nothing of Claude's explains (§35.11)", () => {
  it("the user's save during the rewound turn stays; Claude's edit goes back; rewound.keptFiles names it", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await turn(h, dir, "edit a", () => {
      write(dir, "a.txt", "a by claude\n");
      write(dir, "u.txt", "u saved in IntelliJ while Claude worked\n");
    }, ["a.txt"]);
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.origin])).toEqual([["a.txt", "tool"], ["u.txt", "external"]]);

    const r = await h.engine.request({ type: "rewind", toTurn: 1, mode: "files" });
    expect(r).toMatchObject({ type: "rewound", toTurn: 1, mode: "files", restoredFiles: ["a.txt"], keptFiles: ["u.txt"] });
    expect(read(dir, "a.txt")).toBe("a\n");
    expect(read(dir, "u.txt")).toBe("u saved in IntelliJ while Claude worked\n");
  });

  it("a file Claude changed in a later turn of the range is Claude's: it goes back too", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await turn(h, dir, "edit a", () => {
      write(dir, "a.txt", "a by claude\n");
      write(dir, "u.txt", "u by the user\n");
    }, ["a.txt"]);
    await h.engine.request({ type: "accept_all" });
    await turn(h, dir, "now u", () => write(dir, "u.txt", "u by the user\nand claude\n"), ["u.txt"]);
    const r: RewoundKeptEvent = await h.engine.request({ type: "rewind", toTurn: 1, mode: "files" });
    expect(r.restoredFiles).toEqual(["a.txt", "u.txt"]);
    expect(r.keptFiles ?? []).toEqual([]);
    expect([read(dir, "a.txt"), read(dir, "u.txt")]).toEqual(["a\n", "u\n"]);
  });
});
