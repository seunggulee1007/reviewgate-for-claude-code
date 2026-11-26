import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession } from "../src/session/claude.js";
import { thinkingAlwaysOn } from "../src/statusline/input.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §70.4: Alt+T — extended thinking on or off for the chat. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-thinking"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "a.txt", "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

describe("§70.4 the models that always think", () => {
  it("Opus / Sonnet / Haiku 5.5 and the Fable models; not the others", () => {
    for (const id of ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5-5-20261001", "claude-haiku-5-5", "claude-fable", "claude-fable-1"]) {
      expect(thinkingAlwaysOn(id), id).toBe(true);
    }
    for (const id of ["claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-5-50", "opus", "", "claude-fabled"]) {
      expect(thinkingAlwaysOn(id), id).toBe(false);
    }
  });
});

describe("§70.4 set_thinking", () => {
  it("turns thinking off for the chat, live and at the next start; a new chat starts with it on", async () => {
    const root = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await expect(h.engine.request({ type: "set_thinking", enabled: false })).rejects.toThrow("no_project");
    await h.open(root);
    expect(h.engine.state.session.thinking).toEqual({ enabled: true, alwaysOn: false });
    expect(h.session().opts.settings.thinking).toBeUndefined();
    await expect(h.engine.request({ type: "set_thinking", enabled: "no" as unknown as boolean })).rejects.toThrow("invalid_thinking");

    await h.engine.request({ type: "set_thinking", enabled: false });
    expect(h.session().thinkings).toEqual([false]);
    expect(h.engine.state.session.thinking?.enabled).toBe(false);
    const first = h.engine.state.sessions.currentId!;
    expect(h.engine.state.sessions.list.find((m) => m.id === first)?.thinkingOff).toBe(true);

    // A restart (the CLI starts again) keeps it off.
    await h.engine.request({ type: "restart_session" });
    await h.waitFor((s) => s.session.open && !s.session.starting && h.sessions.length === 2, "restarted");
    expect(h.session().opts.settings.thinking).toBe(false);

    await h.engine.request({ type: "session_new" });
    await h.waitFor((s) => s.sessions.currentId !== first && s.session.open && !s.session.starting, "new chat");
    expect(h.engine.state.session.thinking?.enabled).toBe(true);
    expect(h.session().opts.settings.thinking).toBeUndefined();

    await h.engine.request({ type: "session_open", sessionId: first });
    await h.waitFor((s) => s.sessions.currentId === first && s.session.open && !s.session.starting, "back");
    expect(h.engine.state.session.thinking?.enabled).toBe(false);
    await h.engine.request({ type: "set_thinking", enabled: true });
    expect(h.session().thinkings).toEqual([true]);
    expect(h.engine.state.sessions.list.find((m) => m.id === first)?.thinkingOff).toBeUndefined();
  });

  it("is allowed while a turn runs, and says when the model thinks anyway", async () => {
    const root = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(root);
    await h.engine.request({ type: "set_model", model: "claude-opus-5-5" });
    expect(h.engine.state.session.thinking).toEqual({ enabled: true, alwaysOn: true });
    await h.engine.request({ type: "send", text: "work" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    await h.engine.request({ type: "set_thinking", enabled: false });
    expect(h.session().thinkings).toEqual([false]);
    expect(h.engine.state.session.thinking).toEqual({ enabled: false, alwaysOn: true });
  });
});

describe("§70.4 the session takes it", () => {
  it("starts with the SDK's thinking disabled, and toggles through setMaxThinkingTokens", async () => {
    let options: Options | undefined;
    const tokens: (number | null)[] = [];
    const queryFn = (args: { options?: Options }): Query => {
      options = args.options;
      return {
        next: () => new Promise(() => {}),
        return: async () => ({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return this;
        },
        initializationResult: () => new Promise(() => {}),
        setMaxThinkingTokens: async (n: number | null) => {
          tokens.push(n);
        },
      } as unknown as Query;
    };
    const s = new ClaudeSession({
      cwd: makeRepo(),
      settings: { budget: { maxFiles: 0, maxLines: 0 }, ignorePatterns: [], autoAllowTools: [], loadUserSettings: false, systemPromptAppend: "", thinking: false },
      claudePath: "/nonexistent/claude",
      env: {},
      platform: { killTree: async () => undefined, isWindows: false } as never,
      emit: () => {},
      log: () => {},
      queryFn: queryFn as never,
    });
    await s.start();
    expect(options?.thinking).toEqual({ type: "disabled" });
    await s.setThinking(true);
    await s.setThinking(false);
    expect(tokens).toEqual([null, 0]);
    await s.dispose();
  });
});
