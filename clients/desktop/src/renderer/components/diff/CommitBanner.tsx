/**
 * Banner above the diff pane after `commit` (docs/M12-COMMIT.md): green "Committed <shortSha> on
 * <branch> · Pushed/Not pushed" with "Create PR…" and — when pushed to a GitHub remote — "Open"
 * (<web>/commit/<sha>); red with "Push now" (→ `push`) when the push failed. Dismissed per `at`.
 */
import { useState } from "react";
import { t } from "../../i18n";
import { commitOf, refusalText, useStore } from "../../store";

export function CommitBanner() {
  const commit = useStore((s) => commitOf(s.state));
  const remoteURL = useStore((s) => s.state.project?.remoteURL ?? null);
  const dismissedAt = useStore((s) => s.dismissedCommitAt);
  const dismiss = useStore((s) => s.dismissCommitBanner);
  const openDialog = useStore((s) => s.openDialog);
  const pushNow = useStore((s) => s.pushNow);
  const [pushing, setPushing] = useState(false);
  const last = commit.lastCommit;
  if (!last || dismissedAt === last.at) return null;

  const web = remoteURL ? githubWebURL(remoteURL) : null;
  const push = async () => {
    setPushing(true);
    await pushNow();
    setPushing(false);
  };

  if (last.pushError !== null && !last.pushed) {
    return (
      <div className="banner red" data-testid="Commit banner">
        <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
          <span className="caption bold">{t("Committed {0} on {1}", last.shortSha, last.branch ?? t("detached"))} · {t("Not pushed")}</span>
          <span className="tiny truncate" title={last.pushError}>{refusalText(last.pushError)}</span>
        </div>
        {pushing && <span className="spinner" />}
        <button type="button" className="small" disabled={pushing} onClick={() => void push()} data-testid="Push now">{t("Push now")}</button>
        <button type="button" className="plain small" onClick={dismiss} aria-label={t("Dismiss")} data-testid="Dismiss commit banner">✕</button>
      </div>
    );
  }

  return (
    <div className="banner green" data-testid="Commit banner">
      <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="caption bold">
          {t("Committed {0} on {1}", last.shortSha, last.branch ?? t("detached"))} · {last.pushed ? t("Pushed") : t("Not pushed")}
        </span>
        <span className="tiny muted truncate" title={last.message}>{last.message.split("\n")[0]}</span>
      </div>
      {!last.pushed && (
        <button type="button" className="small" disabled={pushing} onClick={() => void push()} data-testid="Push now">{t("Push now")}</button>
      )}
      <button type="button" className="small" onClick={() => openDialog({ kind: "createPR" })} data-testid="Create PR…">{t("Create PR…")}</button>
      {last.pushed && web && (
        <button type="button" className="small" onClick={() => void window.rg.openExternal(`${web}/commit/${last.sha}`)} data-testid="Open commit">{t("Open")}</button>
      )}
      <button type="button" className="plain small" onClick={dismiss} aria-label={t("Dismiss")} data-testid="Dismiss commit banner">✕</button>
    </div>
  );
}

/** `git@github.example.com:org/repo.git` / `https://github.example.com/org/repo(.git)` → web URL; null for non-GitHub remotes. */
export function githubWebURL(remote: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|(?:[^@]+@))([^/:]+)(?::\d+)?[/:]+(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  if (!/(^|\.)github\./.test(host) && host !== "github.com") return null;
  return `https://${host}/${m[2]}`;
}
