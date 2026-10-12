/**
 * MARK: wave3 desktop-agents — the agent details sheet (docs/PROTOCOL.md §36.1, audit agents-02 / agents-06), opened from the
 * agent card, the chat's group head and the HUD's agent list: what the subagent was told (지시, markdown folded to 3 lines,
 * "전체 보기"), what it reported (보고서: the whole cleaned report from `agent_report` — also after the next turn and a
 * restart —, copy / 메인으로 보내기 / 곁질문으로 묻기), its tool calls (click → the call in the conversation), the files it
 * changed (click → the diff) and its usage and model. While it runs: ■ 이 에이전트 중지. An engine before §36 has no
 * `agent_report`: the sheet shows what the transcript has (the Agent call's prompt, the result's preview) without saying more.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentNode, AgentReportEvent } from "@reviewgate/engine";
import { agentViewOf, continuationCounts, reportQuote, type AgentView } from "../../agentDetails";
import { EDIT_TOOLS, agentElapsed, formatDuration, indexTranscript, useNow, type ToolResultItem, type ToolUseItem } from "../../agents";
import { fetchAgentReport, revealAgentGroup } from "../../agentUi";
import { insertIntoComposer } from "../../composerBridge";
import { t } from "../../i18n";
import { relativeToRoot } from "../../paths";
import { isRunning, useStore } from "../../store";
import { showToast } from "../../toast";
import { formatTokens } from "../chat/HUDStrip";
import { Markdown } from "../chat/Markdown";
import { AwaitingPermissionBadge } from "../chat/PermissionBits";
import { toolDetail, toolIcon } from "../chat/ToolRows";
import { Modal } from "../Menu";
import { transcriptShape } from "../../transcriptShape"; // MARK: wave4d w4d-speed
import { AgentChip, ModelChip, ResumedBadge, StopAgentButton } from "./AgentBits";

const EMPTY_AGENTS: AgentNode[] = [];
const MAX_CALLS = 300;

type ReportLoad = { state: "idle" } | { state: "loading" } | { state: "ready"; report: AgentReportEvent } | { state: "failed"; code: string; message: string };

/** Asks `agent_report` once the agent has a result (again when a continued run ends). */
function useAgentReport(view: AgentView, hasResult: boolean): ReportLoad {
  const [load, setLoad] = useState<ReportLoad>({ state: "idle" });
  const ask = !view.live && (hasResult || view.node?.reportPreview !== undefined);
  const key = `${view.toolUseId}:${view.resumeCount}:${ask}`;
  useEffect(() => {
    if (!ask) {
      setLoad({ state: "idle" });
      return;
    }
    let live = true;
    setLoad({ state: "loading" });
    void fetchAgentReport(view.toolUseId).then((r) => {
      if (!live) return;
      setLoad(r.ok ? { state: "ready", report: r.report } : { state: "failed", code: r.code, message: r.message });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return load;
}

export function AgentDetailSheet({ toolUseId, focus, onClose }: { toolUseId: string; focus?: "report" | "instructions" | undefined; onClose: () => void }) {
  // MARK: wave4d w4d-agents2 — the card menu's "보고서 보기" / "지시 보기" open the sheet at that section (as the Mac's).
  useEffect(() => {
    if (!focus) return;
    const id = requestAnimationFrame(() =>
      document.querySelector(`[data-agent-tool-use-id="${CSS.escape(toolUseId)}"] [data-testid="${focus === "report" ? "Agent sheet report" : "Agent sheet instructions"}"]`)?.scrollIntoView({ block: "start" }),
    );
    return () => cancelAnimationFrame(id);
  }, [focus, toolUseId]);
  const node = useStore((s) => (s.state.hud.agents ?? EMPTY_AGENTS).find((a) => a.toolUseId === toolUseId));
  const transcript = useStore((s) => transcriptShape(s.transcript)); // MARK: wave4d w4d-speed — tool rows only: not per delta
  const running = useStore((s) => isRunning(s.state));
  const index = useMemo(() => indexTranscript(transcript), [transcript]);
  const use = index.uses.get(toolUseId);
  const result = index.results.get(toolUseId);
  const continuations = useMemo(() => continuationCounts(transcript).get(toolUseId) ?? 0, [transcript, toolUseId]);
  const view = agentViewOf({ node, use, result, running, continuations });
  const now = useNow(view.live, 1000);
  const load = useAgentReport(view, result !== undefined);
  const report = load.state === "ready" ? load.report : null;

  const prompt = report?.prompt && report.prompt.length >= view.prompt.length ? report.prompt : view.prompt;
  const reportText = report ? report.text : view.reportPreview;
  const model = view.model ?? report?.model ?? null;
  const usage = view.usage ?? (report?.usage ? { tokens: report.usage.tokens, toolUses: report.usage.toolUses, durationMs: report.usage.durationMs } : null);
  const elapsed = node ? agentElapsed(node, now) : (usage?.durationMs ?? null);

  if (!node && !use) {
    // Another chat became current (or the rows were dropped) while the sheet was asked for.
    return (
      <Modal title={t("Agent details")} onClose={onClose} testId="Agent details sheet">
        <div className="caption muted" data-testid="Agent sheet unknown">{t("ReviewGate could not find this agent in this chat")}</div>
        <div className="actions">
          <button type="button" className="primary" autoFocus onClick={onClose}>{t("Close")}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t("Agent details")} onClose={onClose} wide testId="Agent details sheet">
      <div className="agent-sheet" data-agent-tool-use-id={toolUseId}>
        <div className="agent-sheet-head">
          <span className="agent-icon" aria-hidden="true">◆</span>
          <span className="agent-type">{view.label}</span>
          <ModelChip model={model} />
          <AgentChip status={view.status} stoppedBy={view.stoppedByUser ? "user" : undefined} />
          <ResumedBadge count={view.resumeCount} />
          {view.isBackground && <span className="pill gray" title={t("Runs in the background")}>{t("background")}</span>}
          <AwaitingPermissionBadge agentToolUseId={toolUseId} />
          <span className="spacer" />
          <StopAgentButton node={node} label />
          <button
            type="button"
            className="small"
            onClick={() => {
              onClose();
              revealAgentGroup(toolUseId);
            }}
            data-testid="Agent sheet reveal"
          >
            {t("Show in the conversation")}
          </button>
        </div>
        {view.description && <div className="agent-sheet-desc muted">{view.description}</div>}
        {view.error && <div className="agent-error">✕ {view.error}</div>}

        <Instructions text={prompt} />

        <ReportSection view={view} text={reportText} load={load} onClose={onClose} />

        <ToolCallsSection calls={(index.children.get(toolUseId) ?? []).filter((c): c is ToolUseItem => c.kind === "toolUse")} results={index.results} onClose={onClose} />

        <FilesSection view={view} calls={(index.children.get(toolUseId) ?? []).filter((c): c is ToolUseItem => c.kind === "toolUse")} onClose={onClose} />

        <section className="agent-sheet-section" data-testid="Agent sheet usage">
          <h4>{t("Usage")}</h4>
          <div className="agent-usage num">
            <span title={t("Tokens")}>▤ {usage?.tokens !== undefined ? t("{0} tokens", formatTokens(usage.tokens)) : "—"}</span>
            <span title={t("Tool calls")}>⚒ {usage?.toolUses !== undefined ? t("{0} calls", usage.toolUses) : "—"}</span>
            <span title={t("Duration")}>⏱ {elapsed !== null ? formatDuration(elapsed) : "—"}</span>
            <span title={t("Model")}>
              {t("Model")}: {model ? <ModelChip model={model} /> : <span className="muted">{t("Agent default")}</span>}
            </span>
          </div>
        </section>
      </div>
      <div className="actions">
        <button type="button" className="primary" autoFocus onClick={onClose} data-testid="Agent sheet close">{t("Close")}</button>
      </div>
    </Modal>
  );
}

/** 지시: markdown folded to 3 lines, "전체 보기" unfolds it. */
function Instructions({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || all) return;
    setOverflows(el.scrollHeight > el.clientHeight + 2);
  }, [text, all]);
  return (
    <section className="agent-sheet-section" data-testid="Agent sheet instructions">
      <div className="agent-sheet-section-head">
        <h4>{t("Instructions")}</h4>
        <span className="spacer" />
        {text && (overflows || all) && (
          <button type="button" className="plain tiny" aria-expanded={all} onClick={() => setAll(!all)} data-testid="Instructions toggle">
            {all ? t("Show fewer") : t("Show all")}
          </button>
        )}
      </div>
      {text ? (
        <div ref={box} className={`agent-sheet-prompt ${all ? "all" : "folded"} ${overflows && !all ? "overflowing" : ""}`}>
          <Markdown text={text} />
        </div>
      ) : (
        <div className="caption faint">{t("No instructions recorded")}</div>
      )}
    </section>
  );
}

/** 보고서: the whole cleaned report (or what the transcript has), copy / 메인으로 보내기 / 곁질문으로 묻기. */
function ReportSection({ view, text, load, onClose }: { view: AgentView; text: string; load: ReportLoad; onClose: () => void }) {
  const askAbout = useStore((s) => s.askAbout);
  const [copied, setCopied] = useState(false);
  // §36.3: a continued agent works again — the report of its previous run stays readable meanwhile.
  const previous = view.live && view.resumeCount > 0 && text.trim().length > 0;
  const has = text.trim().length > 0 && (!view.live || previous);
  const why = view.live ? t("The agent is still working — its report comes when it finishes") : t("No report text");
  const note =
    load.state === "loading"
      ? t("Loading the report…")
      : previous
        ? t("The report of the previous run — the agent is working again")
        : load.state === "ready" && load.report.truncated
          ? t("The report is longer than 50,000 characters — only its start was kept")
          : load.state === "failed" && load.code !== "unknown_command" && load.code !== "no_report"
            ? load.message
            : null;
  return (
    <section className="agent-sheet-section" data-testid="Agent sheet report">
      <div className="agent-sheet-section-head">
        <h4>{t("Report")}</h4>
        <span className="spacer" />
        <button
          type="button"
          className="small"
          disabled={!has}
          title={has ? t("Copy") : why}
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              (e: unknown) => showToast(e instanceof Error ? e.message : String(e)),
            )
          }
          data-testid="Agent report copy"
        >
          {copied ? t("Copied") : t("Copy")}
        </button>
        <button
          type="button"
          className="small"
          disabled={!has}
          title={has ? t("Puts the report in the message box as a quote — add what Claude should do with it") : why}
          onClick={() => {
            onClose();
            insertIntoComposer(reportQuote(view.label, view.description, text));
            showToast(t("The report is in the message box — add what Claude should do with it"));
          }}
          data-testid="Agent report to main"
        >
          {t("Send to main chat")}
        </button>
        <button
          type="button"
          className="small"
          disabled={!has}
          title={has ? t("Ask a side question about this report — the main conversation is not affected") : why}
          onClick={() => {
            onClose();
            askAbout({ toolUseId: view.toolUseId }, { question: t("What are the key points of this report, and what should I check?") });
          }}
          data-testid="Agent report ask"
        >
          {t("Ask in a side thread")}
        </button>
      </div>
      {note && <div className="caption muted" data-testid="Agent report note">{note}</div>}
      {view.live && !previous ? (
        <div className="caption faint">{t("The agent is still working — its report comes when it finishes")}</div>
      ) : text.trim().length > 0 ? (
        <div className="agent-sheet-report" data-testid="Agent report text">
          <Markdown text={text} />
        </div>
      ) : (
        <div className="caption faint">{load.state === "loading" ? "" : t("No report text")}</div>
      )}
    </section>
  );
}

/** 도구 호출: the agent's own calls (nested agents count as one call each), click → the call in the conversation. */
function ToolCallsSection({ calls, results, onClose }: { calls: ToolUseItem[]; results: Map<string, ToolResultItem>; onClose: () => void }) {
  const root = useStore((s) => s.state.project?.root ?? null);
  const revealToolUse = useStore((s) => s.revealToolUse);
  const setTab = useStore((s) => s.setTab);
  const tab = useStore((s) => s.tab);
  return (
    <section className="agent-sheet-section" data-testid="Agent sheet calls">
      <h4>
        {t("Tool calls")} <span className="faint num">{calls.length}</span>
      </h4>
      {calls.length === 0 ? (
        <div className="caption faint">{t("No tool calls")}</div>
      ) : (
        <ul className="agent-sheet-calls">
          {calls.slice(0, MAX_CALLS).map((c) => {
            const r = results.get(c.toolUseId);
            return (
              <li key={c.toolUseId}>
                <button
                  type="button"
                  className="agent-call plain"
                  onClick={() => {
                    onClose();
                    if (tab === "prs") setTab("changes");
                    revealToolUse(c.toolUseId);
                  }}
                  title={t("Show in the conversation")}
                >
                  <span className="icon" aria-hidden="true">{toolIcon(c.name)}</span>
                  <span className="name">{c.name}</span>
                  <span className="detail mono truncate">{toolDetail(c.name, c.file, c.input, root)}</span>
                  {r ? r.isError ? <span className="red tiny" aria-label={t("Tool error")}>✕</span> : <span className="green tiny" aria-label={t("Tool result")}>✓</span> : <span className="spinner" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
          {calls.length > MAX_CALLS && <li className="caption faint">+{calls.length - MAX_CALLS}</li>}
        </ul>
      )}
    </section>
  );
}

/** 파일: what its edit tools (and Bash, by the engine's snapshot) changed — the node's list, else its edit calls' files. */
function FilesSection({ view, calls, onClose }: { view: AgentView; calls: ToolUseItem[]; onClose: () => void }) {
  const root = useStore((s) => s.state.project?.root ?? null);
  const changedFiles = useStore((s) => s.state.changedFiles);
  const revealFile = useStore((s) => s.revealFile);
  const files = useMemo(() => {
    if (view.files.length > 0) return view.files;
    const out: string[] = [];
    for (const c of calls) {
      if (!EDIT_TOOLS.has(c.name) || !c.file) continue;
      const rel = relativeToRoot(c.file, root) ?? c.file;
      if (!out.includes(rel)) out.push(rel);
    }
    return out;
  }, [view.files, calls, root]);
  return (
    <section className="agent-sheet-section" data-testid="Agent sheet files">
      <h4>
        {t("Files")} <span className="faint num">{files.length}</span>
      </h4>
      {files.length === 0 ? (
        <div className="caption faint">{t("No files changed")}</div>
      ) : (
        <div className="agent-files">
          {files.map((p) => {
            const inReview = changedFiles.some((f) => f.path === p);
            return (
              <button
                key={p}
                type="button"
                className="file-link"
                disabled={!inReview}
                title={inReview ? p : t("{0} — not in the current review", p)}
                onClick={() => {
                  onClose();
                  revealFile(p);
                }}
              >
                {p}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
