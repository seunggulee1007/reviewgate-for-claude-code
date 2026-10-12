/**
 * "Create PR from this branch…" (the Mac app's `CreatePRSheet`): base picker, title, body, draft →
 * `pr_create`. On success the URL is shown with Open in browser (it also lands in the sidebar banner).
 * MARK: wave4c w4c-commit — §41.1: the title / body come from the branch's commits (`pr_draft`, until the user types), the
 * assignee (@me) / labels / reviewers / projects are kept per repository, and a missing or logged-out `gh` disables the
 * create with its reason. The push still happens only when the user creates the PR.
 */
import { useEffect, useRef, useState } from "react";
import type { PRDraftEvent } from "@reviewgate/engine";
import { ghBlocker, loadPRMeta, prCreateMeta, savePRMeta, type PRMetaText } from "../../commitFormat";
import { engineRequest } from "../../engineRequest";
import { t } from "../../i18n";
import { refusalText, useStore } from "../../store";
import { flowRepoRoot } from "../../../shared/flowSettings";
import { Modal } from "../Menu";
import "./dialogs.css";

export function CreatePRDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.state.project);
  const branches = useStore((s) => s.state.branches.list);
  const createPR = useStore((s) => s.createPR);
  const repoRoot = useStore((s) => flowRepoRoot(s.state));
  const head = project?.branch ?? "HEAD";
  const bases = branches.filter((b) => !b.isCurrent).map((b) => b.name);
  const [base, setBase] = useState(() => ["main", "develop", "master"].find((n) => bases.includes(n)) ?? bases[0] ?? "main");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  // MARK: wave4c w4c-commit — §41.1
  const [meta, setMeta] = useState<PRMetaText>(() => loadPRMeta(repoRoot));
  const [prDraft, setPRDraft] = useState<PRDraftEvent | null>(null);
  /** What the user typed is never replaced by a later draft (another base). */
  const typed = useRef({ title: false, body: false });
  useEffect(() => {
    if (!base) return;
    let live = true;
    engineRequest({ type: "pr_draft", base })
      .then((d) => {
        if (!live) return;
        setPRDraft(d);
        if (!typed.current.title) setTitle(d.title);
        if (!typed.current.body) setBody(d.body);
      })
      .catch(() => live && setPRDraft(null)); // an older engine: the sheet as before
    return () => {
      live = false;
    };
  }, [base]);
  const ghReason = ghBlocker(prDraft?.gh, prDraft?.host);

  const create = async () => {
    if (!base || creating || ghReason) return;
    setCreating(true);
    setError(null);
    const result = await createPR(base, title.trim() || null, body.trim() || null, draft, prCreateMeta(meta));
    setCreating(false);
    if (result) {
      savePRMeta(repoRoot, meta);
      setUrl(result);
    } else {
      const last = useStore.getState().lastError;
      setError(last ? refusalText(last) : t("Could not create the pull request"));
    }
  };

  if (url) {
    return (
      <Modal title={t("Pull request created")} onClose={onClose} testId="Create PR result">
        <a href={url} className="truncate" title={url} onClick={(e) => { e.preventDefault(); void window.rg.openExternal(url); }} data-testid="Created PR URL">{url}</a>
        <div className="actions">
          <button type="button" onClick={() => void window.rg.openExternal(url)}>{t("Open in browser")}</button>
          <button type="button" className="primary" autoFocus onClick={onClose}>{t("Done")}</button>
        </div>
      </Modal>
    );
  }

  const metaField = (key: keyof PRMetaText, label: string, placeholder: string) => (
    <div className="field-row">
      <span>{label}</span>
      <input type="text" value={meta[key]} placeholder={placeholder} aria-label={label} onChange={(e) => setMeta({ ...meta, [key]: e.target.value })} data-testid={`PR ${key}`} />
    </div>
  );

  return (
    <Modal title={t("Create PR from {0}", head)} onClose={creating ? undefined : onClose} wide testId="Create PR dialog">
      <div className="field-row">
        <span>{t("Base")}</span>
        <select value={base} onChange={(e) => setBase(e.target.value)} data-testid="PR base">
          {bases.length === 0 && <option value="main">main</option>}
          {bases.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <span>{t("Title")}</span>
        <input type="text" autoFocus value={title} placeholder={head} onChange={(e) => { setTitle(e.target.value); typed.current.title = true; }} data-testid="PR title" />
      </div>
      <label className="field">
        <span>{t("Body")}</span>
        <textarea className="body" value={body} onChange={(e) => { setBody(e.target.value); typed.current.body = true; }} data-testid="PR body" />
      </label>
      {prDraft && prDraft.commits.length > 0 && (
        <div className="hint" data-testid="PR draft source">{t("Filled from the {0} commit(s) of this branch since {1}", prDraft.commits.length, prDraft.baseRef ?? base)}</div>
      )}
      {metaField("assignees", t("Assignees"), "@me")}
      {metaField("labels", t("Labels"), t("comma-separated"))}
      {metaField("reviewers", t("Reviewers"), t("comma-separated"))}
      {metaField("projects", t("Projects"), t("comma-separated"))}
      <label className="check">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} data-testid="PR draft" />
        {t("Draft")}
      </label>
      <div className="hint">
        {prDraft && !prDraft.hasUpstream
          ? t("{0} is not on the remote yet — Create PR pushes it first, then runs `gh pr create` against {1}.", head, base || "main")
          : t("Pushes {0} and runs `gh pr create` against {1}.", head, base || "main")}
      </div>
      {ghReason && <div className="hint error" role="status" data-testid="Create PR gh reason">{ghReason}</div>}
      {error && <div className="hint error" data-testid="Create PR error">{error}</div>}
      <div className="actions">
        {creating && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" disabled={creating} onClick={onClose}>{t("Cancel")}</button>
        <button type="button" className="primary" disabled={!base || creating || ghReason !== null} title={ghReason ?? undefined} onClick={() => void create()} data-testid="Create PR">
          {t("Create PR")}
        </button>
      </div>
    </Modal>
  );
}
