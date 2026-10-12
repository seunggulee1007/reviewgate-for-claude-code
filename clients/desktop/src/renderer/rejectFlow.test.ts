import { describe, expect, it } from "vitest";
import type { EngineCommand } from "@reviewgate/engine";
import { EngineRefusal, engineRequest, refusalOf } from "./engineRequest";
import { changedPathsOf, runReject, type RejectCommand } from "./rejectFlow";

const edited = () => new EngineRefusal("file_changed_since_review:a.txt, b.txt", "file_changed_since_review", ["a.txt", "b.txt"]);

/** Records every command; the first `refuseFirst` sends reject with `firstError`, the rest succeed (or `forceError`). */
function harness(opts: { firstError?: unknown; forceError?: unknown; confirm: boolean }) {
  const sent: (RejectCommand & { force?: true })[] = [];
  const asked: string[][] = [];
  const deps = {
    request: async (cmd: RejectCommand & { force?: true }) => {
      sent.push(cmd);
      if (cmd.force && opts.forceError) throw opts.forceError;
      if (!cmd.force && opts.firstError) throw opts.firstError;
    },
    confirmOverwrite: async (paths: string[]) => {
      asked.push(paths);
      return opts.confirm;
    },
  };
  return { sent, asked, deps };
}

describe("whole-file reject safety (docs/PROTOCOL.md §19.1)", () => {
  it("a reject that goes through asks nothing", async () => {
    const h = harness({ confirm: true });
    expect(await runReject({ type: "reject", paths: ["a.txt"] }, h.deps)).toEqual({ kind: "done", forced: false });
    expect(h.sent).toEqual([{ type: "reject", paths: ["a.txt"] }]);
    expect(h.asked).toEqual([]);
  });

  it("file_changed_since_review → confirm listing the paths → resend with force", async () => {
    const h = harness({ firstError: edited(), confirm: true });
    expect(await runReject({ type: "reject_all" }, h.deps)).toEqual({ kind: "done", forced: true });
    expect(h.asked).toEqual([["a.txt", "b.txt"]]);
    expect(h.sent).toEqual([{ type: "reject_all" }, { type: "reject_all", force: true }]);
  });

  it("cancel sends nothing more", async () => {
    const h = harness({ firstError: edited(), confirm: false });
    expect(await runReject({ type: "reject", paths: ["a.txt", "b.txt"] }, h.deps)).toEqual({ kind: "cancelled", paths: ["a.txt", "b.txt"] });
    expect(h.sent).toEqual([{ type: "reject", paths: ["a.txt", "b.txt"] }]);
  });

  it("other refusals are handed back without a confirm", async () => {
    const err = new EngineRefusal("session_running", "session_running");
    const h = harness({ firstError: err, confirm: true });
    expect(await runReject({ type: "reject_all" }, h.deps)).toEqual({ kind: "refused", error: err });
    expect(h.asked).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });

  it("a failing forced resend is reported", async () => {
    const again = new EngineRefusal("revert_failed:git checkout failed", "revert_failed");
    const h = harness({ firstError: edited(), forceError: again, confirm: true });
    expect(await runReject({ type: "reject_all" }, h.deps)).toEqual({ kind: "refused", error: again });
  });

  it("reads the paths from the error text when an older bridge drops `paths`", () => {
    expect(changedPathsOf(new Error("file_changed_since_review:x/a.ts, y.ts"))).toEqual(["x/a.ts", "y.ts"]);
    expect(changedPathsOf(new Error("session_running"))).toBeNull();
  });

  it("engineRequest carries code and paths from the bridge", async () => {
    const bridge = {
      request: async () => {
        throw new Error("unused");
      },
      requestDetailed: async (_cmd: EngineCommand) => ({ ok: false as const, error: "file_changed_since_review:a.txt", code: "file_changed_since_review", paths: ["a.txt"] }),
    };
    const err = await engineRequest({ type: "reject_all" }, bridge as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRefusal);
    expect(refusalOf(err)).toEqual({ code: "file_changed_since_review", error: "file_changed_since_review:a.txt", detail: "a.txt", paths: ["a.txt"] });
    // A bridge without requestDetailed (older preload / e2e stub): plain request, code from the leading word.
    const plain = await engineRequest({ type: "reject_all" }, { request: async () => Promise.reject(new Error("reverting")) } as never).catch((e: unknown) => e);
    expect(refusalOf(plain).code).toBe("reverting");
  });
});

// MARK: wave1 desktop-review
describe("outside changes are never reverted without a second confirm (docs/PROTOCOL.md §31.2)", () => {
  const withExternal = (h: ReturnType<typeof harness>, answer: boolean) => {
    const asked: string[][] = [];
    const deps = {
      ...h.deps,
      confirmExternal: async (paths: string[]) => {
        asked.push(paths);
        return answer;
      },
    };
    return { asked, deps };
  };

  it("“앱 밖 변경도 되돌리기”: the outside files are listed first, then reject_all{includeExternal} goes out", async () => {
    const h = harness({ confirm: true });
    const x = withExternal(h, true);
    expect(await runReject({ type: "reject_all", includeExternal: true }, x.deps, ["ide/Mine.java", "pulled.txt"])).toEqual({ kind: "done", forced: false });
    expect(x.asked).toEqual([["ide/Mine.java", "pulled.txt"]]);
    expect(h.sent).toEqual([{ type: "reject_all", includeExternal: true }]);
  });

  it("declining the second confirm sends nothing at all", async () => {
    const h = harness({ confirm: true });
    const x = withExternal(h, false);
    expect(await runReject({ type: "reject_all", includeExternal: true }, x.deps, ["ide/Mine.java"])).toEqual({ kind: "keptExternal", paths: ["ide/Mine.java"] });
    expect(h.sent).toEqual([]);
  });

  it("a caller without the confirm never reverts outside files silently", async () => {
    const h = harness({ confirm: true });
    expect(await runReject({ type: "reject", paths: ["ide/Mine.java"] }, h.deps, ["ide/Mine.java"])).toEqual({ kind: "keptExternal", paths: ["ide/Mine.java"] });
    expect(h.sent).toEqual([]);
  });

  it("plain “모두 되돌리기” (Claude's changes only) asks nothing extra", async () => {
    const h = harness({ confirm: true });
    const x = withExternal(h, true);
    expect(await runReject({ type: "reject_all" }, x.deps)).toEqual({ kind: "done", forced: false });
    expect(x.asked).toEqual([]);
    expect(h.sent).toEqual([{ type: "reject_all" }]);
  });

  it("a single outside file: confirmed, then reject{paths}", async () => {
    const h = harness({ confirm: true });
    const x = withExternal(h, true);
    expect(await runReject({ type: "reject", paths: ["ide/Mine.java"] }, x.deps, ["ide/Mine.java"])).toEqual({ kind: "done", forced: false });
    expect(h.sent).toEqual([{ type: "reject", paths: ["ide/Mine.java"] }]);
  });

  it("the §19.1 forced resend keeps includeExternal", async () => {
    const h = harness({ firstError: edited(), confirm: true });
    const x = withExternal(h, true);
    expect(await runReject({ type: "reject_all", includeExternal: true }, x.deps, ["a.txt"])).toEqual({ kind: "done", forced: true });
    expect(h.sent).toEqual([
      { type: "reject_all", includeExternal: true },
      { type: "reject_all", includeExternal: true, force: true },
    ]);
  });
});
