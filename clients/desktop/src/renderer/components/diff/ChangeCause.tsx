/**
 * "Why did this change": under the diff header, the tool calls that touched the file this turn
 * (`ChangedFile.toolUseIds` → transcript rows) with their short input, the assistant text that preceded
 * each call (`rationale`) and the subagent that made it; clicking one scrolls the conversation to it.
 * Without any recorded call the section stays: "원인 기록 없음 — 곁질문으로 물어보기", or for a change made outside the
 * app (§31 `origin: "external"`) "앱 밖 변경 — Claude가 바꾸지 않았을 수 있음".
 * MARK: wave2 desktop-diff — §34.8 `changedFiles[].why` on top (the header line while folded): the engine's best
 * explanation with its source (Claude 보고 / the call's own sentence / dimmed "앞선 설명" / 원인 기록 없음), the subagent
 * whose text it is and the delegation sentence apart; a call whose rationale came from earlier in the turn is dimmed.
 */
import { useMemo, useState } from "react";
import type { AgentNode, ChangedFileState } from "@reviewgate/engine";
import { agentTypeLabel, isAgentTool, type ToolUseItem } from "../../agents";
import { t } from "../../i18n";
import { readBool, useStore, writeBool } from "../../store";
import { commandOfCause, isExternalChange } from "../../reviewGate";
import { TestBadge, toolIcon } from "../chat/ToolRows";
import { AskButton } from "../side/SideAsk";
import "../reviewGate.css";
// MARK: wave2 desktop-diff
import { readFileWhy, type WhyView } from "../../fileWhy";
import { DelegationText, WhyText } from "./WhyText";
import { transcriptShape } from "../../transcriptShape"; // MARK: wave4d w4d-speed

const EMPTY_AGENTS: AgentNode[] = [];
const OPEN_KEY = "rg.diff.causeOpen";

const lineCount = (v: unknown): number => (typeof v === "string" && v.length > 0 ? v.split("\n").length : 0);

/** A short description of what the call did to the file. */
function shortInput(use: ToolUseItem): string {
  const i = use.input;
  switch (use.name) {
    case "Bash":
      return typeof i["command"] === "string" ? (i["command"] as string).replace(/\s+/g, " ") : "";
    case "Edit": {
      const del = lineCount(i["old_string"]);
      const add = lineCount(i["new_string"]);
      return t("replaced {0} line(s) with {1}", del, add) + (i["replace_all"] === true ? ` · ${t("all occurrences")}` : "");
    }
    case "MultiEdit":
      return Array.isArray(i["edits"]) ? t("{0} edits", (i["edits"] as unknown[]).length) : "";
    case "Write":
      return t("wrote {0} line(s)", lineCount(i["content"]));
    case "NotebookEdit":
      return typeof i["edit_mode"] === "string" ? t("notebook cell · {0}", i["edit_mode"] as string) : t("notebook cell");
    case "Skill": // MARK: r2-skills-side (§31.1, M35): the skill it ran, as a Bash call its command
      return typeof i["skill"] === "string" ? (i["skill"] as string) : typeof i["command"] === "string" ? (i["command"] as string) : "";
    default:
      return "";
  }
}

export function ChangeCause({ file }: { file: ChangedFileState }) {
  const transcript = useStore((s) => transcriptShape(s.transcript)); // MARK: wave4d w4d-speed — tool rows only: not per delta
  const agents = useStore((s) => s.state.hud.agents ?? EMPTY_AGENTS);
  const revealToolUse = useStore((s) => s.revealToolUse);
  const [open, setOpen] = useState(() => readBool(OPEN_KEY, true));
  const ids = file.toolUseIds ?? [];
  const why = useMemo(() => readFileWhy(file.why), [file.why]); // MARK: wave2 desktop-diff

  const { uses, results } = useMemo(() => {
    const u = new Map<string, ToolUseItem>();
    const r = new Map<string, Extract<(typeof transcript)[number], { kind: "toolResult" }>>();
    for (const it of transcript) {
      if (it.kind === "toolUse") u.set(it.toolUseId, it);
      else if (it.kind === "toolResult") r.set(it.toolUseId, it);
    }
    return { uses: u, results: r };
  }, [transcript]);

  // wave1 desktop-review (§31, comp-13): no recorded cause is said, never hidden — and an outside change says so.
  const external = isExternalChange(file);
  if (ids.length === 0) {
    return (
      <div className="change-cause none" data-testid="Change cause">
        <div className={`cause-none ${external ? "external" : ""}`} data-testid={external ? "Cause external" : "Cause none"}>
          <span className="bold caption">{t("Why it changed")}</span>
          <span className="why caption truncate" title={external ? t("Not changed by a Claude tool — it may be the IDE, another session or a git pull") : t("No tool call of this conversation is recorded as having changed this file")}>
            {external ? t("Outside change — Claude may not have made it") : t("No recorded cause — ask a side question")}
          </span>
          <AskButton anchor={{ path: file.path }} title={t("Ask why {0} changed (side question)", file.path)} testId="Ask no cause" />
        </div>
        {why && why.text !== null && <CauseWhy why={why} onReveal={revealToolUse} />}
      </div>
    );
  }

  /** The subagent a call ran under: the live node, else the spawning Agent/Task row's input. */
  const agentOf = (use: ToolUseItem | undefined): { label: string; title: string } | null => {
    const parent = use?.parentToolUseId;
    if (!parent) return null;
    const node = agents.find((a) => a.toolUseId === parent);
    if (node) return { label: agentTypeLabel(node.type), title: node.description };
    const spawn = uses.get(parent);
    if (spawn && isAgentTool(spawn.name)) {
      const type = typeof spawn.input["subagent_type"] === "string" ? (spawn.input["subagent_type"] as string) : "general-purpose";
      return { label: agentTypeLabel(type), title: typeof spawn.input["description"] === "string" ? (spawn.input["description"] as string) : "" };
    }
    return { label: t("subagent"), title: "" };
  };

  const toggle = () => {
    writeBool(OPEN_KEY, !open);
    setOpen(!open);
  };

  return (
    <div className={`change-cause ${open ? "open" : ""}`} data-testid="Change cause">
      <button type="button" className="cause-head plain" onClick={toggle} aria-expanded={open}>
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="bold">{t("Why it changed")}</span>
        {!open && why && (
          <span className="cause-inline" data-testid="Cause why inline">
            <WhyText view={why} />
          </span>
        )}
        <span className="tiny muted num">{t("{0} call(s)", ids.length)}</span>
      </button>
      {open && why && <CauseWhy why={why} onReveal={revealToolUse} />}
      {open && (
        <ol className="cause-list">
          {ids.map((id, n) => {
            const use = uses.get(id);
            // MARK: r2-skills-side — §31.1 (M35): a slash command's !`command` lines changed it — its own work, no call that went missing.
            const command = use ? null : commandOfCause(id);
            if (command) {
              return (
                <li key={id} className="cause-item static" title={t("A skill's !`command` lines run while Claude Code loads it — no tool call, so the chat has no row for them")} data-testid="Cause skill command">
                  <span className="num faint tiny">{n + 1}</span>
                  <div className="col grow" style={{ gap: 2 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="cause-icon" aria-hidden="true">{toolIcon("Skill")}</span>
                      <span className="bold caption">/{command}</span>
                    </div>
                    <div className="cause-rationale none">{t("Its !`…` lines ran while the command loaded")}</div>
                  </div>
                </li>
              );
            }
            if (!use) {
              return (
                <li key={id} className="cause-item missing">
                  <span className="num faint tiny">{n + 1}</span>
                  <span className="faint caption">{t("This call is not in the loaded conversation")}</span>
                </li>
              );
            }
            const agent = agentOf(use);
            const detail = shortInput(use);
            return (
              <li key={id} className={`cause-li ${why?.toolUseId === id ? "chosen" : ""}`}>
                <button type="button" className="cause-item" onClick={() => revealToolUse(id)} title={t("Show in the conversation")} data-testid={`Cause ${use.name}`}>
                  <span className="num faint tiny">{n + 1}</span>
                  <div className="col grow" style={{ gap: 2 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="cause-icon" aria-hidden="true">{toolIcon(use.name)}</span>
                      <span className="bold caption">{use.name}</span>
                      {detail && <span className="mono caption muted truncate grow">{detail}</span>}
                      {use.name === "Bash" && <TestBadge outcome={results.get(id)?.testOutcome} />}
                      {agent && (
                        <span className="pill agent-badge" title={agent.title}>◆ {agent.label}</span>
                      )}
                    </div>
                    {use.rationale ? (
                      use.rationaleSource === "earlier" ? (
                        <div className="cause-rationale earlier" title={use.rationale}>{t("Earlier note: {0}", use.rationale)}</div>
                      ) : (
                        <div className="cause-rationale">“{use.rationale}”</div>
                      )
                    ) : (
                      <div className="cause-rationale none">{t("No explanation preceded this call")}</div>
                    )}
                  </div>
                  <span className="go" aria-hidden="true">↗</span>
                </button>
                <AskButton anchor={{ path: file.path, toolUseId: id }} className="hover cause-ask" title={t("Ask why this call changed the file (side question)")} testId={`Ask cause ${n + 1}`} />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// MARK: wave2 desktop-diff
/** The file's why (§34.8) above its calls; a click shows the call it came from. */
function CauseWhy({ why, onReveal }: { why: WhyView; onReveal: (toolUseId: string) => void }) {
  const target = why.toolUseId;
  const body = (
    <>
      <span className="line1">
        <WhyText view={why} />
      </span>
      {why.delegation && <DelegationText text={why.delegation} />}
    </>
  );
  // Only a why that came from a call links to it (a report or "no record" has nothing to show in the chat).
  if (!target) return <div className="cause-why" data-testid="Cause why">{body}</div>;
  return (
    <button type="button" className="cause-why plain" onClick={() => onReveal(target)} title={t("Show in the conversation")} data-testid="Cause why">
      {body}
    </button>
  );
}
