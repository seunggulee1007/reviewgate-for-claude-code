/**
 * MARK: wave4b w4b-bigturn
 * docs/PROTOCOL.md §39.1 (robustness-10 ②, as on the Mac's review list): a bulk change (over 300 files) lists each group's
 * files folded by folder (`foldFolders`, at most 40 folders) — a folder opens on a click, and by itself when one of its
 * files is selected (⌘] / ⌘[, the diff); it then stays open until folded, as on the Mac. An ordinary list is drawn as before.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { ChangedFileState } from "@reviewgate/engine";
import { folderTitle, foldFolders, isBulk } from "../bigTurn";
import { t } from "../i18n";
import { useStore } from "../store";

export function BulkFolders({ files, groupKey, render }: { files: ChangedFileState[]; groupKey: string; render: (f: ChangedFileState) => ReactNode }) {
  const bulk = useStore((s) => isBulk(s.state.changedFiles.length));
  const selected = useStore((s) => s.selectedPath);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const groups = bulk ? foldFolders(files.map((f) => f.path)) : [];
  const folderOfPath = new Map<string, string>();
  for (const g of groups) for (const p of g.paths) folderOfPath.set(p, g.folder);
  const selectedFolder = selected !== null ? folderOfPath.get(selected) : undefined;
  const selectedKey = selectedFolder !== undefined ? `${groupKey}|${selectedFolder}` : null;
  useEffect(() => {
    if (selectedKey !== null) setOpen((prev) => (prev.has(selectedKey) ? prev : new Set(prev).add(selectedKey)));
  }, [selectedKey]);
  if (!bulk) return <>{files.map(render)}</>;
  return (
    <>
      {groups.map((g) => {
        const key = `${groupKey}|${g.folder}`;
        const isOpen = open.has(key);
        const toggle = () => {
          const next = new Set(open);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          setOpen(next);
        };
        return (
          <Fragment key={key}>
            <li className="section row folder-head" data-testid="Bulk folder">
              <button type="button" className="plain tiny" aria-expanded={isOpen} aria-label={isOpen ? t("Fold folder") : t("Open folder")} onClick={toggle} data-testid="Bulk folder toggle">
                {isOpen ? "▾" : "▸"}
              </button>
              <span className="grow truncate mono" title={g.folder || "/"}>{folderTitle(g.folder, g.paths.length)}</span>
            </li>
            {isOpen && files.filter((f) => folderOfPath.get(f.path) === g.folder).map(render)}
          </Fragment>
        );
      })}
    </>
  );
}
