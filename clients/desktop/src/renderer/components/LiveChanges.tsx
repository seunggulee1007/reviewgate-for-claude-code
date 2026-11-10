/**
 * wave2 desktop-flow — "진행 중 변경 (아직 수락 불가)" (docs/PROTOCOL.md §34.6): while a turn runs, the files it changed so far
 * (`live_changes`: its own start tree → a snapshot now) above the review list — read-only, nothing here can be accepted.
 * A row opens its diff (`live_diff`) where the review diff normally is; the turn's end turns them into the review.
 * Shown only once the turn touched a file (`hud.turnFiles`, an engine before §34 never sends it).
 */
import type { GeneratedKind, LiveChangedFile } from "@reviewgate/engine";
import { t } from "../i18n";
import { liveTotals } from "../reviewRound";
import { useStore } from "../store";
import { PathText, statusColor } from "./ChangedFiles";
import "./reviewRound.css";

export function generatedLabel(kind: GeneratedKind | string): string {
  switch (kind) {
    case "lockfile":
      return t("lockfile");
    case "minified":
      return t("minified");
    default:
      return t("generated file");
  }
}

export function LiveChanges() {
  const running = useStore((s) => s.state.gate.phase === "running");
  const turnFiles = useStore((s) => s.state.hud.turnFiles ?? 0);
  const live = useStore((s) => s.live);
  const open = useStore((s) => s.liveOpen);
  const setOpen = useStore((s) => s.setLiveOpen);
  const refresh = useStore((s) => s.refreshLive);
  const viewing = useStore((s) => s.liveView?.path ?? null);
  const openLiveDiff = useStore((s) => s.openLiveDiff);
  if (!running || (turnFiles === 0 && live.files.length === 0)) return null;
  const totals = liveTotals(live.files, turnFiles);
  return (
    <div className="live-changes" data-testid="Live changes">
      <div className="live-head">
        <button type="button" className="plain live-toggle" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="Live changes toggle">
          <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="round-pulse" aria-hidden="true" />
          <span className="bold truncate">{t("In progress (can't accept yet)")}</span>
        </button>
        <span className="group-count num" title={t("In progress: {0} files · +{1} −{2}", totals.files, totals.added, totals.deleted)}>{totals.files}</span>
        {live.loading ? (
          <span className="spinner" aria-label={t("Loading…")} />
        ) : (
          <button type="button" className="plain small icon" onClick={() => void refresh()} title={t("Read the changes so far again")} aria-label={t("Read the changes so far again")} data-testid="Live changes refresh">↻</button>
        )}
      </div>
      {open && (
        <ul className="list live-list" data-testid="Live changes files">
          {live.error && <li className="caption orange live-note">{live.error}</li>}
          {live.files.length === 0 && !live.error && <li className="caption faint live-note">{live.loading ? t("Loading…") : t("Claude has changed {0} file(s) so far", turnFiles)}</li>}
          {live.files.map((f) => (
            <LiveRow key={f.path} f={f} selected={viewing === f.path} onOpen={openLiveDiff} />
          ))}
          {live.truncated && <li className="caption faint live-note">{t("Showing the first {0} files", live.files.length)}</li>}
        </ul>
      )}
    </div>
  );
}

function LiveRow({ f, selected, onOpen }: { f: LiveChangedFile; selected: boolean; onOpen: (path: string) => void }) {
  return (
    <li
      className={selected ? "selected" : ""}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onOpen(f.path)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen(f.path);
      }}
      title={f.oldPath ? t("{0} (from {1})", f.path, f.oldPath) : f.path}
      data-testid={`Live file ${f.path}`}
    >
      <div className="file-row">
        <span className={`glyph ${statusColor(f.status)}`}>{f.status}</span>
        <div className="grow col" style={{ gap: 2 }}>
          <div className="path">
            <PathText path={f.path} />
            <span className="spacer" />
            {f.isBinary ? <span className="tiny faint">{t("binary")}</span> : (
              <>
                <span className="tiny num green">+{f.added}</span>
                <span className="tiny num red">−{f.deleted}</span>
              </>
            )}
          </div>
          {(f.inReview || f.generated) && (
            <div className="tools">
              {f.inReview && <span className="pill gray risk" title={t("This file also waits in the review — the review shows it as it was before this turn")}>{t("Also in the review")}</span>}
              {f.generated && <span className="pill gray risk">{generatedLabel(f.generated)}</span>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
