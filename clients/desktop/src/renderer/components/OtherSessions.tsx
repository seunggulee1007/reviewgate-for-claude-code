/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.9 (market-03): the user's terminal Claude sessions of this repository, in the sidebar — "이 저장소의
 * 다른 Claude 세션" (name, folder, 작업 중 / 입력 대기 / 쉬는 중; one in this folder is marked: its changes can mix into
 * this review), refreshed every 30 s while the window is frontmost — and "CLI 세션 가져오기": a terminal conversation
 * resumed as a new chat of this window, from which on the review gate applies. "터미널에서 이어가기" copies
 * `cd <folder> && claude --resume <id>`. An engine before §36.9: no section, no sheet.
 */
import { useEffect, useState } from "react";
import type { CliResumableSession, CliRunningSession, SessionMeta } from "@reviewgate/engine";
import { relativeTime, t } from "../i18n";
import { importedOf, runningStatusLabel, sortRunning, terminalResumeCommand } from "../sessionTools";
import { sessionsOf, sessionSwitchRefusal } from "../sessions";
import { lastComponent, readBool, useStore, writeBool } from "../store";
import { showToast } from "../toast";
import { Modal } from "./Menu";
import "./sessionTools.css";
// MARK: wave4d w4d-peers
import type { PeerSelf } from "@reviewgate/engine";
import { selfCopyText } from "../peerSessions";

const REFRESH_MS = 30_000;
const OPEN_KEY = "rg.otherSessions.open";

/** Calls `refresh` now, when the window comes to the front, and every 30 s while it is frontmost and visible. */
function useFrontmostRefresh(refresh: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const tick = () => {
      if (document.hasFocus() && document.visibilityState !== "hidden") refresh();
    };
    const id = setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, enabled]);
}

/** Copies `text` and says so in the toast. */
function copyCommand(text: string): void {
  void window.rg.copyText(text).then(() => showToast(t("Copied: {0}", text)));
}

/** The sidebar section (Changes tab), connected to the store. */
export function OtherSessionsSection() {
  const root = useStore((s) => s.state.project?.root ?? null);
  const supported = useStore((s) => s.cliSessionsSupported);
  const sessions = useStore((s) => s.cliSessions);
  const loading = useStore((s) => s.cliSessionsLoading);
  const error = useStore((s) => s.cliSessionsError);
  const load = useStore((s) => s.loadCliSessions);
  const importOpen = useStore((s) => s.cliImportOpen);
  const setImportOpen = useStore((s) => s.setCliImportOpen);
  const [open, setOpen] = useState(() => readBool(OPEN_KEY, true));
  useFrontmostRefresh(load, root !== null && supported);
  if (!root || !supported) return null;
  return (
    <>
      <OtherSessionsView
        running={sessions ? sortRunning(sessions.running) : null}
        // The 30 s refresh does not flash a spinner over a list already shown.
        loading={loading && sessions === null}
        error={error}
        open={open}
        onToggle={() => {
          setOpen(!open);
          writeBool(OPEN_KEY, !open);
        }}
        onImport={() => setImportOpen(true)}
        self={sessions?.self ?? null} // MARK: wave4d w4d-peers
      />
      {importOpen && <CliImportDialog onClose={() => setImportOpen(false)} />}
    </>
  );
}

/** The section itself (props only, so it renders in tests). `running`: null until the first reply. */
// MARK: wave4d w4d-peers
/** §42.2: "다른 세션에 보이는 이 창 이름: ReviewGate · acme [복사]" — the name to tell a terminal Claude, its address on hover. */
export function PeerSelfLine({ self }: { self: PeerSelf }) {
  const copy = selfCopyText(self);
  if (!copy) return null;
  return (
    <div className="os-self" data-testid="Peer self" title={t("Tell a terminal Claude to send to this name and the message comes to this window. {0}", copy)}>
      <div className="os-self-text">
        <div className="caption faint">{t("This window's name for other sessions")}</div>
        <div className="os-self-name truncate">{self.name ?? self.address}</div>
      </div>
      <button type="button" className="plain small" onClick={() => copyCommand(copy)} title={t("Copy this window's name and address")} aria-label={t("Copy this window's name and address")} data-testid="Copy peer name">
        {t("Copy")}
      </button>
    </div>
  );
}

export function OtherSessionsView(p: { running: CliRunningSession[] | null; loading: boolean; error: string | null; open: boolean; onToggle: () => void; onImport: () => void; self?: PeerSelf | null }) {
  const waiting = p.running?.filter((r) => r.status === "waiting").length ?? 0;
  return (
    <section className="other-sessions" aria-label={t("Other Claude sessions in this repository")} data-testid="Other Claude sessions">
      <div className="os-head">
        <button type="button" className="plain small os-toggle" aria-expanded={p.open} onClick={p.onToggle} data-testid="Other sessions toggle">
          <span aria-hidden="true">{p.open ? "▾" : "▸"}</span>
          <span className="truncate">{t("Other Claude sessions in this repository")}</span>
          {p.running && p.running.length > 0 && <span className="os-count">{p.running.length}</span>}
          {/* Collapsed, the header still says who waits for input (expanded, the rows say it). */}
          {!p.open && waiting > 0 && (
            <span className="pill orange" title={runningStatusLabel("waiting")}>
              {runningStatusLabel("waiting")} {waiting}
            </span>
          )}
        </button>
        {p.loading && <span className="spinner" aria-hidden="true" />}
        <button type="button" className="plain small" onClick={p.onImport} title={t("Import a CLI session")} data-testid="Import CLI session">
          {t("Import")}
        </button>
      </div>
      {p.open && (
        <div className="os-body">
          {p.running && p.running.length > 0 && (
            <ul className="os-list">
              {p.running.map((r) => (
                <li key={r.pid} className={`os-row ${r.sameWorktree ? "same" : ""}`} title={[r.cwd, `pid ${r.pid}${r.entrypoint ? ` · ${r.entrypoint}` : ""}`, r.sessionId ?? ""].filter(Boolean).join("\n")} data-testid={`Other session ${r.pid}`}>
                  <span className={`os-status ${r.status}`}>{runningStatusLabel(r.status)}</span>
                  <span className="os-name truncate">{r.name ?? (r.sessionId ? r.sessionId.slice(0, 8) : `pid ${r.pid}`)}</span>
                  <span className="os-folder truncate">{lastComponent(r.cwd)}</span>
                  {r.sameWorktree && (
                    <span className="pill orange os-same" title={t("Works in this folder — its changes can mix into this review")}>
                      {t("This folder")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {p.running && p.running.length === 0 && <div className="caption faint os-empty">{t("No other Claude sessions here right now.")}</div>}
          {p.error && <div className="caption orange os-empty" role="alert">{p.error}</div>}
          {p.self && <PeerSelfLine self={p.self} />}
        </div>
      )}
    </section>
  );
}

/** "CLI 세션 가져오기", connected to the store. */
export function CliImportDialog({ onClose }: { onClose: () => void }) {
  const sessions = useStore((s) => s.cliSessions);
  const loading = useStore((s) => s.cliSessionsLoading);
  const importing = useStore((s) => s.importingSessionId);
  const error = useStore((s) => s.cliImportError);
  const blocked = useStore((s) => sessionSwitchRefusal(s.state));
  const folder = useStore((s) => s.state.project?.path ?? "");
  const doImport = useStore((s) => s.importCliSession);
  return (
    <Modal title={t("Import a CLI session")} onClose={importing ? undefined : onClose} wide testId="CLI import dialog">
      <CliImportView
        resumable={sessions?.resumable ?? null}
        loading={loading}
        importing={importing}
        error={error}
        blocked={blocked}
        folder={folder}
        platform={window.rg.platform}
        onImport={(id) => void doImport(id)}
        onCopy={copyCommand}
      />
      <div className="actions">
        <span className="spacer" />
        <button type="button" onClick={onClose} disabled={importing !== null} data-testid="CLI import close">{t("Done")}</button>
      </div>
    </Modal>
  );
}

/** The sheet's body (props only). `folder`: this window's folder, for a session without its own `cwd`. */
export function CliImportView(p: { resumable: CliResumableSession[] | null; loading: boolean; importing: string | null; error: string | null; blocked: string | null; folder: string; platform: string; onImport: (sessionId: string) => void; onCopy: (command: string) => void }) {
  return (
    <div className="cli-import">
      <div className="cli-import-gate" role="note">
        <span className="bold">{t("The review gate applies from here on")}</span>
        <span className="caption">{t("The conversation continues in a new chat of this window. What the terminal session already changed is the starting point, not part of a review.")}</span>
      </div>
      {p.blocked && <div className="caption orange" data-testid="CLI import blocked">{p.blocked}</div>}
      {p.error && <div className="caption cli-import-error" role="alert" data-testid="CLI import error">{p.error}</div>}
      {p.resumable === null ? (
        <div className="empty faint" style={{ height: "auto" }}>{p.loading ? <span className="spinner" aria-hidden="true" /> : null}</div>
      ) : p.resumable.length === 0 ? (
        <div className="empty faint" style={{ height: "auto" }}>{t("No terminal conversations of this repository to import.")}</div>
      ) : (
        <ul className="cli-import-list scroll">
          {p.resumable.map((r) => {
            const command = terminalResumeCommand(r.cwd ?? p.folder, r.sessionId, p.platform);
            return (
              <li key={r.sessionId} className="cli-import-row" data-testid={`CLI resumable ${r.sessionId}`}>
                <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                  <span className="bold truncate" title={r.title}>{r.title || r.sessionId.slice(0, 8)}</span>
                  <span className="caption muted truncate" title={r.cwd ?? undefined}>
                    {[relativeTime(r.updatedAt), r.cwd ? lastComponent(r.cwd) : ""].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {p.importing === r.sessionId && <span className="spinner" aria-hidden="true" />}
                <button type="button" className="small plain" onClick={() => p.onCopy(command)} title={t("Copies: {0}", command)} data-testid={`CLI continue ${r.sessionId}`}>
                  {t("Continue in terminal")}
                </button>
                <button type="button" className="small primary" disabled={p.importing !== null || p.blocked !== null} onClick={() => p.onImport(r.sessionId)} title={p.blocked ?? undefined} data-testid={`CLI import ${r.sessionId}`}>
                  {t("Import")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One line above the transcript of a chat imported from the terminal (`SessionMeta.imported`). */
export function ImportedChatNotice() {
  const meta = useStore((s) => {
    const ss = sessionsOf(s.state);
    return ss.list.find((m) => m.id === ss.currentId) ?? null;
  });
  const imported = importedOf(meta);
  if (!imported) return null;
  return (
    <div className="imported-notice" role="note" data-testid="Imported chat notice">
      <span aria-hidden="true">⇣</span>
      <span className="grow truncate" title={imported.cwd ?? undefined}>
        {imported.cwd ? t("Imported from the terminal ({0})", lastComponent(imported.cwd)) : t("Imported from the terminal")} · {t("The review gate applies from here on")}
      </span>
    </div>
  );
}

/**
 * "터미널에서 이어가기" for a chat of this app (Chat history): copies `cd <this window's folder> && claude --resume <id>`.
 * Not for a chat Claude Code has no record of yet, nor for the chat this window runs now (two processes on one
 * conversation): the button is dimmed and a click says why (a toast — a disabled button would hide its tooltip).
 */
export function ContinueInTerminalButton({ meta, current }: { meta: SessionMeta; current: boolean }) {
  const folder = useStore((s) => s.state.project?.path ?? "");
  const sessionOpen = useStore((s) => s.state.session.open);
  const known = meta.cliKnown === true || meta.turns > 0;
  const blocked = !known ? t("Claude Code has no record of this chat yet") : current && sessionOpen ? t("ReviewGate runs this chat now — open another chat here first") : null;
  const command = terminalResumeCommand(folder, meta.id, window.rg.platform);
  return (
    <button
      type="button"
      className={`plain small ${blocked ? "dimmed" : ""}`}
      aria-disabled={blocked !== null}
      disabled={folder === ""}
      onClick={() => (blocked ? showToast(blocked) : copyCommand(command))}
      title={blocked ?? t("Copies: {0}", command)}
      data-testid="Continue in terminal"
    >
      {t("Continue in terminal")}
    </button>
  );
}
