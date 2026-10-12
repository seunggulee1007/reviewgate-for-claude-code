/**
 * §26 "이 시점으로 되돌리기": choose 대화만 / 파일만 / 둘 다 for one user message (each disabled with the reason
 * the checkpoint gives), see how many files would be put back, confirm. Shared with the inline "수정해서 다시 보내기"
 * editor: `useRewindRun` (the `file_changed_since_review` force confirm, "먼저 리뷰를 마무리하세요" with a jump to
 * the review, the busy message) and `RewindRefusalNote`.
 */
import { useState } from "react";
import type { RewindMode } from "@reviewgate/engine";
import { t } from "../../i18n";
import { rewindAvailability, rewindModeLabel, rewindRefusalView, type RewindRefusalView } from "../../rewind";
import { useStore } from "../../store";
import type { RewindRequest } from "../../storeComposer";
import { Modal } from "../Menu";
import { ConfirmDialog } from "./ConfirmDialog";
import { isEnter } from "../../ime";

/** Runs a rewind; a `file_changed_since_review` refusal opens the force confirm, others land in `refusal`. */
export function useRewindRun(onDone: () => void) {
  const rewind = useStore((s) => s.rewind);
  const busy = useStore((s) => s.rewinding);
  const [refusal, setRefusal] = useState<RewindRefusalView | null>(null);
  const [force, setForce] = useState<{ paths: string[]; req: RewindRequest } | null>(null);
  const run = async (req: RewindRequest): Promise<boolean> => {
    setRefusal(null);
    const r = await rewind(req);
    if (r.ok) {
      setForce(null);
      onDone();
      return true;
    }
    const view = rewindRefusalView(r);
    if (view.kind === "force" && !req.force) setForce({ paths: view.paths, req });
    else {
      setForce(null);
      setRefusal(view.kind === "force" ? { kind: "error", message: r.message } : view);
    }
    return false;
  };
  const forceDialog = force ? (
    <ConfirmDialog
      title={t("Your own edits will be lost — revert anyway?")}
      message={
        <div className="col" style={{ gap: 8, alignItems: "stretch" }}>
          <div>{t("You edited these files after Claude's changes. Rewinding puts them back and discards those edits:")}</div>
          <ul className="list accept-all-list" data-testid="Force rewind files">
            {force.paths.map((p) => (
              <li key={p} className="mono">{p}</li>
            ))}
          </ul>
          <div className="caption muted">{t("Nothing has been rewound yet — Cancel keeps every file as it is.")}</div>
        </div>
      }
      confirmLabel={t("Revert anyway")}
      cancelLabel={t("Keep my edits")}
      danger
      busy={busy}
      onConfirm={() => void run({ ...force.req, force: true })}
      onCancel={() => setForce(null)}
      testId="Force rewind dialog"
    />
  ) : null;
  return { run, busy, refusal, clearRefusal: () => setRefusal(null), forceDialog };
}

export function RewindRefusalNote({ view }: { view: RewindRefusalView | null }) {
  const jump = useStore((s) => s.jumpToReview);
  if (!view || view.kind === "force") return null;
  return (
    <div className={`rewind-refusal ${view.kind}`} role="alert" data-testid="Rewind refusal">
      <span className="grow">{view.message}</span>
      {view.kind === "review" && (
        <button type="button" className="small" onClick={jump} data-testid="Jump to review">{t("Go to the review")}</button>
      )}
    </div>
  );
}

const MODES: RewindMode[] = ["conversation", "files", "both"];

export function RewindDialog({ turn, onClose }: { turn: number; onClose: () => void }) {
  const state = useStore((s) => s.state);
  const a = rewindAvailability(state, turn);
  const cp = a.checkpoint;
  const firstOk = (["both", "conversation", "files"] as RewindMode[]).find((m) => a[m].ok) ?? "both";
  const [mode, setMode] = useState<RewindMode>(firstOk);
  const { run, busy, refusal, forceDialog } = useRewindRun(onClose);
  const chosen = a[mode];
  const help = (m: RewindMode): string => {
    switch (m) {
      case "conversation":
        return t("A new chat continues from just before this message. Files stay as they are; the current chat is kept in the history as “(되돌리기 전)”.");
      case "files":
        return cp && cp.filesSince > 0
          ? t("Claude's changes to {0} file(s) from this message on are put back. The conversation goes on as it is; your own edits elsewhere are never touched.", cp.filesSince)
          : t("No file was changed by Claude from this message on — nothing would be put back.");
      case "both":
        return t("Both of the above: the files go back to just before this message and a new chat continues from there.");
    }
  };

  return (
    <>
      <Modal title={t("Rewind to this point")} onClose={busy ? undefined : onClose} testId="Rewind dialog">
        <div className="rewind-dialog">
          {cp && (
            <div className="rewind-target">
              <span className="faint tiny">{t("Turn {0}", cp.turn)}</span>
              <span className="prompt">{cp.prompt}</span>
              <span className="tiny muted">{cp.filesChanged > 0 ? t("{0} file(s) changed in this turn · {1} since", cp.filesChanged, cp.filesSince) : t("No files changed in this turn · {0} since", cp.filesSince)}</span>
            </div>
          )}
          <div className="rewind-modes" role="radiogroup" aria-label={t("What to rewind")}>
            {MODES.map((m) => {
              const av = a[m];
              return (
                <label key={m} className={`rewind-mode ${mode === m ? "on" : ""} ${av.ok ? "" : "disabled"}`} title={av.ok ? undefined : av.why} data-testid={`Rewind mode ${m}`}>
                  <input type="radio" name="rewind-mode" checked={mode === m} disabled={!av.ok || busy} onChange={() => setMode(m)} />
                  <span className="col" style={{ gap: 2, minWidth: 0 }}>
                    <span className="mode-title">
                      {rewindModeLabel(m)}
                      {m !== "conversation" && cp && <span className="pill gray">{t("{0} file(s)", cp.filesSince)}</span>}
                    </span>
                    <span className="mode-help">{av.ok ? help(m) : av.why}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {a.busy && <div className="rewind-refusal busy">{a.busy}</div>}
          <RewindRefusalNote view={refusal} />
        </div>
        <div className="actions">
          {busy && <span className="spinner" />}
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy} data-testid="Cancel">{t("Cancel")}</button>
          <button
            type="button"
            className="danger"
            autoFocus
            disabled={busy || !chosen.ok || a.busy !== null}
            title={!chosen.ok ? chosen.why : (a.busy ?? undefined)}
            onClick={() => void run({ toTurn: turn, mode })}
            data-testid="Rewind confirm"
          >
            {t("Rewind")}
          </button>
        </div>
      </Modal>
      {forceDialog}
    </>
  );
}

/** §27 "대화 압축": `/compact [focus]` as a turn. */
export function CompactDialog({ onClose }: { onClose: () => void }) {
  const compact = useStore((s) => s.compact);
  const canSend = useStore((s) => s.state.gate.canSend);
  const hud = useStore((s) => s.state.hud);
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pct = hud.contextWindow ? Math.round((hud.contextTokens / hud.contextWindow) * 100) : null;
  const tooLong = focus.length > 2000;
  const submit = async () => {
    if (busy || tooLong || !canSend) return;
    setBusy(true);
    const err = await compact(focus);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };
  return (
    <Modal title={t("Compact the conversation")} onClose={busy ? undefined : onClose} testId="Compact dialog">
      <div className="col" style={{ gap: 10, alignItems: "stretch" }}>
        <div className="message">
          {t("Claude Code summarizes the conversation so far and continues from the summary — the context gets small again and the work goes on.")}
          {pct !== null && <div className="caption muted" style={{ marginTop: 4 }}>{t("Context now: {0}% used", pct)}</div>}
        </div>
        <label className="col" style={{ gap: 4, alignItems: "stretch" }}>
          <span className="caption bold">{t("Focus (optional)")}</span>
          <textarea
            value={focus}
            autoFocus
            rows={3}
            placeholder={t("What the summary should keep, e.g. “the parser refactor and its failing tests”")}
            onChange={(e) => setFocus(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e) && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            data-testid="Compact focus"
          />
          {tooLong && <span className="caption red">{t("The focus is too long (at most 2,000 characters).")}</span>}
        </label>
        {!canSend && <div className="rewind-refusal busy">{t("Claude is working — compact once the turn has ended.")}</div>}
        {error && <div className="rewind-refusal error" role="alert">{error}</div>}
      </div>
      <div className="actions">
        {busy && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
        <button type="button" className="primary" disabled={busy || tooLong || !canSend} onClick={() => void submit()} data-testid="Compact confirm">
          {t("Compact")}
        </button>
      </div>
    </Modal>
  );
}
