/**
 * MARK: wave4c w4c-commit
 * docs/PROTOCOL.md §41.1 in Electron (as on the Mac): the commit sheet's "팀 형식: …" line — the project's template, else the
 * format learned from the recent subjects (`commit_format`) — with [형식 바꾸기], and the learned format offered in the
 * template editor ([이 형식 쓰기]). An engine without `commit_format` shows neither (as before).
 */
import { useEffect, useState } from "react";
import type { CommitFormatEvent } from "@reviewgate/engine";
import { engineRequest } from "../../engineRequest";
import { learnedSuggestion, teamFormatLine } from "../../commitFormat";
import { t } from "../../i18n";
import { useStore } from "../../store";

/** `commit_format` once per project / branch; null while it comes, on an older engine or a failure. */
export function useCommitFormat(): CommitFormatEvent | null {
  const root = useStore((s) => s.state.project?.path ?? null);
  const branch = useStore((s) => s.state.project?.branch ?? null);
  const [reply, setReply] = useState<CommitFormatEvent | null>(null);
  useEffect(() => {
    if (!root) return;
    let live = true;
    engineRequest({ type: "commit_format" })
      .then((r) => live && setReply(r))
      .catch(() => live && setReply(null));
    return () => {
      live = false;
    };
  }, [root, branch]);
  return reply;
}

/** "팀 형식: PAY-1800: {title} - {summary}" (+ "최근 커밋에서 배움") and [형식 바꾸기]. */
export function TeamFormatLine(props: { template: string; reply: CommitFormatEvent | null; onChange: () => void }) {
  const branch = useStore((s) => s.state.project?.branch ?? null);
  const line = teamFormatLine(props.template, branch, props.reply);
  if (!line) return null;
  return (
    <div className="flow-row caption" data-testid="Team format">
      <span className="muted" style={{ whiteSpace: "nowrap" }}>{t("Team format:")}</span>
      <span className="mono truncate" title={line.text}>{line.text}</span>
      {line.learned && <span className="muted" style={{ whiteSpace: "nowrap" }}>{t("(learned from recent commits)")}</span>}
      <button type="button" className="flow-link" onClick={props.onChange} data-testid="Change team format">{t("Change format")}</button>
    </div>
  );
}

/** In the template editor: the learned format and [이 형식 쓰기] (when it is not what is typed). */
export function LearnedFormatSuggestion(props: { template: string; reply: CommitFormatEvent | null; onUse: (template: string) => void; disabled?: boolean }) {
  const learned = learnedSuggestion(props.template, props.reply);
  if (!learned) return null;
  const examples = props.reply?.examples ?? [];
  return (
    <div className="flow-row caption" data-testid="Learned format">
      <span className="muted" style={{ whiteSpace: "nowrap" }}>{t("Learned from recent commits:")}</span>
      <span className="mono truncate" title={examples.join("\n")}>{learned}</span>
      <button type="button" className="flow-link" disabled={props.disabled} onClick={() => props.onUse(learned)} data-testid="Use learned format">{t("Use this format")}</button>
    </div>
  );
}
