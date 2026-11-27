/**
 * §62 / §65.8 — small pieces the navigation views share (the peek list, the references strip and tab, the project file
 * view): a preview line with the name marked, and the Back / Forward buttons. No Monaco here.
 */
import { t } from "../i18n";
import { useStore } from "../store";
import { markSymbol } from "./navModel";
import { sourceHelp, sourceLabel } from "./navSource";
import { backBlocked, forwardBlocked, useNav, type NavAnswer } from "./navStore";

/** §73.5: "Exact" / "Estimated" with its tooltip (who answered, why the search did). */
export function NavSourceBadge(props: NavAnswer) {
  const exact = props.source === "lsp";
  const help = sourceHelp(props.source, props.fallback);
  return (
    <span className={`nav-source${exact ? " exact" : ""}`} title={help} aria-label={`${sourceLabel(props.source)}: ${help}`} data-testid="Nav source">
      {sourceLabel(props.source)}
    </span>
  );
}

/** §73.5: "Starting the language server…" while `state.nav.lsp` starts (nothing otherwise). */
export function LspStartingNote() {
  const starting = useStore((s) => s.state.nav?.lsp?.status === "starting");
  if (!starting) return null;
  return (
    <span className="caption muted nav-lsp-starting" data-testid="Language server starting">
      {t("Starting the language server…")}
    </span>
  );
}

/** The symbol marked in a preview line. */
export function Preview(props: { text: string; symbol: string }) {
  return (
    <div className="nav-preview" title={props.text}>
      {markSymbol(props.text, props.symbol).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </div>
  );
}

/** ← / → (Alt+← / Alt+→): each says why it cannot go when it cannot. `always`: shown even with no history yet. */
export function NavHistoryButtons(props: { always?: boolean }) {
  const history = useNav((s) => s.history);
  if (!props.always && history.back.length === 0 && history.forward.length === 0) return null;
  const back = backBlocked(history);
  const forward = forwardBlocked(history);
  return (
    <span className="nav-history" role="group" aria-label={t("Back") + " / " + t("Forward")}>
      <button type="button" className="small" disabled={back !== null} onClick={() => useNav.getState().back()} title={back ?? `${t("Back")} (Alt+←)`} aria-label={t("Back")} data-testid="Nav back">
        ←
      </button>
      <button type="button" className="small" disabled={forward !== null} onClick={() => useNav.getState().forward()} title={forward ?? `${t("Forward")} (Alt+→)`} aria-label={t("Forward")} data-testid="Nav forward">
        →
      </button>
    </span>
  );
}
