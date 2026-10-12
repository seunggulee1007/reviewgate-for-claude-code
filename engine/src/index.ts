export * from "./util/exec.js";
export * from "./platform/index.js";
export * from "./git/exec.js";
export { GitCheckpoint, openCheckpoint, initRepository, EMPTY_TREE, type ChangedFile, type ChangeStatus, type ReviewState as FileReviewState } from "./git/checkpoint.js";
export * from "./git/branches.js";
export * from "./git/ignore.js";
export * from "./git/repo.js";
export * from "./git/worktrees.js";
export * from "./git/commit.js";
export * from "./diff/index.js";
export * from "./pr/index.js";
export * from "./protocol.js";
export * from "./errors.js";
export { ReviewEngine, ENGINE_VERSION, DEFAULT_SETTINGS, type EngineOptions } from "./engine.js";
export { buildState, type EngineSlices } from "./state.js";
export { ReviewGate, FILE_DIFF_MAX_LINES, patchHash, type CollectResult, type PendingCollect, type PreparedRequestChanges } from "./review/gate.js";
export { requestChangesMessage, makeNote, type DiffSide, type ReviewNote } from "./review/notes.js";
export { suggestCommitMessage, COMMIT_SUBJECT_MAX } from "./review/commitMessage.js";
export { acquireLock, releaseLock, readLock, isPidAlive, isForeignLiveLock, lockPath, LOCK_FILE, type LockInfo, type LockOwner, type AcquireResult } from "./review/lock.js";
export { ClaudeSession, resolveClaudeExecutable, activityDetail, type ClaudeSessionLike, type ClaudeSessionOptions, type SessionSettings, type PermissionSettings } from "./session/claude.js";
export type { SessionEvent, SessionInfoEvent, SessionLog, ToolFileEntry } from "./session/events.js";
export { BudgetState, countLines, estimateEditLines, resolveToolPath, DEFAULT_HARD_MULTIPLIER } from "./session/budget.js";
export { buildHooks, needsAsk, autoAllowReason, reviewGateReason, EDIT_TOOLS_MATCHER, READ_ONLY_TOOLS, GIT_MUTATING_RE, ASK_REASON, READ_ONLY_BASH_REASON, ALLOW_PATTERN_REASON, REMEMBERED_REASON, MAX_CALLS_AFTER_DENY, type HookContext } from "./session/hooks.js";
export { isReadOnlyCommand, isRemembered, matchesAllowPattern, rememberKey, scanCommand } from "./session/bashClass.js";
export { AsyncQueue } from "./session/queue.js";
// MARK: wave6 w6-statusline — §44.2: NDJSON lines Swift can decode (a lone surrogate half refuses the whole line)
export { wellFormed, wellFormedJson } from "./util/safeRead.js";
// MARK: wave4b w4b-files — §40.2
export { FILE_RISK_KINDS, FILE_RISK_WEIGHT, LARGE_CHANGE_LINES, fileRisks, fileRiskScore, fileRiskFields, type FileRiskKind, type FileRiskInput } from "./review/fileRisk.js";
