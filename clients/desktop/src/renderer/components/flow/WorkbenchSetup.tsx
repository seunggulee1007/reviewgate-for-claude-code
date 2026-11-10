/**
 * MARK: wave3 desktop-flow
 * docs/PROTOCOL.md §36.12 / §36.14 in Electron (as on the Mac): what the New Workbench sheet shows before and while it creates
 * — the files it copies ("%d files will be copied", the list), the setup command, the steps and the log of the latest one —,
 * the repository's "Workbench setup" editor (the sheet's "Edit…" and Settings › Project) and the banner a new workbench's
 * window shows when its setup failed (the window still opens).
 */
import { useEffect, useRef, useState } from "react";
import type { WorkbenchPreviewEvent, WorkbenchProgressEvent, WorkbenchSetup } from "@reviewgate/engine";
import { t } from "../../i18n";
import { exitWords, formatBytes, latestLog, setupReportHeadline, shownSteps, stepExit, stepState, stepTitle } from "../../flowLogic";
import { useStore } from "../../store";
import { flowRepoRoot, workbenchSetupFor } from "../../../shared/flowSettings";
import "./flow.css";
import { isEnter } from "../../ime";
import { workbenchSetupNote } from "../../platformWords"; // MARK: wave4d w4d-windows

/** The copy / setup part of the New Workbench sheet (an engine that knows §36.12). */
export function WorkbenchSetupSection(props: {
  setup: Required<WorkbenchSetup>;
  /** The preview of the branch / base / folder the sheet shows now (null: not answered yet). */
  preview: WorkbenchPreviewEvent | null;
  loading: boolean;
  error: string | null;
  runSetup: boolean;
  onRunSetup: (v: boolean) => void;
  disabled: boolean;
}) {
  const { setup, preview } = props;
  const [showFiles, setShowFiles] = useState(false);
  const [editing, setEditing] = useState(false);
  const files = preview?.copy ?? [];
  return (
    <div className="col" style={{ gap: 6 }} data-testid="Workbench setup section">
      <div className="flow-row">
        <span aria-hidden="true" className="muted">⧉</span>
        {preview && files.length > 0 ? (
          <button type="button" className="wb-files-toggle" aria-expanded={showFiles} onClick={() => setShowFiles((v) => !v)} data-testid="Workbench copy count">
            <span className="tiny" aria-hidden="true">{showFiles ? "▼" : "▶"}</span>
            {t("{0} files will be copied", preview.count ?? (preview.truncated ? `${files.length}+` : files.length))}
            <span className="muted">· {formatBytes(preview.totalBytes)}</span>
          </button>
        ) : preview ? (
          <span className="muted" data-testid="Workbench no copy">{t("No files to copy")}</span>
        ) : (
          <span className="muted row" style={{ gap: 6 }}>
            {props.loading && <span className="spinner" aria-hidden="true" />}
            {t("Files to copy")}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="small" aria-expanded={editing} onClick={() => setEditing((v) => !v)} title={t("Workbench setup")} disabled={props.disabled} data-testid="Edit workbench setup">
          {t("Edit…")}
        </button>
      </div>
      {showFiles && files.length > 0 && (
        <ul className="wb-files" data-testid="Workbench copy list">
          {files.map((f) => (
            <li key={f.path} title={f.path}>
              <span className="mono">{f.path}</span>
              <span className="num">{formatBytes(f.bytes)}</span>
            </li>
          ))}
          {preview?.truncated && <li className="muted">{t("…and more (the first {0} are listed)", files.length)}</li>}
        </ul>
      )}
      {preview && files.length === 0 && (
        <div className="flow-help">
          {setup.copy.length === 0 && setup.useWorktreeInclude
            ? t("Untracked or ignored files (mvnw, local config…) are copied when they match the patterns of Workbench setup or .worktreeinclude.")
            : t("Nothing in this worktree matches the patterns of Workbench setup.")}
        </div>
      )}
      {props.error && <div className="hint error" data-testid="Workbench preview error">{props.error}</div>}
      <div className="flow-row" style={{ alignItems: "baseline" }}>
        <span aria-hidden="true" className="muted">›_</span>
        <span className="muted">{t("Setup command")}</span>
        {setup.setupCommand ? (
          <span className="wb-command" title={setup.setupCommand} data-testid="Workbench setup command">{setup.setupCommand}</span>
        ) : (
          <span className="faint">{t("None")}</span>
        )}
      </div>
      {(setup.setupCommand !== "" || files.length > 0) && (
        <label className="check">
          <input type="checkbox" checked={props.runSetup} disabled={props.disabled} onChange={(e) => props.onRunSetup(e.target.checked)} data-testid="Workbench run setup" />
          {t("Copy the files and run the setup command after creating")}
        </label>
      )}
      {editing && (
        <div className="flow-box" data-testid="Workbench setup popover">
          <WorkbenchSetupEditor />
        </div>
      )}
    </div>
  );
}

/** The steps of a create (`workbench_progress`) and the log of the latest one that printed something. */
export function WorkbenchProgressView({ progress, running }: { progress: readonly WorkbenchProgressEvent[]; running: boolean }) {
  const steps = shownSteps(progress, running);
  const log = latestLog(progress);
  if (steps.length === 0 && !log) return null;
  return (
    <div className="wb-steps" data-testid="Workbench steps">
      {steps.map((step) => {
        const state = stepState(progress, step, running);
        const exit = exitWords(stepExit(progress.find((p) => p.step === step)));
        return (
          <div key={step} className={`wb-step ${state}`} data-testid={`Workbench step ${step}`}>
            <span className="icon" aria-hidden="true">
              {state === "running" ? <span className="spinner" /> : state === "done" ? "✓" : state === "warning" ? "⚠" : state === "failed" ? "✕" : "○"}
            </span>
            <span>{stepTitle(step)}</span>
            {exit && <span className="exit">{exit}</span>}
          </div>
        );
      })}
      {log && <LogBox text={log} testId="Workbench step log" />}
    </div>
  );
}

/** A log that starts scrolled to its end (the latest lines). */
function LogBox({ text, testId }: { text: string; testId: string }) {
  const [el, setEl] = useState<HTMLPreElement | null>(null);
  useEffect(() => {
    if (el) el.scrollTop = el.scrollHeight;
  }, [el, text]);
  return (
    <pre className="flow-log" ref={setEl} data-testid={testId}>
      {text}
    </pre>
  );
}

/** The repository's "Workbench setup": saved as edited (switches at once, text when editing ends), shared by its workbenches. */
export function WorkbenchSetupEditor() {
  const root = useStore((s) => flowRepoRoot(s.state));
  const settings = useStore((s) => s.settings);
  const saveFlowSettings = useStore((s) => s.saveFlowSettings);
  const setup = workbenchSetupFor(settings, root);
  const [patterns, setPatterns] = useState(setup.copy.join("\n"));
  const [command, setCommand] = useState(setup.setupCommand);
  /** Typing is never overwritten: the saved values come back only while nothing in the editor has the focus. */
  const focused = useRef(false);
  const key = JSON.stringify(setup);
  useEffect(() => {
    if (focused.current) return;
    setPatterns(setup.copy.join("\n"));
    setCommand(setup.setupCommand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, root]);
  const save = (patch: Partial<WorkbenchSetup>) => {
    if (!root) return;
    void saveFlowSettings({ workbenchSetup: { ...setup, ...patch } });
  };
  const commitText = () => {
    const copy = patterns.split(/\r?\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    if (copy.join("\n") !== setup.copy.join("\n") || command.trim() !== setup.setupCommand) save({ copy, setupCommand: command.trim() });
  };
  const off = !root;
  return (
    <div
      className="wb-setup-editor"
      onFocus={() => (focused.current = true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focused.current = false;
      }}
      data-testid="Workbench setup editor"
    >
      <h4>{t("Files to copy")}</h4>
      <textarea
        className="mono"
        value={patterns}
        disabled={off}
        placeholder={"mvnw\n.mvn/**"}
        aria-label={t("Files to copy")}
        onChange={(e) => setPatterns(e.target.value)}
        onBlur={commitText}
        data-testid="Workbench copy patterns"
      />
      <div className="flow-help">{t("One pattern per line (mvnw, .mvn/**, config/local/*.yml). Only untracked or ignored files of this worktree are copied — never a tracked file or .git.")}</div>
      <label className="check">
        <input type="checkbox" checked={setup.useWorktreeInclude} disabled={off} onChange={(e) => save({ useWorktreeInclude: e.target.checked })} data-testid="Workbench use worktreeinclude" />
        {t("Also copy what .worktreeinclude lists")}
      </label>
      <h4>{t("Setup command")}</h4>
      <input
        type="text"
        className="mono"
        value={command}
        disabled={off}
        placeholder="./mvnw -q -o compile"
        aria-label={t("Setup command")}
        onChange={(e) => setCommand(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (isEnter(e)) (e.target as HTMLInputElement).blur();
        }}
        data-testid="Workbench setup command field"
      />
      <div className="flow-help">{workbenchSetupNote(window.rg.platform) /* MARK: wave4d w4d-windows (polish-07): cmd.exe on Windows */}</div>
      <label className="check">
        <input type="checkbox" checked={setup.fetchBase} disabled={off} onChange={(e) => save({ fetchBase: e.target.checked })} data-testid="Workbench fetch default" />
        {t("Fetch before creating")}
      </label>
      <div className="flow-row">
        <span>{t("Folder")}</span>
        <select value={setup.location} disabled={off} onChange={(e) => save({ location: e.target.value === "sibling" ? "sibling" : "managed" })} aria-label={t("Folder")} data-testid="Workbench location default">
          <option value="managed">{t("Managed folder")}</option>
          <option value="sibling">{t("Next to the repository")}</option>
        </select>
      </div>
      <div className="flow-help">{t("Next to the repository: <parent folder>/<repo>-<last part of the branch>, e.g. acme-PAY-1600 for feature/PAY-1600.")}</div>
    </div>
  );
}

/** The banner of a window whose workbench was just created and whose setup failed: the exit and the log. */
export function WorkbenchSetupBanner() {
  const report = useStore((s) => s.flow.setupReport);
  const dismiss = useStore((s) => s.dismissSetupReport);
  const [showLog, setShowLog] = useState(true);
  if (!report) return null;
  return (
    <div className="banner orange wb-setup-banner" role="status" data-testid="Workbench setup failed banner">
      <div className="head">
        <span aria-hidden="true">⚠</span>
        <span className="grow">{setupReportHeadline(report)}</span>
        {report.log && (
          <button type="button" className="small" onClick={() => setShowLog((v) => !v)} data-testid="Workbench setup log toggle">
            {showLog ? t("Hide log") : t("Show log")}
          </button>
        )}
        <button type="button" className="plain small" onClick={dismiss} aria-label={t("Dismiss")} title={t("Dismiss")} data-testid="Dismiss workbench setup banner">
          ✕
        </button>
      </div>
      {showLog && report.log && <LogBox text={report.log} testId="Workbench setup log" />}
    </div>
  );
}
