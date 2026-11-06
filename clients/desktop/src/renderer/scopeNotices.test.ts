import { beforeAll, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState, TranscriptItem } from "@reviewgate/engine";
import { errorEventText, presentationOf } from "./errorCodes";
import { initI18n } from "./i18n";
import { scopeFilesLine, scopeRowText } from "./scopeNotices";
import { errorKey, factsOf, pausesQueue, sessionActions, type ErrorRow } from "./sessionErrors";

/**
 * r1-scope — docs/PROTOCOL.md §33.4 / §39.5 in the desktop client: what a command changed outside this window's review is a
 * chat row (never a banner, never the last error) naming the files, with the folder's actions.
 */

describe("worktree_outside_review is a row with its files", () => {
  beforeAll(() => initI18n("en", "darwin"));

  it("a row, never a banner or a stopped queue; the sentence names the folder when the engine named the files", () => {
    expect(presentationOf("worktree_outside_review")).toBe("row");
    expect(pausesQueue({ fatal: false, code: "worktree_outside_review" })).toBe(false);
    const ev = { code: "worktree_outside_review", message: "Bash worked outside …", toolName: "Bash", path: "/work/acme-42", files: ["made.txt"] };
    expect(errorEventText(ev)).toBe("Changed where this window's review does not see it: /work/acme-42");
    expect(scopeRowText({ code: "worktree_outside_review", files: ["a"] })).toBe("Changed where this window's review does not see it");
    // Without files (an isolated agent, a worktree it made, an older engine) the §33.4 sentence stands.
    expect(errorEventText({ code: "worktree_outside_review", message: "x", path: "/work/acme-42" })).toBe("Claude worked where this window's review does not see it: /work/acme-42");
    expect(scopeRowText({ code: "worktree_blocked", files: ["a"] })).toBeNull();
  });

  it("the files ride on the row's facts and keep two rows naming other files apart", () => {
    const a = factsOf({ code: "worktree_outside_review", path: "/w", files: ["made.txt"] });
    const b = factsOf({ code: "worktree_outside_review", path: "/w", files: ["src/b.ts"] });
    expect(a.files).toEqual(["made.txt"]);
    expect(factsOf({ code: "worktree_outside_review", path: "/w", files: [] }).files).toBeUndefined();
    expect(errorKey("same sentence", a)).not.toBe(errorKey("same sentence", b));
    expect(errorKey("same sentence", a)).toBe(errorKey("same sentence", { ...a }));
    // The row's actions are the banner's were: move the chat / open the workbench, or open the folder.
    expect(sessionActions("worktree_outside_review", { count: 1, facts: a, isWorkbench: () => true })).toEqual(["moveChat", "openWorkbench"]);
    expect(sessionActions("worktree_outside_review", { count: 1, facts: a, isWorkbench: () => false })).toEqual(["openFolder"]);
  });

  it("the files line names the first eight and counts the rest", () => {
    expect(scopeFilesLine(undefined)).toBe("");
    expect(scopeFilesLine(["a.txt", "b/c.ts"])).toBe("a.txt, b/c.ts");
    expect(scopeFilesLine(Array.from({ length: 10 }, (_, i) => `f${i + 1}.txt`))).toBe("f1.txt, f2.txt, f3.txt, f4.txt, f5.txt, f6.txt, f7.txt, f8.txt and 2 more");
  });
});

// ---------------------------------------------------------------- the store (engine bridge mocked)

const sent: EngineCommand[] = [];

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }),
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

describe("the store", () => {
  beforeAll(() => initI18n("en", "darwin"));

  it("a worktree_outside_review event adds a row with the files — no banner, no last error; a restored one reads the same", async () => {
    const useStore = await loadStore();
    const s = useStore.getState().state;
    useStore.setState({
      state: { ...s, seq: s.seq + 1, project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null } } as ReviewState,
      transcript: [],
      errorBanner: null,
      lastError: null,
    });
    useStore.getState().handleEvent({ type: "error", message: "Bash worked outside … Changed: made.txt", fatal: false, scope: "session", code: "worktree_outside_review", toolName: "Bash", path: "/work/acme-42", files: ["made.txt"] });
    useStore.getState().handleEvent({ type: "error", message: "Bash worked outside … Changed: src/b.ts", fatal: false, scope: "session", code: "worktree_outside_review", toolName: "Bash", path: "/work/acme-42", files: ["src/b.ts"] });
    const rows = useStore.getState().transcript.filter((i): i is ErrorRow => i.kind === "error");
    expect(rows.map((r) => r.facts?.files)).toEqual([["made.txt"], ["src/b.ts"]]);
    expect(rows[0]!.message).toBe("Changed where this window's review does not see it: /work/acme-42");
    expect(useStore.getState().errorBanner).toBeNull();
    expect(useStore.getState().lastError).toBeNull();

    const items: TranscriptItem[] = [
      { at: "2026-11-06T01:00:00Z", turn: 1, kind: "user_message", text: "go" },
      { at: "2026-11-06T01:00:05Z", turn: 1, kind: "error", message: "Bash worked outside this window's review (/work/acme-42): … Changed: made.txt", fatal: false, scope: "session", code: "worktree_outside_review", toolName: "Bash", path: "/work/acme-42", files: ["made.txt"] },
    ];
    useStore.setState({ transcript: [] });
    useStore.getState().handleEvent({ type: "transcript_restore", items });
    const restored = useStore.getState().transcript.filter((i): i is ErrorRow => i.kind === "error");
    expect(restored).toHaveLength(1);
    expect(restored[0]!.facts).toMatchObject({ code: "worktree_outside_review", path: "/work/acme-42", files: ["made.txt"] });
  });
});
