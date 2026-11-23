import { afterAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { foldHandled, handledDetail, handledOutcome, handledSummary, MIN_CARDS } from "./handledCards";

// §56.6: decided permission cards and questions one after another fold into one line (the Mac's HandledCardFoldTests).

type Row = { id: number; kind: string; request?: { toolName: string }; allowed?: boolean | null; open?: boolean };
const perm = (id: number, allowed: boolean | null, open = false): Row => ({ id, kind: "permission", request: { toolName: "Bash" }, allowed, open });
const question = (id: number, allowed: boolean | null, open = false): Row => ({ id, kind: "permission", request: { toolName: "AskUserQuestion" }, allowed, open });
const text = (id: number): Row => ({ id, kind: "assistant" });
const fold = (rows: Row[]) => foldHandled(rows, (r) => r.id, (r) => handledOutcome(r, r.open ?? false));
const shape = (rows: Row[]) => fold(rows).map((p) => (p.kind === "handled" ? `run${p.id}:${p.entries.map((e) => e.id).join(",")}` : String(p.entry.id)));

describe("decided cards in the transcript", () => {
  afterAll(() => initI18n("en", "darwin"));

  it("folds two or more decided cards in a row, and nothing else", () => {
    expect(MIN_CARDS).toBe(2);
    expect(shape([text(1), perm(2, true), perm(3, false), question(4, false), text(5)])).toEqual(["1", "run2:2,3,4", "5"]);
    // One decided card alone stays a line of its own.
    expect(shape([perm(1, true), text(2), perm(3, false)])).toEqual(["1", "2", "3"]);
    // A card still waiting ends the run and is never folded; one handled elsewhere (no decision, no longer open) folds.
    expect(shape([perm(1, true), perm(2, null, true), perm(3, null), perm(4, false)])).toEqual(["1", "2", "run3:3,4"]);
    expect(shape([])).toEqual([]);
  });

  it("counts what the run holds", () => {
    const [run] = fold([perm(1, true), perm(2, true), perm(3, false), question(4, false), question(5, true), perm(6, null)]);
    expect(run?.kind).toBe("handled");
    if (run?.kind !== "handled") return;
    expect(run.counts).toEqual({ permissions: 4, questions: 2, allowed: 2, denied: 1, handled: 1, answered: 1, skipped: 1 });
    initI18n("en", "darwin");
    expect(handledSummary(run.counts)).toBe("4 permission(s) · 2 question(s) handled");
    expect(handledDetail(run.counts)).toBe("Allowed 2 · Denied 1 · Answered 1 · Skipped 1 · Handled elsewhere 1");
    initI18n("ko", "win32");
    expect(handledSummary(run.counts)).toBe("권한 4건 · 질문 2건 처리됨");
    expect(handledSummary({ ...run.counts, questions: 0 })).toBe("권한 4건 처리됨");
    expect(handledSummary({ ...run.counts, permissions: 0 })).toBe("질문 2건 처리됨");
    expect(handledDetail({ permissions: 3, questions: 0, allowed: 2, denied: 1, handled: 0, answered: 0, skipped: 0 })).toBe("허용 2 · 거부 1");
  });

  it("reads only permission rows", () => {
    expect(handledOutcome({ kind: "toolUse" }, false)).toBeNull();
    expect(handledOutcome({ kind: "permission", request: { toolName: "SendMessage" }, allowed: true }, false)).toEqual({ question: false, outcome: "allowed" });
    expect(handledOutcome({ kind: "permission", request: { toolName: "AskUserQuestion" }, allowed: null }, true)).toBeNull();
  });
});
