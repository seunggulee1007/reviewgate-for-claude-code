/**
 * An error in the transcript — live or restored by `transcript_restore` (docs/PROTOCOL.md §30), drawn the same way: the
 * sentence, "×N · last time" when the same failure repeated (merged, src/renderer/sessionErrors.ts), and the CLI's own
 * words / exit code on a second line. Notices (§30 resume, §33.4 worktree, §29 release) read as information or warnings.
 */
import { t } from "../../i18n";
import { errorSubline, errorTone, repeatLabel, type ErrorRow } from "../../sessionErrors";
import "../session.css";

const ICON = { fatal: "⊗", error: "ⓘ", warning: "⚠", info: "ⓘ" } as const;

export function ErrorNoticeRow({ item }: { item: ErrorRow }) {
  const code = item.facts?.code;
  const tone = errorTone(code, item.fatal);
  const repeat = repeatLabel(item.count, item.lastAt);
  const words = errorSubline(item.facts);
  // A blocked worktree names its folder below; information keeps the CLI's words folded.
  const sub = tone === "info" ? "" : code === "worktree_blocked" ? (item.facts?.path ?? "") : words;
  return (
    <div className={`error-row notice-${tone}`} data-testid={item.fatal ? "Fatal error" : "Error"} data-code={code ?? ""}>
      <span className="icon" aria-hidden="true">{ICON[tone]}</span>
      <span className="err-body">
        <span>
          {item.message}
          {repeat && <span className="err-repeat" title={t("Happened {0} times", item.count ?? 1)} data-testid="Error repeat">{repeat}</span>}
        </span>
        {sub && <span className="err-sub" data-testid="Error detail">{sub}</span>}
        {tone === "info" && words && (
          <details>
            <summary>{t("Details")}</summary>
            <span className="err-sub">{words}</span>
          </details>
        )}
      </span>
    </div>
  );
}
