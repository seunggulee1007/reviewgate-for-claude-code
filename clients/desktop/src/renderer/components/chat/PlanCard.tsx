/**
 * M20 plan card (docs/M20-MODES.md): sticky above the composer while `session.pendingPlan` is set.
 * The plan is rendered as Markdown in a scrollable box; Approve leaves plan mode and lets the engine
 * send the follow-up instruction, Keep planning (Esc while no field has focus) stays in plan mode with an optional note.
 * A plain message supersedes the plan — the caption says so. The buttons are locked while the review is
 * (a turn, its collection, a revert) and while the answer waits for its `result`; a refusal — or §19.5
 * `plan_followup_failed`, which brings the card back — is shown on the card.
 */
import { useEffect, useRef, useState } from "react";
import type { PermissionMode } from "@reviewgate/engine";
import { t } from "../../i18n";
import { planApproveMode } from "../../terminalMode"; // MARK: wave6 w6-terminal (§44.1)
import { planEscape } from "../../permissionKeys";
import { isPlanLocked } from "../../planLock";
import { pendingPlan, useStore } from "../../store";
import { Markdown } from "./Markdown";
// MARK: wave4d w4d-plan — §42.1: the plan at full size with per-step notes; implement in a new chat / workbench
import { planHandoffBlocker, planNoteCount, planNotesMessage, suggestPlanBranch } from "../../planReview";
import { PlanApproveButtons, PlanReviewDialog } from "./PlanReviewDialog";

export function PlanCard() {
  const state = useStore((s) => s.state);
  const approvePlan = useStore((s) => s.approvePlan);
  const keepPlanning = useStore((s) => s.keepPlanning);
  const approvePlanInto = useStore((s) => s.approvePlanInto);
  const openDialog = useStore((s) => s.openDialog);
  const [note, setNote] = useState("");
  const [stepNotes, setStepNotes] = useState<Record<number, string>>({});
  const [large, setLarge] = useState(false);
  const answering = useStore((s) => s.planAnswering);
  const planNotice = useStore((s) => s.planNotice);
  const autoUnavailable = useStore((s) => s.autoModeUnavailable); // MARK: wave6 w6-terminal (§44.1)
  const plan = pendingPlan(state);
  const busy = isPlanLocked(state, answering);
  // A new proposal: the notes were for the old one.
  const planAt = plan?.at ?? null;
  useEffect(() => setStepNotes({}), [planAt]);

  // Esc = keep planning — only when nothing else wants the Esc: not already handled (a palette, the find bar), no field
  // focused (composer, side question, review note, this card's note), no dialog / menu / popover (audit polish-01).
  const keep = useRef<() => boolean>(() => false);
  keep.current = () => {
    if (!plan || busy) return false;
    // The notes are kept when the answer is refused, so they can be sent again. §42.1: "단계 N (…): …" lines, then the note.
    const message = planNotesMessage(plan.steps ?? [], stepNotes, note) ?? undefined;
    void keepPlanning(message).then((refusal) => {
      if (refusal !== null) return;
      setNote("");
      setStepNotes({});
    });
    return true;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // wave4d w4d-plan: the large plan view's Esc closes it, never answers the plan.
      const overlayOpen = document.querySelector('[role="menu"], .popover, [data-testid="Plan review"]') !== null;
      if (!planEscape(e, { focus: document.activeElement, dialogOpen: useStore.getState().dialog !== null, overlayOpen })) return;
      if (keep.current()) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!plan) return null;

  const approve = (mode: PermissionMode) => {
    if (busy) return;
    void approvePlan(mode).then((refusal) => refusal === null && setNote(""));
  };
  const blocker = planHandoffBlocker(plan, busy);
  // MARK: wave6 w6-terminal — §44.1: a plan made in an auto chat is implemented in auto mode (here, a new chat or workbench).
  const runMode = planApproveMode(state, autoUnavailable);
  const answers = {
    approve,
    newChat: () => {
      if (blocker !== null) return;
      void approvePlanInto(runMode, "new_chat").then((refusal) => refusal === null && setNote(""));
    },
    workbench: () => {
      if (blocker !== null) return;
      openDialog({ kind: "newWorkbench", branch: suggestPlanBranch(plan.path), planMode: runMode });
    },
    keepPlanning: () => void keep.current(),
  };
  const noted = planNoteCount(stepNotes);

  return (
    <div className="plan-card" data-testid="Plan card">
      <div className="head">
        <span className="title">◈ {t("Claude proposed a plan")}</span>
        {plan.path && <span className="tiny muted mono truncate" title={plan.path} data-testid="Plan path">{plan.path}</span>}
      </div>
      <div className="plan-body compact" data-testid="Plan body">
        <Markdown text={plan.plan} />
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className="small" onClick={() => setLarge(true)} title={t("Opens the whole plan with a note field for each step")} data-testid="Plan view large">
          ⤢ {t("View large")}
        </button>
        {plan.steps && plan.steps.length > 0 && <span className="tiny muted">{t("{0} steps", plan.steps.length)}</span>}
        {noted > 0 && <span className="pill orange">{t("{0} step notes", noted)}</span>}
      </div>
      {large && (
        <PlanReviewDialog plan={plan} busy={busy} notice={planNotice} handoffBlocker={blocker} notes={stepNotes} general={note}
          onNote={(i, text) => setStepNotes((n) => ({ ...n, [i]: text }))} onGeneral={setNote} answers={answers} onClose={() => setLarge(false)} />
      )}
      <input
        type="text"
        value={note}
        placeholder={t("Optional note for the next planning turn…")}
        onChange={(e) => setNote(e.target.value)}
        data-testid="Plan note"
      />
      {planNotice && (
        <div className="caption orange" role="alert" data-testid="Plan notice">⚠ {planNotice}</div>
      )}
      <span className="tiny muted">{t("Approving runs the plan as a normal turn — every file it changes still goes through the review. Sending a message of your own drops the plan.")}</span>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => keep.current()} title={t("Stay in plan mode and revise the plan (Esc)")} data-testid="Keep planning">
          {t("Keep planning")}
        </button>
        <span className="spacer" />
        {answering && <span className="spinner" data-testid="Plan answering" />}
        <PlanApproveButtons busy={busy} handoffBlocker={blocker} answers={answers} />
      </div>
    </div>
  );
}
