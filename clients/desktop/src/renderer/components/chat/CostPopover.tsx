/**
 * MARK: wave4d w4d-agents2 — docs/PROTOCOL.md §42.4: what each model cost (rules in agentCost.ts, the same as the Mac's
 * `ModelCostText`). The HUD's "$1.23 세션" opens a popover with the last turn's and the session's split by model and the side
 * questions' cost; the turn summary card ends with "이번 턴 비용(추정)" and its bar.
 */
import { useRef, useState } from "react";
import type { ModelCost } from "@reviewgate/engine";
import { costUsd, modelCostLine, modelShares, type ModelCostShare } from "../../agentCost";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { AnchoredPopover } from "./HudPopovers";
import { formatTokens, formatUSD } from "./HUDStrip";
import "./cost.css";
import { AutoModelCountsLine } from "./AutoModelBits"; // MARK: wave5 w5-model (§43.4)

/** A thin stacked bar (one segment per model family, tinted like the model chips) and "opus $0.38 · sonnet $0.06 · …". */
export function ModelCostBar({ shares }: { shares: ModelCostShare[] }) {
  return (
    <div className="model-cost" role="img" aria-label={modelCostLine(shares)} data-testid="Model cost bar">
      <div className="mc-bar" aria-hidden="true">
        {shares.map((s) => (
          <span key={s.key} className={`mc-seg ${s.family}`} style={{ width: `${Math.max(1, s.fraction * 100)}%` }} />
        ))}
      </div>
      <div className="mc-legend" aria-hidden="true">
        {shares.map((s) => (
          <span key={s.key} className="mc-item num" title={`${s.models.join(", ")} · $${s.costUsd.toFixed(4)} · ${formatTokens(s.tokens)}`}>
            <span className={`mc-dot ${s.family}`} />
            {s.label} {costUsd(s.costUsd)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The turn summary's last line; nothing from an engine / CLI without per-model usage. */
export function TurnModelCost({ models }: { models: ModelCost[] | undefined }) {
  const shares = modelShares(models);
  if (shares.length === 0) return null;
  return (
    <div className="ts-section ts-model-cost" title={t("Claude Code's estimate from the tokens each model used — not a bill")} data-testid="Turn summary model cost">
      <div className="ts-label">{t("Cost this turn (estimate)")}</div>
      <ModelCostBar shares={shares} />
    </div>
  );
}

/** The HUD's "$1.23 세션": a click shows the split by model. */
export function HudCostButton() {
  const hud = useStore((s) => s.state.hud);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const turn = modelShares(hud.turnModels);
  const session = modelShares(hud.sessionModels);
  const side = hud.sideCostUSD ?? 0;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="item num hud-cost"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={t("Session cost so far: {0}", `$${hud.sessionCostUSD.toFixed(4)}`)}
        data-testid="HUD cost"
      >
        {t("{0} session", formatUSD(hud.sessionCostUSD))}
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} onClose={() => setOpen(false)} className="hud-cost-popover" testId="HUD cost popover" width={300}>
          <div className="hcp-head">
            <span className="bold">{t("Cost")}</span>
            <span className="spacer" />
            <span className="num bold">${hud.sessionCostUSD.toFixed(4)}</span>
          </div>
          <div className="tiny muted hcp-row">{t("Session cost so far: {0}", `$${hud.sessionCostUSD.toFixed(4)}`)}</div>
          {turn.length === 0 && session.length === 0 ? (
            <div className="note">{t("The cost per model shows here once a turn ends.")}</div>
          ) : (
            <>
              {turn.length > 0 && (
                <div className="hcp-row" data-testid="HUD cost last turn">
                  <div className="small bold">{t("Last turn by model (estimate)")}</div>
                  <ModelCostBar shares={turn} />
                </div>
              )}
              {session.length > 0 && (
                <div className="hcp-row" data-testid="HUD cost session">
                  <div className="small bold">{t("This session by model (estimate)")}</div>
                  <ModelCostBar shares={session} />
                </div>
              )}
              <div className="tiny faint hcp-row">{t("Claude Code's estimate from the tokens each model used — not a bill")}</div>
            </>
          )}
          <AutoModelCountsLine counts={hud.autoModelCounts} />{/* MARK: wave5 w5-model */}
          {side > 0 && <div className="tiny hcp-row hcp-side">{t("Side questions in this session: {0} — not part of the session cost", `$${side.toFixed(4)}`)}</div>}
        </AnchoredPopover>
      )}
    </>
  );
}
