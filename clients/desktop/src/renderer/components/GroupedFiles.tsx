/**
 * MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2 (comp-14): the review list's "묶기" menu and its sections (by folder,
 * by layer). Without a grouping — and for a bulk list (§39.1), which folds by folder itself — the rows are drawn as before.
 */
import { Fragment, type ReactNode } from "react";
import type { ChangedFileState } from "@reviewgate/engine";
import { isBulk } from "../bigTurn";
import { GROUP_BYS, groupByLabel, groupFiles, sectionLabel, type GroupBy } from "../fileGroups";
import { t } from "../i18n";
import { useStore } from "../store";
import { BulkFolders } from "./BulkFolders";

/** `causeOf` (wave4c w4c-review, §41.3): the file's "원인별" section (`fileCause`). */
export function GroupedFiles(props: { by: GroupBy; files: ChangedFileState[]; groupKey: string; render: (f: ChangedFileState) => ReactNode; causeOf?: (f: ChangedFileState) => string }) {
  const bulk = useStore((s) => isBulk(s.state.changedFiles.length));
  if (props.by === "none" || bulk) return <BulkFolders files={props.files} groupKey={props.groupKey} render={props.render} />;
  return (
    <>
      {groupFiles(props.files, props.by, props.causeOf).map((s) => (
        <Fragment key={`${props.groupKey}|${s.key}`}>
          <li className="section row folder-head" data-testid={`File section ${s.key}`}>
            <span className={`grow truncate ${props.by === "folder" ? "mono" : ""}`} title={s.key || undefined}>{sectionLabel(props.by, s.key)}</span>
            <span className="group-count num" aria-label={t("{0} files", s.files.length)}>{s.files.length}</span>
          </li>
          {s.files.map(props.render)}
        </Fragment>
      ))}
    </>
  );
}

/** "묶기: 없음 · 폴더 · 계층" — kept per project. */
export function GroupByMenu(props: { value: GroupBy; onChange: (by: GroupBy) => void; disabledReason: string | null }) {
  return (
    <select
      className="tiny"
      value={props.value}
      disabled={props.disabledReason !== null}
      onChange={(e) => props.onChange(e.target.value as GroupBy)}
      title={props.disabledReason ?? t("Group the list")}
      aria-label={t("Group the list")}
      data-testid="Group by"
    >
      {GROUP_BYS.map((by) => (
        <option key={by} value={by}>
          {groupByLabel(by)}
        </option>
      ))}
    </select>
  );
}
