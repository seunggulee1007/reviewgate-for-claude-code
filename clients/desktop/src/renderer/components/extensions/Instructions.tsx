/**
 * MARK: wave4d w4d-config — docs/PROTOCOL.md §42.3: Claude's instructions in "Applied extensions" — the project's CLAUDE.md
 * (edited here, the diff confirmed before saving), the memory files the CLI loaded with what each is and when Claude reads
 * it, the subagents — each opened in the system's default app (main checks it is a Markdown file that exists). Files in the
 * home folder are only opened, never edited here. Same rules as the Mac (`InstructionsViews.swift`).
 */
import { useEffect, useState } from "react";
import type { ClaudeMdEvent, MemoryFile, ProjectInstructionFile, SessionExtensions, SubagentInfo } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isRunning, useStore } from "../../store";
import { engineRequest, refusalOf } from "../../engineRequest";
import { refusalMessage } from "../../errorCodes";
import { agentSource, canOpenMarkdown, claudeMdRefusal, diffCounts, instructionsDiff, instructionTitle, whenRead } from "../../claudeConfig";

function OpenButton({ path, missing }: { path: string | null | undefined; missing: string }) {
  const can = canOpenMarkdown(path) && typeof window.rg?.openMarkdown === "function";
  return (
    <button
      type="button"
      className="plain small"
      disabled={!can}
      onClick={() => can && void window.rg.openMarkdown!(path)}
      title={can ? t("Opens in the default app") : missing}
      aria-label={t("Open in Editor")}
    >
      ↗ {t("Open in Editor")}
    </button>
  );
}

function KindLine({ kind }: { kind: string | undefined }) {
  if (!kind) return null;
  return <span className="caption muted">{whenRead(kind)}</span>;
}

export function InstructionsSection({ ext }: { ext: SessionExtensions }) {
  const [editing, setEditing] = useState<{ path: string; kind: string } | null>(null);
  const project = ext.projectInstructions ?? [];
  const memory = (ext.memoryFiles ?? []).filter((m) => !project.some((p) => p.path === m.path));
  return (
    <>
      <section className="ext-section" data-testid="Instructions section">
        <h4>{t("CLAUDE.md and memory")}</h4>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className={`pill ${ext.claudeMd.user ? "green" : "gray"}`} data-testid="CLAUDE.md user">{ext.claudeMd.user ? "✓" : "–"} {t("user")}</span>
          <span className={`pill ${ext.claudeMd.project ? "green" : "gray"}`} data-testid="CLAUDE.md project">{ext.claudeMd.project ? "✓" : "–"} {t("project")}</span>
          <span className="caption faint">{ext.claudeMd.source === "cli" ? t("as reported by Claude Code") : t("files found on disk (not yet confirmed by Claude Code)")}</span>
        </div>
        {(project.length > 0 || memory.length > 0) && (
          <ul className="ext-files ext-instructions">
            {project.map((f) => (
              <ProjectFileRow key={f.path} file={f} onEdit={() => setEditing({ path: f.relPath, kind: f.kind })} />
            ))}
            {memory.map((m) => (
              <MemoryRow key={m.path} file={m} onEdit={() => setEditing({ path: m.path, kind: m.kind ?? "project" })} />
            ))}
          </ul>
        )}
        {editing && <ClaudeMdEditor path={editing.path} kind={editing.kind} onClose={() => setEditing(null)} />}
      </section>
      {ext.agents && <AgentsSection agents={ext.agents} />}
    </>
  );
}

function ProjectFileRow({ file, onEdit }: { file: ProjectInstructionFile; onEdit: () => void }) {
  return (
    <li title={file.path} data-testid={`Instruction ${file.relPath}`}>
      <span className="pill">{instructionTitle(file.kind)}</span>
      <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="mono caption truncate">{file.relPath}</span>
        <KindLine kind={file.kind} />
      </span>
      <button type="button" className="small" onClick={onEdit} title={file.exists ? t("Edit it here; you see the change before it is saved") : t("Create it here; you see it before it is saved")} data-testid={`Edit ${file.relPath}`}>
        {file.exists ? t("Edit…") : t("Create…")}
      </button>
      <OpenButton path={file.exists ? file.path : null} missing={t("The file does not exist yet")} />
    </li>
  );
}

function MemoryRow({ file: m, onEdit }: { file: MemoryFile; onEdit: () => void }) {
  return (
    <li title={m.path}>
      <span className={`pill ${m.kind === "project" || m.kind === "local" ? "" : "gray"}`}>{m.kind ? instructionTitle(m.kind) : m.type}</span>
      <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="mono caption truncate">{m.path}</span>
        <KindLine kind={m.kind} />
      </span>
      {m.tokens !== undefined && <span className="tiny faint num">{t("{0} tokens", m.tokens.toLocaleString())}</span>}
      {m.editable && (
        <button type="button" className="small" onClick={onEdit} data-testid={`Edit ${m.path}`}>
          {t("Edit…")}
        </button>
      )}
      <OpenButton path={m.path} missing={t("Only Markdown files that exist can be opened")} />
    </li>
  );
}

function AgentsSection({ agents }: { agents: SubagentInfo[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="ext-section" data-testid="Subagents">
      <h4>
        <button type="button" className="plain" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "▾" : "▸"} {t("Subagents")} <span className="faint num">{agents.length}</span>
        </button>
      </h4>
      <span className="caption muted">{t("Claude can hand work to these; a file's change applies from the next session.")}</span>
      {open &&
        (agents.length === 0 ? (
          <span className="faint caption">{t("none")}</span>
        ) : (
          <ul className="ext-files">
            {agents.map((a) => (
              <li key={a.name} title={a.description || a.name} data-testid={`Subagent ${a.name}`}>
                <span className={`pill ${a.source === "project" ? "" : "gray"}`}>{agentSource(a.source)}</span>
                <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="mono caption bold truncate">{a.name}</span>
                    {a.model && <span className="tiny faint mono">{a.model}</span>}
                  </span>
                  {a.description && <span className="caption muted ext-agent-desc">{a.description}</span>}
                </span>
                {a.path && <OpenButton path={a.path} missing={t("Only Markdown files that exist can be opened")} />}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

type Phase = "loading" | "editing" | "confirming" | "saving" | "saved" | "failed";

/** The in-dialog editor: read, edit, confirm the diff, save over what was read (`claude_md_write {baseSha}`). */
function ClaudeMdEditor({ path, kind, onClose }: { path: string; kind: string; onClose: () => void }) {
  const restartSession = useStore((s) => s.restartSession);
  const running = useStore((s) => isRunning(s.state));
  const canRestart = useStore((s) => s.state.session.canRestart && !isRunning(s.state) && !s.state.session.starting);
  const [file, setFile] = useState<ClaudeMdEvent | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const words = (e: unknown) => {
    const r = refusalOf(e);
    return claudeMdRefusal(r.code, refusalMessage(r));
  };
  const load = async () => {
    setPhase("loading");
    setError(null);
    setStale(false);
    try {
      const reply = await engineRequest({ type: "claude_md_read", path });
      setFile(reply);
      setText(reply.text);
      setPhase("editing");
    } catch (e) {
      setError(words(e));
      setPhase("failed");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const changed = file !== null && file.text !== text;
  const rows = phase === "confirming" || phase === "saving" ? instructionsDiff(file?.text ?? "", text) : [];
  const counts = diffCounts(rows);
  const save = async () => {
    if (!file) return;
    setPhase("saving");
    setError(null);
    try {
      const reply = await engineRequest({ type: "claude_md_write", path: file.relPath || path, text, baseSha: file.sha });
      setFile(reply);
      setText(reply.text);
      setPhase("saved");
    } catch (e) {
      setStale(refusalOf(e).code === "claude_md_changed");
      setError(words(e));
      setPhase("confirming");
    }
  };

  return (
    <div className="ext-editor" data-testid="CLAUDE.md editor">
      <div className="row" style={{ gap: 6 }}>
        <span className="bold">{phase === "confirming" || phase === "saving" ? t("Check the change") : t("Edit {0}", kind === "local" ? "CLAUDE.local.md" : "CLAUDE.md")}</span>
        <span className="mono tiny faint truncate grow" title={file?.path ?? path}>{file?.path ?? path}</span>
      </div>
      <span className="caption muted">{whenRead(kind)}</span>
      {phase === "loading" && <span className="spinner" />}
      {phase === "failed" && (
        <div className="banner orange" role="alert">
          <span className="grow">{error ?? t("Could not read the file")}</span>
          <button type="button" className="small" onClick={() => void load()}>{t("Retry")}</button>
        </div>
      )}
      {phase === "editing" && (
        <textarea className="mono ext-editor-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={file?.relPath ?? path} data-testid="CLAUDE.md text" />
      )}
      {(phase === "confirming" || phase === "saving") && (
        <>
          <div className="row caption" style={{ gap: 8 }}>
            <span className="green num">+{counts.added}</span>
            <span className="red num">−{counts.removed}</span>
            <span className="muted">{t("Saved only after you confirm")}</span>
          </div>
          {error && (
            <div className="banner orange" role="alert" data-testid="CLAUDE.md save error">
              <span className="grow">{error}</span>
              {stale && <button type="button" className="small" onClick={() => void load()}>{t("Reload")}</button>}
            </div>
          )}
          <div className="ext-editor-diff mono tiny" data-testid="CLAUDE.md diff">
            {rows.map((r, i) =>
              r.kind === "fold" ? (
                <div key={i} className="faint fold">⋯ {t("{0} unchanged lines", r.folded ?? 0)}</div>
              ) : (
                <div key={i} className={r.kind === "add" ? "add" : r.kind === "del" ? "del" : "ctx"}>
                  <span className="sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                  {r.text || " "}
                </div>
              ),
            )}
          </div>
        </>
      )}
      {phase === "saved" && (
        <div className="banner blue">
          <span className="grow">✓ {t("Saved")} — {t("Claude reads the change from the next session — restart to use it now")}</span>
          <button type="button" className="small primary" disabled={!canRestart} onClick={() => void restartSession()}>{t("Restart now")}</button>
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
        {phase === "editing" && <span className="tiny faint grow">{t("Files in your home folder open in an editor; only this project's files are edited here.")}</span>}
        {phase === "editing" && (
          <>
            <button type="button" className="small" onClick={onClose}>{t("Cancel")}</button>
            <button type="button" className="small primary" disabled={!changed} onClick={() => setPhase("confirming")} title={changed ? t("See the change before it is saved") : t("Nothing changed yet")} data-testid="CLAUDE.md review">
              {t("Review Changes…")}
            </button>
          </>
        )}
        {(phase === "confirming" || phase === "saving") && (
          <>
            <button type="button" className="small" disabled={phase === "saving"} onClick={() => setPhase("editing")}>{t("Back to Editing")}</button>
            <button
              type="button"
              className="small primary"
              disabled={phase === "saving" || running}
              onClick={() => void save()}
              title={running ? t("Claude is working — save once the turn has ended") : t("Save the file")}
              data-testid="CLAUDE.md save"
            >
              {phase === "saving" ? <span className="spinner" /> : t("Save")}
            </button>
          </>
        )}
        {(phase === "saved" || phase === "failed") && <button type="button" className="small" onClick={onClose}>{t("Done")}</button>}
      </div>
    </div>
  );
}
