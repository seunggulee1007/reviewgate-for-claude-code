/**
 * r2-chats-cards M08b — docs/PROTOCOL.md §50 "Notes with an answer", as on the Mac (Core `QuestionDraft.notes`,
 * `QuestionDraft.annotations`): a note per question goes back with the answer as `updatedInput.annotations[question]` —
 * `{ notes?, preview? }`, the CLI's own schema: the note, and the chosen option's preview when the question showed previews.
 * The notes live here, per request and question (the card and the message box share them); a question without a note or
 * a chosen preview sends nothing, and no `annotations` at all when none has.
 */
import { create } from "zustand";
import type { Question, QuestionDraft } from "./openQuestion";

export type Annotation = { notes?: string; preview?: string };

export const useQuestionNotes = create<{ notes: Record<string, Record<number, string>> }>(() => ({ notes: {} }));

export function setQuestionNote(requestId: string, index: number, text: string): void {
  useQuestionNotes.setState((s) => {
    const forRequest = { ...(s.notes[requestId] ?? {}) };
    if (text.length > 0) forRequest[index] = text;
    else delete forRequest[index];
    return { notes: { ...s.notes, [requestId]: forRequest } };
  });
}

export function clearQuestionNotes(requestId: string): void {
  useQuestionNotes.setState((s) => {
    if (!(requestId in s.notes)) return s;
    const next = { ...s.notes };
    delete next[requestId];
    return { notes: next };
  });
}

/** One annotation per answered question with a note or a single chosen option's preview, keyed by question text. */
export function annotationsOf(questions: readonly Question[], draft: QuestionDraft, notes: Record<number, string> | undefined): Record<string, Annotation> {
  const out: Record<string, Annotation> = {};
  questions.forEach((q, i) => {
    const a = draft[i];
    if (!a) return;
    const answered = a.selected.length > 0 || (a.otherChecked && a.otherText.trim().length > 0);
    if (!answered) return;
    const note = (notes?.[i] ?? "").trim();
    const chosen = q.options.filter((o) => a.selected.includes(o.label));
    const preview = chosen.length === 1 ? chosen[0]!.preview : undefined;
    if (note.length === 0 && !preview) return;
    out[q.question] = { ...(note.length > 0 ? { notes: note } : {}), ...(preview ? { preview } : {}) };
  });
  return out;
}

/** `annotationsOf` for the request's current notes. */
export function annotationsFor(requestId: string, questions: readonly Question[], draft: QuestionDraft): Record<string, Annotation> {
  return annotationsOf(questions, draft, useQuestionNotes.getState().notes[requestId]);
}
