import { randomUUID } from "node:crypto";
import { parseUnifiedDiff, type FileDiff } from "../diff/parse.js";
import type { Platform } from "../platform/index.js";
import { loginCommand, status as authStatus } from "./auth.js";
import { GHClient, GHError } from "./gh.js";
import {
  summaryId,
  type DraftComment,
  type GHAccount,
  type PRComment,
  type PRDetail,
  type PRFile,
  type PRFileMeta,
  type PRReview,
  type PRSummary,
  type ReviewEvent,
  type SubmitResult,
} from "./models.js";

/** The subset of `GHClient` the store drives; tests substitute a fake. */
export type GHClientLike = Pick<
  GHClient,
  "myOpenPRs" | "reviewRequestedPRs" | "detail" | "files" | "comments" | "reviews" | "submitReview" | "reply"
>;

export type ResolvedGH = { path: string; env: Record<string, string | undefined> };

export type PRStoreDeps = {
  /** Locates `gh` (+ the env to run it with); throws a `GHError` when it is not installed. */
  resolveGH: () => Promise<ResolvedGH>;
  /** Terminal/OS access for `openLoginInTerminal`. */
  platform: Pick<Platform, "openTerminal">;
  /** Called after every observable mutation. */
  onChange?: () => void;
  /** Test seams. */
  makeClient?: (gh: ResolvedGH, host: string) => GHClientLike;
  accountStatus?: (gh: ResolvedGH) => Promise<GHAccount[]>;
  now?: () => Date;
};

export const DEFAULT_GH_HOST = "github.com";

/**
 * PR browsing state (port of Core `PR/PRStore.swift`, minus UI framework): lists (mine / review
 * requested), the opened PR with its files and inline comments, and draft comments collected for a
 * single review submission. Every mutation ends with `onChange()`.
 */
export class PRStore {
  host: string;
  mine: PRSummary[] = [];
  reviewRequested: PRSummary[] = [];
  selectedSummary: PRSummary | null = null;
  selected: PRDetail | null = null;
  comments: PRComment[] = [];
  /** Reviews of the opened PR (`pulls/N/reviews`); loaded with detail/files/comments, refreshed after submit. */
  reviews: PRReview[] = [];
  selectedFile: PRFileMeta | null = null;
  selectedDiff: FileDiff | null = null;
  isLoading = false;
  isSubmitting = false;
  /** `gh` stderr verbatim (or a decoding error) from the last failed call; null after a success. */
  errorText: string | null = null;
  draftComments: DraftComment[] = [];
  /** `gh auth status` per known host; filled by `refreshAccounts()`. */
  accounts: GHAccount[] = [];
  /** Set after a successful `submit()`; the UI shows it as a banner. */
  lastSubmitResult: SubmitResult | null = null;
  /** Set by the engine's `pr_create`. */
  lastCreatedPR: { url: string; branch: string } | null = null;

  /** Files of the opened PR including their patches (never put on the wire as-is). */
  private allFiles: PRFile[] = [];
  private openGeneration = 0;
  private readonly deps: PRStoreDeps;

  constructor(deps: PRStoreDeps, host: string = DEFAULT_GH_HOST) {
    this.deps = deps;
    this.host = host.trim().length > 0 ? host.trim() : DEFAULT_GH_HOST;
  }

  /** `PRFile` without patches — the wire form. */
  get files(): PRFileMeta[] {
    return this.allFiles.map(stripPatch);
  }

  /** The patch of an opened PR file, or null when the file has none (binary / too large). */
  patchFor(filename: string): string | null {
    return this.allFiles.find((f) => f.filename === filename)?.patch ?? null;
  }

  // MARK: - Lists

  async refresh(): Promise<void> {
    this.isLoading = true;
    this.changed();
    try {
      const client = await this.makeClient();
      const [m, r] = await Promise.all([client.myOpenPRs(), client.reviewRequestedPRs()]);
      this.mine = m;
      this.reviewRequested = r;
      this.errorText = null;
    } catch (e) {
      this.errorText = message(e);
    } finally {
      this.isLoading = false;
      this.changed();
    }
  }

  // MARK: - One PR

  /** `summaryId`: `host/owner/repo#N` — a row of `mine` or `reviewRequested`. */
  async open(id: string): Promise<void> {
    const summary = [...this.mine, ...this.reviewRequested].find((s) => summaryId(s) === id);
    if (!summary) {
      this.errorText = `Unknown PR: ${id}`;
      this.changed();
      return;
    }
    const generation = ++this.openGeneration;
    this.selectedSummary = summary;
    this.selected = null;
    this.allFiles = [];
    this.comments = [];
    this.reviews = [];
    this.selectedFile = null;
    this.selectedDiff = null;
    this.draftComments = [];
    this.lastSubmitResult = null;
    this.isLoading = true;
    this.changed();
    try {
      const client = await this.makeClient();
      const [detail, fileList, commentList, reviewList] = await Promise.all([
        client.detail(summary.repo, summary.number),
        client.files(summary.repo, summary.number),
        client.comments(summary.repo, summary.number),
        client.reviews(summary.repo, summary.number),
      ]);
      if (generation !== this.openGeneration) return; // user moved on meanwhile
      this.selected = detail;
      this.allFiles = fileList;
      this.comments = commentList;
      this.reviews = reviewList;
      this.errorText = null;
      if (fileList.length > 0) this.selectFile(fileList[0].filename);
    } catch (e) {
      if (generation !== this.openGeneration) return;
      this.errorText = message(e);
    } finally {
      if (generation === this.openGeneration) {
        this.isLoading = false;
        this.changed();
      }
    }
  }

  close(): void {
    this.openGeneration += 1;
    this.selectedSummary = null;
    this.selected = null;
    this.allFiles = [];
    this.comments = [];
    this.reviews = [];
    this.selectedFile = null;
    this.selectedDiff = null;
    this.draftComments = [];
    this.lastSubmitResult = null;
    this.isLoading = false;
    this.changed();
  }

  selectFile(filename: string): void {
    const file = this.allFiles.find((f) => f.filename === filename);
    if (!file) return;
    this.selectedFile = stripPatch(file);
    if (file.patch === null) {
      this.selectedDiff = { oldPath: file.previousFilename ?? file.filename, newPath: file.filename, isBinary: true, hunks: [] };
    } else {
      this.selectedDiff = parseUnifiedDiff(file.patch);
    }
    this.changed();
  }

  async reloadComments(): Promise<void> {
    const summary = this.selectedSummary;
    if (!summary) return;
    try {
      const client = await this.makeClient();
      const list = await client.comments(summary.repo, summary.number);
      if (this.selectedSummary !== summary) return;
      this.comments = list;
      this.errorText = null;
    } catch (e) {
      this.errorText = message(e);
    }
    this.changed();
  }

  async reloadReviews(): Promise<void> {
    const summary = this.selectedSummary;
    if (!summary) return;
    try {
      const client = await this.makeClient();
      const list = await client.reviews(summary.repo, summary.number);
      if (this.selectedSummary !== summary) return;
      this.reviews = list;
      this.errorText = null;
    } catch (e) {
      this.errorText = message(e);
    }
    this.changed();
  }

  // MARK: - Drafts & submission

  /** Returns the draft's id (generated when the caller did not supply one). */
  addDraft(draft: Omit<DraftComment, "id" | "startLine"> & { id?: string; startLine?: number | null }): string {
    const id = draft.id ?? randomUUID();
    this.draftComments.push({
      id,
      path: draft.path,
      line: draft.line,
      side: draft.side,
      startLine: draft.startLine ?? null,
      body: draft.body,
    });
    this.changed();
    return id;
  }

  removeDraft(id: string): void {
    this.draftComments = this.draftComments.filter((d) => d.id !== id);
    this.changed();
  }

  /** Submits the collected drafts as one review; drafts are cleared on success. */
  async submit(event: ReviewEvent, body: string): Promise<void> {
    const summary = this.selectedSummary;
    const detail = this.selected;
    if (!summary || !detail) return;
    this.isSubmitting = true;
    this.changed();
    try {
      const client = await this.makeClient();
      const inlineCount = this.draftComments.length;
      const review = await client.submitReview(summary.repo, summary.number, {
        commitId: detail.headRefOid,
        event,
        body,
        comments: this.draftComments,
      });
      this.lastSubmitResult = {
        reviewURL: review.url ?? detail.url,
        inlineCount,
        event,
        submittedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      };
      this.draftComments = [];
      this.errorText = null;
      this.changed();
      await this.reloadComments();
      await this.reloadReviews();
    } catch (e) {
      this.errorText = message(e);
    } finally {
      this.isSubmitting = false;
      this.changed();
    }
  }

  /** Replies in the thread of `commentId`; replies must target the thread root (GitHub rejects a reply to a reply). */
  async reply(commentId: number, body: string): Promise<void> {
    const summary = this.selectedSummary;
    if (!summary) return;
    const comment = this.comments.find((c) => c.id === commentId);
    const target = comment?.inReplyTo ?? commentId;
    this.isSubmitting = true;
    this.changed();
    try {
      const client = await this.makeClient();
      await client.reply(summary.repo, summary.number, target, body);
      this.errorText = null;
      await this.reloadComments();
    } catch (e) {
      this.errorText = message(e);
    } finally {
      this.isSubmitting = false;
      this.changed();
    }
  }

  // MARK: - Accounts

  /** Probes every host in `hosts.yml` (concurrently, 8s each). Never throws; a missing `gh` leaves `accounts` empty and sets `errorText`. */
  async refreshAccounts(): Promise<void> {
    try {
      const gh = await this.deps.resolveGH();
      this.accounts = await (this.deps.accountStatus ?? ((r: ResolvedGH) => authStatus(r.path, r.env)))(gh);
    } catch (e) {
      this.accounts = [];
      this.errorText = message(e);
    }
    this.changed();
  }

  /** Opens a terminal running `gh auth login --hostname H --web --git-protocol https` (needs the browser + keychain). */
  async openLoginInTerminal(host: string): Promise<void> {
    const command = loginCommand(host);
    if (command === null) {
      this.errorText = `Invalid host: ${host}`;
      this.changed();
      return;
    }
    try {
      await this.deps.platform.openTerminal(command);
    } catch (e) {
      this.errorText = message(e);
      this.changed();
    }
  }

  // MARK: wave4c w4c-review — §41.3 "20줄 더 보기" in a PR's diff

  /**
   * The open PR's head commit and repository for `filename` (a file of the PR that has a new side); null when no PR is
   * open, the file is not one of its files or was removed.
   */
  headOf(filename: string): { repo: string; sha: string } | null {
    const summary = this.selectedSummary;
    const sha = this.selected?.headRefOid;
    const file = this.allFiles.find((f) => f.filename === filename);
    if (!summary || !sha || !file || file.status === "removed") return null;
    return { repo: summary.repo, sha };
  }

  /** `filename` at the PR's head commit through `gh api` (raw contents). */
  async fetchHeadContent(head: { repo: string; sha: string }, filename: string): Promise<Buffer> {
    const client = (await this.makeClient()) as GHClientLike & Partial<Pick<GHClient, "fileContent">>;
    if (typeof client.fileContent !== "function") throw new Error("file contents are not available");
    return client.fileContent(head.repo, filename, head.sha);
  }

  // MARK: - gh resolution

  private async makeClient(): Promise<GHClientLike> {
    const gh = await this.deps.resolveGH();
    return this.deps.makeClient ? this.deps.makeClient(gh, this.host) : new GHClient(gh.path, this.host, gh.env);
  }

  private changed(): void {
    this.deps.onChange?.();
  }
}

function stripPatch(f: PRFile): PRFileMeta {
  const { patch: _patch, ...meta } = f;
  return meta;
}

function message(e: unknown): string {
  if (e instanceof GHError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
