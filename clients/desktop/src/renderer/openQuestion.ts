/**
 * r1-composer M08 — Claude's question (`AskUserQuestion`) answered from the message box, as on the Mac (Core
 * AppState+Task.swift `openQuestion` / `QuestionDraft`, docs/PROTOCOL.md §50 "An open question"). While a question waits,
 * a message put into the turn only waits behind it, so the composer answers the question instead: a typed answer goes to
 * the first question without one (the option whose label it is, else that question's "Other…" text next to what was
 * picked), 1…N in an empty box pick an option of that question, and ⌘↩ with an empty box sends the card. The card above
 * the composer and the composer share one draft per request (`useQuestionDrafts`).
 */
import type { PermissionRequest } from "@reviewgate/engine";
import { create } from "zustand";
import { pendingPermissionsOf, shortcutTargetId } from "./permissionQueue";

export type QuestionOption = { label: string; description: string; preview?: string };
export type Question = { question: string; header: string; multiSelect: boolean; options: QuestionOption[] };
/** What is picked and typed for one question. */
export type QuestionAnswer = { selected: string[]; otherChecked: boolean; otherText: string };
/** One answer per question, in the card's order. */
export type QuestionDraft = QuestionAnswer[];

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The SDK's `questions` input, read leniently. */
export function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = input["questions"];
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const rec = (q ?? {}) as Record<string, unknown>;
    const options = Array.isArray(rec["options"])
      ? (rec["options"] as unknown[]).map((o) => {
          const opt = (o ?? {}) as Record<string, unknown>;
          const preview = asString(opt["preview"]);
          return { label: asString(opt["label"]), description: asString(opt["description"]), ...(preview ? { preview } : {}) };
        })
      : [];
    return { question: asString(rec["question"]), header: asString(rec["header"]), multiSelect: rec["multiSelect"] === true, options };
  });
}

export function emptyDraft(questions: readonly Question[]): QuestionDraft {
  return questions.map(() => ({ selected: [], otherChecked: false, otherText: "" }));
}

/** The answer to one question: its picked options in their order, then the "Other…" text ("" while it has none). */
export function answerText(q: Question, a: QuestionAnswer | undefined): string {
  if (!a) return "";
  const labels = q.options.map((o) => o.label).filter((l) => a.selected.includes(l));
  const other = a.otherChecked ? a.otherText.trim() : "";
  if (a.otherChecked && other.length === 0) return "";
  return [...labels, ...(other ? [other] : [])].join(", ");
}

/** `updatedInput.answers`: one answer per answered question, keyed by its text. */
export function draftAnswers(questions: readonly Question[], draft: QuestionDraft): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const text = answerText(q, draft[i]);
    if (text.length > 0) out[q.question] = text;
  });
  return out;
}

export function isComplete(questions: readonly Question[], draft: QuestionDraft): boolean {
  return questions.length > 0 && questions.every((q, i) => answerText(q, draft[i]).length > 0);
}

/** The question the message box answers: the first one without an answer, else the last one. */
export function currentQuestion(questions: readonly Question[], draft: QuestionDraft): number | null {
  if (questions.length === 0) return null;
  const i = questions.findIndex((q, k) => answerText(q, draft[k]).length === 0);
  return i >= 0 ? i : questions.length - 1;
}

function withAnswer(draft: QuestionDraft, questions: readonly Question[], index: number, change: (a: QuestionAnswer) => QuestionAnswer): QuestionDraft {
  const next = questions.map((_, i) => draft[i] ?? { selected: [], otherChecked: false, otherText: "" });
  next[index] = change(next[index]!);
  return next;
}

/**
 * `text` answers the current question: the option whose label it is (letter case aside) is picked, any other text becomes
 * its "Other…" answer next to what was picked ("Postgres, 번으로 해줘"). Null for an empty text.
 */
export function fillAnswer(questions: readonly Question[], draft: QuestionDraft, text: string): { draft: QuestionDraft; index: number } | null {
  const trimmed = text.trim();
  const index = currentQuestion(questions, draft);
  if (trimmed.length === 0 || index === null) return null;
  const q = questions[index]!;
  const option = q.options.find((o) => o.label.localeCompare(trimmed, undefined, { sensitivity: "accent" }) === 0);
  const next = withAnswer(draft, questions, index, (a) => {
    if (option) {
      return q.multiSelect
        ? { ...a, selected: a.selected.includes(option.label) ? a.selected : [...a.selected, option.label] }
        : { ...a, selected: [option.label], otherChecked: false };
    }
    return { ...a, otherChecked: true, otherText: trimmed };
  });
  return { draft: next, index };
}

/** Option `n` (1 = the first) of the current question: picked (one answer) or turned on / off (several); null without it. */
export function pickOption(questions: readonly Question[], draft: QuestionDraft, n: number): QuestionDraft | null {
  const index = currentQuestion(questions, draft);
  if (index === null) return null;
  const q = questions[index]!;
  const option = q.options[n - 1];
  if (!option) return null;
  return withAnswer(draft, questions, index, (a) => {
    if (!q.multiSelect) return { ...a, selected: [option.label], otherChecked: false };
    const on = a.selected.includes(option.label);
    return { ...a, selected: on ? a.selected.filter((l) => l !== option.label) : [...a.selected, option.label] };
  });
}

/**
 * The question the message box answers (Mac `AppState.openQuestion`): the oldest open `AskUserQuestion` with at least one
 * question, while no other card is open (Ctrl/⌘+Enter answers that one first) and the running chat is shown.
 */
export function openQuestionOf(state: { session: Parameters<typeof pendingPermissionsOf>[0]["session"] }, viewing: boolean): PermissionRequest | null {
  if (viewing || shortcutTargetId(state) !== null) return null;
  return pendingPermissionsOf(state).find((p) => p.toolName === "AskUserQuestion" && parseQuestions(p.input).length > 0) ?? null;
}

type QuestionDrafts = {
  drafts: Record<string, QuestionDraft>;
  setDraft: (requestId: string, draft: QuestionDraft) => void;
  clearDraft: (requestId: string) => void;
};

/** What the card and the message box picked and typed, per request (kept while the card is not on screen). */
export const useQuestionDrafts = create<QuestionDrafts>((set) => ({
  drafts: {},
  setDraft: (requestId, draft) => set((s) => ({ drafts: { ...s.drafts, [requestId]: draft } })),
  clearDraft: (requestId) =>
    set((s) => {
      if (!(requestId in s.drafts)) return s;
      const { [requestId]: _gone, ...rest } = s.drafts;
      return { drafts: rest };
    }),
}));
