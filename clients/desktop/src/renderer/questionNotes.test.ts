import { describe, expect, it } from "vitest";
import type { Question } from "./openQuestion";
import { annotationsFor, annotationsOf, clearQuestionNotes, setQuestionNote, useQuestionNotes } from "./questionNotes";

/** r2-chats-cards M08b — §50 "Notes with an answer": `updatedInput.annotations` keyed by question text. */
const questions: Question[] = [
  { question: "Which layout?", header: "Layout", multiSelect: false, options: [{ label: "Grid", description: "cards", preview: "[ ][ ]" }, { label: "List", description: "rows", preview: "----" }] },
  { question: "Which tests?", header: "Tests", multiSelect: true, options: [{ label: "unit", description: "" }, { label: "e2e", description: "" }] },
];

describe("question notes (M08b)", () => {
  it("a note and a single chosen preview per answered question; nothing for the rest", () => {
    const draft = [
      { selected: ["Grid"], otherChecked: false, otherText: "" },
      { selected: ["unit", "e2e"], otherChecked: false, otherText: "" },
    ];
    expect(annotationsOf(questions, draft, { 0: "  keep the header sticky ", 1: "   " })).toEqual({ "Which layout?": { notes: "keep the header sticky", preview: "[ ][ ]" } });
    expect(annotationsOf(questions, [{ selected: [], otherChecked: true, otherText: "Masonry" }, { selected: ["unit"], otherChecked: false, otherText: "" }], undefined)).toEqual({});
    expect(annotationsOf(questions, [{ selected: [], otherChecked: false, otherText: "" }, { selected: [], otherChecked: false, otherText: "" }], { 0: "note on nothing" })).toEqual({});
  });

  it("notes are kept per request and question, and cleared with the answer", () => {
    setQuestionNote("Q1", 1, "only the api");
    expect(useQuestionNotes.getState().notes).toEqual({ Q1: { 1: "only the api" } });
    const draft = [{ selected: [], otherChecked: false, otherText: "" }, { selected: ["unit"], otherChecked: false, otherText: "" }];
    expect(annotationsFor("Q1", questions, draft)).toEqual({ "Which tests?": { notes: "only the api" } });
    setQuestionNote("Q1", 1, "");
    expect(useQuestionNotes.getState().notes).toEqual({ Q1: {} });
    clearQuestionNotes("Q1");
    expect(useQuestionNotes.getState().notes).toEqual({});
  });
});
