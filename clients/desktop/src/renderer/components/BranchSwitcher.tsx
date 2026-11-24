/**
 * Branch menu of the sidebar project header: switch / new branch / refresh / create PR, with the switch blocker as footer.
 * MARK: a-gitflow — §61: New Branch follows `createBlocker` (uncommitted work comes along), Create PR `prCreateBlocker`
 * (not a dirty tree), and a switch the working tree blocks offers Commit….
 * MARK: git-sync — §68: Fetch, Pull (fast-forward only), Rebase onto the upstream when diverged and the last fetch, each
 * with its reason; the chip carries ↑ahead ↓behind and a spinner while a fetch / pull runs.
 */
import type { BranchInfo, BranchSwitchBlocker, RemoteSyncState, ReviewState } from "@reviewgate/engine";
import { commitBeforeSwitchBlocker, prCreateBlocker } from "../branchFlow";
import { refusalCodeText } from "../errorCodes";
import { otherChangesTotal } from "../commitOthers";
import { currentBranch, fetchDisabledReason, isDiverged, lastFetchedText, pullDisabledReason, rebaseDisabledReason, syncBadge, syncBadgeHelp, syncOf } from "../gitSync";
import { t } from "../i18n";
import { useStore } from "../store";
import { Menu, type MenuItem } from "./Menu";

export function BranchSwitcher() {
  const state = useStore((s) => s.state);
  const switchBranch = useStore((s) => s.switchBranch);
  const refreshBranches = useStore((s) => s.refreshBranches);
  const openDialog = useStore((s) => s.openDialog);
  const gitFetch = useStore((s) => s.gitFetch);
  const gitPull = useStore((s) => s.gitPull);
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
  );
  const sync = syncOf(state);
  if (sync) items.push({ kind: "sep" }, ...syncItems(state, sync, gitFetch, gitPull)); // MARK: git-sync (§68)
  items.push(
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
  // MARK: git-sync — §68.5: changes outside the review (and no review to commit from) can be committed from here too.
  if (blocker?.kind !== "dirtyWorktree" && otherChangesTotal(state) > 0) {
    const commitBlocked = commitBeforeSwitchBlocker(state);
    items.push({
      kind: "item",
      label: t("Commit…"),
      disabled: commitBlocked !== null,
      title: commitBlocked ?? t("Commit changed files — the review's and your own"),
      onClick: () => openDialog({ kind: "commit" }),
      testId: "Commit from branch menu",
    });
  }
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
  const current = currentBranch(state);
  const badge = syncBadge(current);
  const help = [blocker ? blockerReason(blocker) : t("Switch branch"), syncBadgeHelp(current), lastFetchedText(sync?.lastFetchAt ?? null)].filter((l): l is string => !!l);
  return (
    <Menu
      label={
        <span className="row" style={{ gap: 4 }}>
          <span className="mono caption truncate">⑂ {info.branch ?? t("detached")}</span>
          {badge && <span className="tiny muted mono" aria-label={syncBadgeHelp(current) ?? badge} data-testid="Branch ahead behind">{badge}</span>}
          {sync && (sync.fetching || sync.pulling) && (
            <span className="spinner" aria-label={sync.pulling ? t("Pulling…") : t("Fetching…")} data-testid="Branch sync progress" />
          )}
        </span>
      }
      items={items}
      title={help.join("\n")}
      testId="Branch switcher"
    />
  );
}

/** §68: Fetch, Fetch All Remotes (with more than one), Pull, Rebase onto <upstream> (diverged), and the last fetch. */
export function syncItems(state: Pick<ReviewState, "branches" | "project" | "changedFiles">, sync: RemoteSyncState, gitFetch: (all?: boolean) => Promise<void>, gitPull: (rebase?: boolean) => Promise<void>): MenuItem[] {
  const current = currentBranch(state);
  const upstream = sync.upstream ?? current?.upstream ?? null;
  const fetchOff = fetchDisabledReason(sync);
  const pullOff = pullDisabledReason(sync);
  const diverged = isDiverged(current);
  const behind = current?.behind ?? 0;
  const items: MenuItem[] = [
    {
      kind: "item",
      label: sync.fetching ? t("Fetching…") : t("Fetch"),
      disabled: fetchOff !== null,
      title: fetchOff ?? t("git fetch --prune: updates the remote branches and the ↑↓ counts; your files are not touched"),
      onClick: () => void gitFetch(),
      testId: "Fetch",
    },
  ];
  if (sync.remotes.length > 1) {
    items.push({ kind: "item", label: t("Fetch All Remotes"), disabled: fetchOff !== null, title: fetchOff ?? "git fetch --all --prune", onClick: () => void gitFetch(true), testId: "Fetch all remotes" });
  }
  items.push({
    kind: "item",
    label: sync.pulling ? t("Pulling…") : behind > 0 ? t("Pull {0} commit(s)", behind) : t("Pull"),
    disabled: pullOff !== null || diverged,
    title: pullOff ?? (diverged ? refusalCodeText("pull_diverged", `${current?.ahead ?? 0},${behind}`) ?? ""
      : t("Fetches, then fast-forwards this branch to {0} — never a merge, and uncommitted changes are never overwritten", upstream ?? "upstream")),
    onClick: () => void gitPull(),
    testId: "Pull",
  });
  if (diverged && upstream) {
    const rebaseOff = rebaseDisabledReason(state);
    items.push({
      kind: "item",
      label: t("Rebase onto {0}", upstream),
      disabled: rebaseOff !== null,
      title: rebaseOff ?? t("Replays this branch's {0} commit(s) on top of {1}; a conflict undoes the rebase and nothing changes", current?.ahead ?? 0, upstream),
      onClick: () => void gitPull(true),
      testId: "Rebase onto upstream",
    });
  }
  const last = sync.lastFetchError ? (refusalCodeText("fetch_failed", sync.lastFetchError.replace(/^fetch_failed:/, "")) ?? sync.lastFetchError) : lastFetchedText(sync.lastFetchAt);
  if (last) items.push({ kind: "footer", label: last });
  return items;
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
