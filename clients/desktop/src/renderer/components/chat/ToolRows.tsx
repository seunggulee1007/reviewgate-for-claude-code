/**
 * Tool-use / tool-result / budget / error transcript rows (the Mac app's `ToolUseRow`, `ToolResultRow` and the inline labels).
 * MARK: wave2 desktop-diff — an Edit / MultiEdit / Write row carries its "+N −M" and unfolds a mini diff of what the call
 * writes (miniDiff.ts, from the call's input: visible while the turn still runs); a subagent's rationale that came from
 * earlier in the turn reads "앞선 설명: …" (§34.8 `rationaleSource`).
 */
import { useContext, useEffect, useMemo, useState } from "react";
import type { BudgetEventEvent, TestOutcome } from "@reviewgate/engine";
import { EDIT_TOOLS, filesForToolUse, type ToolResultItem, type ToolUseItem } from "../../agents";
import { t } from "../../i18n";
import { relativeToRoot } from "../../paths";
import { useStore } from "../../store";
import { Modal } from "../Menu";
import { FindContext } from "./findContext";
import { prettyInput } from "./PermissionCard";
import { AskButton, SideBadge, useToolThreads } from "../side/SideAsk";
// MARK: wave2 desktop-diff
import { miniDiffOf, type MiniDiff } from "../../miniDiff";
import { segmentParts } from "../../diffSegments";
import "./miniDiff.css";
import { reportFindingsLine } from "../../chatFollowups"; // MARK: wave4 w4-check3
import { labelDetail, ToolNameLabel } from "../agents/AgentGlanceBits"; // MARK: wave4b w4b-agents
import { backgroundWorkOn, canMoveToBackground } from "../../background"; // MARK: §52

/** Calls whose input carries the text they write. */
const MINI_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/** Tool rows that get the side-question "왜?" (calls that change something or run a command). */
const ASKABLE = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

/** Strips the project folder prefix from an absolute path (TouchedFile.relativePath). */
export function relativePath(path: string, root: string | null | undefined): string {
  return relativeToRoot(path, root) ?? path;
}

export function toolIcon(name: string): string {
  switch (name) {
    case "Read":
      return "📄";
    case "Write":
      return "✎";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "✏";
    case "Bash":
      return "⌘";
    case "Glob":
    case "Grep":
      return "🔍";
    case "Agent":
    case "Task":
      return "◆";
    case "ReportFindings": // MARK: wave4 w4-check3 (§36.13): the pre-review's own mark
      return "✦";
    case "Skill": // MARK: wave4b w4b-agents (§39.3)
      return "✦";
    default:
      if (name.startsWith("mcp__")) return "🔌"; // MARK: wave4b w4b-agents (§39.3)
      return "🔧";
  }
}

/** One-line summary of a tool call's input (file, command, pattern, or the agent's description). */
export function toolDetail(name: string, file: string | undefined, input: Record<string, unknown>, root: string | null | undefined): string {
  // MARK: wave4 w4-check3 (§36.13): the main chat's /code-review reports its findings — "3 findings · Svc.java:42, …".
  if (name === "ReportFindings") {
    const line = reportFindingsLine(input);
    if (line !== null) return line;
  }
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const detail = file ? relativePath(file, root) : str("command") || str("pattern") || str("description") || str("url") || str("query");
  return detail.replace(/\s+/g, " ");
}

export function TestBadge({ outcome }: { outcome: TestOutcome | undefined }) {
  if (!outcome) return null;
  return outcome === "pass" ? (
    <span className="pill green test-badge" title={t("Test run passed (heuristic)")} data-testid="Test pass">✓ {t("Tests passed")}</span>
  ) : (
    <span className="pill red test-badge" title={t("Test run failed (heuristic)")} data-testid="Test fail">✕ {t("Tests failed")}</span>
  );
}

export function ToolUseRow({ item, result, root, nested }: { item: ToolUseItem; result: ToolResultItem | undefined; root: string | null | undefined; nested?: boolean }) {
  const changedFiles = useStore((s) => s.state.changedFiles);
  const selectedPath = useStore((s) => s.selectedPath);
  const revealFile = useStore((s) => s.revealFile);
  const { name, input } = item;
  const detail = labelDetail(name, input) ?? toolDetail(name, item.file, input, root); // MARK: wave4b w4b-agents — §39.3
  // Chat → diff: edit tools by their file, Bash by the files its post-Bash snapshot attributed to it.
  const linkable = EDIT_TOOLS.has(name) || name === "Bash";
  const files = linkable ? filesForToolUse(changedFiles, item.toolUseId, EDIT_TOOLS.has(name) ? item.file : undefined, root) : [];
  const current = files.some((f) => f.path === selectedPath);
  const open = files.length > 0 ? () => revealFile((files.find((f) => f.path !== selectedPath) ?? files[0]!).path) : undefined;
  const title = [prettyInput(input), item.rationale ? `\n— ${item.rationale}` : "", files.length > 0 ? `\n\n${t("Click to show the diff")}` : ""].join("");
  const sideThreads = useToolThreads(item.toolUseId);
  const askable = ASKABLE.has(name);
  const askPath = files.length === 1 ? files[0]!.path : undefined;
  // MARK: wave2 desktop-diff
  const mini = useMemo(() => (MINI_TOOLS.has(name) ? miniDiffOf(name, input) : null), [name, input]);
  const [miniOpen, setMiniOpen] = useState(false);
  // MARK: §52 — "백그라운드로" on a main-thread Bash call that still runs (no result yet, our own turn, the setting on)
  const turnRunning = useStore((s) => s.state.gate.phase === "running");
  const externalTurn = useStore((s) => Boolean(s.state.session.externalTurn));
  const backgroundOn = useStore((s) => backgroundWorkOn(s.settings));
  const moveToBackground = useStore((s) => s.moveToBackground);
  const [bgNote, setBgNote] = useState<string | null>(null);
  const movable = canMoveToBackground({ name, parentToolUseId: item.parentToolUseId, hasResult: result !== undefined, turnRunning, externalTurn, enabled: backgroundOn });
  return (
    <div className={`tool-block ${nested ? "nested" : ""}`} data-tool-use-id={item.toolUseId}>
      <div
        className={`tool-row ${open ? "linked" : ""} ${current ? "current" : ""}`}
        title={title}
        onClick={open}
        role={open ? "button" : undefined}
        data-testid={`Tool ${name}`}
      >
        <span className="icon">{toolIcon(name)}</span>
        <ToolNameLabel name={name} input={input} />
        <span className="detail mono">{detail}</span>
        {mini && <MiniDiffToggle mini={mini} open={miniOpen} onToggle={() => setMiniOpen((o) => !o)} />}
        {movable && (
          <button
            type="button"
            className="small bg-move"
            title={t("Keep the command running in the background and let Claude go on (Ctrl+B)")}
            onClick={(e) => {
              e.stopPropagation();
              setBgNote(null);
              void moveToBackground(item.toolUseId).then(setBgNote);
            }}
            data-testid="Run in background"
          >
            {t("Run in background")}
          </button>
        )}
        {name === "Bash" && <TestBadge outcome={result?.testOutcome} />}
        {files.length > 0 && (name === "Bash" ? (
          <span className="file-links">
            {files.slice(0, 3).map((f) => (
              <button
                key={f.path}
                type="button"
                className={`file-link ${f.path === selectedPath ? "current" : ""}`}
                title={f.path}
                onClick={(e) => {
                  e.stopPropagation();
                  revealFile(f.path);
                }}
              >
                {f.path.split("/").pop()}
              </button>
            ))}
            {files.length > 3 && <span className="faint tiny" title={files.slice(3).map((f) => f.path).join("\n")}>+{files.length - 3}</span>}
          </span>
        ) : (
          <span className="diff-link" aria-hidden="true">{t("diff")} ↗</span>
        ))}
        <SideBadge threads={sideThreads} testId={`Side badge tool ${item.toolUseId}`} />
        {askable && (
          <AskButton
            anchor={{ toolUseId: item.toolUseId, ...(askPath ? { path: askPath } : {}) }}
            question={t("Why did you do this?")}
            context={prettyInput(input)}
            className="hover"
            title={t("Ask why Claude made this call (side question)")}
            testId={`Ask tool ${name}`}
          />
        )}
      </div>
      {mini && miniOpen && <MiniDiffBlock mini={mini} />}
      {bgNote && <div className="bg-note orange tiny" role="status" data-testid="Run in background note">{bgNote}</div>}
      {nested && item.rationale && (
        <div className="rationale" title={item.rationale}>
          {item.rationaleSource === "earlier" ? t("Earlier note: {0}", item.rationale) : item.rationale}
        </div>
      )}
    </div>
  );
}

// MARK: wave2 desktop-diff
/** "▸ +3 −1" on an edit row: unfolds the mini diff (never the row's own click, which opens the review diff). */
function MiniDiffToggle({ mini, open, onToggle }: { mini: MiniDiff; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`mini-toggle plain ${open ? "open" : ""}`}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={open ? t("Hide the lines this call writes") : t("Show the lines this call writes")}
      data-testid="Mini diff toggle"
    >
      <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span className="num green">+{mini.added}</span>
      {!mini.write && <span className="num red">−{mini.deleted}</span>}
    </button>
  );
}

/** The call's old → new lines (a Write: its first lines), changed words marked like the review diff. */
export function MiniDiffBlock({ mini }: { mini: MiniDiff }) {
  return (
    <div className="mini-diff mono" data-testid="Mini diff">
      {mini.lines.map((l, i) =>
        l.kind === "gap" ? (
          <div key={i} className="mini-gap" aria-hidden="true">⋯</div>
        ) : (
          <div key={i} className={`mini-line ${l.kind}`}>
            <span className="sign" aria-hidden="true">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
            <span className="text">
              {segmentParts(l.text, l.segments).map((p, k) => (p.changed ? <span key={k} className="seg">{p.text}</span> : p.text))}
            </span>
          </div>
        ),
      )}
      {mini.lines.length === 0 && mini.hidden === 0 && <div className="mini-more">{t("(empty)")}</div>}
      {mini.hidden > 0 && <div className="mini-more">{t("{0} more lines", mini.hidden)}</div>}
    </div>
  );
}

export function ToolResultRow({ item, toolName, label }: { item: ToolResultItem; toolName?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const { isError, preview } = item;
  // Find (Ctrl/⌘F): a result whose preview matches unfolds so the hit can be highlighted.
  const reveal = useContext(FindContext).openResults.has(item.toolUseId);
  useEffect(() => {
    if (reveal) setOpen(true);
  }, [reveal]);
  // The dialog sits outside <details>: a closed one hides everything but its summary.
  return (
    <>
    <details className="tool-result" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid={isError ? "Tool error" : "Tool result"}>
      <summary className={isError ? "error" : ""}>
        {isError ? "✕ " + (label ?? t("Tool error")) : "✓ " + (label ?? t("Tool result"))}
        {toolName === "Bash" && <TestBadge outcome={item.testOutcome} />}
        {item.truncated && (
          <button
            type="button"
            className="plain tiny full-output"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setFull(true);
            }}
            data-testid="Show full output"
          >
            {t("Show full output")}
          </button>
        )}
      </summary>
      {open && <pre className="mono">{preview.length === 0 ? t("(empty)") : preview}{item.truncated ? "\n…" : ""}</pre>}
    </details>
    {full && <OutputDialog toolUseId={item.toolUseId} preview={preview} onClose={() => setFull(false)} />}
    </>
  );
}

/** "Show full output": the engine's kept Bash output (`tool_output`), else the preview with a note. */
function OutputDialog({ toolUseId, preview, onClose }: { toolUseId: string; preview: string; onClose: () => void }) {
  const toolOutput = useStore((s) => s.toolOutput);
  const command = useStore((s) => {
    const use = s.transcript.find((i) => i.kind === "toolUse" && i.toolUseId === toolUseId);
    return use && use.kind === "toolUse" && typeof use.input["command"] === "string" ? (use.input["command"] as string) : null;
  });
  const [res, setRes] = useState<{ output: string | null; truncated: boolean; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    toolOutput(toolUseId)
      .then((r) => live && setRes({ output: r.output, truncated: r.truncated }))
      .catch((e: unknown) => live && setRes({ output: null, truncated: false, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [toolUseId, toolOutput]);
  const text = res?.output ?? preview;
  return (
    <Modal title={t("Full output")} onClose={onClose} wide testId="Full output dialog">
      {command && <div className="output-command mono truncate" title={command}>$ {command}</div>}
      {res === null ? (
        <div className="row muted caption"><span className="spinner" /> {t("Loading output…")}</div>
      ) : (
        <>
          {res.output === null && (
            <div className="banner orange caption" style={{ borderRadius: 6 }}>
              {res.error ?? t("The full output is no longer kept (older run, engine restart or evicted) — showing the preview.")}
            </div>
          )}
          <pre className="output-body mono" data-testid="Full output">{text.length === 0 ? t("(empty)") : text}</pre>
          {res.truncated && <div className="caption faint">{t("The middle of a very long output was omitted.")}</div>}
        </>
      )}
      <div className="actions">
        <button
          type="button"
          disabled={res === null}
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
        >
          {copied ? t("Copied") : t("Copy")}
        </button>
        <button type="button" className="primary" autoFocus onClick={onClose}>{t("Close")}</button>
      </div>
    </Modal>
  );
}

export function BudgetRow({ event, root }: { event: BudgetEventEvent; root: string | null | undefined }) {
  const deny = event.kind === "deny";
  const counts = t("{0}/{1} files · {2}/{3} lines", event.files, event.budget.maxFiles, event.lines, event.budget.maxLines);
  const target = event.file ? `${event.toolName} ${relativePath(event.file, root)}` : event.toolName;
  return (
    <div className={`budget-row ${deny ? "deny" : "warn"}`} data-testid={deny ? "Budget deny" : "Budget warn"}>
      <span>{deny ? "⛔" : "⚠"}</span>
      <div className="col" style={{ gap: 2 }}>
        <span className="bold">
          {deny ? t("Change limit exceeded — edit denied ({0}). Claude was told to stop and report.", counts) : t("Change limit reached: {0}", counts)}
        </span>
        <span className="target">{target}</span>
      </div>
    </div>
  );
}
