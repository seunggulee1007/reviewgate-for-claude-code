/**
 * MARK: wave6 w6-statusline — Settings › General › "Claude Code 상태줄" (docs/PROTOCOL.md §44.2), as on the Mac
 * (StatusLineSettingsSection): show the user's own status line (on; nothing shows without a `statusLine` in their
 * Claude Code settings; every window at once) and, for this window's project, whether the project's own `statusLine` may
 * run — code that came with the repository, allowed per project and bound to that very command (a changed one asks
 * again). The engine's last `status_line` says what runs or why nothing does.
 */
import type { AppSettings } from "../../../shared/ipc";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { projectStatusLineChoice, useStatusLine, withProjectStatusLine } from "../../statusLine";

export function StatusLineSettingsSection({ settings }: { settings: AppSettings }) {
  const save = useStore((s) => s.saveSettings);
  const root = useStore((s) => s.state.project?.root ?? null);
  const reply = useStatusLine((s) => s.reply);
  const project = reply?.project;
  const choice = projectStatusLineChoice(settings.projectStatusLineAllowed, root, project);
  return (
    <section data-testid="Claude Code status line section">
      <h4>{t("Claude Code status line")}</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.showStatusLine !== false}
          onChange={(e) => void save({ showStatusLine: e.target.checked })}
          data-testid="Show the Claude Code status line"
        />
        {t("Show the Claude Code status line")}
      </label>
      <div className="note">
        {t("Your own status line (the statusLine command of your Claude Code settings, such as the OMC HUD) under the message box, colored as in the terminal. It runs while a project is open and the chat is on screen.")}
      </div>
      {reply && reply.configured && reply.command ? (
        <div className="note" title={reply.path ?? undefined} data-testid="Status line command">
          {t("Command")}: <span className="mono">{reply.command}</span>
        </div>
      ) : reply?.disabled === "disable_all_hooks" ? (
        <div className="note">{t("Turned off: a settings file says disableAllHooks, or \"Turn off my hooks\" is on (Extensions).")}</div>
      ) : reply?.disabled === "managed_policy" ? (
        <div className="note" data-testid="Status line managed policy">
          {t("Turned off by your organization's managed settings: they allow only their own status line, or could not be read.")}
        </div>
      ) : reply ? (
        <div className="note">{t("Your Claude Code settings have no statusLine, so nothing extra is shown.")}</div>
      ) : null}
      {/* A run that failed — also the first one, when there are no lines to hover for the reason. */}
      {reply?.error && (
        <div className="note" style={{ color: "var(--orange)" }} data-testid="Status line failure">
          {t("The last run failed: {0}", reply.error.code === "timeout" ? t("it did not answer in time") : reply.error.message)}
        </div>
      )}
      {project && root && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={choice.allowed}
              disabled={reply?.disabled !== undefined || !project.sha256}
              onChange={(e) => void save({ projectStatusLineAllowed: withProjectStatusLine(settings.projectStatusLineAllowed, root, e.target.checked ? project.sha256 : "") })}
              data-testid="Run this project's status line"
            />
            {t("Run this project's status line")}
          </label>
          <div className="note" title={project.path} data-testid="Project status line command">
            {t("This project's")}: <span className="mono">{project.command}</span>
          </div>
          {choice.changed && (
            <div className="note" style={{ color: "var(--orange)" }} data-testid="Project status line changed">
              {t("The command changed since you allowed it. Check it and turn this on again.")}
            </div>
          )}
          <div className="note">
            {t("This project's .claude/settings.json has its own statusLine — a command that came with the repository. It runs only once you allow this very command here; a changed command asks again.")}
          </div>
        </>
      )}
    </section>
  );
}
