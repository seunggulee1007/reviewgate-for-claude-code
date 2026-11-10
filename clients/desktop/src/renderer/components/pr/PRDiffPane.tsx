/**
 * Unified diff of the selected PR file (the Mac app's `PRDiffPane`): existing review comments and
 * pending drafts sit under the line they belong to; the hover "+" gutter opens a draft composer,
 * "Reply" on a comment opens a reply composer (`pr_reply`).
 *
 * Line matching follows GitHub's `line`/`side`: add/context lines match `newNo` on RIGHT, deleted
 * lines match `oldNo` on LEFT. Hunk headers cannot be commented.
 */
import { useEffect, useMemo, useState } from "react";
import type { DiffLine, DraftComment, PRComment, PRFileMeta } from "@reviewgate/engine";
import { relativeTime, t } from "../../i18n";
import { useStore } from "../../store";
import { Bubble } from "../diff/Bubble";
import { LineComposer, UnifiedDiff, type LineKey } from "../UnifiedDiff";
// MARK: wave3 desktop-flow — §36.14 PR comments to Claude, a PR line's side question
import { prAskTitle, SendCommentButton, usePrLineAsk } from "../flow/PRClaude";
import { refusalMessage } from "../../errorCodes";
// MARK: wave4c w4c-review — §41.3 "20줄 더 보기" from the PR's head commit
import { engineRequest } from "../../engineRequest";
import { prOffersContext } from "../../reviewLeftovers";
import { useFileLinesContext } from "../diff/MoreLines";

type GHSide = "LEFT" | "RIGHT";
type Composer = { side: GHSide; line: number; replyTo: PRComment | null };

/** `LineKey` (old/new) → GitHub side. */
export function ghSide(key: LineKey): GHSide {
  return key.side === "old" ? "LEFT" : "RIGHT";
}

const ghKey = (side: string | null, line: number) => `${side === "LEFT" ? "LEFT" : "RIGHT"}:${line}`;

export function PRDiffPane() {
  const pr = useStore((s) => s.state.pr);
  const filename = useStore((s) => s.prSelectedFilename);
  const diff = useStore((s) => s.prSelectedDiff);
  const loading = useStore((s) => s.prDiffLoading);
  const prAddDraft = useStore((s) => s.prAddDraft);
  const prRemoveDraft = useStore((s) => s.prRemoveDraft);
  const prReply = useStore((s) => s.prReply);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [busy, setBusy] = useState(false);

  const file: PRFileMeta | null = pr.files.find((f) => f.filename === filename) ?? null;
  useEffect(() => setComposer(null), [filename]);
  const askLine = usePrLineAsk(file?.filename ?? null, diff); // MARK: wave3 desktop-flow
  // MARK: wave4c w4c-review — the file at the PR's head commit, asked on the first "20줄 더 보기"
  const head = pr.selected?.headRefOid ?? "";
  const contextKey = file && diff && prOffersContext(file.status, diff.isBinary) ? `${head}\u0000${file.filename}` : null;
  const context = useFileLinesContext(contextKey, () => engineRequest({ type: "pr_file_lines", filename: file!.filename }));

  const comments = useMemo(() => pr.comments.filter((c) => c.path === filename), [pr.comments, filename]);
  const outdated = comments.filter((c) => c.line === null).length;
  const byLine = useMemo(() => {
    const map = new Map<string, PRComment[]>();
    for (const c of comments) {
      if (c.line === null) continue;
      const k = ghKey(c.side, c.line);
      map.set(k, [...(map.get(k) ?? []), c]);
    }
    for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return map;
  }, [comments]);
  const draftsByLine = useMemo(() => {
    const map = new Map<string, DraftComment[]>();
    for (const d of pr.draftComments) {
      if (d.path !== filename) continue;
      const k = ghKey(d.side, d.line);
      map.set(k, [...(map.get(k) ?? []), d]);
    }
    return map;
  }, [pr.draftComments, filename]);

  if (!file) {
    return (
      <div className="pr-diff">
        <div className="empty">
          <div className="glyph">⌕</div>
          <h2>{t("Select a file")}</h2>
          <div>{t("Pick a changed file to see its diff.")}</div>
        </div>
      </div>
    );
  }

  const submit = (body: string) => {
    if (!composer) return;
    if (composer.replyTo) {
      setBusy(true);
      void prReply(composer.replyTo.id, body).then((ok) => {
        setBusy(false);
        if (ok) setComposer(null);
      });
    } else {
      prAddDraft(file.filename, composer.line, composer.side, body);
      setComposer(null);
    }
  };

  const extra = (_line: DiffLine, key: LineKey | null) => {
    if (!key) return null;
    const side = ghSide(key);
    const k = `${side}:${key.line}`;
    const cs = byLine.get(k) ?? [];
    const ds = draftsByLine.get(k) ?? [];
    const open = composer && composer.side === side && composer.line === key.line;
    if (cs.length === 0 && ds.length === 0 && !open) return null;
    return (
      <>
        {cs.map((c) => (
          <Bubble
            key={c.id}
            kind="comment"
            author={c.inReplyTo !== null ? `↳ ${c.author}` : c.author}
            time={relativeTime(c.createdAt)}
            body={c.body}
            onReply={() => setComposer({ side, line: key.line, replyTo: c })}
            actions={<SendCommentButton comment={c} />}
            testId={`Comment ${c.id}`}
          />
        ))}
        {ds.map((d) => (
          <Bubble key={d.id} kind="draft" meta={t("pending review")} body={d.body} onDelete={() => prRemoveDraft(d.id)} testId="Draft comment" />
        ))}
        {open && (
          <LineComposer
            title={composer.replyTo ? t("Reply to {0}", composer.replyTo.author) : `${file.filename}:${key.line}`}
            submitTitle={composer.replyTo ? t("Reply") : t("Add to review")}
            busy={busy || pr.isSubmitting}
            onSubmit={submit}
            onCancel={() => setComposer(null)}
            testId={composer.replyTo ? "Reply composer" : "Draft composer"}
          />
        )}
      </>
    );
  };

  return (
    <div className="pr-diff" data-testid="PR diff pane">
      <div className="pane-header">
        <div className="row">
          <span className="bold truncate" title={file.filename}>{file.filename}</span>
          <span className="caption num green">+{file.additions}</span>
          <span className="caption num red">−{file.deletions}</span>
          <span className="spacer" />
          {outdated > 0 && <span className="caption muted">{t("{0} outdated comment(s) hidden", outdated)}</span>}
        </div>
      </div>
      {diff ? (
        diff.isBinary ? (
          <div className="empty">
            <h2>{t("No textual diff")}</h2>
            <div>{t("GitHub returned no patch for this file (binary or too large).")}</div>
          </div>
        ) : (
          <UnifiedDiff
            diff={diff}
            onAdd={(_l, key) => setComposer({ side: ghSide(key), line: key.line, replyTo: null })}
            extra={extra}
            path={file.filename} /* MARK: wave2 desktop-diff — 경로:줄 복사 */
            context={context} /* MARK: wave4c w4c-review — 20줄 더 보기 (its lines are outside the PR's diff: no comment / side question) */
            revealedActions={false}
            // MARK: wave3 desktop-flow — §36.14: "곁질문으로 묻기" on a PR line (the "?" gutter and the right-click menu)
            onAsk={askLine ? (line) => askLine(line) : undefined}
            lineMenuItems={(line) => line.id < 0 ? [] /* MARK: wave4c w4c-review — a revealed line is outside the PR's diff */ : [
              askLine
                ? { label: t("Ask in a side thread"), onClick: () => askLine(line), title: prAskTitle(), testId: "PR line ask" }
                : { label: t("Ask in a side thread"), onClick: () => undefined, disabled: true, title: refusalMessage({ code: "no_project", error: "no_project", detail: "" }), testId: "PR line ask" },
            ]}
          />
        )
      ) : (
        <div className="empty">
          {loading && <span className="spinner" />}
          <div className="caption muted">{loading ? t("Loading diff…") : t("No diff loaded")}</div>
        </div>
      )}
    </div>
  );
}
