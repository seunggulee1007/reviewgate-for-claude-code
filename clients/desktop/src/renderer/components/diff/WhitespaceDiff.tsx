/**
 * MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3: the review diff with whitespace ignored ("공백 무시", git's `-w`;
 * `select_file {ignoreWhitespace}`). Its hunks are not the review's hunks, so this view is read-only: no part revert, no
 * line / part side question, no note — the row above the lines says so and the toggle goes back. Copy, find, the editor
 * and "20줄 더 보기" (the same B) stay. A file whose every change is whitespace (§34.7 `whitespaceOnly`) reads
 * "공백만 바뀌었어요" here.
 */
import { useEffect, useState } from "react";
import type { ChangedFileState, DiffSince, FileDiff } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "../../engineRequest";
import { refusalMessage } from "../../errorCodes";
import { t } from "../../i18n";
import { useIgnoreWhitespace, whitespaceEmptyText, whitespaceViewNote } from "../../reviewLeftovers";
import { UnifiedDiff } from "../UnifiedDiff";
import { useFullFileContext } from "./UnifiedView";

/** The toolbar's "공백 무시" switch (shared by the normal and the whitespace-ignoring view). */
export function WhitespaceToggle(props: { file: Pick<ChangedFileState, "whitespaceOnly" | "isBinary"> }) {
  const ignore = useIgnoreWhitespace((s) => s.ignore);
  const toggle = useIgnoreWhitespace((s) => s.toggle);
  if (props.file.isBinary) return null;
  return (
    <button
      type="button"
      className={`small diff-tool ${ignore ? "active" : ""}`}
      aria-pressed={ignore}
      onClick={toggle}
      title={ignore ? whitespaceViewNote() : t("Hide changes that only touch whitespace (indentation, tabs ↔ spaces)")}
      data-testid="Ignore whitespace"
    >
      <span aria-hidden="true">␣</span> {t("Ignore whitespace")}
    </button>
  );
}

type Loaded = { key: string; diff: FileDiff | null; truncated: boolean; error: string | null };

/** `select_file {path, since, ignoreWhitespace: true}`, kept per (path, range, B). */
function useWhitespaceDiff(path: string, since: DiffSince, tree: string | null): Loaded | null {
  const key = `${tree ?? ""}\u0000${since}\u0000${path}`;
  const [box, setBox] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    setBox({ key, diff: null, truncated: false, error: null });
    engineRequest({ type: "select_file", path, ...(since !== "review" ? { since } : {}), ignoreWhitespace: true })
      .then((reply) => {
        // An engine before §41.3 ignores the field: its reply is the normal diff — say so instead of passing it off.
        if (reply.ignoreWhitespace !== true) throw new Error(t("This engine cannot ignore whitespace — update ReviewGate"));
        if (live) setBox({ key, diff: reply.diff, truncated: reply.truncated, error: null });
      })
      .catch((e: unknown) => {
        if (live) setBox({ key, diff: null, truncated: false, error: e instanceof Error && !("code" in e) ? e.message : refusalMessage(refusalOf(e)) });
      });
    return () => {
      live = false;
    };
  }, [key, path, since]);
  return box && box.key === key ? box : null;
}

export function WhitespaceDiffBody(props: { file: ChangedFileState; since: DiffSince; tree: string | null }) {
  const { file } = props;
  const loaded = useWhitespaceDiff(file.path, props.since, props.tree);
  const context = useFullFileContext(file.path);
  const toolbar = (
    <>
      <span className="pill gray diff-tools-note" title={whitespaceViewNote()} data-testid="Whitespace view note">
        {t("Whitespace ignored — read only")}
      </span>
      <WhitespaceToggle file={file} />
    </>
  );
  if (!loaded || (!loaded.diff && !loaded.error)) {
    return <div className="empty"><span className="spinner" /><div className="caption muted">{t("Loading diff…")}</div></div>;
  }
  if (loaded.error) {
    return (
      <div className="empty" data-testid="Whitespace diff error">
        <span className="glyph">⚠</span>
        <div className="caption">{loaded.error}</div>
        <WhitespaceToggle file={file} />
      </div>
    );
  }
  const diff = loaded.diff!;
  if (diff.hunks.length === 0) {
    return (
      <div className="empty" data-testid="Whitespace diff empty">
        <h2>{whitespaceEmptyText(file)}</h2>
        <div className="caption muted">{t("Turn “Ignore whitespace” off to see the whitespace changes")}</div>
        <WhitespaceToggle file={file} />
      </div>
    );
  }
  return <UnifiedDiff diff={diff} path={file.path} truncated={loaded.truncated} context={context} toolbar={toolbar} />;
}
