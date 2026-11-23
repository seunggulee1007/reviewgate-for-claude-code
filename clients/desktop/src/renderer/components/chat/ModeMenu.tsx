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

/**
 * §56.5: the composer's mode menu is the terminal's mode line (§44.1) — "⏵⏵ 자동 모드", "⏸ 계획 모드 — 승인하면 자동 모드로
 * 돌아가요" in its colour, first in the row under the box; a click picks a mode, Shift+Tab in the box cycles them (said in
 * its tooltip). No line of its own, and no pill in the HUD: one place says which mode runs.
 */
export function ModeMenu() {
  const m = useModeMenu();
  const state = useStore((s) => s.state);
  const autoUnavailable = useStore((s) => s.autoModeUnavailable);
  const approvesIntoAuto = m.mode === "plan" && planApproveMode(state, autoUnavailable) === "auto";
  const line = modeLine(m.mode, { approvesIntoAuto, autoUnavailable, scheduledLabel: m.scheduled && m.scheduled !== m.mode ? modeLabel(m.scheduled) : null });
  const title = m.open ? `${m.title}\n${t("Shift+Tab in the message box switches the permission mode")}` : t("The permission mode can be picked once the session has started");
  return <Menu className={`mode-menu mode-line ${line.tone}`} label={<span className="truncate">{line.label}</span>} align="left" disabled={!m.open} title={title} ariaLabel={`${t("Permission mode")}: ${line.label}`} testId="Permission mode" items={m.items} />;
}
