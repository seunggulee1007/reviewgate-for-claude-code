/** `files/max · lines/max` capsule (the Mac app's `BudgetBadge`): amber when over, red with DENIED once an edit was refused. */
import type { Budget, BudgetUsage } from "@reviewgate/engine";
import { t } from "../../i18n";

export function BudgetBadge({ usage, budget }: { usage: BudgetUsage; budget: Budget }) {
  const over = usage.files > budget.maxFiles || usage.lines > budget.maxLines;
  const cls = usage.denied ? "denied" : over ? "over" : "";
  return (
    <span className={`budget-badge num ${cls}`} title={t("Per-turn change budget: files / lines")} data-testid="Budget badge">
      <span>📄 {usage.files}/{budget.maxFiles}</span>
      <span>≡ {usage.lines}/{budget.maxLines}</span>
      {usage.denied && <span>{t("DENIED")}</span>}
    </span>
  );
}
