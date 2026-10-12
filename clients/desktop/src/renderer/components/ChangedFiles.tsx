/**
 * Files changed on disk during the last turn (git checkpoint diff), with review state, Accept / Reject and Commit accepted (M12).
 * §31–32 (wave1 desktop-review): grouped into "설정·훅 (Claude 동작 변경)" (mods files, with their risks), "Claude 변경" and
 * "앱 밖 변경" (origin external — Reject all leaves them); uncaptured files cannot be rejected, gitignored ones are not committed;
 * "리뷰 끝내기" empties the list without touching any file.
 * §34 (wave2 desktop-flow): "봤음" by content ("본 뒤 바뀜" per file and counted), "수락 뒤 바뀜", sent notes apart from the
 * unsent ones, accept during a running turn while reject waits (disabled with the reason on screen), the running turn's
 * "진행 중 변경" section, the previous round's decided files dimmed while a fresh turn runs, and the list's own order
 * (groups, risky first) shared with ⌘] / ⌘[ and the move after accept (store `riskFirst`).
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ChangedFileState, ChangeStatus, GateState, SideThread } from "@reviewgate/engine";
import { t } from "../i18n";
import { MENTION_DRAG_TYPE } from "../mentions";
import { finishReviewBlocked, groupChanges, groupHelp, groupLabel, modsRiskHelp, modsRiskLabel, modsRisksOf, showsGroupHeaders, uncapturedText, type ChangeGroup, type ChangeGroupKind } from "../reviewGate";
import { ALL_RISKS, riskHelp, riskKinds, riskLabel, riskTone, sortByRisk } from "../risk";
import { commitOf, pendingFiles, useStore } from "../store";
import { GateNotices } from "./GateNotices";
import { AskButton, SideBadge, useSideThreads } from "./side/SideAsk";
import { threadsOnFile } from "../sideThreads";
// MARK: wave2 desktop-flow
import { acceptBlockedReason, changedSinceViewed, collectFailedReason, diffTreeOf, hasReviewRound2, isTurnActive, rejectBlockedReason, unchangedSinceRequest, viewStateOf, type ViewState } from "../reviewRound";
import { LiveChanges } from "./LiveChanges";
import { staleBannerShown } from "./diff/DiffRound";
import { PreReviewBadge, PreReviewHead } from "./flow/PreReview"; // MARK: wave3 desktop-flow
import { GroupByMenu, GroupedFiles } from "./GroupedFiles"; // MARK: wave4b w4b-files — §40.2 (wraps w4b-bigturn's BulkFolders)
import { compactPath, useGroupBy } from "../fileGroups"; // MARK: wave4b w4b-files
import { useFileCauses } from "./FileCauses"; // MARK: wave4c w4c-review
import { isBulk } from "../bigTurn"; // MARK: wave4b w4b-files
import { ReviewListNotices } from "./StorageNotices";
import { ViewingReviewNote } from "./chat/ViewingChat"; // MARK: wave4b w4b-tabs (§39.2)
import "./reviewGate.css";
import "./reviewRound.css";
import { AuthorFilterChips, FileAuthorChips, useAuthorFilter } from "./agents/AgentGlanceBits"; // MARK: wave4b w4b-agents
import type { FileAuthor } from "../agentGlance";
import { AutoAcceptedBadge } from "./trust/TrustViews"; // MARK: wave4c w4c-trust (§41.2)
import { countsText, stateWord, statusWord } from "../a11yText"; // MARK: wave4d w4d-speed
import "./a11y.css";

const MODS_LEGEND = ["hook", "script", "mcp", "permissions", "env"];

export function ChangedFiles() {
  const state = useStore((s) => s.state);
  const selectedPath = useStore((s) => s.selectedPath);
  const selectFile = useStore((s) => s.selectFile);
  const accept = useStore((s) => s.accept);
  const reject = useStore((s) => s.reject);
  const retryCollect = useStore((s) => s.retryCollect);
  const openDialog = useStore((s) => s.openDialog);
  const pending = pendingFiles(state).length;
  // wave2 desktop-flow — §34.2: accept also while a turn runs on this review; reject waits for the turn's end.
  const acceptBlocked = acceptBlockedReason(state);
  const rejectBlocked = rejectBlockedReason(state);
  const bannerSaysWhy = useStore(staleBannerShown);
  const commit = commitOf(state);
  // §34.4: 💬 counts the notes still to send; the sent ones ("요청함") apart.
  const noteCount = (path: string) => state.reviewNotes.filter((n) => n.path === path && !n.sent).length;
  const sentCount = (path: string) => state.reviewNotes.filter((n) => n.path === path && n.sent).length;
  const viewedPaths = useStore((s) => s.viewedPaths);
  const riskFirst = useStore((s) => s.riskFirst);
  const setRiskFirst = useStore((s) => s.setRiskFirst);
  const groups = useMemo(() => groupChanges(state.changedFiles).map((g) => (riskFirst ? { ...g, files: sortByRisk(g.files) } : g)), [riskFirst, state.changedFiles]);
  const headers = showsGroupHeaders(groups);
  const viewStates = useMemo(() => new Map(state.changedFiles.map((f) => [f.path, viewStateOf(f, viewedPaths)] as const)), [state.changedFiles, viewedPaths]);
  const isViewed = (f: ChangedFileState) => viewStates.get(f.path) === "viewed" || f.state !== "pending";
  const changedAfterView = changedSinceViewed(state.changedFiles, viewedPaths).length;
  // §34.2: a fresh turn runs — the list still shows the previous round's decided files, which have no diff any more.
  const previousRound = hasReviewRound2(state.gate) && diffTreeOf(state.gate) === null && isTurnActive(state.gate) && state.changedFiles.length > 0;
  const sideThreads = useSideThreads();
  const finishBlocked = finishReviewBlocked(state);
  // MARK: wave4b w4b-agents — agents-13: which agent changed each file; "전체 · 메인 · <에이전트>" with two or more authors.
  const authorFilter = useAuthorFilter(state.changedFiles);
  // MARK: wave4c w4c-review — §41.3 "원인별": each file's subagent · Bash command · turn (⌘] / ⌘[ follow it too)
  const causes = useFileCauses(state.changedFiles, authorFilter.authors);
  // MARK: wave4b w4b-files — §40.2 (comp-14): "묶기", kept per project; ⌘] / ⌘[ follow it (`displayOrder`).
  const groupBy = useGroupBy((s) => s.current);
  const chooseGroupBy = useGroupBy((s) => s.choose);
  const setGroupRoot = useGroupBy((s) => s.setRoot);
  const projectRoot = state.project?.root ?? "";
  useEffect(() => setGroupRoot(projectRoot), [projectRoot, setGroupRoot]);
  const bulkList = isBulk(state.changedFiles.length);

  // ⌘⇧K (Ctrl on other platforms) opens the commit dialog.
  useEffect(() => {
    if (!commit.canCommit) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!useStore.getState().dialog) openDialog({ kind: "commit" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [commit.canCommit, openDialog]);

  return (
    <div className="col grow">
      <div className="row" style={{ padding: "6px 12px", gap: 6 }}>
        <span className="muted caption truncate grow" title={t("Next pending file ⌘] · previous ⌘[")} data-testid="Changed summary">{t("{0} changed · {1} pending", state.changedFiles.length, pending)}</span>
        <button
          type="button"
          className="small"
          disabled={pending === 0 || acceptBlocked !== null}
          onClick={() => openDialog({ kind: "acceptAll" })}
          title={acceptBlocked ?? t("Review the list of pending files before accepting them all")}
          data-testid="Accept all"
        >
          {t("Accept all")}
        </button>
        <button type="button" className="small" disabled={pending === 0 || rejectBlocked !== null} onClick={() => openDialog({ kind: "rejectAll" })} title={rejectBlocked ?? undefined} data-testid="Reject all">{t("Reject all")}</button>
      </div>
      <ViewingReviewNote /* MARK: wave4b w4b-tabs — §39.2 "실행 중인 채팅('…')의 리뷰예요" while another chat is shown */ />
      {/* wave2 desktop-flow — a blocked action stays visible, disabled, with its reason in one line (once on screen: the
          diff's "이번 턴 전 기준" banner says it when it is up). */}
      {pending > 0 && rejectBlocked !== null && state.gate.phase !== "reverting" && collectFailedReason(state) === null && !bannerSaysWhy && (
        <div className="caption muted round-reason" data-testid="Reject blocked reason">{rejectBlocked}</div>
      )}
      <div className="row" style={{ padding: "0 12px 6px", gap: 6 }}>
        <button
          type="button"
          className="small grow"
          disabled={!commit.canCommit}
          onClick={() => openDialog({ kind: "commit" })}
          title={collectFailedReason(state) ?? t("Commit the accepted files (⌘⇧K)")}
          aria-label={t("Commit accepted")}
          data-testid="Commit accepted"
        >
          {t("Commit accepted ({0})…", commit.acceptedPaths.length)}
        </button>
        <button
          type="button"
          className="small"
          disabled={finishBlocked !== null}
          onClick={() => openDialog({ kind: "finishReview" })}
          title={finishBlocked === "busy" ? t("Wait until Claude's work and its collection finish") : t("Empty the review list without touching any file")}
          data-testid="Finish review"
        >
          {t("Finish review")}
        </button>
      </div>
      <GateNotices />
      <hr />
      {state.gate.collectError && (
        <div className="banner orange col" style={{ alignItems: "flex-start", gap: 4 }} data-testid="Collect error">
          <span className="bold">{t("Could not collect the turn's changes")}</span>
          <span className="mono caption" style={{ color: "var(--fg)" }}>{state.gate.collectError}</span>
          <button type="button" className="small" onClick={retryCollect} data-testid="Retry collect">{t("Retry")}</button>
        </div>
      )}
      <LiveChanges />
      <ReviewListNotices />{/* MARK: wave4b w4b-bigturn — §39.1 large files left out, "대량 변경: 파일 N개" */}
      {state.changedFiles.length > 0 && <ReviewProgress files={state.changedFiles} isViewed={isViewed} changedAfterView={changedAfterView} />}
      {/* MARK: wave3 desktop-flow — §36.13 AI 사전 리뷰: status, cancel, effort */}
      <PreReviewHead />
      <ul
        className={`list scroll ${previousRound ? "previous-round" : ""}`}
        title={previousRound ? t("From the previous round — a new review starts when this turn ends") : undefined}
        data-testid="Changed files"
      >
        <li className="section row" style={{ gap: 4 }}>
          <span className="grow">{t("Changes")}</span>
          {state.changedFiles.length > 1 && (
            <button
              type="button"
              className={`plain tiny sort-toggle ${riskFirst ? "active" : ""}`}
              aria-pressed={riskFirst}
              onClick={() => setRiskFirst(!riskFirst)}
              title={riskFirst ? t("Sorted by risk — click for the original (git) order") : t("In git order — click to put risky files first")}
              data-testid="Risk sort"
            >
              {riskFirst ? "⚑ " + t("Risky first") : "↕ " + t("Git order")}
            </button>
          )}
          {state.changedFiles.length > 1 && (
            <GroupByMenu value={groupBy} onChange={chooseGroupBy} disabledReason={bulkList ? t("A bulk change is folded by folder") : null} /> /* MARK: wave4b w4b-files */
          )}
          <RiskLegend />
        </li>
        <AuthorFilterChips offered={authorFilter.offered} value={authorFilter.value} onChange={authorFilter.setValue} />
        {state.changedFiles.length === 0 && <li className="muted">{t("No files changed in the last turn")}</li>}
        {groups.map((g) => (
          <Fragment key={g.kind}>
            {headers && <GroupHeader group={g} />}
            {/* MARK: wave4b w4b-bigturn — §39.1 a bulk list by folder, folded from the files the §39.3 author filter keeps
                (a folder counts what it opens to; one with none of them is not listed), as on the Mac */}
            <GroupedFiles by={groupBy /* MARK: wave4b w4b-files — §40.2: sections inside the group */} files={g.files.filter((f) => authorFilter.keep(f.path))} groupKey={g.kind} causeOf={(f) => causes.get(f.path) ?? ""} render={(f) => (
              <FileRow
                authors={authorFilter.authors.get(f.path)}
                key={f.path}
                f={f}
                group={g.kind}
                gate={state.gate}
                selected={selectedPath === f.path}
                viewed={isViewed(f)}
                viewState={viewStates.get(f.path) ?? "unviewed"}
                notes={noteCount(f.path)}
                sentNotes={sentCount(f.path)}
                threads={threadsOnFile(sideThreads, f.path)}
                acceptBlocked={acceptBlocked}
                rejectBlocked={rejectBlocked}
                onSelect={selectFile}
                onAccept={accept}
                onReject={reject}
              />
            )} />
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

/** §31–32: the group's name, its pending count and (outside changes) what Reject all does with them. */
function GroupHeader({ group }: { group: ChangeGroup }) {
  return (
    <>
      <li className={`section row group-head ${group.kind}`} title={groupHelp(group.kind)} data-testid={`Group ${group.kind}`}>
        <span className="grow truncate">{groupLabel(group.kind)}</span>
        <span className="group-count num" title={t("{0} pending · {1} in all", group.pending, group.files.length)} aria-label={t("{0} pending · {1} in all", group.pending, group.files.length)}>
          {group.pending}
        </span>
      </li>
      {group.kind === "external" && <li className="group-hint caption faint">{t("Reject all leaves these as they are")}</li>}
    </>
  );
}

function FileRow(props: {
  f: ChangedFileState;
  group: ChangeGroupKind;
  gate: GateState;
  selected: boolean;
  viewed: boolean;
  /** wave2 desktop-flow — §34.5: "changed" = viewed, then its content changed. */
  viewState: ViewState;
  notes: number;
  /** §34.4: notes already sent with request changes. */
  sentNotes: number;
  threads: SideThread[];
  /** §34.2: why accept / reject wait (null: they are offered). */
  acceptBlocked: string | null;
  rejectBlocked: string | null;
  onSelect: (path: string) => void;
  onAccept: (path: string) => void;
  onReject: (path: string) => void;
  /** MARK: wave4b w4b-agents — the agents whose calls changed it (agents-13). */
  authors?: FileAuthor[] | undefined;
}) {
  const { f, viewed } = props;
  // Inside the "outside changes" group the badge would only repeat the header.
  const risks = riskKinds(f).filter((k) => !(k === "external" && props.group === "external"));
  const uncaptured = f.uncaptured === true;
  const pending = f.state === "pending";
  const changedAfterView = pending && props.viewState === "changed";
  return (
    <li
      className={props.selected ? "selected" : ""}
      onClick={() => props.onSelect(f.path)}
      title={f.oldPath ? t("{0} (from {1})", f.path, f.oldPath) : f.path}
      data-testid={`File ${f.path}`}
      draggable
      onDragStart={(e) => {
        // §23: dropped on the composer, the file becomes an @-mention.
        e.dataTransfer.setData(MENTION_DRAG_TYPE, f.path);
        e.dataTransfer.setData("text/plain", f.path);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onSelect(f.path);
      }}
    >
      <div className="file-row">
        {changedAfterView ? (
          <span className="viewed-dot changed" title={t("Changed since viewed")} aria-label={t("Changed since viewed")} data-testid="Changed since viewed" />
        ) : (
          <span className={`viewed-dot ${viewed ? "on" : ""}`} title={viewed ? t("Viewed") : t("Not viewed yet")} aria-label={viewed ? t("Viewed") : t("Not viewed yet")} data-testid={viewed ? "Viewed" : "Not viewed"} />
        )}
        {/* MARK: wave4d w4d-speed — polish-10: "수정됨", not "M"; "12줄 추가, 3줄 삭제"; the review mark has a name */}
        <span className={`glyph ${statusColor(f.status)}`} aria-hidden="true">{f.status}</span>
        <span className="sr-only" data-find-skip>{statusWord(f.status)}</span>
        <div className="grow col" style={{ gap: 2 }}>
          <div className="path">
            <PathText path={compactPath(f.path) /* MARK: wave4b w4b-files — §40.2: the module kept, the title has it all */} />
            <span className="spacer" />
            <span className="tiny num green" aria-hidden="true">+{f.added}</span>
            <span className="tiny num red" aria-hidden="true">−{f.deleted}</span>
            <span className="sr-only" data-find-skip>{countsText(f.added, f.deleted)}</span>
            {props.notes > 0 && (
              <span className="tiny bold orange" title={t("{0} notes", props.notes)} aria-label={t("{0} notes", props.notes)} data-testid={`Note badge ${f.path}`}>💬{props.notes}</span>
            )}
            {props.sentNotes > 0 && (
              <span className="tiny bold faint" title={t("{0} sent note(s)", props.sentNotes)} aria-label={t("{0} sent note(s)", props.sentNotes)} data-testid={`Sent note badge ${f.path}`}>↩{props.sentNotes}</span>
            )}
            <StateIndicator state={f.state} />
          </div>
          <div className="tools">
            {f.state === "accepted" && <AutoAcceptedBadge rule={f.autoAccepted} path={f.path} />}{/* MARK: wave4c w4c-trust (§41.2) */}
            {/* MARK: wave2 desktop-flow — §34.2 / §34.4 / §34.5 */}
            {pending && f.changedSinceAccepted && (
              <span className="pill orange risk" title={t("Accepted earlier, then changed again — “Since accepted” shows what changed")} data-testid={`Changed after accept ${f.path}`}>{t("Changed after accept")}</span>
            )}
            {changedAfterView && (
              <span className="pill blue risk" title={t("The file changed after you viewed its diff")} data-testid={`Changed since viewed ${f.path}`}>{t("Changed since viewed")}</span>
            )}
            {unchangedSinceRequest(f, props.gate) && (
              <span className="pill gray risk" title={t("The follow-up to your request did not change this file")} data-testid={`Unchanged since request ${f.path}`}>{t("Unchanged since request")}</span>
            )}
            <SideBadge threads={props.threads} testId={`Side badge ${f.path}`} />
            {/* MARK: wave3 desktop-flow — §36.13 */}
            <PreReviewBadge path={f.path} />
            {f.partial && (
              <span className="pill orange risk" title={t("Some parts of this file were reverted; the rest is still under review")} data-testid={`Partial ${f.path}`}>
                ↶ {t("Partly reverted {0}", f.rejectedHunks ?? 0)}
              </span>
            )}
            {risks.map((k) => (
              <span key={k} className={`pill ${riskTone(k)} risk`} title={riskHelp(k)} data-testid={`Risk ${k}`}>{riskLabel(k)}</span>
            ))}
            {modsRisksOf(f).map((r) => (
              <span key={r} className="pill red risk" title={modsRiskHelp(r)} data-testid={`Mods risk ${r}`}>{modsRiskLabel(r)}</span>
            ))}
            {uncaptured && (
              <span className="pill orange risk" title={uncapturedText(f, props.gate)} data-testid={`Uncaptured ${f.path}`}>{t("Not captured")}</span>
            )}
            {f.ignored && (
              <span className="pill gray risk" title={t("gitignored — not committed")} data-testid={`Ignored ${f.path}`}>{t("gitignored")}</span>
            )}
            {f.tools.filter((tool) => tool !== "Bash").map((tool) => (
              <span key={tool} className="pill gray tool-pill">{tool}</span>
            ))}
            <FileAuthorChips authors={props.authors} />
          </div>
        </div>
        <AskButton anchor={{ path: f.path }} label="" className="hover icon-only" title={t("Why did {0} change? Ask a side question", f.path)} testId={`Ask file ${f.path}`} />
        {f.state === "pending" && (
          <span className="row" style={{ gap: 2 }}>
            <button
              type="button"
              className="plain small"
              title={props.acceptBlocked ?? t("Accept (⌘⇧A)")}
              aria-label={t("Accept (⌘⇧A)")}
              disabled={props.acceptBlocked !== null}
              onClick={(e) => {
                e.stopPropagation();
                props.onAccept(f.path);
              }}
            >
              ✓
            </button>
            <button
              type="button"
              className="plain small"
              title={uncaptured ? uncapturedText(f, props.gate) : (props.rejectBlocked ?? t("Reject (⌘⇧R)"))}
              aria-label={t("Reject (⌘⇧R)")}
              disabled={props.rejectBlocked !== null || uncaptured}
              onClick={(e) => {
                e.stopPropagation();
                props.onReject(f.path);
              }}
            >
              ↶
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * "3/7 viewed" with a two-layer bar: decided (accepted / rejected / changes requested) over viewed. wave2 desktop-flow
 * (§34.5): "본 뒤 바뀜 N개" — pending files whose content changed after they were viewed (they count as not viewed).
 */
function ReviewProgress({ files, isViewed, changedAfterView }: { files: ChangedFileState[]; isViewed: (f: ChangedFileState) => boolean; changedAfterView: number }) {
  const total = files.length;
  const viewed = files.filter(isViewed).length;
  const decided = files.filter((f) => f.state !== "pending").length;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  const complete = decided === total;
  return (
    <div className="review-progress" title={t("{0} of {1} files viewed · {2} decided", viewed, total, decided)} data-testid="Review progress">
      <div className="row" style={{ gap: 6 }}>
        <span className={`caption bold num ${complete ? "green" : ""}`}>{t("{0}/{1} viewed", viewed, total)}</span>
        {changedAfterView > 0 && (
          <span className="caption bold blue num" title={t("You viewed these files, then their content changed")} data-testid="Changed since viewed count">
            · {t("{0} changed since viewed", changedAfterView)}
          </span>
        )}
        <span className="spacer" />
        <span className="tiny muted num">{complete ? "✓ " + t("All decided") : t("{0} decided", decided)}</span>
      </div>
      <div className="bar" aria-hidden="true">
        <div className="viewed" style={{ width: pct(viewed) }} />
        <div className="decided" style={{ width: pct(decided) }} />
      </div>
    </div>
  );
}

/** "?" next to the sort toggle: what each risk badge means. */
function RiskLegend() {
  const [open, setOpen] = useState(false);
  return (
    <span className="menu-anchor" onMouseLeave={() => setOpen(false)}>
      <button type="button" className="plain tiny legend-btn" onClick={() => setOpen((v) => !v)} onMouseEnter={() => setOpen(true)} aria-label={t("Badge legend")} data-testid="Risk legend">?</button>
      {open && (
        <div className="menu right risk-legend" role="tooltip">
          <div className="head">{t("Badges")}</div>
          {ALL_RISKS.map((k) => (
            <div key={k} className="legend-item">
              <span className={`pill ${riskTone(k)}`}>{riskLabel(k)}</span>
              <span className="caption muted">{riskHelp(k)}</span>
            </div>
          ))}
          {MODS_LEGEND.map((r) => (
            <div key={r} className="legend-item">
              <span className="pill red">{modsRiskLabel(r)}</span>
              <span className="caption muted">{modsRiskHelp(r)}</span>
            </div>
          ))}
          <div className="legend-item">
            <span className="pill orange">{t("Not captured")}</span>
            <span className="caption muted">{t("Content not captured (large file / binary) — cannot be reverted")}</span>
          </div>
          <div className="legend-item">
            <span className="pill gray">{t("gitignored")}</span>
            <span className="caption muted">{t("gitignored — not committed")}</span>
          </div>
          <div className="legend-item">
            <span className="viewed-dot on" />
            <span className="caption muted">{t("Viewed — the diff was opened (hollow: not yet)")}</span>
          </div>
          <div className="footer">{t("Risky first puts these files at the top; ties keep git order.")}</div>
        </div>
      )}
    </span>
  );
}

/** Directory in secondary color, last path component bold. */
export function PathText({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return <span className="name truncate">{path}</span>;
  return (
    <span className="truncate">
      <span className="dir">{path.slice(0, slash + 1)}</span>
      <span className="name">{path.slice(slash + 1)}</span>
    </span>
  );
}

export function StateIndicator({ state }: { state: ChangedFileState["state"] }) {
  switch (state) {
    // MARK: wave4d w4d-speed — polish-10: a name for the screen reader, not only a tooltip
    case "pending":
      return <span className="dot" title={t("Pending review")} role="img" aria-label={stateWord(state)} />;
    case "accepted":
      return <span className="tiny bold green" title={t("Accepted")} role="img" aria-label={stateWord(state)}>✓</span>;
    case "rejected":
      return <span className="tiny bold orange" title={t("Rejected")} role="img" aria-label={stateWord(state)}>↶</span>;
    case "changesRequested":
      return <span className="tiny bold orange" title={t("Changes requested")} role="img" aria-label={stateWord(state)}>!</span>;
  }
}

export function statusColor(status: ChangeStatus): string {
  switch (status) {
    case "A":
      return "green";
    case "M":
      return "orange";
    case "D":
      return "red";
    case "R":
      return "blue";
    default:
      return "muted";
  }
}
