/**
 * "Commit accepted (N)…" (docs/M12-COMMIT.md, the Mac app's commit sheet): message prefilled with
 * `state.commit.suggestedMessage`, checklist of the accepted files (default all), "Push to origin"
 * (default from settings) → `commit`. A refusal is shown verbatim + localized — unless the commit
 * itself landed (`lastCommit` changed; only the push was refused): then the red banner takes over.
 * §32 (wave1 desktop-review): gitignored files (`ignored`, mods files force-added to the review) are never in the
 * checklist — the engine cannot stage them — and a line says which accepted ones stay out.
 */
import { useState } from "react";
import { t } from "../../i18n";
import { commitPaths } from "../../reviewGate";
import { commitOf, refusalText, useStore } from "../../store";
import { Modal } from "../Menu";
import { CommitDraftRow } from "../flow/CommitDraft"; // MARK: wave3 desktop-flow
import { CommitSplitPanel } from "../flow/CommitSplit"; // §53
import "./dialogs.css";
import { isEnter } from "../../ime";

export function CommitDialog({ onClose }: { onClose: () => void }) {
  const commit = useStore((s) => commitOf(s.state));
  const changedFiles = useStore((s) => s.state.changedFiles);
  const settings = useStore((s) => s.settings);
  const commitAccepted = useStore((s) => s.commitAccepted);
  const candidates = commitPaths(commit.acceptedPaths, changedFiles);
  const [message, setMessage] = useState(() => commit.suggestedMessage ?? "");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.paths));
  const [push, setPush] = useState(() => settings?.commitPushByDefault === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** §53: "나눠서 커밋" — the accepted changes as several commits (the files are fixed while it is open). */
  const [split, setSplit] = useState(false);

  const identityMissing = !commit.identity.name || !commit.identity.email;
  const paths = candidates.paths.filter((p) => selected.has(p));
  const canSubmit = !busy && commit.canCommit && paths.length > 0 && message.trim().length > 0;

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
    const code = await commitAccepted({ message: message.trim(), paths, push });
    setBusy(false);
    const landed = (commitOf(useStore.getState().state).lastCommit?.at ?? null) !== before;
    if (code === null || landed) onClose();
    else setError(code);
  };

  return (
    <Modal title={t("Commit accepted ({0})…", candidates.paths.length)} onClose={busy ? undefined : onClose} wide testId="Commit dialog">
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
        <span>{t("Files ({0} of {1})", paths.length, candidates.paths.length)}</span>
        <ul className="candidates" data-testid="Commit files">
          {candidates.paths.map((p) => (
            <li key={p} onClick={() => !split && toggle(p)} title={p}>
              <input type="checkbox" checked={selected.has(p)} disabled={split} onChange={() => toggle(p)} onClick={(e) => e.stopPropagation()} data-testid={`Commit file ${p}`} />
              <span className="mono truncate">{p}</span>
            </li>
          ))}
        </ul>
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
      {split && <CommitSplitPanel paths={paths} push={push} initialMessage={message} onClose={onClose} />}
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
        <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()} data-testid="Commit">
          {push ? t("Commit & push") : t("Commit")}
        </button>
      </div>}
    </Modal>
  );
}
