/**
 * One-line status bar between the transcript and the composer (the Mac app's `HUDStrip`): model, context
 * usage with a mini progress bar, session cost, turn timing (live while running), activity text, a
 * pending-permission flag, the "N auto-allowed" chip (M16 `rememberedAllows`, with Forget) and the per-turn budget badge.
 * The model chip opens the §25 model / effort picker; the context meter turns amber at 80 % and red at 95 % (§27);
 * "⋯" holds 압축… and the picker.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentNode, HudActivity } from "@reviewgate/engine";
import { isLive } from "../../agents";
import { retryChipText } from "../../errorCodes";
import { rememberedAllowsOf } from "../../friction";
import { t } from "../../i18n";
import { isRunning, useStore } from "../../store";
import { BudgetBadge, budgetIsOn } from "./BudgetBadge";
import { HudModeChip } from "./ModeMenu"; // MARK: wave4b w4b-auto — §39.5 the mode pill is the mode menu
import { contextColor, contextLevel, currentModelOption } from "../../hudModel";
import { formatElapsed } from "../../elapsed";
import { effortLabel, HudMenu, ModelPicker } from "./HudPopovers";
import { useModelMode } from "./AutoModelBits"; // MARK: wave5 w5-model (§43.4)
import { autoModelChipHelp, autoModelChipText } from "../../autoModel";
import { StartingChip } from "./SessionChips";
import { PeerTurnBadge, PermissionHudChip } from "./PermissionBits";
import { InProgressChip } from "./InProgressChip"; // MARK: wave2 desktop-flow
import { BackgroundChip } from "./BackgroundChip"; // MARK: §52
import { AgentListButton } from "../agents/AgentBits"; // MARK: wave3 desktop-agents — §36.1 every agent → its details sheet
import { ExtensionsOffChip } from "./ExtensionsChips"; // MARK: wave3 desktop-session
import { UsageLimitChip } from "./LongWorkChips"; // MARK: wave4 w4-longwork
import { DiskSpaceChip } from "../StorageNotices"; // MARK: wave4b w4b-bigturn
import { agentsHudLine, toolTitle } from "../../agentGlance"; // MARK: wave4b w4b-agents
import { HudCostButton } from "./CostPopover"; // MARK: wave4d w4d-agents2 (§42.4)

/** `950` → `950`, `12_345` → `12.3k`, `1_000_000` → `1M`, `1_500_000` → `1.5M`. */
export function formatTokens(n: number): string {
  const trim = (v: number) => {
    const s = v.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (n >= 1_000_000) return trim(n / 1_000_000) + "M";
  if (n >= 1_000) return trim(n / 1_000) + "k";
  return String(n);
}

export function formatUSD(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function formatSeconds(s: number): string {
  return formatElapsed(s, { tenths: true }); // wave4 w4-input (polish-14): "3분 20초" in Korean
}

export { contextColor, contextLevel } from "../../hudModel";

/** Folds `hud.activity` into the localized one-liner the Mac app shows (AppState.localizedActivity). */
export function activityText(a: HudActivity, running: boolean, agents?: readonly AgentNode[]): string {
  switch (a.kind) {
    case "idle":
      return running ? t("Working…") : t("Idle");
    case "working":
      return t("Claude is working…");
    case "thinking":
      return t("Thinking…");
    case "tool": {
      const tool = a.toolName ? toolTitle(a.toolName) : "?"; // MARK: wave4b w4b-agents — §39.3: "github · get issue", "스킬"
      return a.detail ? t("Running {0}: {1}", tool, a.detail) : t("Running {0}", tool);
    }
    case "subagent":
      // MARK: wave4b w4b-agents — §39.3: "서브에이전트 3개 실행 중 — executor: Edit CartService.java"
      return (agents ? agentsHudLine(agents) : null) ?? (a.detail ? t("Subagent working: {0}", a.detail) : t("Subagent working"));
  }
}

/** Re-renders every second while `since` is set so the turn timer ticks. */
function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? 0 : Math.max(0, (now - since) / 1000);
}

const NO_AGENTS: AgentNode[] = [];

/** "N agents running" (or the finished count) — toggles the agent activity panel (⌥⌘A). */
function AgentsChip() {
  const agents = useStore((s) => s.state.hud.agents ?? NO_AGENTS);
  const open = useStore((s) => s.agentPanelOpen);
  const toggle = useStore((s) => s.toggleAgentPanel);
  if (agents.length === 0 && !open) return null;
  const live = agents.filter((a) => isLive(a.status)).length;
  const label = live > 0 ? t("{0} agent(s) running", live) : agents.length > 0 ? t("{0} agent(s)", agents.length) : t("Agents");
  return (
    <button
      type="button"
      className={`agent-chip agents-chip ${live > 0 ? "blue live" : "gray"}`}
      onClick={() => toggle()}
      title={open ? t("Hide agent activity (⌥⌘A)") : t("Show agent activity (⌥⌘A)")}
      aria-pressed={open}
      data-testid="HUD agents"
    >
      <span className="pulse" aria-hidden="true" />
      {label}
    </button>
  );
}

/** §21: "곁질문 $0.03" — side questions cost apart from the session; toggles the side panel (⌥⌘/ asks about the selection). */
function SideChip() {
  const open = useStore((s) => s.sidePanelOpen);
  const toggle = useStore((s) => s.toggleSidePanel);
  const hudCost = useStore((s) => s.state.hud.sideCostUSD);
  const threads = useStore((s) => s.side.threads);
  const hasProject = useStore((s) => s.state.project !== null);
  if (!hasProject) return null;
  const list = Object.values(threads);
  const running = list.filter((th) => th.status === "running").length;
  const cost = hudCost ?? list.reduce((n, th) => n + (th.costUSD || 0), 0);
  return (
    <button
      type="button"
      className="side-chip-hud"
      aria-pressed={open}
      onClick={() => toggle()}
      title={t("Side questions: {0} thread(s), {1} — not part of the session cost", list.length, `$${cost.toFixed(4)}`)}
      data-testid="HUD side"
    >
      {running > 0 ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">?</span>}
      {cost > 0 ? t("Side {0}", formatUSD(cost)) : list.length > 0 ? t("Side {0}", list.length) : t("Side questions")}
    </button>
  );
}

/** §19.6 `api_retrying`: "재시도 중 (2/10)…" while the CLI retries an API call by itself. */
function RetryChip() {
  const retrying = useStore((s) => s.retrying);
  if (!retrying) return null;
  const why = typeof retrying.status === "number" ? `HTTP ${retrying.status}` : t("no response");
  const wait = retrying.retryDelayMs !== undefined ? t("next try in {0} s", (retrying.retryDelayMs / 1000).toFixed(1)) : "";
  return (
    <span className="pill orange retry-chip" title={[why, wait, retrying.message].filter(Boolean).join(" · ")} data-testid="HUD retrying">
      <span className="spinner" style={{ width: 9, height: 9, marginRight: 4, verticalAlign: -1 }} aria-hidden="true" />
      {retryChipText(retrying.attempt, retrying.maxRetries)}
    </span>
  );
}

/** The model chip: the chosen model's name (and effort), opening the picker. */
function ModelChip({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const session = useStore((s) => s.state.session);
  const hasProject = useStore((s) => s.state.project !== null);
  const option = currentModelOption(session.availableModels ?? [], session.selectedModel, session.model);
  const { auto, policy } = useModelMode(); // MARK: wave5 w5-model — §43.4: "자동 · sonnet", the reason on hover
  const label = auto ? autoModelChipText(session.autoModel ?? null) : option?.displayName ?? session.model ?? (session.selectedModel ?? null);
  if (!label && !hasProject) return null;
  const effort = session.effort ?? null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`model-btn ${open ? "open" : ""}`}
        disabled={!hasProject}
        onClick={() => setOpen(!open)}
        title={auto ? autoModelChipHelp(session.autoModel ?? null, policy) : `${session.model ?? t("Model default")}${effort ? ` · ${effortLabel(effort)}` : ""} — ${t("Change the model or effort")}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="HUD model"
      >
        <span className="truncate">{label ?? t("Model default")}</span>
        {effort && <span className="effort-tag">{effortLabel(effort)}</span>}
        <span className="chev" aria-hidden="true">▾</span>
      </button>
      {open && <ModelPicker anchor={ref.current} onClose={() => setOpen(false)} />}
    </>
  );
}

export function HUDStrip() {
  const state = useStore((s) => s.state);
  const [pickerOpen, setPickerOpen] = useState(false);
  const hud = state.hud;
  const running = isRunning(state);
  const remembered = rememberedAllowsOf(state);
  const forgetAllows = useStore((s) => s.forgetAllows);
  const liveSince = running ? hud.turnStartedAt : null;
  const elapsed = useElapsedSeconds(liveSince);

  const ctxWindow = hud.contextWindow;
  const fraction = ctxWindow && ctxWindow > 0 ? Math.min(hud.contextTokens / ctxWindow, 1) : null;
  const contextHelp = ctxWindow ? t("Context: {0} of {1} tokens", hud.contextTokens, ctxWindow) : t("Context: {0} tokens (window unknown)", hud.contextTokens);
  const activity = activityText(hud.activity, running, hud.agents); // MARK: wave4b w4b-agents

  return (
    <div className="hud" data-testid="HUD">
      <ModelChip open={pickerOpen} setOpen={setPickerOpen} />
      <span className={`item ctx-${fraction !== null ? contextLevel(fraction) : "ok"}`} title={contextHelp} data-testid="HUD context">
        <span className="faint">▤</span>
        {fraction !== null && ctxWindow ? (
          <>
            <span className="num">{formatTokens(hud.contextTokens)} / {formatTokens(ctxWindow)} ({Math.round(fraction * 100)}%)</span>
            <span className="progress" aria-hidden="true">
              <div style={{ width: `${Math.round(fraction * 100)}%`, background: contextColor(fraction) }} />
            </span>
          </>
        ) : (
          <span className="num">{t("{0} tokens", formatTokens(hud.contextTokens))}</span>
        )}
      </span>
      {/* Right after the meter: the HUD clips its overflow at narrow widths, the menu must stay reachable. */}
      <HudMenu onModel={() => setPickerOpen(true)} />
      <span className="sep">·</span>
      <HudCostButton />{/* MARK: wave4d w4d-agents2 — §42.4: the cost opens the split by model (was a plain text) */}
      <SideChip />
      <span className="sep">·</span>
      {liveSince !== null ? (
        <span className="item num" title={t("Turn {0} running for {1} s", hud.turnCount + 1, Math.floor(elapsed))} data-testid="HUD turn">
          {t("turn {0} · {1}", hud.turnCount + 1, formatSeconds(elapsed))}
        </span>
      ) : (
        <span className="item num" title={t("{0} turns; last turn took {1} ms", hud.turnCount, hud.lastTurnMs)} data-testid="HUD turn">
          {t("turn {0} · {1}", hud.turnCount, formatSeconds(hud.lastTurnMs / 1000))}
        </span>
      )}
      <span className="sep">·</span>
      <span className={`activity ${running ? "live" : ""}`} title={activity} data-testid="HUD activity">
        {running && <span className="spinner" style={{ width: 10, height: 10, marginRight: 5, verticalAlign: -1 }} />}
        {activity}
      </span>
      <span className="spacer" />
      {/* wave2 desktop-flow — §34.6: "진행 중: 파일 N개 · +A −D", opens the Changes tab's 진행 중 변경 */}
      <InProgressChip />
      {/* §52: "백그라운드 N" — the commands Claude runs in the background, with their output and [중지] */}
      <BackgroundChip />
      <StartingChip />
      {/* wave3 desktop-session — §36.7: "확장 꺼짐" after the init-timeout fallback, with "확장 켜고 다시 시도" */}
      <ExtensionsOffChip />
      {/* wave4 w4-longwork — §38.2: "사용량 한도 — 오후 3:00에 풀려요" (click: 풀리면 이어서 하기) / "5시간 72% · 주간 41%" */}
      <UsageLimitChip />
      {/* MARK: wave4b w4b-bigturn — §39.1: "디스크 여유 1.2 GB" below 2 GB free */}
      <DiskSpaceChip />
      <RetryChip />
      <AgentsChip />
      <AgentListButton />
      <HudModeChip />
      {/* wave1 desktop-perms: §29 peer turn senders, §33.1 "권한 요청 n개 대기" (jumps to the card that has waited longest) */}
      <PeerTurnBadge />
      <PermissionHudChip />
      {remembered.length > 0 && (
        <span className="pill gray remembered" title={remembered.join("\n")} data-testid="HUD auto-allowed">
          <span className="truncate">{t("{0} auto-allowed", remembered.length)}</span>
          <button type="button" className="plain tiny" onClick={forgetAllows} title={t("Forget session allows")} aria-label={t("Forget session allows")} data-testid="Forget allows">✕</button>
        </span>
      )}
      {budgetIsOn(state.budget) && <BudgetBadge usage={state.budgetUsage} budget={state.budget} />}
    </div>
  );
}
