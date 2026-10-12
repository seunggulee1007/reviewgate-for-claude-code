/**
 * `AskUserQuestion` permission card: renders the SDK's questions as radios (checkboxes when
 * `multiSelect`) with a bold label + description, an optional `preview` for the focused option, and
 * an "Other…" free-text fallback. "Answer" replies via `answerQuestions` (`updatedInput.answers`
 * keyed by question text — labels joined with ", " for multiSelect, else the free text); "Skip" denies.
 */
import { useMemo, useState } from "react";
import { t } from "../../i18n";
import { isPermissionPending } from "../../permissionQueue";
import { useStore, type ChatItem } from "../../store";
import { AgentTag, DecisionCaption } from "./PermissionBits";
import { isEnter } from "../../ime";

type QuestionOption = { label: string; description: string; preview?: string };
type Question = { question: string; header: string; multiSelect: boolean; options: QuestionOption[] };
type Answer = { selected: string[]; otherChecked: boolean; otherText: string };

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseQuestions(input: Record<string, unknown>): Question[] {
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

function answerText(a: Answer): string {
  if (a.otherChecked) return a.otherText.trim();
  return a.selected.join(", ");
}

export function QuestionCard({ item }: { item: Extract<ChatItem, { kind: "permission" }> }) {
  const { request, allowed } = item;
  const questions = useMemo(() => parseQuestions(request.input), [request.input]);
  const answerQuestions = useStore((s) => s.answerQuestions);
  const respondPermission = useStore((s) => s.respondPermission);
  // §33.1: answerable while its own request is open (another card may be older).
  const pending = useStore((s) => isPermissionPending(s.state, request.requestId));
  const active = allowed === null && pending;
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => ({ selected: [], otherChecked: false, otherText: "" })));

  if (allowed !== null) {
    return (
      <div className="perm decided" data-permission-id={request.requestId} data-testid="Permission decided">
        <div className="head">
          <span className="orange">❓</span>
          <span className="title">{t("Question")}</span>
          <span className={`caption bold ${allowed ? "green" : "red"}`} data-testid="Permission decision">{allowed ? t("Answered") : t("Skipped")}</span>
        </div>
        {questions.map((q, i) => (
          <div className="qa-row" key={i}>
            <span className="q">{q.question}</span>
            <span className="a bold">{item.answers?.[q.question] ?? t("(skipped)")}</span>
          </div>
        ))}
      </div>
    );
  }

  const select = (qi: number, label: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      const q = questions[qi]!;
      const cur = next[qi]!;
      const has = cur.selected.includes(label);
      const selected = q.multiSelect ? (has ? cur.selected.filter((l) => l !== label) : [...cur.selected, label]) : [label];
      next[qi] = { ...cur, selected, otherChecked: false };
      return next;
    });
  };

  const selectOther = (qi: number) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[qi] = { ...next[qi]!, selected: [], otherChecked: true };
      return next;
    });
  };

  const setOtherText = (qi: number, text: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[qi] = { ...next[qi]!, otherText: text };
      return next;
    });
  };

  const allAnswered = questions.length > 0 && questions.every((_, i) => answerText(answers[i]!).length > 0);

  const submit = () => {
    if (!active || !allAnswered) return;
    const record: Record<string, string> = {};
    questions.forEach((q, i) => (record[q.question] = answerText(answers[i]!)));
    answerQuestions(request.requestId, record);
  };

  const skip = () => {
    if (!active) return;
    respondPermission(request.requestId, false, t("User skipped the questions"));
  };

  return (
    <div
      className={`perm question-card ${active ? "" : "handled"}`}
      data-permission-id={request.requestId}
      data-testid={active ? "Question card" : "Permission handled"}
      onKeyDown={(e) => {
        if (isEnter(e) && (e.metaKey || e.ctrlKey)) submit();
      }}
    >
      <div className="head">
        <span className="orange">❓</span>
        <span className="title">{t("Claude is asking a question")}</span>
        <AgentTag request={request} />
        {!active && <DecisionCaption status="handled" decision={null} />}
      </div>
      {questions.map((q, i) => {
        const a = answers[i]!;
        const inputType = q.multiSelect ? "checkbox" : "radio";
        const focused = q.options.find((o) => a.selected.includes(o.label) && o.preview);
        return (
          <div className="question" key={i}>
            <span className="q-chip">{q.header}</span>
            <div className="q-text bold">{q.question}</div>
            <div className="q-options">
              {q.options.map((opt) => (
                <label className="q-option" key={opt.label}>
                  <input
                    type={inputType}
                    name={`q-${i}`}
                    checked={a.selected.includes(opt.label)}
                    onChange={() => select(i, opt.label)}
                    disabled={!active}
                  />
                  <span className="col" style={{ gap: 1 }}>
                    <span className="bold">{opt.label}</span>
                    <span className="muted caption">{opt.description}</span>
                  </span>
                </label>
              ))}
              <label className="q-option">
                <input type={inputType} name={`q-${i}`} checked={a.otherChecked} onChange={() => selectOther(i)} disabled={!active} />
                <span className="bold">{t("Other…")}</span>
              </label>
              {a.otherChecked && (
                <input
                  type="text"
                  className="mono"
                  value={a.otherText}
                  placeholder={t("Type your answer…")}
                  onChange={(e) => setOtherText(i, e.target.value)}
                  disabled={!active}
                  data-testid={`Question ${i} other`}
                />
              )}
            </div>
            {focused?.preview && <pre className="mono q-preview">{focused.preview}</pre>}
          </div>
        );
      })}
      <div className="actions">
        <button type="button" className="danger" disabled={!active} onClick={skip} data-testid="Skip">
          {t("Skip")}
        </button>
        <button type="button" className="primary" disabled={!active || !allAnswered} onClick={submit} data-testid="Answer">
          {t("Answer")}
        </button>
      </div>
    </div>
  );
}
