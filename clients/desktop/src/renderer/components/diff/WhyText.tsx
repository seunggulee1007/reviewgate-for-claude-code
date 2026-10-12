/**
 * MARK: wave2 desktop-diff — one "왜" as the diff's cause section and the turn summary card show it (docs/PROTOCOL.md
 * §34.8): "Claude 보고" for the turn-end report, the call's own sentence quoted, an earlier sentence dimmed as
 * "앞선 설명: …", "원인 기록 없음" when nothing was recorded; a subagent's text carries its agent badge, and the main
 * agent's delegation sentence is its own line ("위임 이유: …").
 */
import { agentTypeLabel } from "../../agents";
import type { WhyView } from "../../fileWhy";
import { t } from "../../i18n";
import "./why.css";

/** The why's own sentence (badge + source + text); `delegation` is rendered apart by `DelegationText`. */
export function WhyText({ view }: { view: WhyView }) {
  const agent = view.agent ? agentTypeLabel(view.agent.type ?? "general-purpose") : null;
  return (
    <>
      {agent && (
        <span className="pill agent-badge why-agent" title={t("Subagent")} data-testid="Why agent">
          ◆ {agent}
        </span>
      )}
      {view.source === "reported" && (
        <span className="why-tag" title={t("Taken from Claude's report at the end of the turn")} data-testid="Why reported">
          {t("Reported by Claude")}
        </span>
      )}
      <WhySentence view={view} />
    </>
  );
}

function WhySentence({ view }: { view: WhyView }) {
  if (view.text === null) {
    return (
      <span className="why-text none" data-testid="Why none">
        {view.source === "legacy" ? t("No explanation preceded the change") : t("No recorded reason")}
      </span>
    );
  }
  if (view.source === "earlier") {
    const title = view.age !== null ? `${t("{0} calls earlier", view.age)}\n${view.text}` : view.text;
    return (
      <span className="why-text earlier" title={title} data-testid="Why earlier">
        {t("Earlier note: {0}", view.text)}
      </span>
    );
  }
  return (
    <span className="why-text" title={view.text} data-testid="Why text">
      “{view.text}”
    </span>
  );
}

/** "위임 이유: …" — the main agent's sentence before the Agent call the change ran in. */
export function DelegationText({ text }: { text: string }) {
  return (
    <span className="why-delegation" title={text} data-testid="Why delegation">
      {t("Delegated: {0}", text)}
    </span>
  );
}

/** "①" — a file's pointer to a sentence shown once at the top of the card. */
export function WhyRef({ n, title }: { n: number; title: string }) {
  return (
    <span className="why-ref" title={title} aria-label={`${t("Shared explanation")} ${n}`} data-testid={`Why ref ${n}`}>
      {n}
    </span>
  );
}
