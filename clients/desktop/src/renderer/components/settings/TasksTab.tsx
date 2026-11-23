/**
 * MARK: task-start — docs/PROTOCOL.md §63.3 / §63.4: Settings › Tasks (업무), as the Mac's `TaskSettingsPane` — the start
 * screen, and how "Start from a task" works for this window's repository (or the default every project without its own
 * uses): the platform, the branch prefix, where it starts, the MCP server Claude reads the task with, and the first prompt's
 * template with Reset. A repository's own settings are kept under its hash (src/shared/taskStartSettings.ts).
 */
import { useEffect, useState } from "react";
import type { AppSettings } from "../../../shared/ipc";
import { flowRepoRoot } from "../../../shared/flowSettings";
import {
  DEFAULT_TASK_PREFIX,
  TASK_PLATFORMS,
  globalTaskStartSettings,
  hasProjectTaskStartSettings,
  readsThroughMcp,
  taskPlatformTitle,
  taskStartPatch,
  taskStartSettingsFor,
  type TaskPlatform,
  type TaskStartLocation,
  type TaskStartSettings,
} from "../../../shared/taskStartSettings";
import { t } from "../../i18n";
import { isEnter } from "../../ime";
import { lastComponent, useStore } from "../../store";
import { defaultTaskTemplate, taskBranchName } from "../../taskStart";
import { taskMcpServerNames } from "../../taskStartFlow";

type Scope = "project" | "all";

export function TasksTab({ settings }: { settings: AppSettings }) {
  const root = useStore((s) => flowRepoRoot(s.state));
  const saveSettings = useStore((s) => s.saveSettings);
  const mcp = useStore((s) => s.mcp);
  const capabilities = useStore((s) => s.state.session.capabilities);
  const cached = useStore((s) => s.cachedCapabilities);
  const servers = taskMcpServerNames(mcp.servers, capabilities, cached);
  const [scope, setScope] = useState<Scope>("project");
  const target = root && scope === "project" ? root : null;
  const current = target ? taskStartSettingsFor(settings, target) : globalTaskStartSettings(settings);
  const hasOwn = hasProjectTaskStartSettings(settings, root);

  /** A change writes only where the fields were read: this repository's own, or the default. */
  const save = (patch: Partial<TaskStartSettings>) => {
    const next: TaskStartSettings = { ...current, ...patch };
    const template = next.promptTemplate;
    if (template === undefined || template === defaultTaskTemplate() || template.trim() === "") delete next.promptTemplate;
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    void saveSettings(taskStartPatch(settings, target, next));
  };
  const needsServer = readsThroughMcp(current.platform);
  const serverHelp = !needsServer
    ? t("Only Jira, Linear and other trackers are read through an MCP server")
    : servers.length === 0
      ? t("This project's session reported no MCP servers — type the server's name")
      : t("The MCP server Claude reads the task with");

  return (
    <div className="body" data-testid="Settings tasks">
      <section>
        <h4>{t("Start screen")}</h4>
        <label className="check" data-setting="skipStartScreen">
          <input type="checkbox" checked={settings.skipStartScreen !== true} onChange={(e) => void saveSettings({ skipStartScreen: !e.target.checked })} data-testid="Show the start screen" />
          {t("Show the start screen when a project opens")}
        </label>
        <div className="note">{t("When a project opens in a window: start straight away, start from a task, or continue a recent chat (1 / 2 / 3, Esc starts straight away). Off: the window opens into its chat.")}</div>
      </section>
      <section>
        <h4>{t("Start from a task")}</h4>
        {root ? (
          <>
            <div className="field-row">
              <span>{t("Settings for")}</span>
              <div className="segmented mini" role="radiogroup" aria-label={t("Settings for")} style={{ margin: 0 }} data-testid="Task settings scope">
                <button type="button" role="radio" aria-checked={scope === "project"} className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>
                  {t("{0} only", lastComponent(root))}
                </button>
                <button type="button" role="radio" aria-checked={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
                  {t("All projects (default)")}
                </button>
              </div>
            </div>
            {scope === "project" && (
              <div className="row" style={{ gap: 8 }}>
                <span className="note grow">{hasOwn ? t("This project has its own settings.") : t("This project uses the default until you change something here.")}</span>
                <button
                  type="button"
                  className="small"
                  disabled={!hasOwn}
                  title={hasOwn ? t("Forget this project's own settings; it uses the default again") : t("This project already uses the default")}
                  onClick={() => void saveSettings(taskStartPatch(settings, root, null))}
                  data-testid="Use the default task settings"
                >
                  {t("Use the Default")}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="note">{t("No project open — these are the default for every project.")}</div>
        )}
        <div className="field-row" data-setting="taskPlatform">
          <span>{t("Task platform")}</span>
          <select value={current.platform} onChange={(e) => save({ platform: e.target.value as TaskPlatform })} data-testid="Task platform">
            {TASK_PLATFORMS.map((p) => (
              <option key={p} value={p}>{t(taskPlatformTitle(p))}</option>
            ))}
          </select>
        </div>
        <div className="note">{t("GitHub Issues are read with the GitHub CLI (gh). Jira, Linear and other trackers are read by Claude through the MCP server below — ReviewGate never calls the tracker and keeps no token.")}</div>
        <div className="field-row" data-setting="taskBranchPrefix">
          <span>{t("Branch prefix")}</span>
          <CommitField value={current.branchPrefix} placeholder={DEFAULT_TASK_PREFIX} label={t("Branch prefix")} onCommit={(v) => save({ branchPrefix: v.trim() })} testId="Task branch prefix" />
        </div>
        <div className="note mono">{t("e.g. {0}", taskBranchName(current.branchPrefix, "ACME-123", "Fix cart total", ["bug"]))}</div>
        <div className="note">{t("The task's branch is <prefix><id>-<title words>, e.g. feature/ACME-123-fix-cart-total. {type} becomes fix, docs, chore or feature from the issue's labels.")}</div>
        <div className="field-row" data-setting="taskStartLocation">
          <span>{t("Start in")}</span>
          <select value={current.location} onChange={(e) => save({ location: e.target.value as TaskStartLocation })} data-testid="Task start location">
            <option value="branch">{t("A new branch in this window")}</option>
            <option value="workbench">{t("A new workbench")}</option>
          </select>
        </div>
        <div className="note">{t("A new branch in this window (your uncommitted changes come along), or a new workbench — its own folder, branch and window.")}</div>
        <div className="field-row" data-setting="taskMcpServer" title={serverHelp}>
          <span>{t("MCP server for tasks")}</span>
          <div className="row" style={{ gap: 6 }}>
            <CommitField value={current.mcpServer} placeholder="acme-tracker" label={t("MCP server for tasks")} disabled={!needsServer} title={serverHelp} onCommit={(v) => save({ mcpServer: v.trim() })} testId="Task MCP server" />
            <select
              value=""
              disabled={!needsServer || servers.length === 0}
              title={serverHelp}
              aria-label={t("Choose an MCP server")}
              onChange={(e) => e.target.value && save({ mcpServer: e.target.value })}
              data-testid="Task MCP server menu"
            >
              <option value="">{t("Choose an MCP server")}</option>
              {servers.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="note">{t("The MCP server Claude reads Jira, Linear and other tasks with (its mcp__<server>__* tools). The list is this project's servers; you can type another name.")}</div>
      </section>
      <section data-setting="taskPromptTemplate">
        <div className="row" style={{ gap: 8 }}>
          <h4 className="grow" style={{ margin: 0 }}>{t("First prompt template")}</h4>
          <TemplateReset current={current} onReset={() => save({ promptTemplate: undefined })} />
        </div>
        <TemplateField value={current.promptTemplate ?? defaultTaskTemplate()} onCommit={(v) => save({ promptTemplate: v })} />
        <div className="note">{t("The first message, put into the message box (or the terminal's prompt) and never sent by itself. {id}, {title}, {url}, {body} are the task's; {mcp} is how Claude reads it. A line whose placeholders are all empty is left out.")}</div>
      </section>
    </div>
  );
}

function TemplateReset({ current, onReset }: { current: TaskStartSettings; onReset: () => void }) {
  const builtIn = current.promptTemplate === undefined;
  return (
    <button type="button" className="small" disabled={builtIn} title={builtIn ? t("This is the built-in template") : t("Back to the built-in template")} onClick={onReset} data-testid="Reset task prompt template">
      {t("Reset")}
    </button>
  );
}

/** A one-line field saved on blur / Enter (not on every keystroke). */
function CommitField(props: { value: string; placeholder: string; label: string; disabled?: boolean; title?: string; onCommit: (v: string) => void; testId: string }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => draft !== props.value && props.onCommit(draft);
  return (
    <input
      type="text"
      className="mono"
      value={draft}
      placeholder={props.placeholder}
      aria-label={props.label}
      disabled={props.disabled}
      title={props.title}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => isEnter(e) && commit()}
      data-testid={props.testId}
    />
  );
}

function TemplateField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className="mono"
      rows={8}
      value={draft}
      aria-label={t("First prompt template")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      data-testid="Task prompt template"
    />
  );
}
