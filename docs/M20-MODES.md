# M20 — Permission modes (default / auto / plan / acceptEdits)

SDK: `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`,
`query.setPermissionMode(mode)` works mid-session; `planModeInstructions` customizes plan mode.
We expose four: **default** (ask for non-read-only tools — today's behavior), **auto** (model classifier approves/denies prompts; our PreToolUse deny rules still win), **plan** (read-only; ends with ExitPlanMode), **acceptEdits** (edit tools auto-approved; Bash etc. still asked).
`bypassPermissions`/`dontAsk` are NOT exposed (they would defeat the gate's approval flow).

## Engine
- `Settings.permissionMode?: PermissionMode` (default `"default"`), applied at session start.
- Command `set_permission_mode { mode }` → `query.setPermissionMode(mode)` live + persists in the session file; refuse while `running` (`session_busy`) except switching plan→default via plan approval.
- `state.session.permissionMode`.
- **Plan mode (verified behavior, two CLIs)**: CLI 2.1.273 has NO `ExitPlanMode` tool in SDK sessions (checked the init tool list); CLI 2.1.275 DOES (it carries `plan` + `planFilePath`, offered after the plan file is written) and it reaches `canUseTool`. In both, plan mode makes Claude work read-only and write the plan to `~/.claude/plans/<slug>.md`. Therefore:
  - While `permissionMode === "plan"`, auto-allow `Write`/`Edit` whose resolved path is under `<home>/.claude/plans/` (they are outside the repo, so the containment ask would otherwise prompt) and record them as plan files (never counted in the review or the budget).
  - **`ExitPlanMode` is handled by the engine, never by a client**: no permission card is emitted for it. The engine takes `input.plan` (cap 200 KB), emits `plan_proposed` immediately and denies the tool with "Plan received. The user approves plans in ReviewGate; stay in plan mode and wait.", so the turn ends without implementing. Allowing it would let the same turn leave plan mode and implement, bypassing the app's approval.
  - Fallback for CLIs without the tool: at `turn_end` in plan mode, if a plan file was written this turn, read it (cap 200 KB) and emit `plan_proposed { path, plan }`. Both paths dedupe within a turn (by plan-file path and plan hash), so a plan is proposed exactly once; `path` is `null` when only `ExitPlanMode` supplied it. Also expose `state.session.pendingPlan = { path, plan, at } | null`.
  - Command `plan_response { approve, mode?, message? }`:
    - approve → `setPermissionMode(mode ?? "default")`, clear `pendingPlan`, emit `plan_approved { mode, path }`, and queue a follow-up user message: `message ?? "Implement the approved plan at <path>. Work in small units and stop after each unit for review."` (or `"Implement the plan you just proposed. …"` when `path` is `null`; sent as a normal `send`, so the review gate applies).
    - reject → keep plan mode, clear `pendingPlan`, send `message ?? "Keep planning — revise the plan; do not implement yet."`.
  - If the user just types a message while a plan is pending, `pendingPlan` is cleared (the message supersedes it) — clients should say so in the card.
- Persist per-project last mode in the session file; restore on open (never restore `plan` — restoring a half-finished plan is confusing; restore as `default`? NO: restore the stored mode including plan, because the user may have deliberately parked in plan; document it).

## Clients (Mac + Electron)
- Mode selector next to the composer (segmented or dropdown): 기본 / 자동 / 계획 / 편집 자동승인, with one-line help per mode; disabled while running (tooltip). Persisted per project.
- HUD shows a mode badge when not `default`.
- **Plan card**: on `plan_proposed`, render the plan markdown in a card in the transcript with buttons: "Approve & run" (→ `plan_response{approve:true, mode:"default"}`), "Approve & auto-accept edits" (mode `acceptEdits`), "Keep planning" (reject, optional note field). Card is sticky at the bottom until answered; Esc = keep planning.
- After approval the mode selector reflects the new mode.
