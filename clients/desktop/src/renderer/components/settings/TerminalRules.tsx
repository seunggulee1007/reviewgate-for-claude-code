/**
 * Settings › Permissions › "터미널(Claude Code) 허용 규칙" (docs/PROTOCOL.md §33.8): asks `permission_rules` when it opens
 * (query lane) and shows the user's Claude Code settings files and every `permissions.allow` rule — source, whether the
 * app applies it and why. A rule that can become an app allow pattern (`importAs`) gets a checkbox (unticked); risky ones
 * (rm, git push, globs, MCP writes) a warning icon. "가져오기" appends the ticked patterns to the global or this project's
 * allow patterns (`set_settings`); the Claude Code files are never changed.
 */
import { useCallback, useEffect, useState } from "react";
import type { UserPermissionRule } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { isRiskyImport, ruleScopeText, ruleSourceStatus, ruleWhyText, rulesAfterFetch, type ImportTarget, type RulesLoad } from "../../terminalRules";
import { modeLabel } from "../chat/ModeMenu";

/** The rules: rule · source · applied or not and why; a checkbox where the rule can become an app pattern, ⚠ when risky. */
export function RulesTable({ rules, ticked, onTick }: { rules: UserPermissionRule[]; ticked: Record<string, true>; onTick: (pattern: string, on: boolean) => void }) {
  return (
    <table className="rule-table" data-testid="Terminal rules table">
      <thead>
        <tr>
          <th aria-label={t("Import")} />
          <th>{t("Rule")}</th>
          <th>{t("Source")}</th>
          <th>{t("Status")}</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r, i) => {
          const risky = isRiskyImport(r);
          const importAs = r.importAs;
          return (
            <tr key={`${r.source}:${r.rule}:${i}`} className={r.status === "applied" ? "applied" : "ignored"}>
              <td>
                {importAs && (
                  <input
                    type="checkbox"
                    checked={ticked[importAs] === true}
                    onChange={(e) => onTick(importAs, e.target.checked)}
                    aria-label={t("Import {0}", importAs)}
                    data-testid={`Import ${importAs}`}
                  />
                )}
              </td>
              <td className="mono rule-name" title={importAs && importAs !== r.rule ? `${r.rule} → ${importAs}` : r.rule}>
                {risky && (
                  <span className="risk-mark" title={t("Risky — check before importing")} aria-label={t("Risky — check before importing")}>
                    ⚠
                  </span>
                )}
                {r.rule}
              </td>
              <td className="caption">{ruleScopeText(r.source)}</td>
              <td className="caption">
                <span className={`pill ${r.status === "applied" ? "green" : "gray"}`}>{r.status === "applied" ? t("Applied") : t("Ignored")}</span> {ruleWhyText(r.why)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function TerminalRules({ applyUserAllowRules }: { applyUserAllowRules: boolean }) {
  const fetchRules = useStore((s) => s.fetchPermissionRules);
  const importPatterns = useStore((s) => s.importAllowPatterns);
  const hasProject = useStore((s) => s.state.project !== null);
  const [load, setLoad] = useState<RulesLoad>({ loading: false, rules: null, error: null });
  const [ticked, setTicked] = useState<Record<string, true>>({});
  const [target, setTarget] = useState<ImportTarget>("project");
  const [result, setResult] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoad((l) => ({ ...l, loading: true, error: null }));
    // wave2 check-clients: a refusal keeps the rules read last time (terminalRules.ts `rulesAfterFetch`).
    void fetchRules().then((r) => setLoad((l) => rulesAfterFetch(l, r)));
  }, [fetchRules]);

  // Read when the screen opens, again when the switch that changes the verdicts flips or a project opens.
  useEffect(() => {
    if (hasProject) reload();
  }, [hasProject, applyUserAllowRules, reload]);

  const rules = load.rules?.rules ?? [];
  const importable = [...new Set(rules.map((r) => r.importAs).filter((p): p is string => typeof p === "string" && p.length > 0))];
  const chosen = importable.filter((p) => ticked[p]);
  const effectiveTarget: ImportTarget = hasProject ? target : "global";

  const doImport = async () => {
    const added = await importPatterns(chosen, effectiveTarget);
    if (added === null) return;
    setTicked({});
    setResult(added > 0 ? t("Imported {0} pattern(s).", added) : t("Already in the list — nothing new to import."));
  };

  return (
    <div className="terminal-rules" data-testid="Terminal rules">
      <div className="row" style={{ gap: 8 }}>
        <span className="caption muted grow">{t("Only the ticked rules are added to this app's allow patterns. The Claude Code settings files are not changed.")}</span>
        <button type="button" className="small" onClick={reload} disabled={load.loading || !hasProject} data-testid="Terminal rules reload">
          {t("Reload")}
        </button>
      </div>
      {!hasProject && <div className="note">{t("Open a project first (⌘O)")}</div>}
      {load.loading && (
        <div className="caption muted row" style={{ gap: 6 }}>
          <span className="spinner" aria-hidden="true" />
          {t("Reading the Claude Code settings…")}
        </div>
      )}
      {load.error && (
        <div className="caption" role="alert" style={{ color: "var(--red)" }}>
          {load.error}
        </div>
      )}
      {load.rules && (
        <>
          {load.rules.defaultMode && (
            <div className="caption" data-testid="Terminal default mode">
              {t(
                "Terminal default mode: {0}",
                load.rules.defaultModeSupported
                  ? modeLabel(load.rules.defaultMode as Parameters<typeof modeLabel>[0])
                  : t("{0} (not offered here)", load.rules.defaultMode),
              )}
            </div>
          )}
          <div className="rule-sources" aria-label={t("Settings files")}>
            {load.rules.sources.map((src) => (
              <div key={`${src.scope}:${src.path}`} className="rule-source" title={src.path}>
                <span className="pill gray">{ruleScopeText(src.scope)}</span>
                <span className="mono truncate grow">{src.path}</span>
                <span className={`caption ${src.error ? "error" : src.exists ? "muted" : "faint"}`}>{ruleSourceStatus(src)}</span>
              </div>
            ))}
          </div>
          {rules.length === 0 ? (
            <div className="note">{t("No allow rules in the Claude Code settings.")}</div>
          ) : (
            <RulesTable
              rules={rules}
              ticked={ticked}
              onTick={(pattern, on) =>
                setTicked((cur) => {
                  const next = { ...cur };
                  if (on) next[pattern] = true;
                  else delete next[pattern];
                  return next;
                })
              }
            />
          )}
          {importable.length > 0 && (
            <div className="row wrap import-row" style={{ gap: 10 }}>
              <span className="caption">{t("Import into")}</span>
              <label className="check inline">
                <input type="radio" name="rules-target" checked={effectiveTarget === "project"} disabled={!hasProject} onChange={() => setTarget("project")} />
                {t("This project")}
              </label>
              <label className="check inline">
                <input type="radio" name="rules-target" checked={effectiveTarget === "global"} onChange={() => setTarget("global")} />
                {t("All projects")}
              </label>
              <span className="spacer" />
              <button type="button" className="primary small" disabled={chosen.length === 0} onClick={() => void doImport()} data-testid="Terminal rules import">
                {t("Import ({0})", chosen.length)}
              </button>
            </div>
          )}
          {result && (
            <div className="caption green" role="status">
              {result}
            </div>
          )}
        </>
      )}
    </div>
  );
}
