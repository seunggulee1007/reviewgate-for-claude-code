/**
 * MARK: add-dir — docs/PROTOCOL.md §67.3: the composer's "디렉터리 N" chip while the chat has directories added with
 * `/add-dir` (src/renderer/addedDirs.ts). Its popover lists each (home as `~`, the full path in its tooltip) with ×
 * (`remove_dir`) and "디렉터리 추가…" (the folder picker); while Claude works (the engine would refuse `dir_busy`) both are
 * disabled with that reason as their tooltip.
 */
import { useRef, useState } from "react";
import { addedDirsBusyReason, addedDirsChipText, addedDirsChipTitle, addedDirsOf, removeDir, shownDir } from "../../addedDirs";
import { t } from "../../i18n";
import { Icon } from "../../icons";
import { useStore } from "../../store";
import { AnchoredPopover } from "./HudPopovers";

export function AddedDirsChip(props: { onAdd: () => void; onNotice: (text: string) => void }) {
  const dirs = useStore((s) => addedDirsOf(s.state.session));
  const busy = useStore((s) => addedDirsBusyReason(s.state));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (dirs.length === 0) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="added-dirs-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={addedDirsChipText(dirs.length)}
        title={addedDirsChipTitle()}
        onClick={() => setOpen((o) => !o)}
        data-testid="Added directories"
      >
        <Icon name="folder" size={13} />
        <span className="num">{addedDirsChipText(dirs.length)}</span>
      </button>
      {open && (
        <AnchoredPopover anchor={ref.current} onClose={() => setOpen(false)} width={380} className="added-dirs-popover" testId="Added directories popover">
          <AddedDirsList
            dirs={dirs}
            busy={busy}
            onRemove={(dir) => void removeDir(dir).then((r) => r && props.onNotice(r.notice))}
            onAdd={() => {
              setOpen(false);
              props.onAdd();
            }}
          />
        </AnchoredPopover>
      )}
    </>
  );
}

/** The popover's content (props only, so it renders in tests). */
export function AddedDirsList(p: { dirs: readonly string[]; busy: string | null; onRemove: (dir: string) => void; onAdd: () => void }) {
  return (
    <div className="added-dirs" role="group" aria-label={t("Added directories")}>
      <span className="caption muted">{addedDirsChipTitle()}</span>
      <ul className="added-dirs-list">
        {p.dirs.map((dir) => (
          <li key={dir} className="added-dir">
            <Icon name="folder" size={13} />
            <span className="mono truncate grow" title={dir}>{shownDir(dir)}</span>
            <button
              type="button"
              className="chip-x"
              disabled={p.busy !== null}
              onClick={() => p.onRemove(dir)}
              aria-label={t("Remove {0}", dir)}
              title={p.busy ?? t("Claude no longer works here from your next message")}
              data-testid="Remove added directory"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <span className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="small"
          disabled={p.busy !== null}
          onClick={p.onAdd}
          aria-label={t("Add Directory…")}
          title={p.busy ?? t("Choose another directory Claude may work in (/add-dir)")}
          data-testid="Add directory"
        >
          <Icon name="plus" size={12} /> {t("Add Directory…")}
        </button>
      </span>
    </div>
  );
}
