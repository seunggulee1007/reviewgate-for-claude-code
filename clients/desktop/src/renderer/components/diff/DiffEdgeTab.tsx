/** The collapsed diff pane (M16): a narrow edge tab that re-opens it (⌘⇧D) — shows the changed-file count when files exist. */
import { t } from "../../i18n";
import { useStore } from "../../store";

export function DiffEdgeTab() {
  const changed = useStore((s) => s.state.changedFiles.length);
  const toggleDiffPane = useStore((s) => s.toggleDiffPane);
  const label = changed > 0 ? t("Changes ({0})", changed) : t("Changes");
  return (
    <button type="button" className="diff-edge-tab" onClick={toggleDiffPane} title={t("Show the diff pane (⌘⇧D)")} aria-label={t("Show the diff pane (⌘⇧D)")} data-testid="Diff edge tab">
      <span className="chev">▸</span>
      <span className="label">{label}</span>
    </button>
  );
}
