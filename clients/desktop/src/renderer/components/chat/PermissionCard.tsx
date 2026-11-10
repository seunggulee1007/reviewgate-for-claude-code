/**
 * Inline permission card (the Mac app's `PermissionCard`): tool name with the asking agent (§33.1 "🧩 executor · 컴파일" /
 * "메인 에이전트") and the §29 peer badge, the §33.3 reason line (the call works where this window's review does not
 * see — never "always allow" / "for the session" then), a one-line risk summary (network, deletion, outside the project,
 * git history — src/renderer/bashPattern.ts), the command (Bash) or the pretty input, and the answers: Deny, "Deny with
 * instructions…" (the text goes back to Claude as the deny `message`), Allow for session (M16 `remember`), "Always allow
 * in this project" — the client's exact `Bash(prog sub:*)` pattern, or the engine's §33.6 choices ("이 도구만 (b)", "a 서버
 * 전체", "이 도메인 (x)") — previewed before it is saved to this project's allow patterns, and Allow once.
 *
 * Several cards can wait at once (parallel subagents, §33.1): each answers its own request; the one that has waited
 * longest carries the focus ring and the shortcuts (Ctrl/⌘↩ once, Alt+Ctrl/⌘↩ session, Ctrl/⌘⌫ deny). A card whose
 * request left the queue without an answer from it (answered by the engine, withdrawn, interrupted, the turn ended)
 * turns grey: "처리됨". SendMessage has its own card (SendMessageCard).
 */
import { useEffect, useRef, useState } from "react";
import type { PermissionRequest } from "@reviewgate/engine";
import { deriveAllowPattern, permissionRisks, type PermissionRisk } from "../../bashPattern";
import { t } from "../../i18n";
import { allowPatternLabel, alwaysAllowChoices, canAllowBeyondOnce, reasonView, showsAlwaysAllow } from "../../permissionQueue";
import { onceOnlyHelp } from "../../gitNotices"; // MARK: r1-git
import { useStore } from "../../store";
import { relativeToRoot } from "../../paths";
import { toolUseIdForPermission } from "../../sideThreads";
import { AskButton } from "../side/SideAsk";
import { AgentTag, ALT, DecisionCaption, DENY_KEY, MOD, PeerTurnBadge, ReasonLine, useCardShortcuts, usePermissionCardState } from "./PermissionBits";
import { SendMessageCard } from "./SendMessageCard";
import { isEnter } from "../../ime";
import { callTitle } from "../../agentGlance"; // MARK: wave4b w4b-agents
import { canFollow, folderName, followUpText } from "../../chatMove"; // MARK: wave4b w4b-follow
import { PermissionBulkRow } from "./PermissionBulkRow"; // MARK: r2-peers (M26)
import { cardDigit } from "../../permissionKeys"; // r2-chats-cards M24
import { Menu } from "../Menu";
import { CopyButton, copyWithToast } from "../common/CopyButton";
import { PointerMenu, type AgentMenuItem } from "../agents/AgentBits";
import { useUnsavedWork } from "../../unsavedWork";
import { revealInFolderLabel } from "../../platformWords";

export function prettyInput(input: Record<string, unknown>): string {
  const command = input["command"];
  if (typeof command === "string") return command;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function riskLabel(k: PermissionRisk): string {
  switch (k) {
    case "network":
      return t("Network");
    case "deletion":
      return t("Deletes files");
    case "outside":
      return t("Outside the project");
    case "history":
      return t("Rewrites git history");
  }
}

/** MARK: r1-git — §46: "Allow once" — on a card with a reason, why it is one call at a time (the session allow does nothing there). */
function onceTitle(request: PermissionRequest, isTarget: boolean): string {
  return onceOnlyHelp(request) ?? (isTarget ? t("Allow once ({0})", `${MOD}↩`) : t("Allow once"));
}

function riskHelp(k: PermissionRisk): string {
  switch (k) {
    case "network":
      return t("Talks to the network (downloads, installs, pushes or fetches a URL)");
    case "deletion":
      return t("Removes or overwrites files (rm, git clean, a > redirection)");
    case "outside":
      return t("Touches a path outside the project folder");
    case "history":
      return t("Rewrites or drops git history (reset, rebase, amend, force push, branch -D)");
  }
}

/** `assessed` (wave2 check-clients): the check read the call (a Bash command, an edit's path); otherwise (an MCP tool, an
 * agent, …) the calm line claims nothing about network or deletion — the Mac's neutral "위험 패턴 없음". */
export function RiskLine({ risks, assessed = true }: { risks: PermissionRisk[]; assessed?: boolean }) {
  if (risks.length === 0) {
    return (
      <div className="risk-line calm" data-testid="Permission risk">
        <span className="risk-icon green" aria-hidden="true">✓</span>
        <span>{assessed ? t("No risk signals — runs inside the project, no network, deletes nothing") : t("No risky patterns found")}</span>
      </div>
    );
  }
  return (
    <div className="risk-line risky" data-testid="Permission risk">
      <span className="risk-icon" aria-hidden="true">⚠</span>
      {risks.map((k) => (
        <span key={k} className={`pill ${k === "deletion" || k === "history" ? "red" : "orange"}`} title={riskHelp(k)}>
          {riskLabel(k)}
        </span>
      ))}
      <span className="muted">{t("check before allowing")}</span>
    </div>
  );
}

export function PermissionCard({ request, decision }: { request: PermissionRequest; decision: boolean | null }) {
  // §33.2: a message to another session gets its own card — who receives it and what — with Send / Decline only.
  if (request.toolName === "SendMessage") return <SendMessageCard request={request} decision={decision} />;
  return <ToolPermissionCard request={request} decision={decision} />;
}

function ToolPermissionCard({ request, decision }: { request: PermissionRequest; decision: boolean | null }) {
  const respondPermission = useStore((s) => s.respondPermission);
  const allowAlways = useStore((s) => s.allowAlwaysInProject);
  const root = useStore((s) => s.state.project?.root ?? s.state.project?.path ?? null);
  const { status, active, isTarget, several } = usePermissionCardState(request.requestId, decision);
  const [mode, setMode] = useState<"none" | "deny" | "always">("none");
  const [instructions, setInstructions] = useState("");
  const [choice, setChoice] = useState(0);
  const denyRef = useRef<HTMLInputElement>(null);

  const command = request.toolName === "Bash" && typeof request.input["command"] === "string" ? (request.input["command"] as string) : null;
  const bashPattern = command !== null && root ? deriveAllowPattern(command) : null;
  // §33.3 / §33.6: no remembered allow and no pattern for a call outside the review (or a SendMessage).
  const beyondOnce = canAllowBeyondOnce(request);
  const choices = alwaysAllowChoices(request, bashPattern);
  // MARK: r2-skills-side — §33.6 (M21): the engine's / CLI's choices may follow the derived Bash pattern.
  const engineChoices = choices.some((c) => c !== bashPattern);
  const allowEverywhere = useStore((s) => s.allowAlwaysEverywhere);
  const picked = choices[Math.min(choice, choices.length - 1)] ?? null;
  const reason = reasonView(request.reason, request.file);
  const risks = active ? permissionRisks(request, root) : [];
  // §21 "왜 필요해?": the side question is about the tool call behind this card (its §33 tool_use id, else matched in the transcript).
  const toolUseId = useStore((s) => (active ? (request.toolUseId ?? toolUseIdForPermission(s.transcript, request)) : null));
  const relFile = request.file ? relativeToRoot(request.file, root) : null;

  const id = request.requestId;
  const once = () => respondPermission(id, true);
  const session = () => {
    if (beyondOnce) respondPermission(id, true, undefined, undefined, true);
  };
  // r2-chats-cards M25 (§33.10): no words of ours — the engine says the CLI's own "No" (Claude stops and waits).
  const deny = () => respondPermission(id, false);
  const skip = () => respondPermission(id, false, undefined, undefined, undefined, { skip: true });
  const denyStop = () => respondPermission(id, false, undefined, undefined, undefined, { interrupt: true });
  const danger = reason?.tone === "red";
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // MARK: wave4b w4b-follow — §39.4: a worktree-creating card can follow the chat into the new worktree.
  const allowAndFollow = useStore((s) => s.allowAndFollow);
  const follows = canFollow(request);
  const follow = () => allowAndFollow(id, request.reason?.path ? followUpText(folderName(request.reason.path)) : undefined);
  const denyWith = () => {
    const text = instructions.trim();
    respondPermission(id, false, text.length > 0 ? text : undefined);
  };
  // polish P4-composer-07: closing the window would lose a deny instruction being written.
  useUnsavedWork(`deny-instruction-${id}`, () => (active && instructions.trim().length > 0 ? t("A deny instruction you wrote on a permission card is not sent yet.") : null));

  useEffect(() => {
    if (mode === "deny") denyRef.current?.focus();
  }, [mode]);

  // The open card that has waited longest owns the shortcuts; never while a field owns the keys (permissionKeys.ts).
  useCardShortcuts(active && isTarget, id, beyondOnce, { once, session, deny });

  /** polish P4-composer-24: the card's right-click menu — the command, the input, the file's path and its folder. */
  const cardMenu = (): AgentMenuItem[] => [
    ...(command !== null ? [{ label: t("Copy the command"), onClick: () => void copyWithToast(command), testId: "Permission menu copy command" }] : []),
    { label: t("Copy the input (JSON)"), onClick: () => void copyWithToast(JSON.stringify(request.input, null, 2)), testId: "Permission menu copy input" },
    ...(request.file
      ? [
          { label: t("Copy Path"), onClick: () => void copyWithToast(request.file!), testId: "Permission menu copy path" },
          { label: revealInFolderLabel(window.rg.platform), onClick: () => void window.rg.showItemInFolder(request.file!), testId: "Permission menu reveal" },
        ]
      : []),
  ];
  /** polish P4-composer-24 / 27, as the Mac's `titleHelp`: the keys while it waits (the card that answers them), the tool's real name when the title reads otherwise. */
  const toolLine = callTitle(request.toolName, request.input) !== request.toolName ? t("Tool: {0}", request.toolName) : null;
  const keysLine = !active || !isTarget
    ? null
    : danger
      ? t("Click here to answer from the keyboard: ⌘↩ allow · ⌘⌫ deny · 3 deny with an instruction · esc back to the message box")
      : beyondOnce
        ? t("Click here to answer from the keyboard: 1 or ⌘↩ allow · 2 or ⌥⌘↩ for the session · ⌘⌫ deny · 3 deny with an instruction · esc back to the message box")
        : t("Click here to answer from the keyboard: 1 or ⌘↩ allow · ⌘⌫ deny · 3 deny with an instruction · esc back to the message box");
  const titleHelp = [keysLine, toolLine].filter(Boolean).join("\n") || undefined;

  const cls = ["perm", status === "decided" ? "decided" : "", status === "handled" ? "handled" : "", isTarget ? "target" : ""].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-permission-id={id}
      data-testid={status === "active" ? "Permission card" : status === "handled" ? "Permission handled" : "Permission decided"}
      role="group"
      aria-label={t("Permission: {0}", request.toolName)}
      // r2-chats-cards M24: the card itself takes the keyboard (click it, or Tab to it) — 1 / 2 / 3 as in the terminal.
      tabIndex={active ? 0 : undefined}
      onKeyDown={(e) => {
        if (!active || e.target !== e.currentTarget) return;
        if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          // As on the Mac: esc on the focused card goes back to the message box.
          e.preventDefault();
          document.querySelector<HTMLTextAreaElement>('[data-testid="Composer input"]')?.focus();
          return;
        }
        const digit = cardDigit(e, { cardFocused: true, danger, allowSession: beyondOnce, sendMessage: false });
        if (!digit) return;
        e.preventDefault();
        if (digit === "once") once();
        else if (digit === "session") session();
        else setMode("deny");
      }}
      onContextMenu={(e) => {
        // polish P4-composer-24: copy the command / input / path from the card.
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="head">
        <span className="orange" aria-hidden="true">✋</span>
        {/* polish P4-composer-24 / 27: the keys and the tool's real name on the title itself (the chips keep theirs) */}
        <span className="title truncate" title={titleHelp}>{t("Permission: {0}", callTitle(request.toolName, request.input))}</span>{/* MARK: wave4b w4b-agents — §39.3 */}
        <AgentTag request={request} />
        {active && <PeerTurnBadge />}
        {status !== "active" && <DecisionCaption status={status} decision={decision} />}
      </div>
      {active && reason && <ReasonLine view={reason} />}
      {/* wave2 check-clients: next to a reason (outside this window's review) no "all clear" line — real flags still show. */}
      {active && (!reason || risks.length > 0) && <RiskLine risks={risks} assessed={command !== null || request.file !== undefined || typeof request.input["file_path"] === "string"} />}
      {request.file && (
        <div className="file truncate" title={request.file}>{request.file}</div>
      )}
      <div className="perm-block">
        <pre className="mono">{prettyInput(request.input)}</pre>
        {/* polish P4-composer-24 */}
        <CopyButton text={prettyInput(request.input)} title={command !== null ? t("Copy the command") : t("Copy the input")} iconOnly />
      </div>
      {menuAt && <PointerMenu at={menuAt} items={cardMenu()} onClose={() => setMenuAt(null)} />}
      {active && mode === "deny" && (
        <div className="perm-inline" data-testid="Deny with instructions">
          <div className="row-line">
            <input
              ref={denyRef}
              value={instructions}
              placeholder={t("Tell Claude what to do instead…")}
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={(e) => {
                if (isEnter(e) && !e.shiftKey) {
                  e.preventDefault();
                  denyWith();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setMode("none");
                }
              }}
              aria-label={t("Tell Claude what to do instead…")}
              data-testid="Deny instructions"
            />
            <button type="button" className="danger" onClick={denyWith} data-testid="Deny and send">{t("Deny & send")}</button>
            <button type="button" className="plain" onClick={() => setMode("none")}>{t("Cancel")}</button>
          </div>
          <div className="note">{t("Claude gets this as the reason for the denial and continues from it.")}</div>
        </div>
      )}
      {active && mode === "always" && picked && (
        <div
          className="perm-inline"
          data-testid="Always allow preview"
          // polish P4-composer-27: Enter saves and allows, Esc goes back (not while a field or button of it handles the key).
          onKeyDown={(e) => {
            if (e.target instanceof HTMLInputElement && e.target.type !== "radio") return;
            if (isEnter(e) && !e.shiftKey && !(e.target instanceof HTMLButtonElement)) {
              e.preventDefault();
              void allowAlways(id, picked);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setMode("none");
            }
          }}
        >
          <div className="note">
            {engineChoices ? t("Saved to this project's allow patterns — matching calls will not ask again:") : t("Saved to this project's allow patterns — a matching single command will not ask again:")}
          </div>
          {choices.length > 1 && (
            <fieldset className="perm-choices" data-testid="Always allow choices">
              {choices.map((p, i) => (
                <label key={p}>
                  <input type="radio" name={`always-${id}`} checked={i === Math.min(choice, choices.length - 1)} onChange={() => setChoice(i)} />
                  <span>{allowPatternLabel(p)}</span>
                  {allowPatternLabel(p) !== p && <code>{p}</code>}
                </label>
              ))}
            </fieldset>
          )}
          <div className="row-line">
            <code className="pattern grow" data-testid="Always allow pattern">{picked}</code>
            <button type="button" className="primary" onClick={() => void allowAlways(id, picked)} data-testid="Save and allow">{t("Save & allow")}</button>
            {/* MARK: r2-skills-side — §33.6 (M21): or for every project (the global list) */}
            <button type="button" onClick={() => void allowEverywhere(id, picked)} title={t("Saved to the global allow patterns — matching calls in every project run without asking")} data-testid="Save for all projects">
              {t("Allow in all projects")}
            </button>
            <button type="button" className="plain" onClick={() => setMode("none")}>{t("Cancel")}</button>
          </div>
          <div className="note faint">
            {request.toolName === "Bash"
              ? t("Kept for this repository (all its worktrees). Each command of a chain must match; $(…) and a redirection into a file still ask. Edit or remove it in Settings → Permissions.")
              : t("Edit or remove it in Settings → Permissions.")}
          </div>
        </div>
      )}
      {active && (
        <div className="actions">
          {/* r2-chats-cards M25 (§33.10): Deny is the terminal's No; its menu skips the call or stops the turn too. */}
          <button type="button" className="danger" onClick={deny} title={t("Deny this call — Claude stops and waits for you, as with No in the terminal (⌘⌫ with an empty message box). The menu: skip it and continue, or stop the turn.")} data-testid="Deny">
            {t("Deny")}
            {isTarget && <kbd>{DENY_KEY}</kbd>}
          </button>
          <Menu
            label="▾"
            ariaLabel={t("More ways to deny")}
            title={t("More ways to deny")}
            className="deny-more"
            testId="Deny more"
            items={[
              { kind: "item", label: t("Skip and continue"), title: t("This call does not run; Claude goes on with the rest of the task"), onClick: skip, testId: "Deny skip and continue" },
              ...(request.agent
                ? []
                : [{ kind: "item" as const, label: t("Deny and stop"), title: t("Deny and stop the turn too, as Stop does"), onClick: denyStop, testId: "Deny and stop" }]),
            ]}
          />
          <button
            type="button"
            className="plain"
            onClick={() => setMode(mode === "deny" ? "none" : "deny")}
            aria-expanded={mode === "deny"}
            title={t("Deny and tell Claude what to do instead; the text is sent as the reason (3)")}
            data-testid="Deny with instructions button"
          >
            {t("Deny with instructions…")}
          </button>
          <AskButton
            anchor={toolUseId || relFile ? { ...(toolUseId ? { toolUseId } : {}), ...(relFile ? { path: relFile } : {}) } : null}
            label={t("Why is this needed?")}
            question={command ? t("Why do you need to run `{0}`?", command.length > 200 ? command.slice(0, 200) + "…" : command) : t("Why is this needed?")}
            context={prettyInput(request.input)}
            title={t("Ask why Claude wants this — in a side question; the card keeps waiting")}
            testId="Ask permission"
          />
          <span className="spacer" />
          {showsAlwaysAllow(request, choices) && (
            // wave3 check-clients: a Bash command without a safe pattern keeps the control, disabled with why (as the Mac).
            <button
              type="button"
              disabled={!picked}
              onClick={() => setMode(mode === "always" ? "none" : "always")}
              title={
                !picked
                  ? t("No safe pattern for this command (a chain, redirection, wrapper such as sudo / sh -c, or quoting)")
                  : engineChoices
                    ? t("Always allow in this project ▾")
                    : t("Always allow {0} in this project", picked)
              }
              aria-expanded={picked ? mode === "always" : undefined}
              data-testid="Always allow"
            >
              {engineChoices ? t("Always allow in this project ▾") : t("Always allow in this project")}
            </button>
          )}
          {beyondOnce && (
            <button
              type="button"
              onClick={session}
              title={t("Also auto-allow this tool with the same command prefix for the rest of the session") + (isTarget ? ` (${ALT}${MOD}↩)` : "")}
              data-testid="Allow for session"
            >
              {t("Allow for session")}
              {isTarget && <kbd>{ALT}{MOD}↩</kbd>}
            </button>
          )}
          {follows && (
            // MARK: wave4b w4b-follow — §39.4 "허용하고 따라가기"
            <button type="button" onClick={follow} title={t("Runs the command; once the worktree exists, this chat moves there and is reviewed there")} data-testid="Allow and follow">
              {t("Allow and Follow")}
            </button>
          )}
          {/* MARK: r1-git — §46: a card with a reason says why it is one call at a time */}
          <button type="button" className="primary" onClick={once} title={onceTitle(request, isTarget)} data-testid="Allow">
            {t("Allow once")}
            {isTarget && <kbd>{MOD}↩</kbd>}
          </button>
        </div>
      )}
      {active && mode === "none" && <PermissionBulkRow request={request} />}{/* r2-peers (M26) */}
      {isTarget && several && <div className="shortcut-hint" data-testid="Shortcut target hint">{t("Shortcuts answer this card — it has waited longest")}</div>}
    </div>
  );
}
