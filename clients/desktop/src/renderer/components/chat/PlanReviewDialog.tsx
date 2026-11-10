/**
 * MARK: wave4d w4d-plan — docs/PROTOCOL.md §42.1 (market-08): the proposed plan at full size — the plan on the left, its
 * steps with a note each on the right — with the card's answers: "계속 계획하기" sends the notes as "단계 N (…): …" lines,
 * the approve buttons also implement in a new chat or a new workbench. The Mac's `PlanReviewSheet`.
 */
import type { PendingPlan, PermissionMode } from "@reviewgate/engine";
import { t } from "../../i18n";
import { planApproveMode } from "../../terminalMode"; // MARK: wave6 w6-terminal (§44.1)
import { planNoteCount } from "../../planReview";
import { Modal } from "../Menu";
import { Markdown } from "./Markdown";
import "./planReview.css";
import { planStepWhy } from "../../whyQuestions"; // MARK: wave5 w5-fixes (§43.5)
import { useStore } from "../../store"; // MARK: wave5 w5-fixes
import "./why.css"; // MARK: wave5 w5-fixes

export type PlanAnswers = {
  approve: (mode: PermissionMode) => void;
  newChat: () => void;
  workbench: () => void;
  keepPlanning: () => void;
};

export function PlanReviewDialog(props: {
  plan: PendingPlan;
  busy: boolean;
  notice: string | null;
  handoffBlocker: string | null;
  notes: Record<number, string>;
  general: string;
  onNote: (index: number, text: string) => void;
  onGeneral: (text: string) => void;
  answers: PlanAnswers;
  onClose: () => void;
}) {
  const { plan, busy, notes } = props;
  const steps = plan.steps ?? [];
  // MARK: wave5 w5-fixes — §43.5: '왜?' on a step; the side panel is the window's, so the dialog closes (the notes stay on the card)
  const askAbout = useStore((s) => s.askAbout);
  const askWhy = (index: number, text: string) => {
    const why = planStepWhy(index + 1, text);
    props.onClose();
    askAbout(why.anchor, { question: why.question });
  };
  const noted = planNoteCount(notes) + (props.general.trim() ? 1 : 0);
  const then = (f: () => void) => () => {
    f();
    props.onClose();
  };
  return (
    <Modal title={<>◈ {t("Review the plan")}{plan.path && <span className="tiny muted mono truncate" title={plan.path}> · {plan.path.split(/[\\/]/).pop()}</span>}</>} onClose={props.onClose} wide testId="Plan review">
      <div className="plan-review">
        <div className="plan-review-text" data-testid="Plan review text">
          <Markdown text={plan.plan} />
        </div>
        <div className="plan-review-notes">
          <div className="bold">{t("Notes per step")}</div>
          <div className="tiny muted">{t("A note goes back with “Keep planning” as “Step N (…): …”. Steps without a note are left as they are.")}</div>
          <div className="plan-review-steps">
            {steps.length === 0 && <div className="muted">{t("This plan has no numbered steps — write your note below.")}</div>}
            {steps.map((s) => (
              <label key={s.index} className={`plan-review-step ${notes[s.index]?.trim() ? "noted" : ""}`}>
                <span className="step-text">
                  {s.index + 1}. {s.text}
                  {/* MARK: wave5 w5-fixes — §43.5 */}
                  <button
                    type="button"
                    className="side-ask plan-step-why"
                    onClick={(e) => {
                      e.preventDefault();
                      askWhy(s.index, s.text);
                    }}
                    title={t("Ask Claude why this step is in the plan (side question) — your notes stay on the card")}
                    aria-label={t("Ask why step {0} is in the plan", s.index + 1)}
                    data-testid={`Plan step why ${s.index + 1}`}
                  >
                    <span className="q" aria-hidden="true">?</span>
                    {t("Why?")}
                  </button>
                </span>
                <textarea
                  rows={2}
                  value={notes[s.index] ?? ""}
                  disabled={busy}
                  placeholder={t("Note for this step (optional)")}
                  aria-label={t("Note for step {0}", s.index + 1)}
                  onChange={(e) => props.onNote(s.index, e.target.value)}
                  data-testid={`Plan step note ${s.index + 1}`}
                />
              </label>
            ))}
          </div>
          <div className="bold">{t("Note for the whole plan")}</div>
          <textarea rows={3} value={props.general} disabled={busy} placeholder={t("Optional note for the next planning turn…")} onChange={(e) => props.onGeneral(e.target.value)} data-testid="Plan review note" />
        </div>
      </div>
      {props.notice && <div className="caption orange" role="alert">⚠ {props.notice}</div>}
      <div className="actions">
        <span className="tiny muted grow">{t("Approving runs the plan as normal turns — every file it changes still goes through the review.")}</span>
        <button type="button" disabled={busy} onClick={then(props.answers.keepPlanning)} title={t("Stay in plan mode and send your notes back for a revision")} data-testid="Plan review keep planning">
          {noted > 0 ? t("Keep planning ({0} notes)", noted) : t("Keep planning")}
        </button>
        <PlanApproveButtons busy={busy} handoffBlocker={props.handoffBlocker} answers={{ ...props.answers, approve: (m) => then(() => props.answers.approve(m))(), newChat: then(props.answers.newChat), workbench: then(props.answers.workbench) }} />
      </div>
    </Modal>
  );
}

/**
 * The approve answers: implement in a new chat / a new workbench (with the reason when they cannot), auto-accept edits, approve & run.
 * MARK: wave6 w6-terminal — §44.1: "Approve & run" goes back to auto when the chat came from auto mode (`planApproveMode`).
 */
export function PlanApproveButtons({ busy, handoffBlocker, answers }: { busy: boolean; handoffBlocker: string | null; answers: Pick<PlanAnswers, "approve" | "newChat" | "workbench"> }) {
  const runMode = useStore((s) => planApproveMode(s.state, s.autoModeUnavailable));
  return (
    <>
      {/* MARK: wave6 w6-terminal — §44.1: the new chat / workbench starts in that mode too, so the label says auto */}
      <button type="button" disabled={busy || handoffBlocker !== null} onClick={answers.newChat}
        title={handoffBlocker ?? t("A fresh chat in this workbench gets only the plan file — the long research conversation is not carried on")} data-testid="Approve plan new chat">
        {runMode === "auto" ? t("Implement in a new chat (auto mode)") : t("Implement in a new chat")}
      </button>
      <button type="button" disabled={busy || handoffBlocker !== null} onClick={answers.workbench}
        title={handoffBlocker ?? t("Create a workbench (branch + folder); its window implements the plan in a fresh chat")} data-testid="Approve plan new workbench">
        {runMode === "auto" ? t("Implement in a new workbench… (auto mode)") : t("Implement in a new workbench…")}
      </button>
      <button type="button" disabled={busy} onClick={() => answers.approve("acceptEdits")} title={t("Approve and switch to Accept edits: file edits are applied without asking, the review still holds them")} data-testid="Approve plan accept edits">
        {t("Approve & auto-accept edits")}
      </button>
      <button type="button" className="primary" disabled={busy} onClick={() => answers.approve(runMode)}
        title={runMode === "auto" ? t("Approve the plan, go back to auto mode and implement it") : t("Approve the plan, leave plan mode and implement it")} data-testid="Approve plan">
        {runMode === "auto" ? t("Approve & run in auto mode") : t("Approve & run")}
      </button>
    </>
  );
}
