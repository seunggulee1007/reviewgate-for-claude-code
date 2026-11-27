/**
 * docs/PROTOCOL.md §71.1: `/usage` (`/cost`, `/stats`) — the terminal's Session block and the plan's usage windows with
 * their reset times, live from the state. As on the Mac (App UsageSheet.swift); the words in usageReport.ts.
 */
import { useEffect, useState } from "react";
import type { RateLimitWindow } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { codeChangesLine, modelTokensLine, orderedWindows, resetsText, usageCost, usageDuration, usedText, windowTitle } from "../../usageReport";
import { Modal } from "../Menu";

const WARN_PERCENT = 80;

export function UsageDialog({ onClose }: { onClose: () => void }) {
  const hud = useStore((s) => s.state.hud);
  const totals = hud.sessionTotals;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const models = hud.sessionModels ?? [];
  const windows = orderedWindows(hud.rateLimits);
  const side = hud.sideCostUSD ?? 0;
  return (
    <Modal title={t("Usage")} onClose={onClose} testId="Usage dialog">
      <div className="usage-body">
        <section className="usage-section" data-testid="Usage session">
          <div className="bold">{t("Session")}</div>
          <div className="usage-grid">
            <span className="muted">{t("Estimated cost")}</span>
            <span className="num">{usageCost(hud.sessionCostUSD)}</span>
            {totals && (
              <>
                <span className="muted">{t("Total duration (API)")}</span>
                <span className="num">{usageDuration(totals.apiDurationMs)}</span>
                <span className="muted">{t("Total duration (wall)")}</span>
                <span className="num" data-testid="Usage wall">{totals.startedAt === null ? t("No Claude Code session is running") : usageDuration(now - totals.startedAt)}</span>
                <span className="muted">{t("Total code changes")}</span>
                <span className="num">{codeChangesLine(totals.linesAdded, totals.linesRemoved)}</span>
              </>
            )}
          </div>
          <div className="muted small">{t("Usage by model")}</div>
          {models.length === 0 ? (
            <div className="small muted usage-indent">{t("The usage per model shows here once a turn ends.")}</div>
          ) : (
            models.map((m) => (
              <div key={m.model} className="usage-model usage-indent" data-testid="Usage model">
                <span className="small bold truncate">{m.model}</span>
                <span className="tiny muted num">{modelTokensLine(m)}</span>
                <span className="spacer" />
                <span className="tiny num">{usageCost(m.costUsd)}</span>
              </div>
            ))
          )}
          {side > 0 && <div className="tiny usage-side">{t("Side questions: {0} — not part of the session cost", usageCost(side))}</div>}
          <div className="tiny muted">{t("Claude Code's estimate from token counts at list price — not a bill. These totals start again in a new chat.")}</div>
        </section>
        <section className="usage-section" data-testid="Usage plan">
          <div className="bold">{t("Plan usage")}</div>
          {windows.length === 0 && (
            <div className="small muted">{t("With a Claude subscription, the five-hour and weekly limits show here once Claude Code reports them — after Claude's first answer.")}</div>
          )}
          {windows.map((w) => <PlanWindow key={w.kind} window={w} />)}
        </section>
      </div>
      <div className="tiny muted">{t("The terminal's activity stats and its breakdown of what counts against your plan come from its local history — they're in a terminal chat's /usage.")}</div>
      <div className="actions">
        <button type="button" className="primary" onClick={onClose} autoFocus data-testid="Usage done">{t("Done")}</button>
      </div>
    </Modal>
  );
}

function PlanWindow({ window: w }: { window: RateLimitWindow }) {
  const rejected = w.status === "rejected";
  const percent = w.percent ?? (rejected ? 100 : undefined);
  const high = rejected || (percent ?? 0) >= WARN_PERCENT;
  const reset = resetsText(w.resetsAt);
  return (
    <div className="usage-window" data-testid={`Usage window ${w.kind}`}>
      <div className="row">
        <span className="small">{windowTitle(w.kind)}</span>
        <span className="spacer" />
        {rejected ? <span className="tiny bold orange">{t("Limit reached")}</span> : percent !== undefined && <span className={`tiny num ${high ? "orange" : "muted"}`}>{usedText(percent)}</span>}
      </div>
      {percent !== undefined && (
        <div className={`usage-bar${high ? " high" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={windowTitle(w.kind)}>
          <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        </div>
      )}
      {reset && <div className="tiny muted">{reset}</div>}
    </div>
  );
}
