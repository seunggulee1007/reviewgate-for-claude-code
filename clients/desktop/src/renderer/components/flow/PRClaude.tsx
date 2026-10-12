/**
 * MARK: wave3 desktop-flow
 * docs/PROTOCOL.md §36.14 in Electron (as on the Mac): PR comments to Claude ("Send to Claude" on a comment puts its thread
 * into Claude's message box, "Send all unresolved" every thread whose last word is not the user's) — in the window of the PR
 * head branch's workbench when one is open, else this window, starting with the repository's PR command (e.g.
 * /acme-tools:review-reply {pr}) when one is set; nothing goes out without the user's send. Also "Open as workbench"
 * for the PR's head and a PR diff line's "Ask in a side thread" (the read-only side session gets the hunk as data).
 */
import { useCallback } from "react";
import type { DiffLine, FileDiff, PRComment, PRDetail, ReviewState } from "@reviewgate/engine";
import { t } from "../../i18n";
import { updateReason } from "../../flowLogic";
import { refusalMessage } from "../../errorCodes";
import { isProjectRepo, prLineAnchor, prThreads, threadOf, unresolvedThreads } from "../../prClaude";
import { supportsWorkbenchSetup } from "../../storeFlow";
import { useStore } from "../../store";
import "./flow.css";

/** Where the draft lands, for the buttons' tooltips: the PR head's workbench window, or this window. */
function destination(state: ReviewState, headRef: string): string {
  const wb = state.workbenches.list.find((w) => w.branch === headRef && !w.isCurrent);
  return wb ? t("the {0} workbench window", headRef) : t("this window");
}

/** Why "Send to Claude" cannot work from this window; null = it can. */
function sendBlocker(state: ReviewState): string | null {
  return state.project ? null : t("Open the project in this window first (⌘O) — the comments go to its Claude");
}

/** The PR head's Claude actions: "Open as workbench" (or the workbench that has the head already) and "Send all unresolved". */
export function PRClaudeHeaderButtons({ pr }: { pr: PRDetail }) {
  const state = useStore((s) => s.state);
  const flow = useStore((s) => s.flow);
  const openDialog = useStore((s) => s.openDialog);
  const sendPrThreads = useStore((s) => s.sendPrThreads);
  const host = state.pr.selectedSummary?.host ?? state.pr.host;
  const me = state.pr.accounts.find((a) => a.host === host)?.login ?? null;
  const unresolved = unresolvedThreads(prThreads(state.pr.comments), me);
  const existing = state.workbenches.list.find((w) => w.branch === pr.headRefName) ?? null;
  const repo = state.pr.selectedSummary?.repo ?? null;
  const workbenchBlocker = !state.project
    ? refusalMessage({ code: "no_project", error: "no_project", detail: "" })
    : !isProjectRepo(repo, state.project.remoteURL)
      ? t("This PR is not of the open project's repository ({0})", repo ?? "?")
      : !supportsWorkbenchSetup(state, flow)
        ? updateReason()
        : null;
  const sendBlocked = unresolved.length === 0 ? t("No unresolved comments — every thread's last word is yours") : sendBlocker(state);
  return (
    <span className="pr-claude" data-testid="PR Claude buttons">
      {existing ? (
        <button
          type="button"
          className="small"
          disabled={existing.isCurrent}
          onClick={() => void window.rg.openWorkbenchWindow(existing.path)}
          title={existing.isCurrent ? t("This window is the PR head's workbench") : existing.path}
          data-testid="Open PR workbench"
        >
          {t("Open workbench")}
        </button>
      ) : (
        <button
          type="button"
          className="small"
          disabled={workbenchBlocker !== null}
          onClick={() => openDialog({ kind: "newWorkbenchFromPr", pr: { number: pr.number, headRef: pr.headRefName, baseRef: pr.baseRefName, title: pr.title } })}
          title={workbenchBlocker ?? t("Checks out the PR's head in a workbench of its own (with the repository's Workbench setup)")}
          data-testid="Open PR as workbench"
        >
          {t("Open as workbench")}
        </button>
      )}
      <button
        type="button"
        className="small"
        disabled={sendBlocked !== null}
        onClick={() => void sendPrThreads(unresolved)}
        title={sendBlocked ?? t("Puts the threads you have not answered yet into Claude's message box in {0} — you read it and send it", destination(state, pr.headRefName))}
        data-testid="Send all unresolved"
      >
        {t("Send all unresolved")}
        {unresolved.length > 0 && <span className="count num">{unresolved.length}</span>}
      </button>
    </span>
  );
}

/** "Send to Claude" on one comment: its whole thread goes into the composer. */
export function SendCommentButton({ comment }: { comment: PRComment }) {
  const state = useStore((s) => s.state);
  const sendPrThreads = useStore((s) => s.sendPrThreads);
  const pr = state.pr.selected;
  if (!pr) return null;
  const blocker = sendBlocker(state);
  return (
    <button
      type="button"
      className="plain small send-claude"
      disabled={blocker !== null}
      onClick={() => {
        const thread = threadOf(comment, state.pr.comments);
        if (thread) void sendPrThreads([thread]);
      }}
      title={blocker ?? t("Puts this thread into Claude's message box in {0} — you read it and send it", destination(state, pr.headRefName))}
      data-testid="Send comment to Claude"
    >
      {t("Send to Claude")}
    </button>
  );
}

/** A PR diff line's side question (the hunk goes along as data); null without a PR or a project in this window. */
export function usePrLineAsk(path: string | null, diff: FileDiff | null): ((line: DiffLine) => void) | null {
  const askAbout = useStore((s) => s.askAbout);
  const pr = useStore((s) => s.state.pr.selected);
  const hasProject = useStore((s) => s.state.project !== null);
  const ask = useCallback(
    (line: DiffLine) => {
      if (!pr || !path || !diff) return;
      const anchor = prLineAnchor(pr.number, path, line, diff, pr.headRefOid || null);
      if (anchor) askAbout({ pr: anchor }, { context: anchor.hunk });
    },
    [askAbout, pr, path, diff],
  );
  return pr && path && diff && hasProject ? ask : null;
}

/** The tooltip of the PR line's "Ask in a side thread". */
export const prAskTitle = (): string => t("Ask about this line in a side question — the hunk goes along as data; nothing changes");
