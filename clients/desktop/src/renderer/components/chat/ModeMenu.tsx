/**
 * M20 permission-mode dropdown in the composer footer (docs/M20-MODES.md): the four modes the engine
 * exposes, the current one checked, each with its one-line help.
 * MARK: wave4b w4b-auto — §39.5: while a turn is in flight a pick applies from Claude's next step; one into or out of plan
 * mode (or while the turn is collected) waits for the turn to end ("기본 → 계획"); the HUD chip is the same menu.
 */
import { t } from "../../i18n";
import { permissionMode, useStore } from "../../store";
import { Menu, type MenuItem } from "../Menu";
import type { PermissionMode } from "@reviewgate/engine";
import { autoModeHelp, busyModeHelp, scheduledModeText } from "../../autoMode";
import { modeBusy, modeSwitchesNow } from "../../storeAutoMode";
import { modeLine, planApproveMode } from "../../terminalMode"; // MARK: wave6 w6-terminal (§44.1)

export const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return t("Accept edits");
    case "plan":
      return t("Plan");
    case "auto":
      return t("Auto");
    default:
      return t("Default");
  }
}

export function modeHelp(mode: PermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return t("Edits are applied without asking; commands still ask. Every change still goes through the review.");
    case "plan":
      return t("Read-only: Claude researches and proposes a plan you approve before anything is written.");
    case "auto":
      return autoModeHelp(); // MARK: wave4b w4b-auto — commands on Claude Code's own judgment, file changes still reviewed
    default:
      return t("Claude asks before every edit and every command.");
  }
}

/** The mode menu's state: the live mode, the one waiting for the turn's end, whether a pick waits, the label and tooltip. */
function useModeMenu() {
  const state = useStore((s) => s.state);
  const scheduled = useStore((s) => s.scheduledPermissionMode);
  const pick = useStore((s) => s.pickPermissionMode);
  const mode = permissionMode(state);
  const busy = modeBusy(state);
  const label = scheduled ? `${modeLabel(mode)} → ${modeLabel(scheduled)}` : modeLabel(mode);
  const title = scheduled ? scheduledModeText(modeLabel(scheduled)) : `${t("Permission mode")}: ${modeLabel(mode)} — ${modeHelp(mode)}`;
  const items: MenuItem[] = [
    { kind: "head", label: t("Permission mode") },
    ...MODES.map((m) => ({
      kind: "item" as const,
      checked: m === (scheduled ?? mode),
      title: modeHelp(m),
      testId: `Mode ${m}`,
      label: (
        <span className="mode-entry">
          {modeLabel(m)}
          <span className="mode-help">{modeHelp(m)}</span>
        </span>
      ),
      onClick: () => pick(m),
    })),
    ...(busy ? [{ kind: "footer" as const, label: busyModeHelp(modeSwitchesNow(state, "auto", mode)) }] : []),
  ];
  return { mode, scheduled, label, title, items, open: state.session.open };
}

export function ModeMenu() {
  const m = useModeMenu();
  return <Menu className="mode-menu" label={<span className="truncate">◈ {m.label}</span>} align="right" disabled={!m.open} title={m.title} testId="Permission mode" items={m.items} />;
}

/**
 * MARK: wave6 w6-terminal — §44.1: the terminal's mode line under the composer ("⏵⏵ 자동 모드 (shift+tab 전환)", "⏸ 계획 모드 —
 * 승인하면 자동 모드로 돌아가요"); it follows the engine at once, plan mode Claude entered by itself included.
 */
export function ComposerModeLine() {
  const state = useStore((s) => s.state);
  const scheduled = useStore((s) => s.scheduledPermissionMode);
  const autoUnavailable = useStore((s) => s.autoModeUnavailable);
  if (!state.session.open) return null;
  const mode = permissionMode(state);
  const approvesIntoAuto = mode === "plan" && planApproveMode(state, autoUnavailable) === "auto";
  const line = modeLine(mode, { approvesIntoAuto, autoUnavailable, scheduledLabel: scheduled && scheduled !== mode ? modeLabel(scheduled) : null });
  return (
    <div className={`mode-line ${line.tone}`} title={t("Shift+Tab in the message box switches the permission mode")} data-testid="Composer mode line">
      {line.text}
    </div>
  );
}

/** The HUD's mode pill (shown while the mode is not `default` or a pick waits): the same menu. */
export function HudModeChip() {
  const m = useModeMenu();
  if (m.mode === "default" && !m.scheduled) return null;
  const tone = (m.scheduled ?? m.mode) === "plan" ? "mode" : "orange";
  return <Menu className={`hud-mode-chip pill ${tone}`} label={<span className="truncate">◈ {m.label}</span>} align="right" disabled={!m.open} title={m.title} testId="HUD mode" items={m.items} />;
}
