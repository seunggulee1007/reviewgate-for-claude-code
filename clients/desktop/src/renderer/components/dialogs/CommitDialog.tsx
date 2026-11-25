/**
 * "Commit accepted (N)…" (docs/M12-COMMIT.md, the Mac app's commit sheet): message prefilled with
 * `state.commit.suggestedMessage`, checklist of the accepted files (default all), "Push to origin"
 * (default from settings) → `commit`. A refusal is shown verbatim + localized — unless the commit
 * itself landed (`lastCommit` changed; only the push was refused): then the red banner takes over.
 * §32 (wave1 desktop-review): gitignored files (`ignored`, mods files force-added to the review) are never in the
 * checklist — the engine cannot stage them — and a line says which accepted ones stay out.
 */
import { useEffect, useState } from "react";
import type { OtherChange } from "@reviewgate/engine";
import { extraPathsOf, otherStatusLetter, othersMessage, othersOnly, visibleOthers } from "../../commitOthers"; // MARK: git-sync (§68.5)
import { t } from "../../i18n";
import { commitPaths } from "../../reviewGate";
import { commitOf, refusalText, useStore } from "../../store";
import { Modal } from "../Menu";
import { CommitDraftRow } from "../flow/CommitDraft"; // MARK: wave3 desktop-flow
import { CommitSplitPanel } from "../flow/CommitSplit"; // §53
import "./dialogs.css";
import { isEnter } from "../../ime";
import { engineRequest, refusalOf } from "../../engineRequest";
import { commitLockReason } from "../../commitLock";
import { commitListed, commitPushFor, commitToAccept, setCommitPushFor } from "../../acceptCommit"; // MARK: r2-review-flow (M28)

/**
 * MARK: r2-review-flow — M28: the pending files are listed after the accepted ones — ticked, they are accepted as the commit goes
 * ("리뷰 끝냄으로 표시하고 커밋", one action instead of accept → dialog → commit); with nothing accepted every pending file is
 * ticked. "Push after commit" is kept per project.
 */
export function CommitDialog({ onClose }: { onClose: () => void }) {
  const commit = useStore((s) => commitOf(s.state));
  const changedFiles = useStore((s) => s.state.changedFiles);
  const settings = useStore((s) => s.settings);
  const commitAccepted = useStore((s) => s.commitAccepted);
  const root = useStore((s) => s.state.project?.root ?? null);
  const locked = useStore((s) => commitLockReason(s.state));
  const accepted = commitPaths(commit.acceptedPaths, changedFiles);
  const candidates = { ...accepted, paths: commitListed(accepted.paths, changedFiles) };
  const [message, setMessage] = useState(() => commit.suggestedMessage ?? "");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(accepted.paths.length > 0 ? accepted.paths : candidates.paths));
  const [push, setPushState] = useState(() => commitPushFor(root, settings?.commitPushByDefault === true));
  const setPush = (on: boolean) => {
    setPushState(on);
    setCommitPushFor(root, on);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** §53: "나눠서 커밋" — the accepted changes as several commits (the files are fixed while it is open). */
  const [split, setSplit] = useState(false);
  // MARK: git-sync — §68.5: changed files outside the review, none ticked; untracked ones only when asked for.
  const [others, setOthers] = useState<OtherChange[]>([]);
  const [othersTruncated, setOthersTruncated] = useState(false);
  const [showUntracked, setShowUntracked] = useState(false);
  const [extraSelected, setExtraSelected] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    engineRequest({ type: "commit_others" })
      .then((r) => {
        if (!live) return;
        setOthers(r.files);
        setOthersTruncated(r.truncated);
        // Only the user's own changes: not Claude's last instruction (or "Apply accepted changes") as the message.
        const only = othersOnly(candidates.paths.length, r.files.length, r.truncated);
        setMessage((current) => othersMessage(current, commit.suggestedMessage ?? "", r.suggestedMessage, only) ?? current);
      })
      .catch(() => undefined); // an older engine: no second group
    return () => {
      live = false;
    };
  }, []);
  const shownOthers = visibleOthers(others, showUntracked);
  const extras = extraPathsOf(extraSelected, others, showUntracked);
  const untrackedCount = others.filter((f) => f.untracked).length;
  const onlyOthers = othersOnly(candidates.paths.length, others.length, othersTruncated);
  const toggleExtra = (path: string) =>
    setExtraSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const identityMissing = !commit.identity.name || !commit.identity.email;
  const paths = candidates.paths.filter((p) => selected.has(p));
  const toAccept = commitToAccept(selected, changedFiles);
  const canSubmit = !busy && locked === null && (commit.canCommit || toAccept.length > 0 || extras.length > 0) && paths.length + extras.length > 0 && message.trim().length > 0;

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const before = commit.lastCommit?.at ?? null;
    if (toAccept.length > 0) {
      // The engine commits accepted files only: the ticked pending ones are accepted first (accepting writes nothing).
      try {
        await engineRequest({ type: "accept", paths: toAccept });
        await useStore.getState().settle();
      } catch (e) {
        setBusy(false);
        setError(refusalOf(e).error);
        return;
      }
    }
    const code = await commitAccepted({ message: message.trim(), paths, push, extraPaths: extras });
    setBusy(false);
    const landed = (commitOf(useStore.getState().state).lastCommit?.at ?? null) !== before;
    if (code === null || landed) onClose();
    else setError(code);
  };

  return (
    <Modal title={onlyOthers ? t("Commit changes") : t("Commit accepted ({0})…", candidates.paths.length)} onClose={busy ? undefined : onClose} wide testId="Commit dialog">
      <div className="row" style={{ gap: 6 }} role="group" aria-label={t("Commit mode")}>
        <button type="button" className={`small ${split ? "" : "primary"}`} aria-pressed={!split} disabled={busy} onClick={() => setSplit(false)} data-testid="Commit mode single">
          {t("Commit at once")}
        </button>
        <button type="button" className={`small ${split ? "primary" : ""}`} aria-pressed={split} disabled={busy || paths.length === 0} onClick={() => setSplit(true)} data-testid="Commit mode split">
          {t("Commit in parts")}
        </button>
      </div>
      {!split && (<>
      <label className="field">
        <span>{t("Commit message")}</span>
        <textarea
          className="body mono"
          autoFocus
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && isEnter(e)) void submit();
          }}
          data-testid="Commit message"
        />
      </label>
      {/* MARK: wave3 desktop-flow — §36.11: Claude drafts the message (read-only); it only fills the field above. */}
      <CommitDraftRow message={message} onMessage={setMessage} paths={paths} disabled={busy} />
      </>)}
      <div className="field">
        {/* §68.8: only the user's own changes — no empty review list above them */}
        {!onlyOthers && (<>
        <span>{t("Files ({0} of {1})", paths.length, candidates.paths.length)}</span>
        <ul className="candidates" data-testid="Commit files">
          {candidates.paths.map((p) => {
            const f = changedFiles.find((x) => x.path === p);
            const pendingFile = f?.state === "pending";
            return (
              <li key={p} onClick={() => !split && toggle(p)} title={p}>
                <input type="checkbox" checked={selected.has(p)} disabled={split || (pendingFile && split)} onChange={() => toggle(p)} onClick={(e) => e.stopPropagation()} data-testid={`Commit file ${p}`} />
                <span className="mono truncate grow">{p}</span>
                {pendingFile && (
                  <span className="tiny bold orange" title={t("Not reviewed yet — committing it marks it reviewed (accepted) first")} data-testid={`Commit pending ${p}`}>{t("Pending")}</span>
                )}
                {f && <span className="tiny num green">+{f.added}</span>}
                {f && <span className="tiny num red">−{f.deleted}</span>}
              </li>
            );
          })}
        </ul>
        </>)}
        {!split && (others.length > 0 || othersTruncated) && (
          // MARK: git-sync — §68.5 "Other changes": committed as they are, never reviewed or marked accepted
          <div className="col" style={{ gap: 4, marginTop: 6 }} data-testid="Commit other changes">
            <div className="row" style={{ gap: 6 }}>
              <span className="grow" title={t("Files changed outside the review — your own edits, or files changed before Claude's turn. Ticked, they go into this commit as they are: they are not reviewed and nothing is marked accepted.")}>
                {t("Other changes ({0} of {1})", extras.length, shownOthers.length)}
              </span>
              {untrackedCount > 0 && (
                <label className="check tiny" title={t("Also list new files git does not track yet")}>
                  <input type="checkbox" checked={showUntracked} onChange={(e) => setShowUntracked(e.target.checked)} data-testid="Commit show untracked" />
                  {t("Untracked ({0})", untrackedCount)}
                </label>
              )}
            </div>
            <ul className="candidates" data-testid="Commit other files">
              {shownOthers.map((f) => (
                <li key={f.path} onClick={() => toggleExtra(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <input type="checkbox" checked={extraSelected.has(f.path)} onChange={() => toggleExtra(f.path)} onClick={(e) => e.stopPropagation()} data-testid={`Commit other ${f.path}`} aria-label={f.path} />
                  <span className="tiny mono bold muted" title={f.untracked ? t("Untracked — a new file git does not track yet") : t("Changed outside the review")}>{otherStatusLetter(f)}</span>
                  <span className="mono truncate grow">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
                  {f.hidden && <span className="tiny muted" title={t("An ignore pattern in Settings hides this file from the review; it can still be committed")}>{t("Hidden from the review")}</span>}
                </li>
              ))}
              {shownOthers.length === 0 && <li className="muted">{t("No tracked changes outside the review")}</li>}
            </ul>
            {othersTruncated && <div className="hint">{t("Only the first 500 files are listed")}</div>}
          </div>
        )}
        {candidates.ignored.length > 0 && (
          <div className="hint" title={candidates.ignored.join("\n")} data-testid="Commit ignored">
            {t("{0} gitignored file(s) are not committed: {1}", candidates.ignored.length, candidates.ignored.join(", "))}
          </div>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} data-testid="Push to origin" />
        {t("Push to origin")}
      </label>
      {settings?.commitTrailer.trim() && <div className="hint mono">{settings.commitTrailer.trim()}</div>}
      {identityMissing && (
        <div className="hint error" data-testid="Identity warning">
          {t("Git identity is not configured (user.name / user.email).{0}", "")} {t("Set it with `git config user.name` / `git config user.email`.")}
        </div>
      )}
      {split && <CommitSplitPanel paths={paths.filter((p) => accepted.paths.includes(p))} push={push} initialMessage={message} onClose={onClose} />}
      {!split && error && (
        <div className="hint error" data-testid="Commit error">
          {refusalText(error)}
          {refusalText(error) !== error && <div className="tiny muted mono">{error}</div>}
        </div>
      )}
      {!split && <div className="actions">
        {busy && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
        <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()} title={locked ?? undefined} data-testid="Commit">
          {toAccept.length > 0 ? (push ? t("Mark Reviewed, Commit and Push") : t("Mark Reviewed and Commit")) : push ? t("Commit & push") : t("Commit")}
        </button>
      </div>}
    </Modal>
  );
}
