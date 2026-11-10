import { exec } from "../util/exec.js";
import type { DraftComment, PRComment, PRDetail, PRFile, PRReview, PRSummary, ReviewEvent } from "./models.js";

/**
 * Thin wrapper over the `gh` CLI (port of Core `PR/GHClient.swift`). Every call names the host
 * explicitly (`--hostname` / `--repo HOST/O/R`) so the engine never depends on `gh`'s default host,
 * and request bodies go through `--input -` (stdin) so nothing user-typed ends up in an argv.
 */
export const GH_TIMEOUT_MS = 90_000;

/** Non-zero exit from `gh`; `stderr` is what `gh` printed, verbatim. */
export class GHError extends Error {
  constructor(
    public readonly status: number,
    public readonly stderr: string,
    public readonly args: string[],
    public readonly timedOut = false,
  ) {
    super(GHError.describe(status, stderr, args, timedOut));
    this.name = "GHError";
  }

  static describe(status: number, stderr: string, args: string[], timedOut: boolean): string {
    const msg = stderr.trim();
    if (msg.length > 0) return msg;
    const command = args.join(" ");
    if (timedOut) return `gh ${command} timed out after ${GH_TIMEOUT_MS / 1000}s`;
    return `gh ${command} exited with status ${status}`;
  }
}

/** Raised when `gh` exited 0 but its output is not the JSON shape we expect. */
export class GHDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GHDecodeError";
  }
}

export type SubmitReviewInput = {
  commitId: string;
  event: ReviewEvent;
  body: string;
  comments: DraftComment[];
};

export class GHClient {
  constructor(
    public readonly ghPath: string,
    public readonly host: string,
    public readonly env: Record<string, string | undefined>,
  ) {}

  // MARK: - Lists

  myOpenPRs(): Promise<PRSummary[]> {
    return this.search("is:pr is:open author:@me");
  }

  reviewRequestedPRs(): Promise<PRSummary[]> {
    return this.search("is:pr is:open review-requested:@me");
  }

  async search(query: string): Promise<PRSummary[]> {
    const data = await this.run([
      "api", "--hostname", this.host, "-X", "GET", "search/issues",
      "--paginate", "--slurp",
      "-f", `q=${query}`, "-f", "per_page=50",
    ]);
    return decodeSearch(data, this.host).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  // MARK: - One PR

  async detail(repo: string, number: number): Promise<PRDetail> {
    const data = await this.run([
      "pr", "view", String(number), "--repo", `${this.host}/${repo}`, "--json",
      "number,title,body,author,state,url,headRefName,baseRefName,headRefOid,reviewDecision,additions,deletions,changedFiles",
    ]);
    return decodeDetail(data);
  }

  async files(repo: string, number: number): Promise<PRFile[]> {
    const data = await this.run(["api", "--hostname", this.host, "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files`]);
    return decodeFiles(data);
  }

  async comments(repo: string, number: number): Promise<PRComment[]> {
    const data = await this.run(["api", "--hostname", this.host, "--paginate", "--slurp", `repos/${repo}/pulls/${number}/comments`]);
    return decodeComments(data);
  }

  async reviews(repo: string, number: number): Promise<PRReview[]> {
    const data = await this.run(["api", "--hostname", this.host, "--paginate", "--slurp", `repos/${repo}/pulls/${number}/reviews`]);
    return decodeReviews(data);
  }

  // MARK: - Writes

  async submitReview(repo: string, number: number, input: SubmitReviewInput): Promise<PRReview> {
    const data = await this.run(
      ["api", "--hostname", this.host, "-X", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"],
      encodeReviewRequest(input),
    );
    return decodeReview(parseJSON(data));
  }

  async reply(repo: string, number: number, commentId: number, body: string): Promise<PRComment> {
    const data = await this.run(
      ["api", "--hostname", this.host, "-X", "POST", `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, "--input", "-"],
      Buffer.from(JSON.stringify({ body }), "utf8"),
    );
    return decodeComment(parseJSON(data));
  }

  // MARK: wave4c w4c-review — §41.3 "20줄 더 보기" in a PR's diff

  /** The raw bytes of `path` at commit `ref` (`repos/O/R/contents/<path>?ref=…`, raw media type). */
  async fileContent(repo: string, path: string, ref: string): Promise<Buffer> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.run(["api", "--hostname", this.host, "-H", "Accept: application/vnd.github.v3.raw", `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`]);
  }

  // MARK: - Process

  protected async run(args: string[], stdin?: Buffer): Promise<Buffer> {
    const out = await exec(this.ghPath, args, { env: this.env, stdin, timeoutMs: GH_TIMEOUT_MS });
    if (out.status !== 0) {
      throw new GHError(out.status ?? -1, out.stderr, args, out.timedOut);
    }
    return out.stdout;
  }
}

// MARK: - Request body

/** `POST pulls/N/reviews` body; `start_line`/`start_side` only when the draft spans lines. */
export function encodeReviewRequest(input: SubmitReviewInput): Buffer {
  const comments = input.comments.map((c) => {
    const o: Record<string, unknown> = { path: c.path, line: c.line, side: c.side, body: c.body };
    if (c.startLine !== null && c.startLine !== undefined) {
      o.start_line = c.startLine;
      o.start_side = c.side;
    }
    return o;
  });
  const body = { commit_id: input.commitId, event: input.event, body: input.body, comments };
  return Buffer.from(JSON.stringify(body), "utf8");
}

// MARK: - Decoding (GitHub wire shapes)

type J = Record<string, unknown>;

function parseJSON(data: Buffer | string): unknown {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new GHDecodeError(`gh output is not JSON: ${(e as Error).message}`);
  }
}

function obj(v: unknown, what: string): J {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new GHDecodeError(`${what}: expected an object`);
  return v as J;
}

function str(o: J, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new GHDecodeError(`${what}.${key}: expected a string`);
  return v;
}

function num(o: J, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== "number") throw new GHDecodeError(`${what}.${key}: expected a number`);
  return v;
}

function optStr(o: J, key: string, what: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new GHDecodeError(`${what}.${key}: expected a string`);
  return v;
}

function optNum(o: J, key: string, what: string): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number") throw new GHDecodeError(`${what}.${key}: expected a number`);
  return v;
}

function optBool(o: J, key: string, what: string): boolean | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") throw new GHDecodeError(`${what}.${key}: expected a boolean`);
  return v;
}

/** ISO-8601 as GitHub emitted it; rejected when unparsable (Swift's `.iso8601` strategy would throw too). */
function date(o: J, key: string, what: string): string {
  const s = str(o, key, what);
  if (Number.isNaN(Date.parse(s))) throw new GHDecodeError(`${what}.${key}: not an ISO-8601 date`);
  return s;
}

function optDate(o: J, key: string, what: string): string | null {
  const s = optStr(o, key, what);
  if (s === null) return null;
  if (Number.isNaN(Date.parse(s))) throw new GHDecodeError(`${what}.${key}: not an ISO-8601 date`);
  return s;
}

function login(o: J, key: string, what: string): string {
  return str(obj(o[key], `${what}.${key}`), "login", `${what}.${key}`);
}

/** `[[page1…],[page2…]]` (slurped) or `[…]` (single page / non-slurped). */
function decodePages(data: Buffer | string, what: string): unknown[] {
  const v = parseJSON(data);
  if (!Array.isArray(v)) throw new GHDecodeError(`${what}: expected an array`);
  if (v.every((p) => Array.isArray(p))) return (v as unknown[][]).flat();
  return v;
}

/**
 * `--paginate --slurp` wraps each page in an outer array: `[{total_count, items:[…]}, …]`.
 * A bare (non-slurped) object is accepted too. Items whose `repository_url` has no `/repos/O/R` are dropped.
 */
export function decodeSearch(data: Buffer | string, host: string): PRSummary[] {
  const v = parseJSON(data);
  const pages = Array.isArray(v) ? v : [v];
  const out: PRSummary[] = [];
  for (const page of pages) {
    const items = obj(page, "search page").items;
    if (!Array.isArray(items)) throw new GHDecodeError("search page.items: expected an array");
    for (const raw of items) {
      const item = obj(raw, "search item");
      const repo = repoFromURL(str(item, "repository_url", "search item"));
      if (repo === null) continue;
      out.push({
        number: num(item, "number", "search item"),
        title: str(item, "title", "search item"),
        repo,
        host,
        author: login(item, "user", "search item"),
        updatedAt: date(item, "updated_at", "search item"),
        url: str(item, "html_url", "search item"),
        isDraft: optBool(item, "draft", "search item") ?? false,
      });
    }
  }
  return out;
}

/** `https://api.github.com/repos/O/R` / `https://ghe/api/v3/repos/O/R` → `O/R`. */
function repoFromURL(repositoryURL: string): string | null {
  const i = repositoryURL.indexOf("/repos/");
  if (i < 0) return null;
  const parts = repositoryURL.slice(i + "/repos/".length).split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

export function decodeDetail(data: Buffer | string): PRDetail {
  const o = obj(parseJSON(data), "pr view");
  return {
    number: num(o, "number", "pr view"),
    title: str(o, "title", "pr view"),
    body: optStr(o, "body", "pr view") ?? "",
    author: login(o, "author", "pr view"),
    state: str(o, "state", "pr view"),
    url: str(o, "url", "pr view"),
    headRefName: str(o, "headRefName", "pr view"),
    baseRefName: str(o, "baseRefName", "pr view"),
    headRefOid: str(o, "headRefOid", "pr view"),
    reviewDecision: optStr(o, "reviewDecision", "pr view") ?? "",
    additions: num(o, "additions", "pr view"),
    deletions: num(o, "deletions", "pr view"),
    changedFiles: num(o, "changedFiles", "pr view"),
  };
}

export function decodeFiles(data: Buffer | string): PRFile[] {
  return decodePages(data, "files").map((raw) => {
    const o = obj(raw, "file");
    return {
      filename: str(o, "filename", "file"),
      previousFilename: optStr(o, "previous_filename", "file"),
      status: str(o, "status", "file"),
      additions: num(o, "additions", "file"),
      deletions: num(o, "deletions", "file"),
      patch: optStr(o, "patch", "file"),
    };
  });
}

export function decodeComments(data: Buffer | string): PRComment[] {
  return decodePages(data, "comments").map(decodeComment);
}

function decodeComment(raw: unknown): PRComment {
  const o = obj(raw, "comment");
  return {
    id: num(o, "id", "comment"),
    path: str(o, "path", "comment"),
    line: optNum(o, "line", "comment"),
    side: optStr(o, "side", "comment"),
    startLine: optNum(o, "start_line", "comment"),
    body: str(o, "body", "comment"),
    author: login(o, "user", "comment"),
    createdAt: date(o, "created_at", "comment"),
    inReplyTo: optNum(o, "in_reply_to_id", "comment"),
    diffHunk: optStr(o, "diff_hunk", "comment") ?? "",
  };
}

export function decodeReviews(data: Buffer | string): PRReview[] {
  return decodePages(data, "reviews").map(decodeReview);
}

function decodeReview(raw: unknown): PRReview {
  const o = obj(raw, "review");
  return {
    id: num(o, "id", "review"),
    author: login(o, "user", "review"),
    state: str(o, "state", "review"),
    body: optStr(o, "body", "review") ?? "",
    submittedAt: optDate(o, "submitted_at", "review"),
    url: optStr(o, "html_url", "review"),
  };
}
