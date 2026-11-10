/**
 * MARK: polish p-foundation — P1-chrome-21 / P2-review-35: a path cut in the middle — the folders shrink first, the file
 * name stays — with the whole path on hover. (The review diff header's, shared.)
 *
 *   <MiddlePath path={file.path} className="bold" />
 *   <MiddlePath path={file.oldPath} prefix={t("from")} className="caption muted" />
 */
import "./common.css";

export function MiddlePath(props: { path: string; className?: string; prefix?: string; testId?: string }) {
  // The last separator of either kind: a Windows path keeps its file name too.
  const cut = Math.max(props.path.lastIndexOf("/"), props.path.lastIndexOf("\\"));
  const dir = cut < 0 ? "" : props.path.slice(0, cut + 1);
  const name = cut < 0 ? props.path : props.path.slice(cut + 1);
  return (
    <span className={`path-middle ${props.className ?? ""}`} title={props.path} data-testid={props.testId}>
      {props.prefix && (
        <span className="faint" style={{ flex: "none" }}>
          {props.prefix}&nbsp;
        </span>
      )}
      <span className="head truncate">{dir}</span>
      <span className="tail">{name}</span>
    </span>
  );
}
