/**
 * MARK: wave5 w5-fixes — docs/PROTOCOL.md §43.5: the basis of "plan vs actual" chosen from the newest turn summary (the
 * Mac's `PlanBasisMenuButton` / `PlanBasisLine`). Automatic, then the plan files (the one followed checked) and a note;
 * while a plan approved in ReviewGate decides, the items are off and the reason is the last line.
 */
import { useMemo } from "react";
import type { PlanSourceState } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { planBasisMenu, type PlanBasisMenuModel } from "../../planBasis";
import { Menu, type MenuItem } from "../Menu";
import "./planBasis.css";

/**
 * The live chat's basis menu (null on an older engine / without a chat, or when `enabled` is false). Selected as text so a
 * state snapshot with the same plan source does not redraw the card (§42.6).
 */
export function usePlanBasis(enabled: boolean): PlanBasisMenuModel | null {
  const key = useStore((s) => (enabled && s.state.session.planSource ? JSON.stringify(s.state.session.planSource) : ""));
  return useMemo(() => (key ? planBasisMenu(JSON.parse(key) as PlanSourceState) : null), [key]);
}

export function PlanBasisMenu({ menu }: { menu: PlanBasisMenuModel }) {
  const followPlan = useStore((s) => s.followPlan);
  const items: MenuItem[] = [
    { kind: "head", label: t("Plan vs actual basis") },
    ...menu.items.map(
      (item): MenuItem => ({
        kind: "item",
        label: item.title,
        title: menu.blocker ?? item.help,
        checked: item.checked,
        disabled: menu.blocker !== null,
        testId: item.path === null ? "Plan basis automatic" : `Plan basis ${item.path}`,
        onClick: () => {
          if (item.path !== menu.chosenPath) void followPlan(item.path);
        },
      }),
    ),
    { kind: "footer", label: menu.blocker ?? menu.note },
  ];
  return (
    <Menu
      label={<span className="truncate">{menu.label}</span>}
      items={items}
      title={menu.blocker ?? t("Choose which plan this chat's turn summaries compare against")}
      align="right"
      className="ts-basis"
      testId="Plan basis menu"
    />
  );
}

/** The newest summary had no plan to compare against: the section's title and the menu, to choose a plan file. */
export function PlanBasisLine({ menu }: { menu: PlanBasisMenuModel }) {
  return (
    <div className="ts-section ts-basis-line" data-testid="Plan basis line">
      <span className="ts-label">{t("Plan vs actual")}</span>
      <span className="tiny muted truncate grow">{t("This turn had no plan to compare against")}</span>
      <PlanBasisMenu menu={menu} />
    </div>
  );
}
