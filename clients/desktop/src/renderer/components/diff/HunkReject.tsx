/**
 * Hunk-level reject (docs/PROTOCOL.md §17) for the unified review diff: a checkbox and "Revert this part"
 * on every hunk header, plus a bar above the diff with the selection count and "Revert selected" (asks first
 * when more than one part is selected). Only a pending, modified, textual file can be reverted in parts; the
 * others get a hint to reject the whole file. The store sends `reject_hunks` with the `expectedEndTree` the
 * diff was made for; the new snapshot B re-requests the diff by itself.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChangedFileState, DiffHunk } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore, type ReviewDiff } from "../../store";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
// MARK: wave2 desktop-flow — §34.1 hunk ids are the whole review's; §34.2 reject waits for the turn's end
import { diffTreeOf, rejectBlockedReason } from "../../reviewRound";

export type HunkReject = {
  /** Per-hunk header controls (undefined when the file cannot be reverted in parts). */
  hunkActions: ((hunk: DiffHunk) => ReactNode) | undefined;
  selected: ReadonlySet<number>;
  /** The bar above the diff (selection + "Revert selected", or why parts cannot be reverted). */
  bar: ReactNode;
  /** The confirm dialog for a multi-part revert. */
  dialog: ReactNode;
};

/** Why `reject_hunks` would be refused for this file before even asking the engine (null = supported). */
function unsupportedReason(file: ChangedFileState, diff: ReviewDiff | null): string | null {
  // §32 (wave1 desktop-review): a stub stands for the content — no part of it can be put back (`partial_reject_unsupported:uncaptured`).
  if (file.uncaptured) return t("This file's content was not captured, so no part of it can be reverted either");
  if (file.isBinary || diff?.isBinary) return t("Binary files cannot be reverted in parts — reject the whole file instead.");
  switch (file.status) {
    case "M":
      return null;
    case "A":
      return t("Parts of a {0} file cannot be reverted — reject the whole file instead.", t("added"));
    case "D":
      return t("Parts of a {0} file cannot be reverted — reject the whole file instead.", t("deleted"));
    case "R":
      return t("Parts of a {0} file cannot be reverted — reject the whole file instead.", t("renamed"));
    default:
      return t("Parts of a {0} file cannot be reverted — reject the whole file instead.", t("copied"));
  }
}

export function useHunkReject(file: ChangedFileState | null, diff: ReviewDiff | null): HunkReject {
  const rejectHunks = useStore((s) => s.rejectHunks);
  const blocked = useStore((s) => rejectBlockedReason(s.state));
  const tree = useStore((s) => diffTreeOf(s.state.gate));
  const since = useStore((s) => s.diffSince);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<number[] | null>(null);

  // A new file, a new snapshot B (after a revert, refresh or turn) or another range invalidates the hunk ids.
  useEffect(() => {
    setSelected(new Set());
    setConfirm(null);
  }, [file?.path, tree, since]);

  const hunks = diff?.hunks ?? [];
  const pending = file?.state === "pending";
  // §34.1: the ids of a range other than the whole review are not `reject_hunks` ids — revert parts from 전체 only.
  const otherRange = diff?.since !== undefined && diff.since !== "review";
  const reason = file && pending ? (unsupportedReason(file, diff) ?? (otherRange ? t("Parts can be reverted in the “Whole review” view") : null)) : null;
  const enabled = file !== null && pending && reason === null && hunks.length > 0 && diff !== null;
  const locked = blocked !== null;
  const disabled = locked || busy;

  const run = async (ids: number[]) => {
    if (!file || ids.length === 0) return;
    setBusy(true);
    try {
      const refusal = await rejectHunks(file.path, ids);
      if (refusal === null) setSelected(new Set());
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const toggle = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const hunkActions = useMemo(() => {
    if (!enabled) return undefined;
    return (h: DiffHunk) => (
      <span className="hunk-controls" onClick={(e) => e.stopPropagation()}>
        <label className="hunk-check" title={t("Select this part")}>
          <input type="checkbox" checked={selected.has(h.id)} disabled={disabled} onChange={() => toggle(h.id)} data-testid={`Select hunk ${h.id}`} />
        </label>
        <button
          type="button"
          className="small hunk-revert"
          disabled={disabled}
          onClick={() => void run([h.id])}
          title={blocked ?? t("Put this part back as it was before the turn; the rest of the file stays under review")}
          data-testid={`Revert hunk ${h.id}`}
        >
          ↶ {t("Revert this part")}
        </button>
      </span>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, selected, disabled, blocked, file?.path]);

  let bar: ReactNode = null;
  if (file && pending && diff && !diff.isBinary && hunks.length > 0) {
    if (reason) {
      bar = (
        <div className="hunk-bar muted" data-testid="Hunk bar">
          <span className="caption truncate grow" title={reason}>{reason}</span>
        </div>
      );
    } else {
      const n = selected.size;
      const ids = hunks.map((h) => h.id).filter((id) => selected.has(id));
      bar = (
        <div className="hunk-bar" data-testid="Hunk bar">
          <span className="caption muted truncate grow">
            {t("{0} part(s) changed", hunks.length)}
            {n > 0 && <span className="accent-text"> · {t("{0} selected", n)}</span>}
            {file.partial && <span className="orange"> · {t("{0} part(s) already reverted", file.rejectedHunks ?? 0)}</span>}
          </span>
          {busy && <span className="spinner" />}
          {n > 0 && (
            <button type="button" className="plain small" disabled={disabled} onClick={() => setSelected(new Set())}>
              {t("Clear selection")}
            </button>
          )}
          <button
            type="button"
            className="small"
            disabled={disabled || n === 0}
            onClick={() => (n > 1 ? setConfirm(ids) : void run(ids))}
            title={blocked ?? t("Revert the selected parts only")}
            data-testid="Revert selected hunks"
          >
            ↶ {t("Revert selected ({0})", n)}
          </button>
        </div>
      );
    }
  }

  const dialog =
    confirm && file ? (
      <ConfirmDialog
        title={t("Revert {0} parts of {1}?", confirm.length, file.path.slice(file.path.lastIndexOf("/") + 1))}
        message={
          confirm.length >= hunks.length
            ? t("Every part is selected, so the whole file goes back to how it was before the turn and leaves the review.")
            : t("The selected parts go back to how they were before the turn; the other {0} part(s) stay under review.", hunks.length - confirm.length)
        }
        confirmLabel={t("Revert {0} parts", confirm.length)}
        danger
        busy={busy}
        onConfirm={() => void run(confirm)}
        onCancel={() => setConfirm(null)}
        testId="Revert hunks dialog"
      />
    ) : null;

  return { hunkActions, selected, bar, dialog };
}
