/**
 * MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 `history_diff.why`: why that round changed the file, read from its chat
 * (the turn summary's §34.8 reason, else the tool call's rationale), shown like the live review's "왜 바뀌었나". Nothing
 * when the engine had none (an older engine, a chat that says nothing).
 */
import { useMemo } from "react";
import type { FileWhy } from "@reviewgate/engine";
import { readFileWhy } from "../../fileWhy";
import { t } from "../../i18n";
import { DelegationText, WhyText } from "../diff/WhyText";

export function FileWhyLine({ why }: { why: FileWhy }) {
  const view = useMemo(() => readFileWhy(why), [why]);
  if (!view || view.text === null) return null;
  return (
    <div className="history-why caption" data-testid="History why">
      <span className="bold">{t("Why it changed")}</span>
      <span className="history-why-text">
        <WhyText view={view} />
      </span>
      {view.delegation && <DelegationText text={view.delegation} />}
    </div>
  );
}
