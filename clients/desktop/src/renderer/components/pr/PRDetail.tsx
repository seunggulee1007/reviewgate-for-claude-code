/**
 * The opened PR (the Mac app's `PRDetailView`): header (title, refs, decision, stats, Open in
 * browser, Review), the submit-result banner, then the reviews + files list on the left and the
 * selected file's diff (`PRDiffPane`) on the right.
 */
import { useState } from "react";
import type { PRDetail as PRDetailModel, PRFileMeta, PRReview, ReviewEvent } from "@reviewgate/engine";
import { relativeTime, t } from "../../i18n";
import { useStore } from "../../store";
import { PRDiffPane } from "./PRDiffPane";
import { PRClaudeHeaderButtons } from "../flow/PRClaude"; // MARK: wave3 desktop-flow
import "./pr.css";

export function PRDetail() {
  const pr = useStore((s) => s.state.pr);
  if (pr.selected) return <Opened pr={pr.selected} />;
  if (pr.isLoading && pr.selectedSummary) {
    return (
      <div className="pr-detail empty" data-testid="PR loading">
        <span className="spinner" />
        <div className="caption muted">{t("Loading {0}#{1}…", pr.selectedSummary.repo, pr.selectedSummary.number)}</div>
      </div>
    );
  }
  return (
    <div className="pr-detail empty" data-testid="PR placeholder">
      <div className="glyph">⇄</div>
      <h2>{t("Select a pull request")}</h2>
      <div>{t("Choose a PR from the list to see its files and diff.")}</div>
    </div>
  );
}

function Opened({ pr }: { pr: PRDetailModel }) {
  const state = useStore((s) => s.state.pr);
  const dismissedSubmitAt = useStore((s) => s.dismissedSubmitAt);
  const dismissSubmitBanner = useStore((s) => s.dismissSubmitBanner);
  const openDialog = useStore((s) => s.openDialog);
  const result = state.lastSubmitResult;
  const decision = decisionBadge(pr);
  return (
    <div className="pr-detail" data-testid="PR detail">
      <div className="pr-detail-header">
        <div className="row" style={{ alignItems: "flex-start" }}>
          <h2 className="grow" title={pr.title}>
            {pr.title} <span className="muted num">#{pr.number}</span>
          </h2>
          <button type="button" className="small" onClick={() => void window.rg.openExternal(pr.url)}>{t("Open in browser")}</button>
          {/* MARK: wave3 desktop-flow — §36.14: 워크벤치로 열기, 미해결 전체 보내기 */}
          <PRClaudeHeaderButtons pr={pr} />
          <button type="button" className="primary small" onClick={() => openDialog({ kind: "submitReview" })} title={t("Submit the drafts as one review")} data-testid="Review">
            {t("Review ({0} drafts)", state.draftComments.length)}
          </button>
        </div>
        <div className="row wrap">
          <span className="muted">{pr.author}</span>
          <span className="pr-refs" title={`${pr.headRefName} → ${pr.baseRefName}`}>{pr.headRefName} → {pr.baseRefName}</span>
          <span className={`pill ${decision.color}`} data-testid="Review decision">{decision.label}</span>
          <span className="spacer" />
          <span className="caption num green">+{pr.additions}</span>
          <span className="caption num red">−{pr.deletions}</span>
          <span className="caption muted">{t("{0} files", pr.changedFiles)}</span>
        </div>
      </div>
      {result && dismissedSubmitAt !== result.submittedAt && (
        <div className="banner green" data-testid="Submit banner">
          <span className="green">✓</span>
          <span className="truncate">{t("Review submitted ({0}) · {1} inline comment(s)", eventLabel(result.event), result.inlineCount)}</span>
          <button type="button" className="small" onClick={() => void window.rg.openExternal(result.reviewURL)} data-testid="Open on GitHub">{t("Open on GitHub")}</button>
          <span className="spacer" />
          <button type="button" className="plain small" onClick={dismissSubmitBanner} aria-label={t("Dismiss")} data-testid="Dismiss submit banner">✕</button>
        </div>
      )}
      <div className="pr-body">
        <div className="pr-side">
          <ul className="list">
            <ReviewsSection />
            <FilesSection />
          </ul>
        </div>
        <PRDiffPane />
      </div>
    </div>
  );
}

function decisionBadge(pr: PRDetailModel): { label: string; color: string } {
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { label: t("Approved"), color: "green" };
    case "CHANGES_REQUESTED":
      return { label: t("Changes requested"), color: "red" };
    case "REVIEW_REQUIRED":
      return { label: t("Review required"), color: "orange" };
    default:
      return { label: pr.state.charAt(0) + pr.state.slice(1).toLowerCase(), color: "gray" };
  }
}

export function eventLabel(event: ReviewEvent): string {
  switch (event) {
    case "COMMENT":
      return t("Comment");
    case "APPROVE":
      return t("Approve");
    case "REQUEST_CHANGES":
      return t("Request changes");
  }
}

function ReviewsSection() {
  const reviews = useStore((s) => s.state.pr.reviews);
  const accounts = useStore((s) => s.state.pr.accounts);
  const host = useStore((s) => s.state.pr.selectedSummary?.host ?? s.state.pr.host);
  const [expanded, setExpanded] = useState(true);
  const login = accounts.find((a) => a.host === host)?.login ?? null;
  return (
    <>
      <li className="section">
        <button type="button" className="section-toggle" onClick={() => setExpanded((e) => !e)} data-testid="Reviews toggle">
          <span className="tiny">{expanded ? "▼" : "▶"}</span> {t("Reviews ({0})", reviews.length)}
        </button>
      </li>
      {expanded && reviews.length === 0 && <li className="section-empty">{t("No reviews yet")}</li>}
      {expanded && reviews.map((r) => <ReviewRow key={r.id} review={r} mine={login !== null && r.author === login} />)}
    </>
  );
}

function ReviewRow({ review, mine }: { review: PRReview; mine: boolean }) {
  const badge = reviewStateBadge(review.state);
  return (
    <li className={`pr-review-row ${mine ? "mine" : ""}`} data-testid={`Review ${review.id}`}>
      <div className="row" style={{ gap: 6 }}>
        <span className={`truncate ${mine ? "bold" : ""}`}>{review.author}</span>
        {mine && <span className="tiny muted">{t("you")}</span>}
        <span className={`pill ${badge.color}`}>{badge.label}</span>
        <span className="spacer" />
        {review.submittedAt && <span className="caption muted" title={review.submittedAt}>{relativeTime(review.submittedAt)}</span>}
      </div>
      {review.body && <div className="body">{review.body}</div>}
    </li>
  );
}

function reviewStateBadge(state: string): { label: string; color: string } {
  switch (state) {
    case "APPROVED":
      return { label: state, color: "green" };
    case "CHANGES_REQUESTED":
      return { label: state, color: "red" };
    case "PENDING":
      return { label: state, color: "orange" };
    default:
      return { label: state, color: "gray" };
  }
}

function FilesSection() {
  const files = useStore((s) => s.state.pr.files);
  const comments = useStore((s) => s.state.pr.comments);
  const drafts = useStore((s) => s.state.pr.draftComments);
  const selected = useStore((s) => s.prSelectedFilename);
  const prSelectFile = useStore((s) => s.prSelectFile);
  return (
    <>
      <li className="section">{t("Files ({0})", files.length)}</li>
      {files.map((f) => (
        <li key={f.filename} className={f.filename === selected ? "selected" : ""} onClick={() => prSelectFile(f)} data-testid={`PR file ${f.filename}`}>
          <FileRow
            file={f}
            comments={comments.filter((c) => c.path === f.filename && c.line !== null).length}
            drafts={drafts.filter((d) => d.path === f.filename).length}
          />
        </li>
      ))}
    </>
  );
}

function FileRow({ file, comments, drafts }: { file: PRFileMeta; comments: number; drafts: number }) {
  const glyph = statusGlyph(file.status);
  return (
    <div className="pr-file-row">
      <span className={`glyph ${glyph.color}`}>{glyph.glyph}</span>
      <div className="col grow" style={{ gap: 1 }}>
        <span className="name" title={file.filename}>{file.filename}</span>
        {file.previousFilename && <span className="caption muted truncate" title={file.previousFilename}>{t("from {0}", file.previousFilename)}</span>}
      </div>
      <span className="counts">
        {comments > 0 && <span className="muted" title={t("{0} comment(s)", comments)}>💬 {comments}</span>}
        {drafts > 0 && <span className="pill orange" title={t("{0} draft comment(s)", drafts)}>✎ {drafts}</span>}
        <span className="num green">+{file.additions}</span>
        <span className="num red">−{file.deletions}</span>
      </span>
    </div>
  );
}

function statusGlyph(status: string): { glyph: string; color: string } {
  switch (status) {
    case "added":
      return { glyph: "A", color: "green" };
    case "removed":
      return { glyph: "D", color: "red" };
    case "modified":
    case "changed":
      return { glyph: "M", color: "orange" };
    case "renamed":
      return { glyph: "R", color: "blue" };
    case "copied":
      return { glyph: "C", color: "blue" };
    default:
      return { glyph: "?", color: "muted" };
  }
}
