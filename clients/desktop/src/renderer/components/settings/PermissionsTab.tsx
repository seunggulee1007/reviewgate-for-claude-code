/**
 * Settings › Permissions (docs/PROTOCOL.md §33.4–33.8): the app's allow patterns (all projects / this project — Bash,
 * MCP tools and servers, WebFetch domains, …), "Allow for session" — kept per worktree or not — with what is allowed
 * right now, the terminal's Claude Code allow rules (applied to lookup / read tools; importable as app patterns) and
 * isolated worktree agents. Every switch persists through `store.saveSettings` (→ `set_settings`).
 */
import { useEffect, useState } from "react";
import type { AppSettings } from "../../../shared/ipc";
import { rememberedAllowsOf } from "../../friction";
import { t } from "../../i18n";
import { projectRootHash } from "../../sessions";
import { useStore } from "../../store";
import { TerminalRules } from "./TerminalRules";
import { DefaultModeSetting } from "./DefaultModeSetting"; // MARK: wave4b w4b-auto (§39.5)
import "./permissionsTab.css";

/** One pattern per line; saved on blur (typing does not round-trip through the main process). */
function PatternsField(props: { value: string; onCommit: (v: string) => void; testId: string; label: string }) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  return (
    <textarea
      className="mono"
      rows={3}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== props.value && props.onCommit(draft)}
      aria-label={props.label}
      data-testid={props.testId}
    />
  );
}

export function PermissionsTab({ settings }: { settings: AppSettings }) {
  const save = useStore((s) => s.saveSettings);
  const projectRoot = useStore((s) => s.state.project?.root ?? null);
  const remembered = useStore((s) => rememberedAllowsOf(s.state));
  const forgetAllows = useStore((s) => s.forgetAllows);
  const projectHash = projectRoot ? projectRootHash(projectRoot) : null;
  const applyRules = settings.applyUserAllowRules !== false;
  const patch = (p: Partial<AppSettings>) => void save(p);

  return (
    <div className="body" data-testid="Settings permissions">
      <DefaultModeSetting settings={settings} />
      <section>
        <h4>{t("Allow patterns")}</h4>
        <div className="field-row">
          <span>{t("All projects")}</span>
          <PatternsField value={settings.bashAllowPatterns} onCommit={(v) => patch({ bashAllowPatterns: v })} label={`${t("Allow patterns")} — ${t("All projects")}`} testId="Allow patterns" />
        </div>
        <div className="note">{t("One per line: Bash(npm test:*), Bash(git *), mcp__server__tool, mcp__server__*, WebFetch(domain:docs.spring.io), WebSearch. Matching calls never ask. Applies immediately.")}</div>
        {projectHash && (
          <>
            <div className="field-row">
              <span>{t("This project")}</span>
              <PatternsField
                value={settings.projectBashAllowPatterns?.[projectHash] ?? ""}
                onCommit={(v) => patch({ projectBashAllowPatterns: { ...(settings.projectBashAllowPatterns ?? {}), [projectHash]: v } })}
                label={`${t("Allow patterns")} — ${t("This project")}`}
                testId="Project allow patterns"
              />
            </div>
            <div className="note">{t("Only for {0}, added by \"Always allow in this project\" on a permission card. Applies immediately.", projectRoot ?? "")}</div>
          </>
        )}
      </section>
      <section>
        <h4>{t("Allowed for the session")}</h4>
        <label className="check">
          <input type="checkbox" checked={settings.persistSessionAllows === true} onChange={(e) => patch({ persistSessionAllows: e.target.checked })} data-testid="Persist session allows" />
          {t("Keep \"Allow for session\" in this worktree")}
        </label>
        <div className="note">{t("Kept when the app reopens · separate for each workbench")}</div>
        {remembered.length > 0 ? (
          <ul className="remembered-list" aria-label={t("Allowed for the session")} data-testid="Remembered allows">
            {remembered.map((key) => (
              <li key={key} title={key}>
                {key}
              </li>
            ))}
          </ul>
        ) : (
          <div className="note">{t("Nothing is allowed for the session yet.")}</div>
        )}
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="small" disabled={remembered.length === 0 || projectRoot === null} onClick={forgetAllows} data-testid="Forget session allows">
            {t("Clear all")}
          </button>
          <span className="caption muted">{t("{0} auto-allowed", remembered.length)}</span>
        </div>
      </section>
      <section>
        <h4>{t("Claude Code allow rules (terminal)")}</h4>
        <label className="check">
          <input type="checkbox" checked={applyRules} onChange={(e) => patch({ applyUserAllowRules: e.target.checked })} data-testid="Apply user allow rules" />
          {t("Apply terminal allow rules (lookup and read tools)")}
        </label>
        <div className="note">{t("Tools you allowed in Claude Code that cannot change files (WebSearch, WebFetch, read-only MCP tools, …) run here without a card. Edits and commands still go through the review. Applies immediately.")}</div>
        <TerminalRules applyUserAllowRules={applyRules} />
      </section>
      <section>
        <h4>{t("Agents and worktrees")}</h4>
        <label className="check">
          <input type="checkbox" checked={settings.allowWorktreeIsolation === true} onChange={(e) => patch({ allowWorktreeIsolation: e.target.checked })} data-testid="Allow worktree isolation" />
          {t("Allow isolated worktree agents (Workflow, isolation)")}
        </label>
        <div className="note">{t("Even when on, every one asks with a card and a warning · applies from the next session")}</div>
      </section>
    </div>
  );
}
