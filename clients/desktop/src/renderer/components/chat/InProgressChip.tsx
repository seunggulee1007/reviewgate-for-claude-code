/**
 * wave2 desktop-flow — the HUD's "진행 중: 파일 N개 · +A −D" (docs/PROTOCOL.md §34.6): what the running turn changed so far
 * (`hud.turnFiles` without a snapshot; the +/− from the last `live_changes`). A click opens the Changes tab's
 * "진행 중 변경" section. Nothing while no turn runs, before the turn touches a file, or from an engine before §34.
 */
import { t } from "../../i18n";
import { liveTotals } from "../../reviewRound";
import { useStore } from "../../store";
import "../reviewRound.css";

export function InProgressChip() {
  const running = useStore((s) => s.state.gate.phase === "running");
  const turnFiles = useStore((s) => s.state.hud.turnFiles ?? 0);
  const files = useStore((s) => s.live.files);
  const fetched = useStore((s) => s.live.at !== null);
  const reveal = useStore((s) => s.revealLiveChanges);
  if (!running || (turnFiles === 0 && files.length === 0)) return null;
  const totals = liveTotals(files, turnFiles);
  // The +/− only from a read that lists every file the turn touched (it is read while the list is on screen).
  const label = fetched && files.length >= turnFiles ? t("In progress: {0} files · +{1} −{2}", totals.files, totals.added, totals.deleted) : t("In progress: {0} files", totals.files);
  return (
    <button type="button" className="live-chip" onClick={reveal} title={t("What Claude changed so far in this turn — click to see the files")} aria-label={label} data-testid="HUD in progress">
      <span className="round-pulse" aria-hidden="true" />
      <span className="num long">{label}</span>
      {/* wave3 check-clients: a narrow HUD shows the count only (as the Mac's chip), the words stay in the label. */}
      <span className="num short" aria-hidden="true">{totals.files}</span>
    </button>
  );
}
