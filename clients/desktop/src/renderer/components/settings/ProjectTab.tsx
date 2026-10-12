/**
 * MARK: wave3 desktop-flow
 * Settings › Project (as on the Mac): the daily-flow settings of this window's repository (docs/PROTOCOL.md §36.11 / §36.12 /
 * §36.14) — the commit message template, the workbench setup and the command PR comments start with. Kept per repository
 * (its main worktree), so every workbench of it shares them; the same editors as the commit sheet's and the workbench sheet's.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useStore, lastComponent } from "../../store";
import { flowRepoRoot, prRespondCommandFor } from "../../../shared/flowSettings";
import { CommitTemplateEditor } from "../flow/CommitDraft";
import { WorkbenchSetupEditor } from "../flow/WorkbenchSetup";
import "../flow/flow.css";
import { isEnter } from "../../ime";
import { AutoAcceptSettings } from "../trust/TrustViews"; // MARK: wave4c w4c-trust (§41.2)

export function ProjectTab() {
  const root = useStore((s) => flowRepoRoot(s.state));
  if (!root) {
    return (
      <div className="empty" data-testid="Project settings empty">
        <h2>{t("No project open")}</h2>
        <div className="muted">{t("Open a project to edit the settings of its repository.")}</div>
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 14 }} data-testid="Project settings">
      <div className="muted caption">{t("Settings of {0} — every workbench of this repository uses them.", lastComponent(root))}</div>
      <section className="col" style={{ gap: 6 }}>
        <h4 style={{ margin: 0 }}>{t("Commit message template")}</h4>
        <CommitTemplateEditor />
      </section>
      <section className="col" style={{ gap: 6 }}>
        <h4 style={{ margin: 0 }}>{t("Workbench setup")}</h4>
        <WorkbenchSetupEditor />
      </section>
      <section className="col" style={{ gap: 6 }}>
        <h4 style={{ margin: 0 }}>{t("PR comments")}</h4>
        <PrRespondCommandField />
      </section>
      <AutoAcceptSettings />{/* MARK: wave4c w4c-trust (§41.2) */}
    </div>
  );
}

/** The repository's command for "Send to Claude" on PR comments (client only — never sent to the engine). */
function PrRespondCommandField() {
  const root = useStore((s) => flowRepoRoot(s.state));
  const saved = useStore((s) => prRespondCommandFor(s.settings, flowRepoRoot(s.state)));
  const saveFlowSettings = useStore((s) => s.saveFlowSettings);
  const [text, setText] = useState(saved);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(saved);
  }, [saved, root]);
  const commit = () => {
    focused.current = false;
    if (text.trim() !== saved) void saveFlowSettings({ prRespondCommand: text });
  };
  return (
    <div className="col" style={{ gap: 4 }}>
      <input
        type="text"
        className="mono"
        value={text}
        placeholder="/acme-tools:review-reply {pr}"
        aria-label={t("Command for PR comments")}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (isEnter(e)) (e.target as HTMLInputElement).blur();
        }}
        data-testid="PR respond command"
      />
      <div className="flow-help">{t("“Send to Claude” starts the draft with this command ({pr} = the PR number) — e.g. a skill that fixes the code and answers each comment. Empty: the comments only. You still read the draft and send it yourself.")}</div>
    </div>
  );
}
