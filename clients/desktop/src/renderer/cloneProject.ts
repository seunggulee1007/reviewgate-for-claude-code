/**
 * docs/PROTOCOL.md §74 on Windows (the Mac's Core `CloneProject.swift`): the no-project window's fourth card, Clone from Git.
 * The link rule, the folder, the "already cloned" match, the clone and its reasons are the engine's
 * (`project_clone_preview`, `project_clone`, `project_clone_cancel`); this is the renderer's side: the requests, the
 * refusals in the user's words, the running clone's progress (its own small store) and the task's clone link.
 */
import { create } from "zustand";
import type { EngineEvent, ProjectClonePreviewEvent, ProjectCloneProgressEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";
import { parentArg } from "./newProject";

type Bridge = Parameters<typeof engineRequest>[1];

export type ClonePhase = ProjectCloneProgressEvent["phase"];

/** The running clone's latest step (null: none running) — the clone dialog's bar. */
export const useCloneProgress = create<{ progress: ProjectCloneProgressEvent | null }>(() => ({ progress: null }));

/** The main store's event hook: every `project_clone_progress` goes to the clone's store. */
export function applyCloneEvent(ev: EngineEvent): boolean {
  if (ev.type !== "project_clone_progress") return false;
  useCloneProgress.setState({ progress: ev });
  return true;
}

/**
 * `project_clone_preview`: what `url` clones and where, the recent projects (`paths`) that already have it — or why there is
 * none (not a link, credentials in it, an engine before §74) in the user's words.
 */
export async function previewClone(url: string, name: string | null, parent: string | undefined, paths: string[], bridge?: Bridge): Promise<ProjectClonePreviewEvent | { unavailable: string }> {
  try {
    const r = (await engineRequest({ type: "project_clone_preview", url, ...(name ? { name } : {}), ...parentArg(parent), paths }, bridge)) as ProjectClonePreviewEvent;
    if (typeof r?.path !== "string" || typeof r.url !== "string") return { unavailable: tooOldToClone() };
    return { ...r, matches: Array.isArray(r.matches) ? r.matches.filter((p) => typeof p === "string") : [] };
  } catch (e) {
    const r = refusalOf(e);
    return { unavailable: r.code === "unknown_command" || /^unknown command\b/.test(r.error) ? tooOldToClone() : cloneRefusal(e) };
  }
}

const tooOldToClone = (): string => t("This engine cannot clone yet — update ReviewGate");

/** §74.3 refusals in the user's words; anything else as the shared table words it. */
export function cloneRefusal(e: unknown): string {
  const r = refusalOf(e);
  switch (r.code) {
    case "clone_auth_failed":
      return t("git could not sign in to this repository. For GitHub, run gh auth login in a terminal (it sets up git's sign-in too), or set up an SSH key.");
    case "clone_not_found":
      return t("Repository not found — check the link, and that your account can see it");
    case "clone_branch_not_found":
      return t("That branch is not in the repository — leave Branch empty for its default branch");
    case "clone_network":
      return t("Could not reach the server — check the network or VPN, then try again");
    case "clone_timeout":
      return t("git stopped answering for 2 minutes — check the network, then try again");
    case "clone_folder_exists":
      return t("That folder already exists — choose another folder name");
    case "git_missing":
      return window.rg?.platform === "win32" ? t("git was not found — install Git for Windows, then try again") : t("git was not found — install it (xcode-select --install in Terminal), then try again");
    case "clone_failed":
      return r.detail ? t("git clone failed: {0}", r.detail) : t("git clone failed");
    case "bad_url":
      return t("This is not a repository link — paste an https or SSH URL, or owner/repo");
    case "url_has_credentials":
      return t("Take the password or token out of the link — git signs in with your saved sign-in");
    case "bad_branch":
      return t("That is not a branch name");
    case "clone_busy":
      return t("Another clone is running — wait for it or cancel it");
    case "clone_cancelled":
      return t("Clone cancelled");
    case "bad_parent":
      return t("The folder for new projects must be a full path — change it in Settings › General");
    case "parent_not_writable":
      return r.detail ? t("Could not make the project folder: {0}", r.detail) : t("Could not make the project folder");
    default:
      return refusalMessage(r);
  }
}

/** The step under the progress bar. */
export function clonePhaseLabel(phase: ClonePhase): string {
  switch (phase) {
    case "connecting":
      return t("Connecting…");
    case "counting":
      return t("Counting objects…");
    case "compressing":
      return t("Compressing objects…");
    case "receiving":
      return t("Receiving objects…");
    case "resolving":
      return t("Resolving deltas…");
    case "checkout":
      return t("Checking out files…");
  }
}

/**
 * §74.4 "Start from a task": the link to clone for a task whose repository (`owner/repo`) no recent project has — on the
 * link's host when the task is a link, else GitHub's shorthand.
 */
export function cloneURLForTask(ref: string, repo: string): string {
  const link = ref.split(/\s+/).find((w) => /^https?:\/\//.test(w));
  if (link) {
    try {
      const host = new URL(link).host;
      if (host) return `https://${host}/${repo}.git`;
    } catch {
      /* not a link after all */
    }
  }
  return repo;
}
