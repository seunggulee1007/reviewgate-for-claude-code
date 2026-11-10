# M15 — Polish: refresh, chat history, chat tabs

## Engine
### Refresh
- `refresh { scope?: ("review"|"branches"|"workbenches"|"pr"|"accounts")[] }` (default all applicable). `review`: when phase is `reviewing` → re-snapshot B and re-diff against A (external edits appear; files whose diff became empty are dropped; new files appear pending); when `idle` with an open project → detect worktree changes vs HEAD? NO — keep the gate turn-based; idle refresh only re-reads branches/workbenches/identity. Reply `result`.

### Chat sessions (history + tabs)
Storage under `<gitDir>/reviewgate/sessions/`:
- `index.json`: `{ version:1, sessions: SessionMeta[] }`, `SessionMeta = { id /* claude sessionId */, title, createdAt, updatedAt, turns, costUSD, lastUserText, archived?: boolean }`
- `<id>.ndjson`: transcript rows (move the current single transcript file here; keep migration: existing `reviewgate-transcript.ndjson` becomes the first session's file).
- `reviewgate-session.json` keeps `{ currentId, openTabIds: string[] }`.
Commands:
- `session_list` → `state.sessions`
- `session_new` → stops the current Claude session (refused while `running`/`collecting`/`reverting`, and while the review is bound to this chat: `collect_failed` / `review_pending` (changes requested) / `notes_pending` (unsent notes) — plainly pending files do not block, see docs/PROTOCOL.md §9), starts a fresh session (no resume), creates meta with title "New chat" until the first user message (then title = first line ≤ 60 chars), emits `transcript_restore {items: []}`.
- `session_open { id }` → same guards; resumes that session (`resume: id`), emits `transcript_restore` with its rows. If resume fails (CLI can't find it) → fall back to a fresh session and mark meta `resumeFailed: true` (still keep transcript for reading).
- `session_rename { id, title }`, `session_archive { id, archived }`, `session_delete { id }` (refused for the current one).
- `tabs_set { openTabIds: string[] }` — client persists which tabs are open (engine stores it; harmless if clients ignore).
State: `state.sessions = { list: SessionMeta[] (newest first), currentId: string|null, openTabIds: string[] }`. `state.session.sessionId` stays.
Rules: exactly one live Claude session per engine (worktree). Every turn end updates meta (turns, cost, updatedAt, title if still "New chat").

## Clients (Mac + Electron)
- Toolbar/menu Refresh (⌘R): `refresh`; PR tab already had refresh — unify.
- Chat pane header becomes a **tab strip**: one tab per `openTabIds` (title, dot when it's the running one, close ×), `+` = `session_new`, overflow menu "History…" opens a sheet/popover listing all sessions (title, relative time, turns, cost; actions Open / Rename / Archive / Delete; search). Clicking a tab = `session_open` (disabled with tooltip when the engine would refuse: running / review pending). Transcript swaps on `transcript_restore`. Closing a tab just removes it from `openTabIds` (session stays in history).
- Window/pane persistence: split positions, sidebar tab, last selected file — per project in UserDefaults / electron settings.
- Empty state of a fresh chat: keep the existing hint.

## Tests
engine: session lifecycle (new → send → meta title/turns/cost; open resumes with rows; delete/rename/archive; guards; migration of the legacy transcript file), refresh re-diff picks up an external edit and drops an externally reverted file.
clients: protocol decode; GUI: create two chats, switch, history sheet, refresh after external edit shows the change.
