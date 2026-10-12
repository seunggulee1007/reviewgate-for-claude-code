/**
 * Chat history (docs/M15-POLISH.md): every session of the project — title, relative time, turns,
 * cost — with search, Open / Rename (inline) / Archive toggle / Delete (confirmed; the current chat
 * cannot be deleted). Archived chats are hidden unless "Show archived" is on.
 */
import { useEffect, useState } from "react";
import { relativeTime, t } from "../../i18n";
import type { SessionMeta } from "@reviewgate/engine";
import { sessionsOf, sessionSwitchRefusal } from "../../sessions";
import { useStore } from "../../store";
import { RecordOnlyBadge, recordOnlyNote, recordOnlyQuestion } from "../chat/RecordOnly";
import { Modal } from "../Menu";
import "./dialogs.css";
import { ContinueInTerminalButton } from "../OtherSessions"; // MARK: wave3 desktop-session
// MARK: wave4 w4-history — §38.3 the search also reads the messages; opening a match scrolls to it
import type { TranscriptSearchMatch } from "@reviewgate/engine";
import { chatSearchRows, jumpToRow, searchMessages } from "../../transcriptHistory";
import "../chat/olderRows.css";
import { isEnter } from "../../ime";
import { MovedChatBadge } from "../chat/ChatMoveViews"; // MARK: wave4b w4b-follow — §39.4 "옮김 → <worktree>" in the chat list too
import { MatchLines } from "./SearchMatchLines"; // MARK: wave4c w4c-review — §41.3 three lines per chat + "N건 더"

/** `highlight`: a chat to point at (§30 resume notice → "이전 대화 보기"). */
export function HistoryDialog({ onClose, highlight }: { onClose: () => void; highlight?: string }) {
  const state = useStore((s) => s.state);
  const openChat = useStore((s) => s.openChat);
  const renameChat = useStore((s) => s.renameChat);
  const archiveChat = useStore((s) => s.archiveChat);
  const deleteChat = useStore((s) => s.deleteChat);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(() => highlight !== undefined && sessionsOf(state).list.some((m) => m.id === highlight && m.archived === true));
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // §30: a chat only its transcript is left of asks before it is opened.
  const [confirmOpen, setConfirmOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (highlight) document.querySelector(`[data-testid="History ${CSS.escape(highlight)}"]`)?.scrollIntoView({ block: "center" });
  }, [highlight]);

  const sessions = sessionsOf(state);
  const refusal = sessionSwitchRefusal(state);
  // MARK: wave4 w4-history — §38.3: the messages too (debounced; an engine before §38.3 answers nothing: titles only).
  const [matches, setMatches] = useState<{ query: string; list: TranscriptSearchMatch[] | null } | null>(null);
  useEffect(() => {
    const qq = query.trim();
    if (!qq) {
      setMatches(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void searchMessages(qq).then((list) => {
        if (live) setMatches({ query: qq, list });
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const searching = query.trim() !== "" && matches?.query !== query.trim();
  const found = chatSearchRows(sessions.list, query, matches?.query === query.trim() ? matches.list : null);
  const matchOf = new Map(found.map((r) => [r.meta.id, r.match] as const));
  const rows = found.map((r) => r.meta).filter((m) => showArchived || !m.archived);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const commitRename = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    const current = sessions.list.find((m) => m.id === editing.id);
    if (title && current && title !== current.title) await act(() => renameChat(editing.id, title));
    setEditing(null);
  };

  return (
    <Modal title={t("Chat history")} onClose={busy ? undefined : onClose} wide testId="History dialog">
      <div className="row">
        <input type="text" className="grow" placeholder={t("Search chats…")} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus data-testid="History search" />
        <label className="check caption">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {t("Show archived")}
        </label>
      </div>
      <div className="history-list scroll" data-testid="History list">
        {rows.length === 0 && !searching && <div className="empty faint">{sessions.list.length === 0 ? t("No chats yet") : t("No matching chats")}</div>}
        {searching && <div className="caption faint" data-testid="History searching">{t("Searching the messages…")}</div>}
        {rows.map((m) => (
          <HistoryRow
            key={m.id}
            meta={m}
            current={m.id === sessions.currentId}
            refusal={refusal}
            busy={busy}
            editing={editing?.id === m.id ? editing.title : null}
            confirming={confirmDelete === m.id}
            highlighted={highlight === m.id}
            match={matchOf.get(m.id) ?? null}
            confirmingOpen={confirmOpen === m.id}
            onCancelOpen={() => setConfirmOpen(null)}
            onEdit={(title) => setEditing(title === null ? null : { id: m.id, title })}
            onCommitRename={() => void commitRename()}
            onOpen={(confirmed, row) => {
              if (m.resumeFailed && m.id !== sessions.currentId && !confirmed) {
                setConfirmOpen(m.id);
                return;
              }
              setConfirmOpen(null);
              const match = matchOf.get(m.id); // MARK: wave4 w4-history — §38.3 open at the matched row
              const target = row ?? match?.row; // MARK: wave4c w4c-review — §41.3 the clicked one of its lines
              if (target !== undefined) jumpToRow(m.id, target);
              void act(async () => {
                if (await openChat(m.id)) onClose();
              });
            }}
            onArchive={() => void act(() => archiveChat(m.id, !(m.archived === true)))}
            onDelete={(confirmed) => {
              if (!confirmed) setConfirmDelete(confirmDelete === m.id ? null : m.id);
              else void act(() => deleteChat(m.id)).then(() => setConfirmDelete(null));
            }}
          />
        ))}
      </div>
      <div className="actions">
        {busy && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" onClick={onClose} disabled={busy} data-testid="Close history">{t("Done")}</button>
      </div>
    </Modal>
  );
}

function HistoryRow(props: {
  meta: SessionMeta;
  current: boolean;
  refusal: string | null;
  busy: boolean;
  editing: string | null;
  confirming: boolean;
  highlighted: boolean;
  /** MARK: wave4 w4-history — §38.3: the message line the search found in this chat. */
  match: TranscriptSearchMatch | null;
  confirmingOpen: boolean;
  onCancelOpen: () => void;
  onEdit: (title: string | null) => void;
  onCommitRename: () => void;
  /** `row` (wave4c w4c-review, §41.3): the search line clicked — the chat opens there. */
  onOpen: (confirmed: boolean, row?: number) => void;
  onArchive: () => void;
  onDelete: (confirmed: boolean) => void;
}) {
  const { meta: m, current, refusal, busy } = props;
  const openDisabled = busy || (!current && refusal !== null);
  return (
    <div className={`history-row ${current ? "current" : ""} ${m.archived ? "archived" : ""} ${props.highlighted ? "highlight" : ""}`} data-testid={`History ${m.id}`}>
      <div className="col grow" style={{ gap: 2 }}>
        {props.editing !== null ? (
          <input
            type="text"
            value={props.editing}
            autoFocus
            maxLength={60}
            onChange={(e) => props.onEdit(e.target.value)}
            onBlur={props.onCommitRename}
            onKeyDown={(e) => {
              if (isEnter(e)) props.onCommitRename();
              if (e.key === "Escape") props.onEdit(null);
            }}
            data-testid="Rename input"
          />
        ) : (
          <div className="row" style={{ gap: 6 }}>
            <span className="bold truncate" title={m.lastUserText ?? undefined}>{m.title}</span>
            {current && <span className="pill">{t("current")}</span>}
            {m.archived && <span className="pill gray">{t("archived")}</span>}
            {m.resumeFailed && <RecordOnlyBadge />}
            {m.movedTo && <MovedChatBadge moved={m.movedTo} />}
          </div>
        )}
        {props.match && <MatchLines match={props.match} disabled={openDisabled} onOpenAt={(row) => props.onOpen(false, row)} /> /* MARK: wave4c w4c-review — §41.3 */}
        <div className="caption muted truncate">
          {relativeTime(m.updatedAt)} · {t("{0} turn(s)", m.turns)} · ${m.costUSD.toFixed(4)}
        </div>
      </div>
      <div className="row" style={{ gap: 4, flex: "none" }}>
        {props.confirmingOpen ? (
          <>
            <span className="caption orange" title={recordOnlyNote()} style={{ maxWidth: 300 }}>{recordOnlyQuestion()}</span>
            <button type="button" className="primary small" disabled={openDisabled} onClick={() => props.onOpen(true)} data-testid="Confirm open record only">{t("View content")}</button>
            <button type="button" className="small" disabled={busy} onClick={props.onCancelOpen}>{t("Cancel")}</button>
          </>
        ) : props.confirming ? (
          <>
            <span className="caption red">{t("Delete this chat?")}</span>
            <button type="button" className="danger small" disabled={busy} onClick={() => props.onDelete(true)} data-testid="Confirm delete">{t("Delete")}</button>
            <button type="button" className="small" disabled={busy} onClick={() => props.onDelete(false)}>{t("Cancel")}</button>
          </>
        ) : (
          <>
            <button type="button" className="small" disabled={openDisabled} title={!current && refusal ? refusal : undefined} onClick={() => props.onOpen(false)} data-testid="Open chat">
              {t("Open")}
            </button>
            {/* wave3 desktop-session — §36.9 "터미널에서 이어가기" */}
            <ContinueInTerminalButton meta={m} current={current} />
            <button type="button" className="plain small" disabled={busy} onClick={() => props.onEdit(m.title)}>{t("Rename")}</button>
            <button type="button" className="plain small" disabled={busy} onClick={props.onArchive}>{m.archived ? t("Unarchive") : t("Archive")}</button>
            <button type="button" className="plain small danger" disabled={busy || current} title={current ? t("The current chat cannot be deleted.") : undefined} onClick={() => props.onDelete(false)}>
              {t("Delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
