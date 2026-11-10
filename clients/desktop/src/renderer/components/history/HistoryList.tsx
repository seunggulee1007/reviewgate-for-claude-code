/**
 * The sidebar's History tab (docs/PROTOCOL.md §14): completed review rounds, newest first — when, the prompt
 * that started them and verdict counts; a round expands to its files (verdict, partial reverts, commits) and the
 * notes sent with "request changes". Clicking a file shows its diff from that round read-only in the diff pane.
 * wave2 desktop-flow (§34.4): the round still in progress (`review_history.current`) comes first, marked "진행 중", with
 * the notes already sent in it.
 */
import { useState } from "react";
import type { HistoryVerdict, ReviewHistoryEntry, ReviewHistoryFile } from "@reviewgate/engine";
import { formatDate, relativeTime, t } from "../../i18n";
import { useStore } from "../../store";
import { PathText, statusColor } from "../ChangedFiles";
import "./history.css";
import "../reviewRound.css";
import { filterHistoryEntries } from "../../transcriptHistory"; // MARK: wave4 w4-history (§38.3)
import { AutoAcceptedBadge } from "../trust/TrustViews"; // MARK: wave4c w4c-trust (§41.2)

type Verdict = HistoryVerdict | "pending";
const VERDICTS: Verdict[] = ["accepted", "rejected", "changes_requested", "pending"];

export function verdictLabel(v: Verdict): string {
  switch (v) {
    case "accepted":
      return t("Accepted");
    case "rejected":
      return t("Rejected");
    case "changes_requested":
      return t("Changes requested");
    case "pending":
      return t("Unresolved");
  }
}

export function verdictTone(v: Verdict): string {
  switch (v) {
    case "accepted":
      return "green";
    case "rejected":
      return "red";
    case "changes_requested":
      return "orange";
    case "pending":
      return "gray";
  }
}

const verdictGlyph = (v: Verdict) => (v === "accepted" ? "✓" : v === "rejected" ? "↶" : v === "changes_requested" ? "!" : "…");

export function VerdictChip({ verdict, count }: { verdict: Verdict; count?: number }) {
  return (
    <span className={`pill ${verdictTone(verdict)} verdict-chip`} title={verdictLabel(verdict)} data-testid={`Verdict ${verdict}`}>
      {verdictGlyph(verdict)} {count !== undefined ? count : verdictLabel(verdict)}
    </span>
  );
}

export function HistoryList() {
  const history = useStore((s) => s.reviewHistory);
  const load = useStore((s) => s.loadReviewHistory);
  const view = useStore((s) => s.historyView);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // wave2 desktop-flow — §34.4: the round in progress first (never among `entries`).
  const current = history.current ?? null;
  const all = current ? [current, ...history.entries.filter((e) => e.id !== current.id)] : history.entries;
  // MARK: wave4 w4-history — §38.3: find a past change by path, request, note or commit subject.
  const [query, setQuery] = useState("");
  const entries = filterHistoryEntries(all, query);
  // The newest round starts expanded so its files are one click away.
  const isOpen = (e: ReviewHistoryEntry, i: number) => expanded[e.id] ?? (i === 0 || view?.entry.id === e.id);

  return (
    <div className="col grow history-pane" data-testid="Review history">
      <div className="row history-toolbar">
        <span className="caption muted truncate grow">{t("{0} review round(s)", history.entries.length)}</span>
        <label className="check caption" title={t("Include the review rounds of every chat in this workspace")}>
          <input type="checkbox" checked={history.all} onChange={(e) => void load(e.target.checked)} data-testid="History all chats" />
          {t("All chats")}
        </label>
        {history.loading ? (
          <span className="spinner" />
        ) : (
          <button type="button" className="plain small icon" title={t("Refresh")} aria-label={t("Refresh")} onClick={() => void load()} data-testid="History refresh">↻</button>
        )}
      </div>
      <div className="row history-search">
        <input
          type="search"
          className="grow"
          placeholder={t("Search paths, requests, notes, commits")}
          aria-label={t("Search paths, requests, notes, commits")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="Review history search"
        />
      </div>
      <hr />
      {history.error && <div className="banner orange caption">{history.error}</div>}
      {query.trim() !== "" && entries.length === 0 && all.length > 0 && <div className="history-empty muted caption" data-testid="Review history no match">{t("No matching review round")}</div>}
      <ul className="list scroll rh-list" data-testid="History entries">
        {all.length === 0 && !history.loading && !history.error && (
          <li className="history-empty muted caption">
            {history.all ? t("No review rounds yet.") : t("No review rounds in this chat yet.")}
            <span className="faint"> {t("A round is recorded when its files have all been decided or the next request starts.")}</span>
          </li>
        )}
        {entries.map((e, i) => (
          <HistoryEntryRow
            key={e.id}
            entry={e}
            open={isOpen(e, i)}
            onToggle={() => setExpanded((x) => ({ ...x, [e.id]: !isOpen(e, i) }))}
          />
        ))}
      </ul>
    </div>
  );
}

function HistoryEntryRow({ entry, open, onToggle }: { entry: ReviewHistoryEntry; open: boolean; onToggle: () => void }) {
  const view = useStore((s) => s.historyView);
  const openHistoryDiff = useStore((s) => s.openHistoryDiff);
  const counts = VERDICTS.map((v) => [v, entry.files.filter((f) => f.verdict === v).length] as const).filter(([, n]) => n > 0);
  const adds = entry.files.reduce((n, f) => n + f.adds, 0);
  const dels = entry.files.reduce((n, f) => n + f.dels, 0);
  const notesOf = (f: ReviewHistoryFile) => entry.notes.filter((n) => n.path === f.path);
  const inProgress = entry.inProgress === true; // wave2 desktop-flow — §34.4 `review_history.current`
  return (
    <li className={`history-entry ${open ? "open" : ""} ${view?.entry.id === entry.id ? "viewing" : ""} ${inProgress ? "in-progress" : ""}`} data-testid={`History entry ${entry.id}`}>
      <button type="button" className="entry-head plain" onClick={onToggle} aria-expanded={open}>
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <div className="col grow" style={{ gap: 3 }}>
          <div className="row" style={{ gap: 6 }}>
            {inProgress && (
              <span className="pill blue" title={t("This review round is still going on — it is recorded when its files are all decided or the next request starts")} data-testid="History in progress">
                {t("In progress")}
              </span>
            )}
            <span className="caption bold num" title={`${formatDate(entry.startedAt)} → ${formatDate(entry.endedAt)}`}>{relativeTime(entry.endedAt)}</span>
            <span className="tiny faint num truncate">{formatDate(entry.endedAt)}</span>
            <span className="spacer" />
            <span className="tiny num green">+{adds}</span>
            <span className="tiny num red">−{dels}</span>
          </div>
          <div className="entry-prompt" title={entry.prompt}>{entry.prompt || t("(no prompt)")}</div>
          <div className="row wrap" style={{ gap: 4 }}>
            {counts.map(([v, n]) => (
              <VerdictChip key={v} verdict={v} count={n} />
            ))}
            {entry.notes.length > 0 && <span className="pill gray" title={t("Notes sent with request changes")}>💬 {entry.notes.length}</span>}
            {entry.turns.length > 1 && <span className="tiny faint">{t("{0} turns", entry.turns.length)}</span>}
          </div>
        </div>
      </button>
      {open && (
        <ul className="entry-files">
          {entry.files.map((f) => {
            const current = view?.entry.id === entry.id && view.path === f.path;
            const notes = notesOf(f);
            return (
              <li key={f.path} className={current ? "selected" : ""}>
                <button
                  type="button"
                  className="entry-file plain"
                  onClick={() => openHistoryDiff(entry, f.path)}
                  title={f.oldPath ? t("{0} (from {1})", f.path, f.oldPath) : f.path}
                  data-testid={`History file ${f.path}`}
                >
                  <span className={`glyph mono bold ${statusColor(f.status)}`}>{f.status}</span>
                  <PathText path={f.path} />
                  <span className="tiny num green">+{f.adds}</span>
                  <span className="tiny num red">−{f.dels}</span>
                  <VerdictChip verdict={f.verdict} />
                  {f.verdict === "accepted" && <AutoAcceptedBadge rule={f.autoAccepted} path={f.path} />}{/* MARK: wave4c w4c-trust (§41.2) */}
                </button>
                {(f.rejectedHunks || f.committed || f.changesRequested || notes.length > 0) && (
                  <div className="entry-file-meta">
                    {f.rejectedHunks ? <span className="pill orange">↶ {t("Partly reverted {0}", f.rejectedHunks)}</span> : null}
                    {f.committed && <span className="pill green" title={f.commit ? t("Commit: {0}", f.commit.subject) : undefined}>{t("committed")}</span>}
                    {f.changesRequested ? <span className="pill gray">{t("sent back {0}×", f.changesRequested)}</span> : null}
                  </div>
                )}
                {notes.length > 0 && (
                  <ul className="entry-notes">
                    {notes.map((n, i) => (
                      <li key={i}>
                        {n.line !== null && <span className="mono tiny faint">{n.side === "old" ? "−" : "+"}{n.line}</span>}
                        <span className="note-body">{n.body}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
