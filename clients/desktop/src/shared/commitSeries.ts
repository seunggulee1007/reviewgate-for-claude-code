/**
 * docs/PROTOCOL.md §53 "Commits in meaningful units": the wire types of `commit_hunks`, `commit_split_draft` and
 * `commit_series`. Declared here until `@reviewgate/engine` exports them (the shapes follow §53 exactly).
 */
export type CommitFileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "?" | string;
export type CommitHunk = { id: number; header: string; added: number; deleted: number; text: string };
/** `hunks: []` = the file can only go whole. */
export type CommitFile = { path: string; oldPath?: string; status: CommitFileStatus; binary: boolean; hunks: CommitHunk[] };
/** No `hunks` = the whole file. */
export type CommitPart = { path: string; hunks?: number[] };
export type CommitPlan = { message: string; parts: CommitPart[]; why?: string };
export type CommittedSeriesCommit = { sha: string; shortSha: string; message: string; files: string[] };
export type CommittedSeries = { commits: CommittedSeriesCommit[]; branch: string; pushed: boolean; partial?: boolean };

export type CommitHunksCommand = { type: "commit_hunks"; paths?: string[] };
export type CommitSplitDraftCommand = { type: "commit_split_draft"; paths?: string[] };
export type CommitSeriesCommand = { type: "commit_series"; commits: CommitPlan[]; push?: boolean };

/** The §53 commands a client sends (the renderer's allow-list in src/main/ipcGuard.ts). */
export const COMMIT_SERIES_COMMANDS = ["commit_hunks", "commit_split_draft", "commit_series"] as const;
