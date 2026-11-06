import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@reviewgate/engine";
import { answerText, currentQuestion, draftAnswers, emptyDraft, fillAnswer, isComplete, openQuestionOf, parseQuestions, pickOption, useQuestionDrafts } from "./openQuestion";

// r1-composer M08 (docs/PROTOCOL.md §50 "An open question"), as on the Mac (Core ComposerQuestionTests): Claude's
// AskUserQuestion is answered from the message box — a typed answer goes to the question the box answers instead of into
// the running turn, 1…N pick an option, ⌘↩ with an empty box sends the card.

const ask = (requestId: string, questions: { question: string; options: string[]; multiSelect?: boolean }[]): PermissionRequest => ({
  requestId,
  toolName: "AskUserQuestion",
  input: { questions: questions.map((q) => ({ question: q.question, header: "H", multiSelect: q.multiSelect === true, options: q.options.map((label) => ({ label, description: "" })) })) },
});
const bash = (requestId: string): PermissionRequest => ({ requestId, toolName: "Bash", input: { command: "make" } });
const session = (pending: PermissionRequest[]) => ({ session: { pendingPermission: pending[0] ?? null, pendingPermissions: pending } });

const which = ask("Q1", [{ question: "Which database?", options: ["Postgres", "SQLite"] }]);
const two = ask("Q2", [
  { question: "Which database?", options: ["Postgres", "SQLite"] },
  { question: "Which checks?", options: ["Lint", "Tests", "Types"], multiSelect: true },
]);

describe("the question the message box answers", () => {
  it("is the oldest open question while no other card is open and the running chat is shown", () => {
    expect(openQuestionOf(session([which, two]), false)?.requestId).toBe("Q1");
    // A command waits too: ⌘↩ answers that card first.
    expect(openQuestionOf(session([which, bash("R1")]), false)).toBeNull();
    // Another chat shown read-only: its rows, not the running chat's question.
    expect(openQuestionOf(session([which]), true)).toBeNull();
    // A question without questions is no question.
    expect(openQuestionOf(session([{ requestId: "Q0", toolName: "AskUserQuestion", input: {} }]), false)).toBeNull();
    expect(openQuestionOf(session([]), false)).toBeNull();
  });
});

describe("a typed answer and the number keys", () => {
  const one = parseQuestions(which.input);
  const both = parseQuestions(two.input);

  it("a typed answer is the question's free answer; an option's label picks that option", () => {
    const free = fillAnswer(one, emptyDraft(one), "  use whatever is installed  ");
    expect(free?.index).toBe(0);
    expect(draftAnswers(one, free!.draft)).toEqual({ "Which database?": "use whatever is installed" });
    expect(isComplete(one, free!.draft)).toBe(true);
    const picked = fillAnswer(one, emptyDraft(one), "sqlite");
    expect(picked?.draft[0]).toEqual({ selected: ["SQLite"], otherChecked: false, otherText: "" });
    expect(fillAnswer(one, emptyDraft(one), "   ")).toBeNull();
  });

  it("several questions are answered in turn: the text for the first without an answer, then 1…N for the next", () => {
    const first = fillAnswer(both, emptyDraft(both), "Postgres")!;
    expect(first.index).toBe(0);
    expect(isComplete(both, first.draft)).toBe(false);
    expect(currentQuestion(both, first.draft)).toBe(1);
    let draft = pickOption(both, first.draft, 2)!;
    draft = pickOption(both, draft, 3)!;
    draft = pickOption(both, draft, 3)!; // several answers: on and off
    expect(pickOption(both, draft, 4)).toBeNull(); // no fourth option
    expect(draftAnswers(both, draft)).toEqual({ "Which database?": "Postgres", "Which checks?": "Tests" });
    expect(isComplete(both, draft)).toBe(true);
  });

  it("a note typed after a pick joins the picked option ('1번으로 해줘')", () => {
    const picked = pickOption(one, emptyDraft(one), 1)!;
    const noted = fillAnswer(one, picked, "번으로 해줘")!;
    expect(answerText(one[0]!, noted.draft[0])).toBe("Postgres, 번으로 해줘");
    // Picking again leaves the typed words out of the answer.
    expect(answerText(one[0]!, pickOption(one, noted.draft, 2)![0])).toBe("SQLite");
  });

  it("the card and the box share one draft per request", () => {
    const store = useQuestionDrafts.getState();
    store.setDraft("Q1", pickOption(one, emptyDraft(one), 2)!);
    expect(useQuestionDrafts.getState().drafts["Q1"]?.[0]?.selected).toEqual(["SQLite"]);
    useQuestionDrafts.getState().clearDraft("Q1");
    expect(useQuestionDrafts.getState().drafts["Q1"]).toBeUndefined();
  });
});
