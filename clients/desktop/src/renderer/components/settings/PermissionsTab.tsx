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

/** Two "one per line" texts as one, duplicates dropped (the repository's list first). */
function mergedLines(a: string | undefined, b: string | undefined): string {
  const lines = [a ?? "", b ?? ""].flatMap((x) => x.split(/\r?\n/)).map((l) => l.trim()).filter((l) => l.length > 0);
  return [...new Set(lines)].join("\n");
}

export function PermissionsTab({ settings }: { settings: AppSettings }) {
  const save = useStore((s) => s.saveSettings);
  const projectRoot = useStore((s) => s.state.project?.root ?? null);
  const commonDir = useStore((s) => s.state.project?.commonDir ?? null);
  const remembered = useStore((s) => rememberedAllowsOf(s.state));
  const forgetAllows = useStore((s) => s.forgetAllows);
  // MARK: r2-skills-side — §33.6 (M21): the list is the repository's (every worktree of it); one this folder kept before is
  // shown with it and moves there on the next edit.
  const projectHash = projectRoot ? projectRootHash(commonDir ?? projectRoot) : null;
  const legacyHash = projectRoot && commonDir ? projectRootHash(projectRoot) : null;
  const projectText = projectHash ? mergedLines(settings.projectBashAllowPatterns?.[projectHash], legacyHash ? settings.projectBashAllowPatterns?.[legacyHash] : undefined) : "";
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
                value={projectText}
                onCommit={(v) => {
                  const { [legacyHash ?? ""]: _moved, ...rest } = settings.projectBashAllowPatterns ?? {};
                  patch({ projectBashAllowPatterns: { ...(legacyHash ? rest : settings.projectBashAllowPatterns ?? {}), [projectHash]: v } });
                }}
                label={`${t("Allow patterns")} — ${t("This project")}`}
                testId="Project allow patterns"
              />
            </div>
            <div className="note">{t("For this repository and all its worktrees ({0}), added by \"Always allow in this project\" on a permission card. Applies immediately.", projectRoot ?? "")}</div>
          </>
        )}
      </section>
      <section>
        <h4>{t("Allowed for the session")}</h4>
        <label className="check">
          <input type="checkbox" checked={settings.persistSessionAllows !== false} onChange={(e) => patch({ persistSessionAllows: e.target.checked })} data-testid="Persist session allows" />
          {t("Keep \"Allow for session\" for this repository")}
        </label>
        <div className="note">{t("Kept when the app reopens · shared by the repository's worktrees and workbenches")}</div>
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
        {/* MARK: r2-skills-side — §33.5 (M20) */}
        {/* the reason it is off on the whole row, not only on the box (a disabled box is a 13-pixel target) */}
        <label className={`check ${applyRules ? "" : "disabled"}`} title={applyRules ? undefined : t("Turn on the terminal allow rules first")} data-testid="Apply user Bash rules row">
          <input type="checkbox" checked={settings.applyUserBashRules !== false} disabled={!applyRules} onChange={(e) => patch({ applyUserBashRules: e.target.checked })} title={applyRules ? undefined : t("Turn on the terminal allow rules first")} data-testid="Apply user Bash rules" />
          {t("Also apply the terminal's Bash allow rules")}
        </label>
        <div className="note">{t("Commands your Bash(…) rules allow (e.g. Bash(mvn:*)) run without a card, as in the terminal; your deny and ask rules still win, and the files they change are reviewed. Applies immediately.")}</div>
        <TerminalRules applyUserAllowRules={applyRules} />
      </section>
      <section>
        <h4>{t("Agents and worktrees")}</h4>
        <label className="check">
          <input type="checkbox" checked={settings.allowWorktreeIsolation !== false} onChange={(e) => patch({ allowWorktreeIsolation: e.target.checked })} data-testid="Allow worktree isolation" />
          {t("Allow agents that work in another worktree (isolation)")}
        </label>
        <div className="note">{t("In auto mode they run without a card; otherwise each asks with a card. A row afterwards says where they worked · applies from the next session")}</div>
      </section>
    </div>
  );
}
