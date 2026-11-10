/**
 * wave1 desktop-review — the gate banners of docs/PROTOCOL.md §31–32 in the banner stack (Changes tab), each one line
 * with what happened and what to do:
 * - `gate.headMoved` (orange): the branch / commit moved during the turn → "앱 밖 변경 보기";
 * - `gate.concurrentClaude` (yellow): another Claude works in this worktree → "워크벤치 만들기" — the same sessions,
 *   re-reported on every send, never show again once closed;
 * - `gate.localSettingsChanged` (red): `.claude/settings.local.json` changed (never captured) → "파일 열기";
 * - `gate.nestedChanges` (red): changes in nested repositories, outside this review → "워크벤치로 열기" for a worktree;
 * - `gate.snapshotSkipped` (orange): unreadable files left out → "무시 패턴에 추가".
 * All but the concurrent one are cleared by the engine when the next turn starts; a closed one comes back with its next occurrence.
 */
import { useState, type ReactNode } from "react";
import type { ConcurrentClaude, NestedChange, SkippedPath } from "@reviewgate/engine";
import { t } from "../i18n";
import {
  concurrentText,
  externalPendingOf,
  headMovedText,
  isConcurrentShown,
  isGateNoticeShown,
  joinRoot,
  localSettingsHint,
  localSettingsText,
  nestedDetails,
  nestedText,
  skippedText,
  type GateNoticeKind,
} from "../reviewGate";
import { useStore } from "../store";
import "./reviewGate.css";
import { RejectUndoBanner } from "./trust/TrustViews"; // MARK: wave4c w4c-trust (§41.2)

const sep = (): string => (typeof window !== "undefined" && window.rg?.sep) || "/";
/** Stable empty lists for the selectors (a new [] per call would re-render forever). */
const NO_SESSIONS: ConcurrentClaude[] = [];
const NO_REPOS: NestedChange[] = [];
const NO_SKIPPED: SkippedPath[] = [];

function GateBanner(props: { tone: "orange" | "yellow" | "red"; testId: string; text: string; sub?: ReactNode; actions?: ReactNode; details?: ReactNode; open?: boolean; onDismiss: () => void }) {
  return (
    <div className={`banner gate-banner ${props.tone} ${props.open ? "open" : ""}`} role="status" data-testid={props.testId}>
      <div className="gate-main">
        <span className="gate-text" title={props.text}>{props.text}</span>
        {props.sub}
        {props.details}
      </div>
      <div className="gate-actions">
        {props.actions}
        <button type="button" className="plain small" onClick={props.onDismiss} title={t("Dismiss")} aria-label={t("Dismiss")} data-testid={`${props.testId} dismiss`}>
          ✕
        </button>
      </div>
    </div>
  );
}

export function GateBanners() {
  const gate = useStore((s) => s.state.gate);
  const notices = useStore((s) => s.gateNotices);
  const shown = (kind: GateNoticeKind) => isGateNoticeShown(kind, gate, notices);
  return (
    <>
      {shown("headMoved") && <HeadMovedBanner />}
      {isConcurrentShown(gate, notices) && <ConcurrentBanner />}
      {shown("localSettings") && <LocalSettingsBanner />}
      {shown("nested") && <NestedBanner />}
      {shown("skipped") && <SkippedBanner />}
      <RejectUndoBanner />{/* MARK: wave4c w4c-trust (§41.2) */}
    </>
  );
}

function HeadMovedBanner() {
  const moved = useStore((s) => s.state.gate.headMoved ?? null);
  const external = useStore((s) => externalPendingOf(s.state));
  const dismiss = useStore((s) => s.dismissGateNotice);
  const reveal = useStore((s) => s.revealExternalChanges);
  if (!moved) return null;
  return (
    <GateBanner
      tone="orange"
      testId="Head moved banner"
      text={headMovedText(moved)}
      actions={
        external > 0 && (
          <button type="button" className="small" onClick={reveal} data-testid="Show outside changes">
            {t("Show outside changes")}
          </button>
        )
      }
      onDismiss={() => dismiss("headMoved")}
    />
  );
}

function ConcurrentBanner() {
  const sessions = useStore((s) => s.state.gate.concurrentClaude ?? NO_SESSIONS);
  const dismiss = useStore((s) => s.dismissConcurrentClaude);
  const openDialog = useStore((s) => s.openDialog);
  if (sessions.length === 0) return null;
  return (
    <GateBanner
      tone="yellow"
      testId="Concurrent Claude banner"
      text={concurrentText(sessions)}
      actions={
        <button type="button" className="small" onClick={() => openDialog({ kind: "newWorkbench" })} title={t("A git worktree of this repository with its own Claude session — the other session's edits no longer mix in")} data-testid="Create workbench">
          {t("Create workbench")}
        </button>
      }
      onDismiss={dismiss}
    />
  );
}

function LocalSettingsBanner() {
  const change = useStore((s) => s.state.gate.localSettingsChanged ?? null);
  const root = useStore((s) => s.state.project?.root ?? null);
  const dismiss = useStore((s) => s.dismissGateNotice);
  const openDialog = useStore((s) => s.openDialog);
  if (!change) return null;
  const hint = localSettingsHint(change);
  return (
    <GateBanner
      tone="red"
      testId="Local settings banner"
      text={localSettingsText(change)}
      sub={hint && <span className="gate-sub" data-testid="Local settings hint">{hint}</span>}
      actions={
        <>
          {root && (
            <button type="button" className="small" onClick={() => void window.rg.openInEditor(joinRoot(root, change.path, sep()), 1)} data-testid="Open local settings">
              {t("Open file")}
            </button>
          )}
          {/* §33.5: the changed allow rules — Settings › Permissions shows which of them apply here. */}
          {hint && (
            <button type="button" className="small" onClick={() => openDialog({ kind: "settings", tab: "permissions" })} data-testid="Show terminal allow rules">
              {t("Show the terminal allow rules")}
            </button>
          )}
        </>
      }
      onDismiss={() => dismiss("localSettings")}
    />
  );
}

function NestedBanner() {
  const repos = useStore((s) => s.state.gate.nestedChanges ?? NO_REPOS);
  const root = useStore((s) => s.state.project?.root ?? null);
  const dismiss = useStore((s) => s.dismissGateNotice);
  const [open, setOpen] = useState(false);
  if (repos.length === 0) return null;
  const first = repos[0]!;
  const openWorktree = (r: NestedChange) => root && void window.rg.openWorkbenchWindow(joinRoot(root, r.path, sep()));
  const single = repos.length === 1;
  const text = single ? nestedText(first) : t("Outside the review — {0} nested repositories changed: not reviewed in this window", repos.length);
  const firstDetails = single ? nestedDetails(first) : [];
  const hasFiles = repos.some((r) => r.touchedFiles.length > 0);
  return (
    <GateBanner
      tone="red"
      testId="Nested changes banner"
      text={text}
      open={open}
      sub={firstDetails.length > 0 && <span className="gate-sub">{firstDetails.join(" · ")}</span>}
      details={
        open && (
          <ul className="gate-details" data-testid="Nested changes details">
            {repos.map((r) => (
              <li key={r.path}>
                {!single && <div>{nestedText(r)}</div>}
                {!single && nestedDetails(r).length > 0 && <div className="gate-sub">{nestedDetails(r).join(" · ")}</div>}
                {r.touchedFiles.map((p) => (
                  <div key={p} className="mono">{p}</div>
                ))}
                {!single && r.kind === "worktree" && root && (
                  <button type="button" className="small" onClick={() => openWorktree(r)} title={t("Opens that worktree in its own window, where its changes are reviewed")} data-testid={`Open nested worktree ${r.path}`}>
                    {t("Open as workbench")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )
      }
      actions={
        <>
          {single && first.kind === "worktree" && root && (
            <button type="button" className="small" onClick={() => openWorktree(first)} title={t("Opens that worktree in its own window, where its changes are reviewed")} data-testid="Open nested worktree">
              {t("Open as workbench")}
            </button>
          )}
          {(hasFiles || !single) && (
            <button type="button" className="small plain" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="Nested changes toggle">
              {open ? t("Hide files") : t("Show files")}
            </button>
          )}
        </>
      }
      onDismiss={() => dismiss("nested")}
    />
  );
}

function SkippedBanner() {
  const skipped = useStore((s) => s.state.gate.snapshotSkipped ?? NO_SKIPPED);
  const dismiss = useStore((s) => s.dismissGateNotice);
  const ignore = useStore((s) => s.ignoreSkippedFiles);
  const [busy, setBusy] = useState(false);
  if (skipped.length === 0) return null;
  return (
    <GateBanner
      tone="orange"
      testId="Snapshot skipped banner"
      text={skippedText(skipped)}
      actions={
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void ignore().finally(() => setBusy(false));
          }}
          title={t("Adds them to Settings > Ignore patterns (every project)")}
          data-testid="Ignore skipped files"
        >
          {t("Add to ignore patterns")}
        </button>
      }
      onDismiss={() => dismiss("skipped")}
    />
  );
}
