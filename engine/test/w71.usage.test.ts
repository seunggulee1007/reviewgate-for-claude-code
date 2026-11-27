import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §71.1: `/usage` — the Session block the terminal shows (`hud.sessionTotals`). */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-usage"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "a.txt", "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

describe("§71.1 hud.sessionTotals", () => {
  it("the CLI's start, its API time and the lines the collected turns changed; a new chat starts again", async () => {
    const repo = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(repo);
    const first = h.engine.state.hud.sessionTotals!;
    expect(first.startedAt).toEqual(expect.any(Number));
    expect(first).toMatchObject({ apiDurationMs: 0, linesAdded: 0, linesRemoved: 0 });

    await h.engine.request({ type: "send", text: "write b" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    const s = h.session();
    (s as unknown as { statusUsage?: unknown }).statusUsage = { usage: null, model: null, apiDurationMs: 4200 };
    s.emit({ type: "tool_use", id: "w1", name: "Write", input: { file_path: join(repo, "b.txt") }, file: join(repo, "b.txt") });
    write(repo, "b.txt", "one\ntwo\nthree\n");
    s.emit({ type: "tool_result", toolUseId: "w1", isError: false, preview: "ok" });
    s.emitTurnEnd({ toolFiles: [{ path: join(repo, "b.txt"), tools: ["Write"], count: 1, toolUseIds: ["w1"] }] });
    await h.waitFor((st) => st.gate.phase === "reviewing", "reviewing");
    await h.settle();
    expect(h.engine.state.hud.sessionTotals).toMatchObject({ startedAt: first.startedAt, apiDurationMs: 4200, linesAdded: 3, linesRemoved: 0 });

    await h.engine.request({ type: "session_new" });
    await h.waitFor((st) => st.session.open && !st.session.starting && h.sessions.length === 2, "new chat");
    expect(h.engine.state.hud.sessionTotals).toMatchObject({ linesAdded: 0, linesRemoved: 0 });
  });
});
