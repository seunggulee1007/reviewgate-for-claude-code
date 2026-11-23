/**
 * Settings' tabs besides Permissions, Project and Accounts (docs/PROTOCOL.md §55.11 — they were one long General tab; the
 * Mac app's SettingsPanes.swift): General (appearance, the chat, closing, notifications, updates), Session (the terminal,
 * the session, extensions, limits, side questions, other sessions, the status line, the system prompt), Review (ignore
 * patterns, disk space, test commands), Git & Workbenches and Advanced (toolchain, overrides, the pinned CLI). Each row
 * carries `data-setting` (the search jumps there) and, when it does not apply at once, its badge. Every control persists
 * through `store.saveSettings` (→ `window.rg.setSettings` → `set_settings`).
 */
import { useEffect, useState } from "react";
import type { Appearance, AppSettings, ExecutableKind, ToolchainInfo } from "../../../shared/ipc";
import { t } from "../../i18n";
import { toolchainDetectedNote, toolchainOverrideNote } from "../../platformWords"; // MARK: wave4d w4d-windows
import { useStore } from "../../store";
import { PeerInboundSection } from "./PeerSettings";
import { TestCommandPatternsSection } from "./TestCommandPatterns";
import { CliVersionSection } from "./CliVersions"; // MARK: wave3 desktop-session
import { backgroundWorkOn } from "../../background"; // MARK: §52
import { MAX_MAX_TURNS, MIN_MAX_TURNS, maxTurnsOf } from "../../longWork"; // MARK: wave4 w4-longwork
import { StorageSettingsSection } from "./StorageSettings"; // MARK: wave4b w4b-bigturn
import { isEnter } from "../../ime";
import { NotificationGroupsSection } from "../NotificationNotices"; // MARK: wave4b w4-notify
import { SideModelPicker, SideWebSetting } from "./SideSettings"; // MARK: wave4b w4b-side
import { StatusLineSettingsSection } from "./StatusLineSettings"; // MARK: wave6 w6-statusline
import { DEFAULT_SYSTEM_PROMPT_APPEND } from "../../../shared/systemPrompt"; // §54
import { TerminalSettingsSection } from "./TerminalSettings"; // MARK: terminal-win (§57.17)
import { UpdateSettingsSection } from "./UpdateSettings"; // §48 Windows
import { AppliesBadge } from "./SettingsBits"; // §55.11

/** Mirrors src/main/settings.ts (which cannot be imported here: it pulls in `electron`). */
const DEFAULT_IGNORE_PATTERNS = ".omc/\n.claude/settings.local.json";
const DEFAULT_WORKTREE_ROOT = "~/.reviewgate/worktrees";
const HARD_MULTIPLIER = 2.0;

type PaneProps = { settings: AppSettings };

function usePatch() {
  const save = useStore((s) => s.saveSettings);
  return (p: Partial<AppSettings>) => void save(p);
}

/** Appearance, the chat, closing and quitting, notifications, updates. */
export function GeneralPane({ settings }: PaneProps) {
  const patch = usePatch();
  return (
    <div className="body" data-testid="Settings general">
      <section>
        <h4>{t("Appearance")}</h4>
        <div className="field-row" data-setting="appearance">
          <span>{t("Theme")}</span>
          <select value={settings.appearance ?? "system"} onChange={(e) => patch({ appearance: e.target.value as Appearance })} data-testid="Appearance">
            <option value="system">{t("System")}</option>
            <option value="light">{t("Light")}</option>
            <option value="dark">{t("Dark")}</option>
          </select>
        </div>
        <div className="note">{t("System follows the OS setting. Applies immediately to every window, including the title bar and menus.")}</div>
        <label className="check" data-setting="reopenLastProjects">
          <input
            type="checkbox"
            checked={settings.reopenLastProjects !== false}
            onChange={(e) => patch({ reopenLastProjects: e.target.checked })}
            data-testid="Reopen last projects"
          />
          {t("Reopen last projects on launch")}
        </label>
        <div className="note">{t("Reopens the windows that were open when you last quit (up to 5, in order). Off: start with the empty state.")}</div>
      </section>
      <section>
        <h4>{t("Typing and the chat")}</h4>
        {/* MARK: wave4b w4b-tabs — market-12: reads and searches in a row fold into one "탐색: …" line unless this is on. */}
        <label className="check" data-setting="showExploreDetail">
          <input
            type="checkbox"
            checked={settings.showExploreDetail === true}
            onChange={(e) => patch({ showExploreDetail: e.target.checked })}
            data-testid="Show exploration rows in detail"
          />
          {t("Show exploration rows in detail")}
        </label>
        <div className="note">{t("Off: reads, searches and read-only commands in a row fold into one line in the chat (click it to open).")}</div>
      </section>
      <section>
        <h4>{t("Closing and quitting")}</h4>
        {/* MARK: wave4 w4-safety — daily-12: the close / quit confirm ("Don't ask again" turns it off; on again here). */}
        <label className="check" data-setting="confirmQuit">
          <input
            type="checkbox"
            checked={settings.confirmQuit !== false}
            onChange={(e) => patch({ confirmQuit: e.target.checked })}
            data-testid="Ask before quitting"
          />
          {t("Ask before quitting")}
        </label>
        <div className="note">{t("Closing the last window or quitting asks first. \"Don't ask again\" in that question turns this off.")}</div>
        <label className="check" data-setting="confirmCloseWhileWorking">
          <input
            type="checkbox"
            checked={settings.confirmCloseWhileWorking !== false}
            onChange={(e) => patch({ confirmCloseWhileWorking: e.target.checked })}
            data-testid="Ask before closing while Claude works"
          />
          {t("Ask before closing while Claude works")}
        </label>
        <div className="note">{t("Closing a window or quitting while a turn runs, or while Claude waits for your answer, asks first.")}</div>
      </section>
      <section>
        <h4>{t("Notifications")}</h4>
        <label className="check" data-setting="notifications">
          <input type="checkbox" checked={settings.notifications !== false} onChange={(e) => patch({ notifications: e.target.checked })} data-testid="Notifications" />
          {t("Notify me when ReviewGate is in the background")}
        </label>
        <div className="note">{t("A turn finished (files to review), a permission request, a plan, a question from Claude, or an error that needs you. The dock / taskbar shows how many are waiting.")}</div>
        <label className="check" data-setting="notificationSound" title={settings.notifications === false ? t("Turn on notifications first") : undefined}>
          <input type="checkbox" checked={settings.notificationSound !== false} disabled={settings.notifications === false} onChange={(e) => patch({ notificationSound: e.target.checked })} data-testid="Notification sound" />
          {t("Play a sound")}
        </label>
        {/* MARK: wave4b w4-notify — one switch per group, where to look in the OS */}
        <NotificationGroupsSection settings={settings} patch={patch} />
      </section>
      {/* §48 Windows: automatic checks, the install as the banner shows it, Check Now */}
      <UpdateSettingsSection settings={settings} patch={patch} />
    </div>
  );
}

/** The terminal, the session, extensions, limits, side questions, other sessions, the status line, the system prompt. */
export function SessionPane({ settings }: PaneProps) {
  const patch = usePatch();
  const openDialog = useStore((s) => s.openDialog);
  return (
    <div className="body" data-testid="Settings session">
      <TerminalSettingsSection settings={settings} patch={patch} />{/* MARK: terminal-win — §57.17 */}
      <section>
        <h4>{t("Session")}</h4>
        <label className="check" data-setting="autoRestartSession">
          <input type="checkbox" checked={settings.autoRestartSession} onChange={(e) => patch({ autoRestartSession: e.target.checked })} data-testid="Auto-restart session" />
          {t("Auto-restart session")}
        </label>
        <div className="note">{t("When the Claude session dies unexpectedly, restart it automatically (once per turn) instead of waiting for Restart.")}</div>
        {/* MARK: §52 */}
        <label className="check" data-setting="backgroundWork">
          <input type="checkbox" checked={backgroundWorkOn(settings)} onChange={(e) => patch({ backgroundWork: e.target.checked })} data-testid="Background work" />
          {t("Allow background tasks and /loop")}
          <AppliesBadge id="backgroundWork" />
        </label>
        <div className="note">{t("Like the terminal, Claude can run commands in the background (a dev server, a long build) and repeat the same request with /loop. When a background command ends or a scheduled run starts, Claude goes on, and that turn is reviewed like any other. Files a background command changed in the meantime join the next review.")}</div>
        {/* §52.2: subagents work in the background by default, as in the terminal — Claude answers meanwhile. */}
        <label className="check" data-setting="subagentsInTurn" title={backgroundWorkOn(settings) ? undefined : t("Allow background work first: without it every subagent finishes inside the turn")}>
          <input type="checkbox" checked={settings.subagentsInTurn === true} disabled={!backgroundWorkOn(settings)} onChange={(e) => patch({ subagentsInTurn: e.target.checked })} data-testid="Subagents finish inside the turn" />
          {t("Subagents finish inside the turn")}
          <AppliesBadge id="subagentsInTurn" />
        </label>
        <div className="note">{t("Off (the default): as in the terminal, a subagent works in the background and Claude answers your messages meanwhile; what it changes still goes into the next review, and Claude goes on when it is done. On: Claude waits for its subagents before it answers, as before.")}</div>
      </section>
      <section>
        <h4>{t("Extensions")}</h4>
        <label className="check" data-setting="loadUserSettings">
          <input type="checkbox" checked={settings.loadUserSettings} onChange={(e) => patch({ loadUserSettings: e.target.checked })} data-testid="Load user settings" />
          {t("Load user settings (skills, plugins, MCP, hooks from ~/.claude)")}
          <AppliesBadge id="loadUserSettings" />
        </label>
        <div className="note">{t("Skills, plugins, MCP servers and hooks from ~/.claude. Bash and other non-edit tools still require approval here.")}</div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="small" disabled={!settings.loadUserSettings} title={settings.loadUserSettings ? undefined : t("Turn on Load user settings first")} onClick={() => openDialog({ kind: "extensions" })} data-testid="Settings extensions">
            {t("Applied extensions…")}
          </button>
          <span className="caption muted">{t("Turn single plugins or your hooks off for ReviewGate sessions.")}</span>
        </div>
      </section>
      <section>
        <h4>{t("Limits")}</h4>
        {/* §54: off by default — Claude works through a task as in the terminal; the numbers apply only while it is on */}
        <label className="check" data-setting="budgetEnabled">
          <input type="checkbox" checked={settings.budgetEnabled === true} onChange={(e) => patch({ budgetEnabled: e.target.checked })} data-testid="Limit changes per reply" />
          {t("Limit changes per reply")}
        </label>
        <Stepper label={t("Max files")} value={settings.budgetMaxFiles} min={1} max={100} step={1} disabled={settings.budgetEnabled !== true} onChange={(v) => patch({ budgetMaxFiles: v })} testId="Max files" />
        <Stepper label={t("Max changed lines")} value={settings.budgetMaxLines} min={10} max={5000} step={10} disabled={settings.budgetEnabled !== true} onChange={(v) => patch({ budgetMaxLines: v })} testId="Max changed lines" />
        <div className="note">
          {settings.budgetEnabled === true
            ? t("Hard stop at ×{0} — edits beyond it are denied by the sidecar. Applies live to the open session.", HARD_MULTIPLIER.toFixed(1))
            : t("Off (the default): no limit on the files or lines one reply changes — Claude finishes the task as in the terminal, and you review the changes afterwards.")}
        </div>
        {/* MARK: wave4 w4-longwork — §38.2: no limit by default (as in the terminal); the number applies only while it is on */}
        <label className="check" data-setting="maxTurnsLimit">
          <input type="checkbox" checked={settings.maxTurnsLimit === true} onChange={(e) => patch({ maxTurnsLimit: e.target.checked })} data-testid="Limit tool calls per message" />
          {t("Limit tool calls per message")}
          <AppliesBadge id="maxTurnsLimit" />
        </label>
        <Stepper label={t("Tool calls per message")} value={maxTurnsOf(settings.maxTurns)} min={MIN_MAX_TURNS} max={MAX_MAX_TURNS} step={10} disabled={settings.maxTurnsLimit !== true} onChange={(v) => patch({ maxTurns: v })} testId="Max tool calls per message" />
        <div className="note">{t("Off (the default): no limit — Claude works through a message until it is done, as in the terminal. On: Claude stops after this many tool calls for one message; Continue goes on from there.")}</div>
      </section>
      <section>
        <h4>{t("Side questions")}</h4>
        <div className="field-row" data-setting="sideModel">
          <span>{t("Model")}</span>
          {/* MARK: wave4b w4b-side — §40.3 the model from the session's list, the web off by default */}
          <SideModelPicker value={settings.sideModel ?? ""} onCommit={(v) => patch({ sideModel: v })} fallback={<SideModelInput value={settings.sideModel ?? ""} onCommit={(v) => patch({ sideModel: v })} />} />
        </div>
        <div className="note">{t("Same model as the main conversation: it reuses the conversation's cache and answers fastest. Another model (e.g. haiku) costs less per token but reads the whole conversation again.")}</div>
        <SideWebSetting settings={settings} patch={patch} />
        <div className="note">{t("Side questions are always read-only: they can read files but never edit them or run changing commands.")}</div>
      </section>
      <PeerInboundSection settings={settings} />
      <StatusLineSettingsSection settings={settings} />{/* MARK: wave6 w6-statusline — §44.2 */}
      <section data-setting="systemPromptAppend">
        <h4 className="row" style={{ gap: 6 }}>{t("System prompt append")}<AppliesBadge id="systemPromptAppend" /></h4>
        <TextArea value={settings.systemPromptAppend} rows={6} placeholder={DEFAULT_SYSTEM_PROMPT_APPEND} onCommit={(v) => patch({ systemPromptAppend: v })} testId="System prompt append" />
        <div className="note">{t("Placeholders {maxFiles} and {maxLines} are substituted. Empty uses the built-in prompt.")}</div>
        <div><button type="button" className="small" onClick={() => patch({ systemPromptAppend: "" })}>{t("Reset to default")}</button></div>
      </section>
    </div>
  );
}

/** Checkpoint ignore patterns, disk space, test command patterns. */
export function ReviewPane({ settings }: PaneProps) {
  const patch = usePatch();
  return (
    <div className="body" data-testid="Settings review">
      <section data-setting="checkpointIgnorePatterns">
        <h4>{t("Checkpoint ignore patterns")}</h4>
        <TextArea value={settings.checkpointIgnorePatterns} mono rows={4} onCommit={(v) => patch({ checkpointIgnorePatterns: v })} testId="Checkpoint ignore patterns" />
        <div className="note">{t("One per line; a path prefix (e.g. .omc/) or a glob with * (e.g. *.log). Matching files are hidden from the review list and never reverted. Applies to the next turn.")}</div>
        <div><button type="button" className="small" onClick={() => patch({ checkpointIgnorePatterns: DEFAULT_IGNORE_PATTERNS })}>{t("Reset to default")}</button></div>
      </section>
      <TestCommandPatternsSection settings={settings} />{/* wave3 check-clients — §34.9 */}
      <StorageSettingsSection settings={settings} />{/* MARK: wave4b w4b-bigturn — §39.1 large-file limit, [오래된 리뷰 기록 정리] */}
    </div>
  );
}

/** Where workbenches go, Run as Task, the commit dialog's push default and trailer. */
export function GitPane({ settings }: PaneProps) {
  const patch = usePatch();
  return (
    <div className="body" data-testid="Settings git">
      <section>
        <h4>{t("Workbenches")}</h4>
        <div className="field-row" data-setting="worktreeRoot">
          <span>{t("Worktree folder")}</span>
          <TextField value={settings.worktreeRoot} placeholder={DEFAULT_WORKTREE_ROOT} onCommit={(v) => patch({ worktreeRoot: v })} testId="Worktree folder" />
        </div>
        <div className="note">{t("New workbenches are created under this folder as <repo>-<hash>/<branch>. Never inside the repository.")}</div>
        {/* MARK: §49 Run as Task — the composer's button, File › and the sidebar's "업무로 실행…" (default on) */}
        <label className="check" data-setting="runAsTaskEnabled">
          <input type="checkbox" checked={settings.runAsTaskEnabled !== false} onChange={(e) => patch({ runAsTaskEnabled: e.target.checked })} data-testid="Run as Task enabled" />
          {t("Run as Task")}
        </label>
        <div className="note">{t("Adds \"Run as Task\" to the composer and the Workbenches menu: the message starts in a new workbench (its own branch, folder, window and chat), so this chat is left as it is.")}</div>
      </section>
      <section>
        <h4>{t("Commit")}</h4>
        <label className="check" data-setting="commitPushByDefault">
          <input type="checkbox" checked={settings.commitPushByDefault} onChange={(e) => patch({ commitPushByDefault: e.target.checked })} data-testid="Push by default" />
          {t("Push by default")}
        </label>
        <div className="field-row" data-setting="commitTrailer">
          <span>{t("Commit trailer")}</span>
          <TextField value={settings.commitTrailer} placeholder="Co-Authored-By: …" onCommit={(v) => patch({ commitTrailer: v })} testId="Commit trailer" />
        </div>
        <div className="note">{t("Appended as the last line of every commit message made from here (e.g. Co-Authored-By: …). Empty adds nothing.")}</div>
      </section>
      <div className="caption muted">{t("The commit message template, workbench setup and PR command of the open repository are in Project.")}</div>
    </div>
  );
}

/** What the window found, the path overrides and the pinned CLI version. */
export function AdvancedPane({ settings }: PaneProps) {
  const toolchain = useStore((s) => s.state.toolchain);
  const hasProject = useStore((s) => s.state.project !== null);
  const [info, setInfo] = useState<ToolchainInfo | null>(null);
  useEffect(() => {
    void window.rg.toolchainInfo().then(setInfo);
  }, []);
  return (
    <div className="body" data-testid="Settings advanced">
      <section data-setting="toolchain">
        <h4>{t("Toolchain")}</h4>
        <ToolRow name="claude" path={toolchain.claude} version={toolchain.claudeVersion} />
        <ToolRow name="gh" path={toolchain.gh} version={toolchain.ghVersion} />
        <ToolRow name="git" path={toolchain.git} version={null} />
        <ToolRow name="node" path={info ? `Electron ${info.electron} (node ${info.node})` : null} version={null} />
        <div className="note">{toolchainDetectedNote(window.rg.platform, hasProject) /* MARK: wave4d w4d-windows (polish-07): PATH on Windows */}</div>
      </section>
      <section>
        <h4>{t("Toolchain overrides")}</h4>
        <ExecutableRow kind="claude" label={t("claude path")} value={settings.claudePath} detected={toolchain.claude} setting="claudePath" />
        <ExecutableRow kind="gh" label={t("gh path")} value={settings.ghPath} detected={toolchain.gh} setting="ghPath" />
        <ExecutableRow kind="git" label={t("git path")} value={settings.gitPath} detected={toolchain.git} setting="gitPath" />
        <div className="note">{toolchainOverrideNote(window.rg.platform)}</div>
      </section>
      {/* MARK: wave3 desktop-session — §36.8 "CLI 버전 고정" */}
      <CliVersionSection />
    </div>
  );
}

/**
 * One executable override: the path is shown, never typed — "Choose…" opens main's native file
 * dialog and main validates the file (src/main/settingsGuard.ts), so the renderer cannot hand main a binary to spawn.
 */
function ExecutableRow({ kind, label, value, detected, setting }: { kind: ExecutableKind; label: string; value: string; detected: string | null; setting: string }) {
  const [error, setError] = useState<string | null>(null);
  const apply = (s: AppSettings | null) => {
    setError(null);
    if (s) useStore.setState({ settings: s });
  };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
  return (
    <div className="field-row" data-setting={setting}>
      <span className="row" style={{ gap: 4 }}>{label}<AppliesBadge id={setting} /></span>
      <div className="col" style={{ gap: 2 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className={`tool-path mono ${value ? "" : "missing"}`} title={value || detected || undefined} data-testid={label}>
            {value || `${t("auto-detect")}${detected ? ` (${detected})` : ""}`}
          </span>
          <button type="button" className="small" onClick={() => void window.rg.pickExecutable(kind).then(apply, fail)} data-testid={`${label} choose`}>{t("Choose…")}</button>
          {value && <button type="button" className="small" onClick={() => void window.rg.clearExecutable(kind).then(apply, fail)}>{t("auto-detect")}</button>}
        </div>
        {error && <span className="caption" style={{ color: "var(--red)" }}>{t("Not used: {0}", error)}</span>}
      </div>
    </div>
  );
}

function ToolRow({ name, path, version }: { name: string; path: string | null; version: string | null }) {
  return (
    <div className="field-row">
      <span className="mono">{name}</span>
      <div className="col" style={{ gap: 1 }}>
        <span className={`tool-path ${path ? "" : "missing"}`} title={path ?? undefined}>{path ?? t("not found")}</span>
        {version && <span className="caption muted">{version}</span>}
      </div>
    </div>
  );
}

function Stepper(props: { label: string; value: number; min: number; max: number; step: number; disabled?: boolean; onChange: (v: number) => void; testId: string }) {
  const clamp = (v: number) => Math.min(props.max, Math.max(props.min, Math.round(v)));
  return (
    <div className={props.disabled ? "stepper muted" : "stepper"}>
      <span style={{ width: 130 }}>{props.label}</span>
      <input type="number" value={props.value} min={props.min} max={props.max} step={props.step} disabled={props.disabled} data-testid={props.testId}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== props.value) props.onChange(clamp(v)); }} />
      <button type="button" className="small" disabled={props.disabled} onClick={() => props.onChange(clamp(props.value - props.step))}>−</button>
      <button type="button" className="small" disabled={props.disabled} onClick={() => props.onChange(clamp(props.value + props.step))}>+</button>
    </div>
  );
}

/** Text input that persists on blur / Enter (typing does not round-trip through the main process). */
function TextField(props: { value: string; placeholder?: string; onCommit: (v: string) => void; testId: string }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => draft !== props.value && props.onCommit(draft);
  return <input type="text" className="mono" value={draft} placeholder={props.placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => isEnter(e) && commit()} data-testid={props.testId} />;
}

function TextArea(props: { value: string; rows: number; mono?: boolean; placeholder?: string; onCommit: (v: string) => void; testId: string }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  return <textarea className={props.mono ? "mono" : ""} rows={props.rows} value={draft} placeholder={props.placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== props.value && props.onCommit(draft)} data-testid={props.testId} />;
}

/** The side-question model: saved on blur / Enter (not on every keystroke — each save restarts nothing but re-sends settings). */
function SideModelInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    const next = v.trim();
    if (next !== value && /^[A-Za-z0-9._:\[\]/-]*$/.test(next)) onCommit(next);
  };
  return (
    <input
      type="text"
      className="mono"
      value={v}
      placeholder={t("same as main")}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => isEnter(e) && commit()}
      data-testid="Side model"
    />
  );
}
