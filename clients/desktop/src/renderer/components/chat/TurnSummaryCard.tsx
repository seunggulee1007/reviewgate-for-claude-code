/**
 * `turn_summary` (docs/PROTOCOL.md §15) as a compact, collapsible card after the turn's end row: the changed
 * files (status, +/−, risk badges, the one-line "why", click → diff), the turn's commands with their test
 * verdict (click → the row in the conversation), and — after an approved plan — "plan vs actual": each step
 * with the files matched to it and the changes no step mentions. The newest card starts open, older ones folded.
 * §31 (wave1 desktop-review): files changed outside the app (`origin: "external"`) carry "앱 밖 변경" and the header
 * says how many of the turn's files they are ("앱 밖 변경 M개 포함").
 * MARK: wave2 desktop-diff — §34.8 / §34.9: each file's why with its source (WhyText: Claude 보고, the call's sentence,
 * dimmed 앞선 설명, 원인 기록 없음; the subagent's own text first, "위임 이유: …" on its own line); a sentence two or more
 * files share is shown once at the top, numbered, and those files carry its number; the header's test line is
 * "테스트 통과 · 마지막 편집 뒤 실행" / "테스트 실패" / "편집 뒤 테스트 없음" (`lastTest`; an engine before §34 keeps the
 * old count-based badge).
 */
import { useMemo, useState } from "react";
import type { TurnSummaryEvent, TurnSummaryFile } from "@reviewgate/engine";
import { t } from "../../i18n";
import { riskHelp, riskKinds, riskLabel, riskTone } from "../../risk";
import { externalCountOf } from "../../reviewGate";
import { summaryReviewTotals } from "../../reviewRound";
import "./reviewTotals.css";
import { useStore, type ChatItem } from "../../store";
import { PathText, statusColor } from "../ChangedFiles";
import { TestBadge } from "./ToolRows";
import { AskButton } from "../side/SideAsk";
// MARK: wave2 desktop-diff
import { planCardWhy, summaryWhy, testVerdict, type FileWhyRef, type SharedWhy, type WhyView } from "../../fileWhy";
import { DelegationText, WhyRef, WhyText } from "../diff/WhyText";
import { AgentChangesSection } from "../agents/AgentGlanceBits"; // MARK: wave4b w4b-agents
import { useViewing } from "../../viewedChat"; // MARK: wave4b w4b-side
import { AutoAcceptedSummaryLine } from "../trust/TrustViews"; // MARK: wave4c w4c-trust (§41.2)
import { TurnModelCost } from "./CostPopover"; // MARK: wave4d w4d-agents2 (§42.4)
import { TurnAutoModelLine } from "./AutoModelBits"; // MARK: wave5 w5-model (§43.4)
import { isRequestScope, planSourceTitle, unplannedBadge, unplannedChip, unplannedHelp, unplannedTitle } from "../../planReview"; // MARK: wave4d w4d-plan
import { PlanBasisLine, PlanBasisMenu, usePlanBasis } from "./PlanBasisMenu"; // MARK: wave5 w5-fixes (§43.5)
import type { PlanBasisMenuModel } from "../../planBasis"; // MARK: wave5 w5-fixes
import { planStepWhy } from "../../whyQuestions"; // MARK: wave5 w5-fixes (§43.5)
import "./why.css"; // MARK: wave5 w5-fixes

/** The id of the newest summary row — the only one that starts expanded. */
const latestSummaryId = (items: ChatItem[]): number | null => {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === "turnSummary") return items[i]!.id;
  return null;
};

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function TurnSummaryCard({ id, summary }: { id: number; summary: TurnSummaryEvent }) {
  const latest = useStore((s) => latestSummaryId(s.transcript) === id);
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? latest;
  const adds = summary.files.reduce((n, f) => n + f.adds, 0);
  const dels = summary.files.reduce((n, f) => n + f.dels, 0);
  const tests = summary.commands.filter((c) => c.testOutcome);
  const failedTests = tests.filter((c) => c.testOutcome === "fail").length;
  const plan = summary.plan;
  const planHit = plan ? plan.steps.filter((s) => s.done === true || s.files.length > 0).length : 0;
  const external = externalCountOf(summary.files);
  // MARK: wave2 desktop-diff
  const card = useMemo(() => planCardWhy(summary.files), [summary.files]);
  const verdict = testVerdict(summary.lastTest);
  const reviewTotals = summaryReviewTotals(summary);   // wave3 check-clients
  // MARK: wave5 w5-fixes — §43.5: the newest summary of the live chat carries the "plan vs actual" basis menu
  const viewingOther = useViewing() !== null;
  const basis = usePlanBasis(latest && !viewingOther);
  const planShown = plan !== undefined && plan !== null && (plan.steps.length > 0 || plan.unplannedFiles.length > 0);

  return (
    <div className={`turn-summary ${open ? "open" : ""}`} data-testid="Turn summary">
      <button type="button" className="ts-head plain" onClick={() => setOverride(!open)} aria-expanded={open}>
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="bold">{t("Turn summary")}</span>
        <span className="ts-meta truncate">
          {reviewTotals && <span className="ts-scope">{t("This turn")}</span>}
          <span>{t("{0} file(s)", summary.files.length)}</span>
          <span className="num green">+{adds}</span>
          <span className="num red">−{dels}</span>
          {summary.commands.length > 0 && <span>· {t("{0} command(s)", summary.commands.length)}</span>}
          {verdict ? (
            <span className={`ts-test ${verdict.tone}`} title={verdict.title} data-testid="Summary test verdict">· {verdict.text}</span>
          ) : (
            tests.length > 0 && (failedTests > 0 ? <span className="red">· ✕ {t("Tests failed")}</span> : <span className="green">· ✓ {t("Tests passed")}</span>)
          )}
          {plan && plan.steps.length > 0 && !isRequestScope(plan) && <span>· {t("plan {0}/{1}", planHit, plan.steps.length)}</span>}
          {plan && plan.unplannedFiles.length > 0 && <span className="orange">· {unplannedChip(plan.unplannedFiles.length, plan)}</span>}
          {external > 0 && (
            <span className="orange" title={t("Not changed by a Claude tool — it may be the IDE, another session or a git pull")} data-testid="Summary external">
              · {t("{0} outside change(s) included", external)}
            </span>
          )}
        </span>
      </button>
      {reviewTotals && (
        // wave3 check-clients (§34.3): the whole review after a merged turn, on its own line under this turn's numbers
        // (in the head it pushed the test line out of a narrow chat pane).
        <div className="ts-review-line num" title={t("The review as a whole after this turn — the numbers before it are what this turn changed")} data-testid="Summary review totals">
          {t("Whole review: {0} file(s) · +{1} −{2}", reviewTotals.files, reviewTotals.added, reviewTotals.deleted)}
        </div>
      )}
      {summary.autoAccepted && summary.autoAccepted.length > 0 && <AutoAcceptedSummaryLine files={summary.autoAccepted} />}{/* MARK: wave4c w4c-trust (§41.2) */}
      <TurnAutoModelLine choice={summary.autoModel} />{/* MARK: wave5 w5-model (§43.4) */}
      {open && (
        <div className="ts-body">
          {card.shared.length > 0 && <SharedWhyList shared={card.shared} />}
          <ul className="ts-files" data-testid="Turn summary files">
            {summary.files.map((f) => (
              <SummaryFileRow key={f.path} file={f} unplanned={plan?.unplannedFiles.includes(f.path) === true} unplannedLabel={plan ? unplannedBadge(plan) : undefined} why={card.files.get(f.path)} shared={card.shared} />
            ))}
          </ul>
          <AgentChangesSection files={summary.files} />{/* MARK: wave4b w4b-agents — agents-13 */}
          {summary.commands.length > 0 && <Commands summary={summary} />}
          {plan && planShown && <PlanVsActual plan={plan} basis={basis} askable={!viewingOther} />}
          {!planShown && basis && <PlanBasisLine menu={basis} />}{/* MARK: wave5 w5-fixes — §43.5 */}
          <TurnModelCost models={summary.models} />{/* MARK: wave4d w4d-agents2 — §42.4 */}
        </div>
      )}
    </div>
  );
}

function SummaryFileRow({ file: f, unplanned, unplannedLabel, why, shared }: { file: TurnSummaryFile; unplanned: boolean; unplannedLabel?: string; why: FileWhyRef | undefined; shared: SharedWhy[] }) {
  const live = useStore((s) => s.state.changedFiles.some((c) => c.path === f.path));
  const viewing = useViewing() !== null; // MARK: wave4b w4b-side — §40.3
  const selected = useStore((s) => s.selectedPath === f.path && s.historyView === null);
  const revealFile = useStore((s) => s.revealFile);
  const revealToolUse = useStore((s) => s.revealToolUse);
  const kinds = riskKinds({ path: f.path, status: f.status, tools: f.tools, added: f.adds, deleted: f.dels, origin: f.origin, risks: f.risks /* MARK: wave4b w4b-files — §40.2 */ });
  // MARK: wave2 desktop-diff — the file's own why / delegation, or the number of the card's shared sentence
  const ref: FileWhyRef = why ?? { why: summaryWhy(f), delegation: null };
  const askTool = (typeof ref.why === "number" ? shared[ref.why - 1]?.view.toolUseId : ref.why.toolUseId) ?? f.whyToolUseId;
  return (
    <li className={`ts-file ${selected ? "current" : ""}`}>
      <button
        type="button"
        className="ts-file-main plain"
        disabled={!live}
        onClick={() => revealFile(f.path)}
        title={live ? t("Open the diff of {0}", f.path) : t("{0} — not in the current review", f.path)}
        data-testid={`Summary file ${f.path}`}
      >
        <span className={`glyph mono bold ${statusColor(f.status)}`}>{f.status}</span>
        <PathText path={f.path} />
        <span className="tiny num green">+{f.adds}</span>
        <span className="tiny num red">−{f.dels}</span>
        {kinds.map((k) => (
          <span key={k} className={`pill ${riskTone(k)}`} title={riskHelp(k)}>{riskLabel(k)}</span>
        ))}
        {unplanned && <span className="pill orange" title={t("No step of the approved plan mentions this file")}>{unplannedLabel ?? t("Unplanned")}</span>}
        {typeof ref.why === "number" && <WhyRef n={ref.why} title={sharedTitle(shared[ref.why - 1])} />}
        {typeof ref.delegation === "number" && <WhyRef n={ref.delegation} title={sharedTitle(shared[ref.delegation - 1])} />}
        <StateLabel state={f.state} />
      </button>
      {/* MARK: wave4b w4b-side — §40.3 (SME-12): also after the review is done — the question gets the call that made the
          change; not on another chat shown read-only (its question would go to the running chat) */}
      {(live || !viewing) && (
        <AskButton
          anchor={{ path: f.path, ...(askTool ? { toolUseId: askTool } : {}) }}
          className="hover ts-ask"
          title={live ? t("Ask why {0} changed (side question)", f.path) : t("Ask why {0} changed — its review is done (side question)", f.path)}
          testId={`Ask summary ${f.path}`}
        />
      )}
      {typeof ref.why !== "number" && <FileWhyLine view={ref.why} onReveal={revealToolUse} />}
      {typeof ref.delegation === "string" && (
        <span className="ts-delegation">
          <DelegationText text={ref.delegation} />
        </span>
      )}
    </li>
  );
}

// MARK: wave2 desktop-diff
/** A file's own why under its row; it links to the call it came from (the old "“why”" button, now with its source). */
function FileWhyLine({ view, onReveal }: { view: WhyView; onReveal: (toolUseId: string) => void }) {
  const target = view.toolUseId;
  if (!target) {
    return (
      <span className={`ts-why static ${view.text === null ? "none" : ""}`} data-testid="Summary why">
        <WhyText view={view} />
      </span>
    );
  }
  return (
    <button type="button" className="ts-why plain" onClick={() => onReveal(target)} title={view.text ?? undefined} data-testid="Summary why">
      <WhyText view={view} />
    </button>
  );
}

const sharedTitle = (s: SharedWhy | undefined): string => (!s || s.view.text === null ? "" : s.kind === "delegation" ? t("Delegated: {0}", s.view.text) : s.view.text);

/** Sentences two or more of the card's files share — once, numbered, with the files that carry them. */
function SharedWhyList({ shared }: { shared: SharedWhy[] }) {
  const revealToolUse = useStore((s) => s.revealToolUse);
  const revealFile = useStore((s) => s.revealFile);
  const changed = useStore((s) => s.state.changedFiles);
  const live = (p: string) => changed.some((c) => c.path === p);
  return (
    <ol className="ts-shared" data-testid="Turn summary shared why">
      {shared.map((s) => {
        const target = s.kind === "why" ? s.view.toolUseId : null;
        const sentence = s.kind === "why" ? <WhyText view={s.view} /> : <DelegationText text={s.view.text ?? ""} />;
        return (
          <li key={s.n} className="ts-shared-item">
            <WhyRef n={s.n} title={sharedTitle(s)} />
            <div className="body">
              {target ? (
                <button type="button" className="sentence plain" onClick={() => revealToolUse(target)} title={t("Show in the conversation")}>
                  {sentence}
                </button>
              ) : (
                <span className="sentence">{sentence}</span>
              )}
              <span className="chips">
                {s.paths.slice(0, SHARED_CHIPS).map((p) => (
                  <button key={p} type="button" className="ts-chip" disabled={!live(p)} onClick={() => revealFile(p)} title={p}>
                    {baseName(p)}
                  </button>
                ))}
                {s.paths.length > SHARED_CHIPS && (
                  <span className="tiny faint" title={s.paths.slice(SHARED_CHIPS).join("\n")}>
                    +{s.paths.length - SHARED_CHIPS}
                  </span>
                )}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
const SHARED_CHIPS = 6;

function StateLabel({ state }: { state: TurnSummaryFile["state"] }) {
  switch (state) {
    case "pending":
      return null;
    case "accepted":
      return <span className="tiny bold green" title={t("Accepted")}>✓</span>;
    case "rejected":
      return <span className="tiny bold orange" title={t("Rejected")}>↶</span>;
    case "changesRequested":
      return <span className="tiny bold orange" title={t("Changes requested")}>!</span>;
  }
}

function Commands({ summary }: { summary: TurnSummaryEvent }) {
  const revealToolUse = useStore((s) => s.revealToolUse);
  return (
    <div className="ts-section">
      <div className="ts-label">{t("Commands")}</div>
      <ul className="ts-cmds" data-testid="Turn summary commands">
        {summary.commands.map((c) => (
          <li key={c.toolUseId}>
            <button type="button" className="ts-cmd plain" onClick={() => revealToolUse(c.toolUseId)} title={`${c.command}\n${t("Show in the conversation")}`}>
              <span className="faint mono" aria-hidden="true">$</span>
              <span className="mono truncate grow">{c.command.replace(/\s+/g, " ")}</span>
              {c.parentToolUseId && <span className="pill gray" title={t("Run by a subagent")}>◆</span>}
              {c.testOutcome ? (
                <TestBadge outcome={c.testOutcome} />
              ) : c.isError ? (
                <span className="pill red" data-testid="Command failed">✕ {t("Failed")}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanVsActual({ plan, basis, askable }: { plan: NonNullable<TurnSummaryEvent["plan"]>; basis: PlanBasisMenuModel | null; askable: boolean /* MARK: wave5 w5-fixes */ }) {
  const revealFile = useStore((s) => s.revealFile);
  const changed = useStore((s) => s.state.changedFiles);
  const live = (p: string) => changed.some((c) => c.path === p);
  const chip = (p: string, tone = "") => (
    <button key={p} type="button" className={`ts-chip ${tone}`} disabled={!live(p)} onClick={() => revealFile(p)} title={p}>
      {baseName(p)}
    </button>
  );
  return (
    <div className="ts-section" data-testid="Plan vs actual">
      <div className="ts-label" title={t("Steps are matched to changed files by path, file name or a distinctive name — a heuristic, not a verdict")}>
        {planSourceTitle(plan) /* MARK: wave4d w4d-plan — §42.1: the plan file, Claude's to-do list, the first message's list or the request */}
        {plan.path && <span className="faint mono tiny truncate" title={plan.path}> · {baseName(plan.path)}</span>}
        {basis && <PlanBasisMenu menu={basis} />}{/* MARK: wave5 w5-fixes — §43.5 */}
      </div>
      {isRequestScope(plan) && <div className="tiny muted" data-testid="Plan request">{plan.title ?? plan.steps[0]?.text ?? ""}</div>}
      <ol className="ts-plan">
        {(isRequestScope(plan) ? [] : plan.steps).map((s) => {
          const hit = s.files.length > 0;
          return (
            <li key={s.index} className={hit ? "hit" : s.done ? "done" : "miss"}>
              <span className="check" aria-hidden="true">{hit ? "✓" : s.done ? "☑" : "○"}</span>
              <div className="col grow" style={{ gap: 3 }}>
                <span className="step-text">{s.text}</span>
                {hit && <span className="chips">{s.files.map((p) => chip(p))}</span>}
              </div>
              {!hit && <span className="tiny faint">{s.done ? t("checked in the plan") : t("no matching change")}</span>}
              {/* MARK: wave5 w5-fixes — §43.5: '왜?' on the step (not on another chat shown read-only) */}
              {askable && (
                <AskButton
                  anchor={planStepWhy(s.index + 1, s.text).anchor}
                  question={planStepWhy(s.index + 1, s.text).question}
                  className="hover ts-ask"
                  title={t("Ask Claude why this step is in the plan and which changes belong to it (side question)")}
                  testId={`Plan step why ${s.index + 1}`}
                />
              )}
            </li>
          );
        })}
      </ol>
      {plan.unplannedFiles.length > 0 && (
        <div className="ts-unplanned" data-testid="Unplanned changes" title={unplannedHelp(plan)}>
          <span className="bold">⚠ {unplannedTitle(plan)}</span>
          <span className="chips">{plan.unplannedFiles.map((p) => chip(p, "orange"))}</span>
        </div>
      )}
    </div>
  );
}
