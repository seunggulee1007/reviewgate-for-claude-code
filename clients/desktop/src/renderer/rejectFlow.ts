/**
 * Whole-file reject with the §19.1 safety net (docs/PROTOCOL.md): `reject` / `reject_all` refused with
 * `file_changed_since_review` (+ `paths`) asks the user first — "직접 수정한 내용이 사라집니다 — 그래도 되돌릴까요?" —
 * and only a confirmed answer re-sends the same command with `force: true`. Cancel sends nothing.
 * §31.2: a command that reverts files changed outside the app (`origin: "external"` — the IDE, another session, a pull)
 * is sent only after a second confirm listing them ("앱 밖 변경도 되돌리기"); declining sends nothing.
 */
import { refusalOf } from "./engineRequest";

export type RejectCommand = { type: "reject"; paths: string[] } | { type: "reject_all"; includeExternal?: true };

export type RejectOutcome =
  | { kind: "done"; forced: boolean }
  /** The user kept their edits (nothing was reverted). */
  | { kind: "cancelled"; paths: string[] }
  /** §31.2: the user kept the outside changes (nothing was sent). */
  | { kind: "keptExternal"; paths: string[] }
  /** Any other refusal, or the forced re-send failing: the caller shows it. */
  | { kind: "refused"; error: unknown };

export type RejectDeps = {
  request(cmd: RejectCommand & { force?: true }): Promise<unknown>;
  /** Shows the confirm listing `paths`; resolves true for "revert anyway". */
  confirmOverwrite(paths: string[]): Promise<boolean>;
  /** §31.2: shows the "these may not be Claude's" confirm listing the outside files; resolves true for "revert them too". */
  confirmExternal?(paths: string[]): Promise<boolean>;
};

export const FILE_CHANGED_SINCE_REVIEW = "file_changed_since_review";

/** The edited files of a `file_changed_since_review` refusal (`paths`, else the list in its `error` text). */
export function changedPathsOf(e: unknown): string[] | null {
  const r = refusalOf(e);
  if (r.code !== FILE_CHANGED_SINCE_REVIEW) return null;
  if (r.paths && r.paths.length > 0) return r.paths;
  return r.detail
    .split(", ")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** `external`: the outside files `cmd` would revert — confirmed through `deps.confirmExternal` before anything is sent. */
export async function runReject(cmd: RejectCommand, deps: RejectDeps, external: readonly string[] = []): Promise<RejectOutcome> {
  if (external.length > 0 && !(deps.confirmExternal && (await deps.confirmExternal([...external])))) return { kind: "keptExternal", paths: [...external] };
  try {
    await deps.request(cmd);
    return { kind: "done", forced: false };
  } catch (e) {
    const paths = changedPathsOf(e);
    if (paths === null) return { kind: "refused", error: e };
    if (!(await deps.confirmOverwrite(paths))) return { kind: "cancelled", paths };
    try {
      await deps.request({ ...cmd, force: true });
      return { kind: "done", forced: true };
    } catch (again) {
      return { kind: "refused", error: again };
    }
  }
}
