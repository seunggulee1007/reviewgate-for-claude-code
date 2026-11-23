/**
 * Branch menu of the sidebar project header: switch / new branch / refresh / create PR, with the switch blocker as footer.
 * MARK: a-gitflow — §61: New Branch follows `createBlocker` (uncommitted work comes along), Create PR `prCreateBlocker`
 * (not a dirty tree), and a switch the working tree blocks offers Commit….
 */
import type { BranchInfo, BranchSwitchBlocker } from "@reviewgate/engine";
import { commitBeforeSwitchBlocker, prCreateBlocker } from "../branchFlow";
import { t } from "../i18n";
import { useStore } from "../store";
import { Menu, type MenuItem } from "./Menu";

export function BranchSwitcher() {
  const state = useStore((s) => s.state);
  const switchBranch = useStore((s) => s.switchBranch);
  const refreshBranches = useStore((s) => s.refreshBranches);
  const openDialog = useStore((s) => s.openDialog);
  const info = state.project;
  if (!info) return null;
  const blocker = state.branches.switchBlocker;
  const createBlocker = state.branches.createBlocker ?? null;
  const prBlocker = prCreateBlocker(state);
  const items: MenuItem[] = state.branches.list.map((b) => ({
    kind: "item",
    label: b.isCurrent ? b.name : branchTitle(b),
    checked: b.isCurrent,
    disabled: b.isCurrent || blocker !== null,
    onClick: () => void switchBranch(b.name),
    testId: `Branch ${b.name}`,
  }));
  if (items.length === 0) items.push({ kind: "item", label: t("No branches"), disabled: true });
  items.push(
    { kind: "sep" },
    {
      kind: "item",
      label: t("New Branch…"),
      disabled: createBlocker !== null,
      title: createBlocker ? blockerReason(createBlocker) : t("Create a branch from HEAD and check it out — uncommitted changes come along"),
      onClick: () => openDialog({ kind: "newBranch" }),
      testId: "New Branch…",
    },
    { kind: "item", label: t("Refresh"), onClick: () => void refreshBranches() },
    { kind: "sep" },
    {
      kind: "item",
      label: t("Create PR from this branch…"),
      disabled: prBlocker !== null,
      title: prBlocker ?? t("Push this branch and open a pull request (gh pr create)"),
      onClick: () => openDialog({ kind: "createPR" }),
      testId: "Create PR from this branch…",
    },
  );
  if (blocker) items.push({ kind: "sep" }, { kind: "footer", label: blockerReason(blocker) });
  if (blocker?.kind === "dirtyWorktree") {
    // §61: the way forward where the block is shown.
    const commitBlocked = commitBeforeSwitchBlocker(state);
    items.push({
      kind: "item",
      label: t("Commit…"),
      disabled: commitBlocked !== null,
      title: commitBlocked ?? t("Commit the changes, then switch branches"),
      onClick: () => openDialog({ kind: "commit" }),
      testId: "Commit before switching branch",
    });
  }
  return (
    <Menu
      label={<span className="mono caption truncate">⑂ {info.branch ?? t("detached")}</span>}
      items={items}
      title={blocker ? blockerReason(blocker) : t("Switch branch")}
      testId="Branch switcher"
    />
  );
}

function branchTitle(b: BranchInfo): string {
  const parts = [b.name];
  if (b.ahead > 0) parts.push(`↑${b.ahead}`);
  if (b.behind > 0) parts.push(`↓${b.behind}`);
  return parts.join("  ");
}

export function blockerReason(b: BranchSwitchBlocker): string {
  switch (b.kind) {
    case "pendingReview":
      return t("Review {0} pending files first", b.count);
    case "dirtyWorktree":
      return t("Working tree has uncommitted changes");
    case "running":
      return t("Claude is working");
  }
}
