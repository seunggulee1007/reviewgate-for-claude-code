/**
 * `AskUserQuestion` permission card: renders the SDK's questions as radios (checkboxes when
 * `multiSelect`) with a bold label + description, an optional `preview` for the focused option, and
 * an "Other…" free-text fallback. "Answer" replies via `answerQuestions` (`updatedInput.answers`
 * keyed by question text — the picked labels, then the free text, joined with ", "); "Skip" denies.
 * MARK: r1-composer M08 (docs/PROTOCOL.md §50 "An open question") — the question the message box answers (`openQuestionOf`)
 * sits above the composer (`QuestionSlot`), the question a typed answer or 1…N goes to marked and its options numbered; its
 * transcript row is one line while it waits there and once it is answered. The card and the composer share one draft
 * (`useQuestionDrafts`). A question open while another card or an older question comes first stays a card in the transcript.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionRequest } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isPermissionPending } from "../../permissionQueue";
import { useStore, type ChatItem } from "../../store";
import { AgentTag, DecisionCaption } from "./PermissionBits";
import { isEnter } from "../../ime";
import { currentQuestion, draftAnswers, emptyDraft, isComplete, openQuestionOf, parseQuestions, useQuestionDrafts, type Question, type QuestionDraft } from "../../openQuestion";
import { useViewing } from "../../viewedChat";
import { annotationsFor, clearQuestionNotes, setQuestionNote, useQuestionNotes } from "../../questionNotes"; // r2-chats-cards M08b
import { useUnsavedWork } from "../../unsavedWork";
import "./question.css";

type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

/** The transcript's row for a question: one line, unless the card has to be answered right there. */
export function QuestionCard({ item }: { item: PermissionItem }) {
  const { request, allowed } = item;
  const questions = useMemo(() => parseQuestions(request.input), [request.input]);
  // §33.1: answerable while its own request is open (another card may be older).
  const pending = useStore((s) => isPermissionPending(s.state, request.requestId));
  const viewing = useViewing() !== null;
  const inSlot = useStore((s) => openQuestionOf(s.state, viewing)?.requestId === request.requestId);
  if (allowed !== null || !pending || inSlot) return <QuestionLine item={item} questions={questions} waiting={allowed === null && pending} />;
  return <QuestionEditor request={request} questions={questions} slot={false} />;
}

/** r1-composer M08: the card the message box answers, above the composer (`ChatPane`). */
export function QuestionSlot() {
  const viewing = useViewing() !== null;
  const request = useStore((s) => openQuestionOf(s.state, viewing));
  const questions = useMemo(() => (request ? parseQuestions(request.input) : []), [request]);
  if (!request) return null;
  return (
    <div className="question-slot" data-testid="Question slot">
      <QuestionEditor key={request.requestId} request={request} questions={questions} slot />
    </div>
  );
}

/** One line: "Claude의 질문: … — 아래에서 답해 주세요" while its card waits above the composer, then the answers. */
function QuestionLine({ item, questions, waiting }: { item: PermissionItem; questions: Question[]; waiting: boolean }) {
  const asked = questions.map((q) => q.question).join(" · ");
  const answerOf = (q: Question) => item.answers?.[q.question] ?? "—";
  const text = waiting
    ? t("Claude asked: {0} — answer it below", asked)
    : item.allowed === true
      ? t("Answered: {0}", questions.map((q) => `${q.question} → ${answerOf(q)}`).join(" · "))
      : item.allowed === false
        ? t("Skipped: {0}", asked)
        : t("Handled: {0}", asked);
  const full = questions.map((q) => `${q.question}\n→ ${answerOf(q)}`).join("\n\n");
  return (
    <div
      className={`question-line ${waiting ? "waiting" : ""}`}
      data-permission-id={item.request.requestId}
      data-testid={waiting ? "Question line waiting" : "Question line"}
      title={full}
    >
      <span className="q-mark" aria-hidden="true">❓</span>
      <span className="truncate">{text}</span>
    </div>
  );
}

function QuestionEditor({ request, questions, slot }: { request: PermissionRequest; questions: Question[]; slot: boolean }) {
  const answerQuestions = useStore((s) => s.answerQuestions);
  const respondPermission = useStore((s) => s.respondPermission);
  const active = useStore((s) => isPermissionPending(s.state, request.requestId));
  const stored = useQuestionDrafts((s) => s.drafts[request.requestId]);
  const setDraft = useQuestionDrafts((s) => s.setDraft);
  const clearDraft = useQuestionDrafts((s) => s.clearDraft);
  const answers: QuestionDraft = stored ?? emptyDraft(questions);
  const current = slot ? currentQuestion(questions, answers) : null;
  // r2-chats-cards M08b: a note per question, sent as `updatedInput.annotations`.
  const notes = useQuestionNotes((s) => s.notes[request.requestId]);
  const [notesOpen, setNotesOpen] = useState<Set<number>>(() => new Set());
  /** M08b: question `i`'s note field is open (asked for, or it holds a note). */
  const noteShown = (i: number) => notesOpen.has(i) || (notes?.[i] ?? "").length > 0;
  // polish P4-composer-07: closing the window would lose what was picked or typed here.
  useUnsavedWork(`question-${request.requestId}`, () =>
    active && (stored !== undefined || Object.keys(notes ?? {}).length > 0) ? t("Answers to Claude's question are not sent yet.") : null,
  );
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  // r1-composer M08: with several questions the one the message box answers now scrolls into view.
  useEffect(() => {
    if (current !== null && questions.length > 1) refs.current[current]?.scrollIntoView?.({ block: "nearest" });
  }, [current, questions.length]);

  const update = (qi: number, change: (a: QuestionDraft[number]) => QuestionDraft[number]) => {
    const next = questions.map((_, i) => answers[i] ?? { selected: [], otherChecked: false, otherText: "" });
    next[qi] = change(next[qi]!);
    setDraft(request.requestId, next);
  };

  const select = (qi: number, label: string) =>
    update(qi, (cur) => {
      const q = questions[qi]!;
      const has = cur.selected.includes(label);
      const selected = q.multiSelect ? (has ? cur.selected.filter((l) => l !== label) : [...cur.selected, label]) : [label];
      return { ...cur, selected, otherChecked: q.multiSelect ? cur.otherChecked : false };
    });

  const selectOther = (qi: number) =>
    update(qi, (cur) => (questions[qi]!.multiSelect ? { ...cur, otherChecked: !cur.otherChecked } : { ...cur, selected: [], otherChecked: true }));

  const setOtherText = (qi: number, text: string) => update(qi, (cur) => ({ ...cur, otherText: text }));

  const allAnswered = isComplete(questions, answers);

  const submit = () => {
    if (!active || !allAnswered) return;
    answerQuestions(request.requestId, draftAnswers(questions, answers), annotationsFor(request.requestId, questions, answers));
    clearDraft(request.requestId);
    clearQuestionNotes(request.requestId);
  };

  const skip = () => {
    if (!active) return;
    respondPermission(request.requestId, false, t("User skipped the questions"));
    clearDraft(request.requestId);
    clearQuestionNotes(request.requestId);
  };

  const unanswered = questions.filter((q, i) => draftAnswers([q], [answers[i] ?? { selected: [], otherChecked: false, otherText: "" }])[q.question] === undefined).length;

  const optionCount = current !== null ? (questions[current]?.options.length ?? 0) : 0;
  return (
    <div
      className={`perm question-card ${active ? "" : "handled"} ${slot ? "in-slot" : ""}`}
      data-permission-id={slot ? undefined : request.requestId}
      data-testid={active ? "Question card" : "Permission handled"}
      onKeyDown={(e) => {
        if (isEnter(e) && (e.metaKey || e.ctrlKey)) submit();
      }}
    >
      <div className="head">
        <span className="orange">❓</span>
        <span className="title">{t("Claude has a question")}</span>{/* polish P4-composer-42: the Mac's words */}
        <AgentTag request={request} />
        {!active && <DecisionCaption status="handled" decision={null} />}
      </div>
      {questions.map((q, i) => {
        const a = answers[i] ?? { selected: [], otherChecked: false, otherText: "" };
        const inputType = q.multiSelect ? "checkbox" : "radio";
        const focused = q.options.find((o) => a.selected.includes(o.label) && o.preview);
        const answersHere = current === i;
        return (
          <div className={`question ${answersHere && questions.length > 1 ? "current" : ""}`} key={i} ref={(el) => void (refs.current[i] = el)}>
            <span className="q-chip">{q.header}</span>
            {answersHere && questions.length > 1 && (
              <span className="tiny accent" data-testid={`Question ${i} answered from the message box`}>↓ {t("Answered from the message box")}</span>
            )}
            <div className="q-text bold">{q.question}</div>
            <div className="q-options">
              {q.options.map((opt, oi) => (
                <label className="q-option" key={opt.label}>
                  {answersHere && <kbd className="q-key" title={t("Press {0} in the message box to pick this", oi + 1)}>{oi + 1}</kbd>}
                  {/* no shared `name`: the draft keeps the one-answer rule, and a note typed after a pick shows both */}
                  <input type={inputType} checked={a.selected.includes(opt.label)} onChange={() => select(i, opt.label)} disabled={!active} />
                  <span className="col" style={{ gap: 1 }}>
                    <span className="bold">{opt.label}</span>
                    <span className="muted caption">{opt.description}</span>
                  </span>
                </label>
              ))}
              {/* r2-chats-cards M08b, as on the Mac: "메모 추가" ends the "기타…" row until a note is open — no row of its own */}
              <div className="q-other-row">
                <label className="q-option" title={t("Type an answer that is not in the list")}>
                  <input type={inputType} checked={a.otherChecked} onChange={() => selectOther(i)} disabled={!active} />
                  <span className="bold">{t("Other…")}</span>
                </label>
                {active && !noteShown(i) && (
                  <button type="button" className="link small" onClick={() => setNotesOpen((o) => new Set(o).add(i))} title={t("Add a note Claude reads together with your answer")} data-testid={`Question ${i} add note`}>
                    {t("Add a note")}
                  </button>
                )}
              </div>
              {a.otherChecked && (
                <input
                  type="text"
                  className="mono"
                  value={a.otherText}
                  placeholder={t("Type your answer")}
                  onChange={(e) => setOtherText(i, e.target.value)}
                  disabled={!active}
                  data-testid={`Question ${i} other`}
                />
              )}
            </div>
            {focused?.preview && <pre className="mono q-preview">{focused.preview}</pre>}
            {active && noteShown(i) && (
              <input
                type="text"
                className="q-note"
                value={notes?.[i] ?? ""}
                placeholder={t("A note with your answer (optional)")}
                title={t("Claude reads this note together with your answer")}
                aria-label={t("Note with the answer")}
                autoFocus={(notes?.[i] ?? "").length === 0}
                onChange={(e) => setQuestionNote(request.requestId, i, e.target.value)}
                data-testid={`Question ${i} note`}
              />
            )}
          </div>
        );
      })}
      <div className="actions">
        {slot && active && (
          <span className="caption muted grow" data-testid="Question card hint">
            {optionCount > 0 ? t("Pick 1–{0} or type below · ⌘↩ answers · ⌥↩ sends separately", optionCount) : t("Type below · ⌘↩ answers · ⌥↩ sends separately")}
          </span>
        )}
        {/* polish P4-composer-27: what each does, and why Answer waits — Skip is a plain button, as on the Mac */}
        <button type="button" disabled={!active} onClick={skip} title={t("Tell Claude you skipped the questions (esc while this card is focused)")} data-testid="Skip">
          {t("Skip")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!active || !allAnswered}
          onClick={submit}
          title={allAnswered ? t("Send your answers (⌘↩ while this card is focused)") : t("Answer every question first — {0} left", unanswered)}
          data-testid="Answer"
        >
          {t("Answer")}
        </button>
      </div>
    </div>
  );
}
