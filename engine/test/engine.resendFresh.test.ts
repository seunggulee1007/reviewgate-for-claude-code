import { mkdirSync, realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.5 (§30 × §16): the message a hung CLI never took is no sign that the CLI knows the chat. When the
 * init-timeout fallback restarts a brand-new chat to send its first message again, that chat is started fresh under its
 * own id — `--resume` of a conversation the CLI never had fails ("No conversation found"), which flagged the new chat
 * `resumeFailed`, moved the user to yet another empty chat with a "cleaned up after 30 days" notice and lost the message.
 */

const dirs: string[] = [];
const harnesses: Harness[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = tmp("rg-resend-repo");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "r\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

async function hungFirstMessage(): Promise<{ h: Harness; id: string }> {
  const config = tmp("rg-resend-home");
  mkdirSync(config, { recursive: true });
  const dir = makeRepo();
  const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: config } });
  harnesses.push(h);
  await h.hello({ loadUserSettings: true, extensionsInitTimeoutMs: 5000 });
  const id = (await h.open(dir)).sessions.currentId!;
  expect(h.session().opts.settings.sessionId).toBe(id);
  await h.engine.handle({ type: "send", text: "edit the readme" });
  // The CLI hangs in its initialize handshake: the message never ran (no output for it).
  h.session().emit({ type: "init_timeout", afterMs: 5000 });
  await h.waitFor((s) => h.sessions.length === 2 && s.session.open && !s.session.starting, "restarted");
  return { h, id };
}

describe("a message the hung CLI never took does not make its chat resumable (§35.5)", () => {
  it("the first message of a new chat: the fallback CLI starts fresh under the chat's id and gets the message", async () => {
    const { h, id } = await hungFirstMessage();
    const second = h.session();
    expect(second.opts.settings.loadUserSettings).toBe(false);
    expect(second.opts.settings.resumeSessionId).toBeUndefined();
    expect(second.opts.settings.sessionId).toBe(id);
    expect(second.sends.map((x) => x.text)).toEqual(["edit the readme"]);
    expect(h.engine.state.sessions.currentId).toBe(id);
    expect(h.engine.state.gate.phase).toBe("running");
  });

  it("…and when the hung CLI had recorded it after all, the fresh start's \"already in use\" resumes it and sends the message again (§30)", async () => {
    const { h, id } = await hungFirstMessage();
    const inUse = `Error: Session ID ${id} is already in use.`;
    h.session().emit({ type: "error", message: "Claude Code process exited with code 1", fatal: true, code: "session_id_in_use", detail: inUse, exitCode: 1, signal: null });
    h.session().emit({ type: "closed", code: 1 });
    await h.waitFor((s) => h.sessions.length === 3 && s.session.open && !s.session.starting, "resumed");
    expect(h.session().opts.settings.resumeSessionId).toBe(id);
    expect(h.session().sends.map((x) => x.text)).toEqual(["edit the readme"]);
    expect(h.engine.state.sessions.currentId).toBe(id);
    expect(h.engine.state.sessions.list.find((m) => m.id === id)?.resumeFailed).toBeUndefined();
    expect(h.ofType("error").filter((e) => e.code === "session_id_in_use" || e.code === "resume_not_found")).toEqual([]);
  });

  it("a chat the CLI already knows is still resumed by the fallback (its earlier turn)", async () => {
    const config = tmp("rg-resend-home2");
    mkdirSync(config, { recursive: true });
    const dir = makeRepo();
    const h = makeHarness({ env: { CLAUDE_CONFIG_DIR: config } });
    harnesses.push(h);
    await h.hello({ loadUserSettings: true, extensionsInitTimeoutMs: 5000 });
    const id = (await h.open(dir)).sessions.currentId!;
    await h.engine.handle({ type: "send", text: "hi" });
    h.session().emitTurnEnd({ sessionId: id });
    await h.waitFor((s) => s.hud.turnCount === 1 && s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn 1");
    await h.engine.handle({ type: "send", text: "and now?" });
    h.session().emit({ type: "init_timeout", afterMs: 5000 });
    await h.waitFor((s) => h.sessions.length === 2 && s.session.open && !s.session.starting, "restarted");
    expect(h.session().opts.settings.resumeSessionId).toBe(id);
    expect(h.session().sends.map((x) => x.text)).toEqual(["and now?"]);
  });
});
