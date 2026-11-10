/**
 * MARK: wave5 w5-model — docs/PROTOCOL.md §43.4 auto model in the Windows client, as on the Mac: the model picker's "자동"
 * with its three policies, the composer's one-message model ("이번엔 opus"), the chat's faint switch line, the turn
 * summary's model line and auto's picks in the cost popover. Words: ../../autoModel.ts.
 */
import type { AutoModelChoice, AutoModelCount, AutoModelPolicy, ModelOption } from "@reviewgate/engine";
import { useStore } from "../../store";
import { t } from "../../i18n";
import {
  autoModelChipHelp,
  autoModelCountsLine,
  autoModelPolicyDetail,
  autoModelPolicyName,
  autoModelSummaryLine,
  autoModelSwitchLine,
  nextMessageLabel,
  oneMessageOptions,
} from "../../autoModel";
import "./autoModel.css";

const POLICIES: AutoModelPolicy[] = ["cost", "balanced", "quality"];

/** The settings' mode / policy (absent: manual, balanced — auto is off unless chosen). */
export function useModelMode(): { auto: boolean; policy: AutoModelPolicy } {
  const settings = useStore((s) => s.settings);
  const policy = settings?.modelAutoPolicy;
  return { auto: settings?.modelMode === "auto", policy: policy === "cost" || policy === "quality" ? policy : "balanced" };
}

/** The top of the model picker: "자동" and, when on, its policy. Every window's engine gets the change (main's set_settings). */
export function AutoModelPickerSection() {
  const { auto, policy } = useModelMode();
  const saveSettings = useStore((s) => s.saveSettings);
  const last = useStore((s) => s.state.session.autoModel ?? null);
  const hasProject = useStore((s) => s.state.project !== null);
  return (
    <div className="auto-model" data-testid="Auto model section">
      <button
        type="button"
        role="option"
        aria-selected={auto}
        className={`model-opt ${auto ? "on" : ""}`}
        onClick={() => void saveSettings({ modelMode: auto ? "manual" : "auto" })}
        data-testid="Model auto"
      >
        <span className="check" aria-hidden="true">{auto ? "✓" : ""}</span>
        <span className="col" style={{ gap: 1, minWidth: 0, alignItems: "flex-start" }}>
          <span className="model-name">{t("Auto")}</span>
          <span className="model-desc">{t("Picks opus, sonnet or haiku for each message before it goes out")}</span>
        </span>
      </button>
      {auto && (
        <div className="auto-model-policy">
          <div className="effort-seg" role="radiogroup" aria-label={t("Auto")} data-testid="Auto model policy">
            {POLICIES.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={policy === p} className={policy === p ? "active" : ""} onClick={() => (policy === p ? undefined : void saveSettings({ modelMode: "auto", modelAutoPolicy: p }))} data-testid={`Auto model policy ${p}`}>
                {autoModelPolicyName(p)}
              </button>
            ))}
          </div>
          <div className="tiny muted">{autoModelPolicyDetail(policy)}</div>
          {hasProject && <div className="tiny muted">{autoModelChipHelp(last, policy)}</div>}
          <div className="tiny muted">{t("Every switch shows as a faint line in the chat. A running turn keeps its model.")}</div>
        </div>
      )}
    </div>
  );
}

/** The composer's one-message model: "이번엔 opus" (only the next message; cleared once it is sent or queued). */
export function NextMessageModelMenu({ value, onChange, models, disabled }: { value: string | null; onChange: (v: string | null) => void; models: ModelOption[]; disabled: boolean }) {
  const options = oneMessageOptions(models);
  return (
    <select
      className={`next-model ${value ? "on" : ""}`}
      value={value ?? ""}
      disabled={disabled || options.length === 0}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      title={t("Only the next message goes out on the model you pick here")}
      aria-label={t("Model for this message")}
      data-testid="Next message model"
    >
      <option value="">{t("As usual (auto or your model)")}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {nextMessageLabel(o.value)}
        </option>
      ))}
    </select>
  );
}

/** The chat's faint line under a message whose model changed. */
export function AutoModelSwitchLine({ choice }: { choice: AutoModelChoice | undefined }) {
  const line = autoModelSwitchLine(choice);
  if (!line) return null;
  return (
    <div className="auto-model-switch tiny faint" data-testid="Model switch line">
      <span aria-hidden="true">⇄ </span>
      {line}
    </div>
  );
}

/** The turn summary's "모델: opus (자동 · 설계 판단)". */
export function TurnAutoModelLine({ choice }: { choice: AutoModelChoice | undefined }) {
  if (!choice) return null;
  return (
    <div className="ts-auto-model tiny muted" data-testid="Turn summary model">
      {autoModelSummaryLine(choice)}
    </div>
  );
}

/** The cost popover's "자동이 고른 모델" (nothing without auto picks). */
export function AutoModelCountsLine({ counts }: { counts: AutoModelCount[] | undefined }) {
  const line = autoModelCountsLine(counts);
  if (!line) return null;
  return (
    <div className="hcp-row" data-testid="HUD cost auto picks">
      <div className="small bold">{t("Auto picks in this session")}</div>
      <div className="tiny muted num">{line}</div>
    </div>
  );
}
