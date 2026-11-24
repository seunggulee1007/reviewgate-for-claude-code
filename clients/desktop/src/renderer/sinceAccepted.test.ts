/**
 * accept-baseline — docs/PROTOCOL.md §66 on Windows: a file reviewed since its accept shows the since-accepted status
 * letter and "수락 이후 변경", offers "수락 이후 / 라운드 전체" (수락 이후 first and by default), reject's words say the
 * accepted content comes back, "라운드 시작으로 되돌리기" sends `reject {to: "round"}` (never during a turn), parts are
 * reverted in the since-accepted view against the accepted tree, and the folded group counts the engine's number.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AcceptedBase, ChangedFileState, EngineCommand, FileDiff, GateState, ReviewState } from "@reviewgate/engine";
import { initI18n, t } from "./i18n";
import { availableRanges, defaultRange } from "./reviewRound";
import {
  acceptedGroupCount,
  badgeStatus,
  hunkRejectBase,
  hunkStatus,
  offersRoundReject,
  roundRejectBlocked,
  roundRejectMessage,
  roundRejectTitle,
  sinceAcceptedLabel,
  sinceAcceptedRejectHelp,
  wholeRoundLabel,
} from "./sinceAccepted";

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return respond(c);
      },
      setSettings: async (patch: Record<string, unknown>) => ({ appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400, ...patch }),
      getSettings: async () => ({ appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400 }),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
      sep: "/",
    },
  };
  return (await import("./store")).useStore;
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const base = (p: Partial<AcceptedBase> = {}): AcceptedBase => ({ blob: "acc", tree: "ACC1", at: "2026-01-02T03:04:05.000Z", turn: 2, status: "M", roundAdded: 12, roundDeleted: 0, ...p });

/** Claude created it, the user accepted it, a later turn edited it: the round says `A`, the accept `M`. */
const file = (path: string, p: Partial<ChangedFileState> = {}): ChangedFileState => ({
  path,
  oldPath: null,
  status: "A",
  added: 2,
  deleted: 1,
  isBinary: false,
  tools: ["Edit"],
  toolUseIds: ["toolu_" + path],
  state: "pending",
  noteCount: 0,
  origin: "tool",
  blob: "b-" + path,
  changedSinceAccepted: true,
  acceptedBase: base(),
  ...p,
});

const gate = (p: Partial<GateState> = {}): GateState => ({
  phase: "reviewing",
  canSend: true,
  canRequestChanges: false,
  blockedReason: null,
  collectError: null,
  pendingCount: 1,
  changesRequestedCount: 0,
  isRequestingChanges: false,
  turnStartTree: "A",
  turnEndTree: "B1",
  reviewEndTree: "B1",
  lastReviewSummary: null,
  changedOutside: [],
  ignoredTouched: [],
  filteredByPattern: [],
  restored: false,
  reviewSummary: { files: 1, added: 2, deleted: 1 },
  externalPendingCount: 0,
  ...p,
});

/** Two hunks; the added line says which range the diff was asked in. */
const diffOf = (path: string, text: string): FileDiff => ({
  oldPath: path,
  newPath: path,
  isBinary: false,
  hunks: [0, 1].map((id) => ({
    id,
    header: `@@ -${id + 1} +${id + 1} @@`,
    lines: [
      { id: id * 2, kind: "hunkHeader" as const, oldNo: null, newNo: null, text: `@@ -${id + 1} +${id + 1} @@` },
      { id: id * 2 + 1, kind: "add" as const, oldNo: null, newNo: id + 1, text },
    ],
  })),
});

const diffReplies = (cmd: EngineCommand): Reply => {
  if (cmd.type === "select_file") {
    const since = cmd.since ?? "accepted";
    return { ok: true, reply: { type: "file_diff", scope: "turn", path: cmd.path, diff: diffOf(cmd.path, `${cmd.path}@${since}`), truncated: false, endTree: "B1", baseTree: since === "accepted" ? "ACC1" : "A", since } };
  }
  return { ok: true, reply: { type: "result", ok: true } };
};

let seq = 5000;

describe("§66 since accepted (accept-baseline, Windows)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = diffReplies;
  });

  it("shows the change since the accept: its letter, its label, 수락 이후 first and 라운드 전체", () => {
    const f = file("new.ts");
    expect(badgeStatus(f)).toBe("M");
    expect(badgeStatus(file("gone.ts", { status: "M", acceptedBase: base({ status: "D" }) }))).toBe("D");
    expect(badgeStatus(file("old.ts", { acceptedBase: undefined }))).toBe("A"); // an older engine: the round's
    expect(sinceAcceptedLabel()).toBe("수락 이후 변경");
    expect(availableRanges(f, {})).toEqual(["accepted", "review"]);
    expect(defaultRange(f, {})).toBe("accepted");
    expect(wholeRoundLabel(f, "review")).toBe("라운드 전체");
    expect(wholeRoundLabel(f, "accepted")).toBeNull();
    // An older engine (changedSinceAccepted, no base): as before — 전체 first, its usual label.
    const older = file("b.ts", { acceptedBase: undefined });
    expect(availableRanges(older, {})).toEqual(["review", "accepted"]);
    expect(wholeRoundLabel(older, "review")).toBeNull();
  });

  it("parts are reverted in the since-accepted view, judged by the change since the accept, against the accepted tree", () => {
    const f = file("new.ts");
    expect(hunkRejectBase(f, "accepted", "ACC1")).toEqual({ base: "ACC1" });
    expect(hunkRejectBase(f, undefined, "A")).toEqual({ base: "A" });
    expect(hunkRejectBase(f, "turn", "T")).toBeNull();
    expect(hunkRejectBase(file("b.ts", { acceptedBase: undefined }), "accepted", "T")).toBeNull();
    expect(hunkStatus(f, "accepted")).toBe("M");
    expect(hunkStatus(f, undefined)).toBe("A");
  });

  it("reject's words: the accepted content comes back; the way to the round's start is offered apart and waits for the turn", () => {
    const f = file("src/new.ts");
    expect(sinceAcceptedRejectHelp(f)).toBe("수락한 내용으로 되돌려요 (⌘⇧R)");
    expect(sinceAcceptedRejectHelp(file("b.ts", { acceptedBase: undefined }))).toBeNull();
    expect(offersRoundReject(f)).toBe(true);
    expect(offersRoundReject(file("b.ts", { acceptedBase: undefined }))).toBe(false);
    expect(offersRoundReject(file("c.ts", { state: "changesRequested" }))).toBe(false);
    expect(roundRejectTitle("src/new.ts")).toBe("new.ts을(를) 라운드 시작으로 되돌릴까요?");
    // A file this round created is deleted by the way back; another goes back to the round's start.
    expect(roundRejectMessage(f)).toContain("삭제돼요");
    expect(roundRejectMessage(file("m.ts", { status: "M" }))).not.toContain("삭제");
    expect(roundRejectBlocked(f, { phase: "reviewing" }, null)).toBeNull();
    expect(roundRejectBlocked(f, { phase: "running" }, null)).toBe(t("Reject is available when this turn ends"));
    expect(roundRejectBlocked(f, { phase: "reviewing" }, "busy")).toBe("busy");
    expect(roundRejectBlocked(file("u.ts", { uncaptured: true }), { phase: "reviewing" }, null)).not.toBeNull();
  });

  it("the folded group counts the engine's accepted-uncommitted, else the client's own", () => {
    expect(acceptedGroupCount(gate({ reviewSummary: { files: 4, added: 1, deleted: 0, acceptedUncommitted: 3 } }), 2)).toBe(3);
    expect(acceptedGroupCount(gate(), 2)).toBe(2);
    expect(acceptedGroupCount({}, 1)).toBe(1);
  });

  it("through the store: the default view's hunks go with the accepted tree; Reject leaves `to` to the engine; the round asks by name", async () => {
    const useStore = await loadStore();
    const s = useStore.getState().state;
    useStore.setState({ selectedPath: null, selectedDiff: null, diffCache: {}, viewedPaths: {}, tab: "changes", errorBanner: null });
    const f = file("new.ts");
    useStore.getState().handleEvent({
      type: "state",
      state: { ...s, seq: ++seq, changedFiles: [f, file("b.ts", { status: "M" })], gate: gate({ pendingCount: 2 }), project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null } } as ReviewState,
    });
    await flush();
    expect(useStore.getState().selectedPath).toBe("new.ts");
    expect(useStore.getState().diffSince).toBe("accepted");
    expect(sent.find((c) => c.type === "select_file")).toEqual({ type: "select_file", path: "new.ts", since: "accepted" });

    sent.length = 0;
    expect(await useStore.getState().rejectHunks("new.ts", [1])).toBeNull();
    expect(sent.find((c) => c.type === "reject_hunks")).toEqual({ type: "reject_hunks", path: "new.ts", hunks: [1], expectedEndTree: "B1", expectedBaseTree: "ACC1" });

    sent.length = 0;
    useStore.getState().reject("b.ts");
    await flush();
    expect(sent.find((c) => c.type === "reject")).toEqual({ type: "reject", paths: ["b.ts"] });
    sent.length = 0;
    useStore.getState().reject("new.ts", "round");
    await flush();
    expect(sent.find((c) => c.type === "reject")).toEqual({ type: "reject", paths: ["new.ts"], to: "round" });

    // Not while a turn runs (a reject scheduled then always restores the accepted content).
    sent.length = 0;
    useStore.getState().handleEvent({
      type: "state",
      state: { ...useStore.getState().state, seq: ++seq, changedFiles: [f], gate: gate({ phase: "running", canSend: false, blockedReason: "running", turnEndTree: null }) } as ReviewState,
    });
    useStore.getState().reject("new.ts", "round");
    await flush();
    expect(sent.filter((c) => c.type === "reject")).toEqual([]);
  });
});
