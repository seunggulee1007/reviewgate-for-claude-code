import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRefused } from "../src/errors.js";
import type { PermissionMode } from "../src/protocol.js";
import { sessionTranscriptPath } from "../src/review/sessions.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §39.5 (wave4b w4b-auto), engine part: the auto-mode notices are rows; a refused switch has its code. */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-automode"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const rowsOf = (dir: string, id: string) =>
  readFileSync(sessionTranscriptPath(join(dir, ".git"), id), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("ReviewEngine in auto mode (§39.5)", () => {
  it("what the classifier blocked and an unavailable auto mode are chat rows: no state.lastError, the queue is not stopped", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = harness();
    await h.hello({ permissionMode: "auto" });
    await h.open(dir);
    await h.engine.request({ type: "send", text: "build it" });
    h.session().emit({ type: "error", message: "Auto mode blocked: mvn -v — [Security Weaken]", fatal: false, code: "auto_mode_denied", toolName: "Bash", detail: "mvn -v — [Security Weaken]" });
    h.session().emit({ type: "error", message: "Auto mode is not available here", fatal: false, code: "auto_mode_unavailable", detail: "default" });
    h.session().emitTurnEnd();
    const s = await h.waitFor((x) => x.gate.phase === "idle" || x.gate.phase === "reviewing", "turn collected");
    await h.settle();
    expect(s.lastError).toBeNull();
    expect(h.ofType("error").map((e) => [e.code, e.scope, e.fatal])).toEqual([
      ["auto_mode_denied", "session", false],
      ["auto_mode_unavailable", "session", false],
    ]);
    const rows = rowsOf(dir, s.sessions.currentId!).filter((r) => r.kind === "error");
    expect(rows).toEqual([
      expect.objectContaining({ code: "auto_mode_denied", toolName: "Bash", detail: "mvn -v — [Security Weaken]", fatal: false, scope: "session" }),
      expect.objectContaining({ code: "auto_mode_unavailable", detail: "default" }),
    ]);
  });

  it("set_permission_mode auto that the CLI refuses for the model → auto_mode_unavailable, the mode stays", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const h = harness();
    await h.hello();
    await h.open(dir);
    const session = h.session() as unknown as { setPermissionMode(mode: PermissionMode): Promise<void> };
    session.setPermissionMode = async () => {
      throw new CommandRefused("auto_mode_unavailable: Cannot set permission mode to auto: auto mode unavailable for this model");
    };
    await expect(h.engine.request({ type: "set_permission_mode", mode: "auto" })).rejects.toThrow("auto_mode_unavailable");
    const s = await h.waitFor(() => true, "state");
    expect(s.session.permissionMode).toBe("default");
    const refusal = h.ofType("result").find((r) => !r.ok);
    expect(refusal).toMatchObject({ ok: false, code: "auto_mode_unavailable" });
  });
});
