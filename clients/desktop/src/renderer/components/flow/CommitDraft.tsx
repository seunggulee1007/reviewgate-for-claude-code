/**
 * MARK: wave3 desktop-flow
 * docs/PROTOCOL.md §36.11 in Electron (as on the Mac): "Write with Claude" under the commit sheet's message — a read-only
 * side session drafts the message in the repository's format from the ticked accepted files' diff, the last commit subjects
 * and the template; the result only fills the field ("Writing…" meanwhile, "Restore my message" when it replaced what was
 * typed, a failure in one line, off with the reason on an engine before §36 or with no file ticked) — it never commits.
 * The template button shows the rendered first line on this branch and opens the repository's "Commit message template".
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { firstLine, renderCommitTemplate, updateReason } from "../../flowLogic";
import { useStore } from "../../store";
import { commitTemplateFor, flowRepoRoot } from "../../../shared/flowSettings";
import { LearnedFormatSuggestion, TeamFormatLine, useCommitFormat } from "./TeamFormat"; // MARK: wave4c w4c-commit (§41.1)
import "./flow.css";

/** The row under the commit sheet's message. `paths`: the ticked accepted files (what the commit would hold). */
export function CommitDraftRow(props: { message: string; onMessage: (text: string) => void; paths: string[]; disabled?: boolean }) {
  const flow = useStore((s) => s.flow);
  const draft = useStore((s) => s.draftCommitMessage);
  const saveFlowSettings = useStore((s) => s.saveFlowSettings);
  const root = useStore((s) => flowRepoRoot(s.state));
  const branch = useStore((s) => s.state.project?.branch ?? null);
  const template = useStore((s) => commitTemplateFor(s.settings, flowRepoRoot(s.state)));
  const clearFlowError = useStore((s) => s.clearFlowError);
  const format = useCommitFormat(); // MARK: wave4c w4c-commit — §41.1 the team's format
  // A failure of an earlier sheet is not this one's (the "update ReviewGate" reason stays: it comes from `draftSupported`).
  useEffect(() => clearFlowError("draft"), [clearFlowError]);
  /** What the last draft replaced (non-empty), until restored or edited. */
  const [replaced, setReplaced] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** The template being typed (saved on blur, and before a draft so the fork reads what is on screen). */
  const [templateText, setTemplateText] = useState(template);
  useEffect(() => {
    if (!editing) setTemplateText(template);
  }, [template, editing]);
  useEffect(() => {
    if (drafted !== null && props.message !== drafted) {
      setReplaced(null);
      setDrafted(null);
    }
  }, [props.message, drafted]);

  const blocker = !flow.draftSupported ? updateReason() : props.paths.length === 0 ? t("Tick at least one accepted file") : null;
  const reason = !flow.draftSupported ? updateReason() : flow.drafting ? null : flow.draftError;
  const saveTemplate = async () => {
    if (root && templateText !== template) await saveFlowSettings({ commitTemplate: templateText });
  };

  const run = async () => {
    if (blocker || flow.drafting || props.disabled) return;
    await saveTemplate();
    const text = await draft(props.paths);
    if (text === null) return;
    const current = props.message.trim();
    setReplaced(current === "" || current === text ? null : props.message);
    setDrafted(text);
    props.onMessage(text);
  };

  const rendered = template.trim() ? firstLine(renderCommitTemplate(template, branch)) : "";
  return (
    <div className="commit-draft" data-testid="Commit draft">
      <div className="flow-row">
        <button
          type="button"
          className="small"
          disabled={blocker !== null || flow.drafting || props.disabled}
          onClick={() => void run()}
          title={blocker ?? t("Claude drafts the message in this repository's format from the accepted diff and the last commit subjects — in a read-only side session; the main chat is untouched and nothing is committed")}
          data-testid="Write commit message with Claude"
        >
          <span className="flow-spark" aria-hidden="true">✦</span> {t("Write with Claude")}
        </button>
        {flow.drafting ? (
          <span className="row caption muted" style={{ gap: 6 }} data-testid="Commit draft progress">
            <span className="spinner" aria-hidden="true" />
            {t("Writing…")}
          </span>
        ) : (
          replaced !== null && (
            <button
              type="button"
              className="flow-link"
              onClick={() => {
                props.onMessage(replaced);
                setReplaced(null);
                setDrafted(null);
              }}
              data-testid="Restore commit message"
            >
              {t("Restore my message")}
            </button>
          )
        )}
        <button
          type="button"
          className={`plain small commit-template-btn ${editing ? "active" : ""}`}
          aria-expanded={editing}
          aria-label={t("Commit message template")}
          title={t("Commit message template")}
          onClick={() => {
            if (editing) void saveTemplate();
            setEditing((v) => !v);
          }}
          data-testid="Commit message template"
        >
          <span aria-hidden="true">≡</span>
          {rendered ? <span className="mono truncate">{rendered}</span> : <span className="caption">{t("Commit message template")}</span>}
        </button>
      </div>
      {reason && (
        <div className="flow-reason" title={reason} data-testid="Commit draft error">
          <span aria-hidden="true">⚠</span>
          <span>{reason}</span>
        </div>
      )}
      {!editing && <TeamFormatLine template={template} reply={format} onChange={() => setEditing(true)} />}
      {editing && (
        <div className="flow-box commit-template-editor" data-testid="Commit template editor">
          <TemplateField value={templateText} onChange={setTemplateText} onCommit={() => void saveTemplate()} branch={branch} disabled={!root} autoFocus />
          <LearnedFormatSuggestion
            template={templateText}
            reply={format}
            disabled={!root}
            onUse={(v) => {
              setTemplateText(v);
              if (root) void saveFlowSettings({ commitTemplate: v });
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The template textarea, its help and the rendered preview on `branch` (the sheet and Settings › Project). */
export function TemplateField(props: { value: string; onChange: (v: string) => void; onCommit: () => void; branch: string | null; disabled?: boolean; autoFocus?: boolean }) {
  return (
    <>
      <textarea
        className="mono"
        value={props.value}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        placeholder="PAY-{issue}: "
        aria-label={t("Commit message template")}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onCommit}
        data-testid="Commit template field"
      />
      <div className="flow-help">{t("Claude writes the message in this format. {issue} = the issue number in the branch name (feature/PAY-1800-2 → 1800), {branch} = the branch; Claude fills {title} and {summary}. Empty: Claude follows the format of the recent commits.")}</div>
      {props.value.trim() !== "" && props.branch && (
        <div className="commit-template-preview" data-testid="Commit template preview">
          <span style={{ whiteSpace: "nowrap" }}>{t("On {0}", props.branch)}</span>
          <span className="mono">{renderCommitTemplate(props.value, props.branch)}</span>
        </div>
      )}
    </>
  );
}

/** Settings › Project: the repository's template, saved when editing ends. */
export function CommitTemplateEditor() {
  const root = useStore((s) => flowRepoRoot(s.state));
  const branch = useStore((s) => s.state.project?.branch ?? null);
  const template = useStore((s) => commitTemplateFor(s.settings, flowRepoRoot(s.state)));
  const saveFlowSettings = useStore((s) => s.saveFlowSettings);
  const format = useCommitFormat(); // MARK: wave4c w4c-commit — §41.1 the learned format offered here too
  const [text, setText] = useState(template);
  /** Typing is never overwritten: the saved template comes back only while the field does not have the focus. */
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(template);
  }, [template, root]);
  return (
    <div className="commit-template-editor col" style={{ gap: 6 }} onFocus={() => (focused.current = true)}>
      <TemplateField
        value={text}
        onChange={setText}
        onCommit={() => {
          focused.current = false;
          if (root && text !== template) void saveFlowSettings({ commitTemplate: text });
        }}
        branch={branch}
        disabled={!root}
      />
      <LearnedFormatSuggestion
        template={text}
        reply={format}
        disabled={!root}
        onUse={(v) => {
          setText(v);
          if (root) void saveFlowSettings({ commitTemplate: v });
        }}
      />
    </div>
  );
}
