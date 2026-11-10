import { describe, expect, it } from "vitest";
import type { EngineCommand, EngineEvent } from "@reviewgate/engine";
import { requestWithDetails, type EngineLike } from "./engineRequest.js";

/** A fake engine that answers like `ReviewEngine.reply`: reject / resolve first, then emit the `result`. */
function fakeEngine(answer: (cmd: EngineCommand) => EngineEvent): EngineLike & { listeners: number } {
  const listeners = new Set<(ev: EngineEvent) => void>();
  return {
    get listeners() {
      return listeners.size;
    },
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    request(cmd) {
      const ev = answer(cmd);
      return new Promise((resolve, reject) => {
        if (ev.type === "result" && !ev.ok) reject(new Error(ev.error));
        else resolve(ev as never);
        for (const l of listeners) l(ev);
      });
    },
  };
}

describe("requestWithDetails", () => {
  it("passes the code and paths of a refused result", async () => {
    const engine = fakeEngine(() => ({ type: "result", id: "1", ok: false, error: "file_changed_since_review:a.txt, b.txt", code: "file_changed_since_review", paths: ["a.txt", "b.txt"] }));
    const r = await requestWithDetails(engine, { type: "reject_all" });
    expect(r).toEqual({ __error: "file_changed_since_review:a.txt, b.txt", __code: "file_changed_since_review", __paths: ["a.txt", "b.txt"] });
    expect(engine.listeners).toBe(0);
  });

  it("passes the partial series of a commit_failed refusal", async () => {
    const partial = { commits: [{ sha: "abc1234567", shortSha: "abc1234", message: "a", files: ["a.ts"] }], branch: "main", pushed: false as const };
    const engine = fakeEngine(() => ({ type: "result", id: "1", ok: false, error: "commit_failed:hook failed", code: "commit_failed", partial }));
    expect(await requestWithDetails(engine, { type: "commit_series", commits: [] })).toEqual({ __error: "commit_failed:hook failed", __code: "commit_failed", __partial: partial });
  });

  it("works with an older engine that sends no code", async () => {
    const engine = fakeEngine(() => ({ type: "result", id: "1", ok: false, error: "session_running" }));
    expect(await requestWithDetails(engine, { type: "accept_all" })).toEqual({ __error: "session_running" });
  });

  it("resolves the reply on success", async () => {
    const engine = fakeEngine(() => ({ type: "result", id: "1", ok: true }));
    expect(await requestWithDetails(engine, { type: "accept_all" })).toEqual({ type: "result", id: "1", ok: true });
    expect(engine.listeners).toBe(0);
  });
});
