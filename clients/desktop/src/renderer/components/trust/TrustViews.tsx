/**
 * MARK: wave4c w4c-trust — docs/PROTOCOL.md §41.2 (Electron; Mac `App/UI/Sidebar/TrustViews.swift`): the "규칙으로 수락"
 * badge of a file, the turn summary's "규칙으로 수락 N개 [모두 대기로 되돌리기]", the "거절했어요 — [거절 취소]" banner and
 * Settings › Project › 자동 수락 규칙. Decisions in src/renderer/trust.ts; the commands go straight to the engine.
 */
import type { AutoAcceptedFile, AutoAcceptRule, EngineCommand } from "@reviewgate/engine";
import { useState } from "react";
import { engineRequest, refusalOf } from "../../engineRequest";
import { refusalMessage } from "../../errorCodes";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { autoAcceptedHelp, autoUndoView, enabledTrustRules, rejectUndoView, TRUST_RULES, trustNeverText, trustRuleHelp, trustRuleName } from "../../trust";
import "./trust.css";

/** Sends `cmd`; a refusal goes to the top banner unless `quiet` says the view already shows why. */
async function send(cmd: EngineCommand, quiet: (code: string) => boolean = () => false): Promise<boolean> {
  try {
    await engineRequest(cmd);
    return true;
  } catch (e) {
    const r = refusalOf(e);
    if (!quiet(r.code)) {
      const message = refusalMessage(r);
      useStore.setState({ lastError: message, errorBanner: { message, scope: "session", fatal: false, code: r.code } });
    }
    return false;
  }
}

/** The file row's badge: accepted by a rule, not by the user. */
export function AutoAcceptedBadge({ rule, path }: { rule: string | undefined; path: string }) {
  if (!rule) return null;
  const name = trustRuleName(rule);
  return (
    <span className="pill green risk trust-badge" title={autoAcceptedHelp(rule)} aria-label={autoAcceptedHelp(rule)} data-testid={`Auto accepted ${path}`}>
      {t("By rule")}
      {name ? ` · ${name}` : ""}
    </span>
  );
}

/** The turn summary's line: how many files this collection's rules accepted, and [모두 대기로 되돌리기]. */
export function AutoAcceptedSummaryLine({ files }: { files: readonly AutoAcceptedFile[] }) {
  const changedFiles = useStore((s) => s.state.changedFiles);
  const gate = useStore((s) => s.state.gate);
  const view = autoUndoView({ changedFiles, gate }, files.map((f) => f.path));
  const [busy, setBusy] = useState(false);
  if (files.length === 0) return null;
  const names = [...new Set(files.map((f) => trustRuleName(f.rule)).filter((n): n is string => n !== null))].join(" · ");
  return (
    <div className="ts-review-line trust-line" data-testid="Summary auto accepted">
      <span title={files.map((f) => f.path).join("\n")}>
        {t("Accepted by a rule: {0} file(s)", files.length)}
        {names ? ` (${names})` : ""}
      </span>
      <button
        type="button"
        className="plain small"
        disabled={busy || view.blocked !== null}
        title={view.blocked ?? t("Puts these files back to pending — nothing on disk changes")}
        aria-label={t("Back to pending (all)")}
        data-testid="Summary auto accepted undo"
        onClick={async () => {
          setBusy(true);
          await send({ type: "auto_accept_undo", paths: view.paths });
          setBusy(false);
        }}
      >
        {t("Back to pending (all)")}
      </button>
      {view.blocked && <span className="muted caption" data-testid="Summary auto accepted reason">{view.blocked}</span>}
    </div>
  );
}

/** "거절했어요 — [거절 취소]" while the engine offers it (gone at the next turn or another reject). */
export function RejectUndoBanner() {
  const gate = useStore((s) => s.state.gate);
  const [busy, setBusy] = useState(false);
  const view = rejectUndoView({ gate });
  if (!view) return null;
  return (
    <div className="banner gate-banner yellow trust-undo" role="status" data-testid="Reject undo banner">
      <div className="gate-main">
        <span className="gate-text" title={view.path}>{t("Rejected — {0}", view.path)}</span>
        {view.blocked && <span className="muted caption" data-testid="Reject undo reason">{view.blocked}</span>}
      </div>
      <div className="gate-actions">
        <button
          type="button"
          className="small"
          disabled={busy || view.blocked !== null}
          title={view.blocked ?? t("Puts the proposal back on disk and in the review, pending")}
          data-testid="Reject undo"
          onClick={async () => {
            setBusy(true);
            await send({ type: "reject_undo", path: view.path }, (code) => code.startsWith("reject_undo_"));
            setBusy(false);
          }}
        >
          {t("Undo the reject")}
        </button>
      </div>
    </div>
  );
}

/** Settings › Project › 자동 수락 규칙: one switch per rule, kept for the repository by the engine. */
export function AutoAcceptSettings() {
  const rules = useStore((s) => s.state.autoAcceptRules);
  const open = useStore((s) => s.state.project !== null);
  const on = new Set(enabledTrustRules(rules));
  const toggle = (rule: AutoAcceptRule, value: boolean) => {
    const next: Partial<Record<AutoAcceptRule, boolean>> = {};
    for (const r of TRUST_RULES) if (r === rule ? value : on.has(r)) next[r] = true;
    void send({ type: "set_auto_accept", rules: next });
  };
  return (
    <section className="col" style={{ gap: 6 }} data-testid="Auto accept settings">
      <h4 style={{ margin: 0 }}>{t("Auto-accept rules")}</h4>
      <div className="note">{t("Off by default. A rule accepts a file when a turn ends (a lockfile also when you accept its manifest), and the list marks it. Every worktree of this repository uses them.")}</div>
      {TRUST_RULES.map((rule) => (
        <div key={rule} className="col" style={{ gap: 2 }}>
          <label className="check">
            <input type="checkbox" checked={on.has(rule)} disabled={!open} onChange={(e) => toggle(rule, e.target.checked)} data-testid={`Auto accept ${rule}`} />
            {trustRuleName(rule)}
          </label>
          <div className="note">{trustRuleHelp(rule)}</div>
        </div>
      ))}
      <div className="note">{trustNeverText()}</div>
    </section>
  );
}
