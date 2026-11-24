/**
 * MARK: git-sync — docs/PROTOCOL.md §68 on Windows, as the Mac's Core `GitSync.swift` (`GitSyncText`, `GitSyncRules`):
 * Fetch / Pull in the branch menu, the ahead / behind badge on the branch chip, why each is off, the refusals' words and the
 * line a Fetch / Pull leaves under the branch line. The English strings are the Mac's (their Korean comes from its catalogs).
 */
import type { BranchInfo, FetchedEvent, PullBlocker, PulledEvent, RemoteSyncState, ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";

/** What the last Fetch / Pull the user asked for came to. */
export type GitSyncNotice = { kind: "success" | "info" | "error"; text: string; paths: string[] };

type Syncy = Pick<ReviewState, "branches" | "project" | "changedFiles">;

/** `state.branches.sync`; null from an older engine or in a folder without git (Fetch / Pull hidden). */
export function syncOf(st: Syncy): RemoteSyncState | null {
  if (!st.project || st.project.vcs === "shadow") return null;
  return st.branches.sync ?? null;
}

export function currentBranch(st: Pick<ReviewState, "branches">): BranchInfo | null {
  return st.branches.list.find((b) => b.isCurrent) ?? null;
}

/** git's names of an unfinished operation, kept in English. */
function operationName(raw: string): string {
  return raw === "rebase" || raw === "cherry-pick" || raw === "revert" ? raw : "merge";
}

function blockedText(kind: string): string {
  switch (kind) {
    case "running":
      return t("Claude is working — pull when the turn ends");
    case "busy":
      return t("A fetch or pull is already running");
    case "detached":
      return t("Check out a branch first (HEAD is detached)");
    default:
      return t("Pull is not possible right now");
  }
}

const NO_UPSTREAM = "This branch has no upstream — push it first (git push -u) to pull into it";
const DIVERGED = "This branch and its upstream have diverged — a fast-forward is not possible. Rebase onto the upstream, or merge in a terminal.";
const REVIEW_BEFORE_REBASE = "Finish the review before rebasing — a rebase rewrites the files under review";

/** The §68 refusal codes (`refusalCodeText` asks here first); null for any other code. */
export function gitSyncRefusalText(code: string, detail: string): string | null {
  const d = detail.trim();
  switch (code) {
    case "pull_blocked":
      return blockedText(d);
    case "pull_no_upstream":
      return d ? t("{0} has no upstream — push it first (git push -u) to pull into it", d) : t(NO_UPSTREAM);
    case "pull_in_progress":
      return t("A {0} is in progress — finish or abort it in a terminal, then pull", operationName(d));
    case "pull_diverged": {
      const counts = d.split(",").map((n) => parseInt(n.trim(), 10));
      if (counts.length === 2 && counts.every((n) => Number.isFinite(n))) {
        return t("This branch and its upstream have diverged ({0} local, {1} incoming commits) — a fast-forward is not possible. Rebase onto the upstream, or merge in a terminal.", counts[0], counts[1]);
      }
      return t(DIVERGED);
    }
    case "pull_would_overwrite":
      return t("Pull would overwrite your uncommitted changes: {0} — commit them (or finish their review) first. Nothing was changed.", d);
    case "pull_rebase_blocked":
      return d === "review" ? t(REVIEW_BEFORE_REBASE) : t("Commit your changes before rebasing");
    case "pull_rebase_failed":
      return t("The rebase stopped and was undone — nothing changed: {0}", d);
    case "pull_failed":
      return t("Pull failed: {0}", d);
    case "fetch_failed":
      return d ? t("Fetch failed: {0}", d) : t("Fetch failed");
    default:
      return null;
  }
}

export function pullBlockerText(b: PullBlocker): string {
  switch (b.kind) {
    case "noUpstream":
      return t(NO_UPSTREAM);
    case "operation":
      return t("A {0} is in progress — finish or abort it in a terminal, then pull", operationName(b.operation));
    default:
      return blockedText(b.kind);
  }
}

/** Why Pull is off (null: it can run, or the item is hidden). */
export function pullDisabledReason(sync: RemoteSyncState | null): string | null {
  if (!sync) return null;
  if (sync.fetching || sync.pulling) return blockedText("busy");
  return sync.pullBlocker ? pullBlockerText(sync.pullBlocker) : null;
}

export function fetchDisabledReason(sync: RemoteSyncState | null): string | null {
  if (!sync) return null;
  if (sync.fetching || sync.pulling) return blockedText("busy");
  if (sync.fetchBlocker?.kind === "noRemote") return t("The repository has no remote");
  if (sync.fetchBlocker?.kind === "busy") return blockedText("busy");
  return null;
}

/** Commits on both sides: Pull refuses, "Rebase onto <upstream>" is offered. */
export function isDiverged(b: BranchInfo | null): boolean {
  return b !== null && b.upstream !== null && b.ahead > 0 && b.behind > 0;
}

/** §68.3: Pull's own reasons, then files under review, then tracked changes. */
export function rebaseDisabledReason(st: Syncy): string | null {
  const reason = pullDisabledReason(syncOf(st));
  if (reason) return reason;
  if (st.changedFiles.length > 0) return t(REVIEW_BEFORE_REBASE);
  if (st.branches.switchBlocker?.kind === "dirtyWorktree") return t("Commit your changes before rebasing");
  return null;
}

/** The chip's badge: "↑2 ↓3" ("" when level or without an upstream). */
export function syncBadge(b: BranchInfo | null): string {
  if (!b || b.upstream === null) return "";
  const parts: string[] = [];
  if (b.ahead > 0) parts.push(`↑${b.ahead}`);
  if (b.behind > 0) parts.push(`↓${b.behind}`);
  return parts.join(" ");
}

/** "2 commit(s) to push · 3 commit(s) to pull — origin/main". */
export function syncBadgeHelp(b: BranchInfo | null): string | null {
  if (!b || b.upstream === null || (b.ahead === 0 && b.behind === 0)) return null;
  const parts: string[] = [];
  if (b.ahead > 0) parts.push(t("{0} commit(s) to push", b.ahead));
  if (b.behind > 0) parts.push(t("{0} commit(s) to pull", b.behind));
  return `${parts.join(" · ")} — ${b.upstream}`;
}

export function pulledText(r: Pick<PulledEvent, "mode" | "upstream" | "commits" | "fileCount">): string {
  switch (r.mode) {
    case "up_to_date":
      return t("Already up to date with {0}", r.upstream);
    case "rebase":
      return t("Rebased onto {0}: {1} incoming commit(s) · {2} file(s) changed", r.upstream, r.commits, r.fileCount);
    default:
      return t("Pulled {0} commit(s) from {1} · {2} file(s) changed", r.commits, r.upstream, r.fileCount);
  }
}

export function fetchedText(r: Pick<FetchedEvent, "remotes" | "behind">): string {
  const remotes = r.remotes.join(", ");
  if (r.behind !== null && r.behind > 0) return t("Fetched {0} — {1} incoming commit(s) to pull", remotes, r.behind);
  if (r.behind === null) return t("Fetched {0}", remotes);
  return t("Fetched {0} — up to date", remotes);
}

/** "Fetched 3 min ago" — the branch menu's quiet footer; null before the first fetch. */
export function lastFetchedText(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t("Fetched just now");
  if (minutes < 60) return t("Fetched {0} min ago", minutes);
  return t("Fetched {0} h ago", Math.floor(minutes / 60));
}
