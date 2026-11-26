/**
 * docs/PROTOCOL.md §69 on Windows (the Mac's Core `NewProject.swift`): the window with no project offers 1 New (a folder made
 * from the first prompt — `project_name` / `project_create`), 2 Start from a task (the base project picked first —
 * `project_match` — then §63's task dialog in it) and 3 Open a folder. The name rule, the `-2` suffix and the remote match are
 * the engine's; this is the renderer's side: the requests, the refusals in the user's words, the keys and the task the
 * project's start screen picks up.
 */
import type { ProjectMatchesEvent, ProjectNameEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";

type Bridge = Parameters<typeof engineRequest>[1];

/** The parent folder setting as the engine takes it: absent when empty (the engine's default, `<home>/ReviewGate`). */
export function parentArg(parent: string | undefined): { parent?: string } {
  const p = (parent ?? "").trim();
  return p ? { parent: p } : {};
}

/** `project_name`: the folder New would make for `text`; null when the engine cannot say (the dialog keeps its last one). */
export async function previewProjectName(text: string, parent: string | undefined, bridge?: Bridge): Promise<ProjectNameEvent | null> {
  try {
    const reply = (await engineRequest({ type: "project_name", text, ...parentArg(parent) }, bridge)) as ProjectNameEvent;
    return typeof reply?.path === "string" && typeof reply.name === "string" ? reply : null;
  } catch {
    return null;
  }
}

/** `project_match`: which recent projects have the task's repository as a remote (none when the engine cannot say). */
export async function matchProjects(ref: string, paths: string[], bridge?: Bridge): Promise<Pick<ProjectMatchesEvent, "repo" | "matches" | "guess">> {
  try {
    const r = (await engineRequest({ type: "project_match", ref, paths }, bridge)) as ProjectMatchesEvent;
    return { repo: typeof r?.repo === "string" ? r.repo : null, matches: Array.isArray(r?.matches) ? r.matches.filter((p) => typeof p === "string") : [], guess: typeof r?.guess === "string" ? r.guess : null };
  } catch {
    return { repo: null, matches: [], guess: null };
  }
}

/** The row to preselect among `candidates` (most recent first): the engine's guess, else the most recent. */
export function preselectProject(guess: string | null, candidates: readonly string[]): string | null {
  return guess !== null && candidates.includes(guess) ? guess : (candidates[0] ?? null);
}

/** §69.2 refusals of `project_create` in the user's words; anything else as the shared table words it. */
export function newProjectRefusal(e: unknown): string {
  const r = refusalOf(e);
  switch (r.code) {
    case "bad_parent":
      return t("The folder for new projects must be a full path — change it in Settings › General");
    case "parent_not_writable":
      return r.detail ? t("Could not make the project folder: {0}", r.detail) : t("Could not make the project folder");
    case "git_init_failed":
      return r.detail ? `${t("The git repository could not be initialized")}: ${r.detail}` : t("The git repository could not be initialized");
    default:
      return refusalMessage(r);
  }
}

// ---------------------------------------------------------------- the keys

/** 1 New · 2 Start from a task · 3 Open a folder. */
export type NoProjectChoice = 1 | 2 | 3;

/**
 * A key on the no-project cards (`KeyboardEvent.key`): 1 / 2 / 3 act at once, the arrows move the mark (stopping at either
 * end), Enter takes it. `handled` false: not the cards' key.
 */
export function noProjectKey(key: string, mark: NoProjectChoice): { handled: boolean; mark: NoProjectChoice; act: NoProjectChoice | null } {
  const clamp = (n: number) => Math.max(1, Math.min(3, n)) as NoProjectChoice;
  switch (key) {
    case "1":
    case "2":
    case "3":
      return { handled: true, mark: Number(key) as NoProjectChoice, act: Number(key) as NoProjectChoice };
    case "ArrowLeft":
    case "ArrowUp":
      return { handled: true, mark: clamp(mark - 1), act: null };
    case "ArrowRight":
    case "ArrowDown":
      return { handled: true, mark: clamp(mark + 1), act: null };
    case "Enter":
      return { handled: true, mark, act: mark };
    default:
      return { handled: false, mark, act: null };
  }
}

// ---------------------------------------------------------------- the task the project's start screen picks up

/** Paths compare without case and separator differences (Windows), and without a trailing separator. */
export function samePathLoose(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}
