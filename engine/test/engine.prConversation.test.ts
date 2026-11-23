import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeFakeExe, type FakeExe } from "./helpers/fakeGh.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/** docs/PROTOCOL.md §60: the PR's Conversation tab (issue comments), through a fake `gh` that keeps the comments in a file. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
const fakes: FakeExe[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const f of fakes.splice(0)) f.restore();
  for (const d of dirs.splice(0)) removeDir(d);
});

const comment = (id: number, login: string, body: string, at: string) => ({
  id,
  user: { login },
  body,
  created_at: at,
  updated_at: at,
  html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${id}`,
  author_association: "MEMBER",
});

/**
 * A fake `gh` for one PR (acme/widgets#7): every call is appended to `calls.jsonl` ({args, input}); the conversation lives in
 * `conversation.json` and is served two comments per slurped page; a POST appends to it (refused while `fail` exists).
 */
function fakeGh(dir: string): FakeExe {
  const js = `
const dir = ${JSON.stringify(dir)};
if (args[0] === "--version") { fs.writeSync(1, "gh version 2.0.0 (fake)\\n"); process.exit(0); }
const input = args.includes("--input") ? fs.readFileSync(0, "utf8") : null;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, input }) + "\\n");
const convFile = path.join(dir, "conversation.json");
const conv = fs.existsSync(convFile) ? JSON.parse(fs.readFileSync(convFile, "utf8")) : [];
const endpoint = args.find((a) => a.startsWith("repos/") || a === "search/issues");
const out = (v) => fs.writeSync(1, JSON.stringify(v));
if (args[0] === "pr" && args[1] === "view") {
  out({ number: 7, title: "Cart fix", body: "Fixes the cart total.", author: { login: "alice" }, state: "OPEN",
    url: "https://github.com/acme/widgets/pull/7", headRefName: "fix/cart", baseRefName: "main",
    headRefOid: "0123456789abcdef0123456789abcdef01234567", reviewDecision: "", additions: 1, deletions: 0, changedFiles: 0 });
} else if (endpoint === "search/issues") {
  out([{ total_count: 1, items: [{ number: 7, title: "Cart fix", repository_url: "https://api.github.com/repos/acme/widgets",
    user: { login: "alice" }, updated_at: "2026-01-02T03:04:05Z", html_url: "https://github.com/acme/widgets/pull/7" }] }]);
} else if (endpoint === "repos/acme/widgets/issues/7/comments" && args.includes("POST")) {
  if (fs.existsSync(path.join(dir, "fail"))) {
    fs.writeSync(2, "HTTP 403: Resource not accessible by integration\\n(https://api.github.com/repos/acme/widgets/issues/7/comments)\\n");
    process.exit(1);
  }
  const id = 4000 + conv.length;
  const c = { id, user: { login: "me" }, body: JSON.parse(input).body, created_at: "2026-01-05T00:00:00Z",
    updated_at: "2026-01-05T00:00:00Z", html_url: "https://github.com/acme/widgets/pull/7#issuecomment-" + id, author_association: "OWNER" };
  conv.push(c);
  fs.writeFileSync(convFile, JSON.stringify(conv));
  out(c);
} else if (endpoint === "repos/acme/widgets/issues/7/comments") {
  const pages = [];
  for (let i = 0; i < conv.length; i += 2) pages.push(conv.slice(i, i + 2));
  out(pages.length > 0 ? pages : [[]]);
} else if (endpoint && endpoint.startsWith("repos/acme/widgets/pulls/7/")) {
  out([[]]);
} else {
  fs.writeSync(2, "unexpected gh call: " + args.join(" ") + "\\n");
  process.exit(2);
}
`;
  const fake = makeFakeExe(dir, "gh", js);
  fakes.push(fake);
  return fake;
}

type Call = { args: string[]; input: string | null };

async function setup() {
  const dir = makeTempDir("rg-pr-conv");
  dirs.push(dir);
  writeFileSync(
    join(dir, "conversation.json"),
    JSON.stringify([
      comment(3001, "alice", "Could you split this?", "2026-01-02T03:04:05Z"),
      comment(3002, "bob", "LGTM after that", "2026-01-02T04:00:00Z"),
      comment(3003, "carol", "+1", "2026-01-03T00:00:00Z"),
    ]),
  );
  const fake = fakeGh(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello({ ghPath: fake.path });
  const calls = (): Call[] =>
    existsSync(join(dir, "calls.jsonl"))
      ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call)
      : [];
  const conversationIds = () => (h.engine.state.pr.conversation ?? []).map((c) => c.id);
  return { dir, h, calls, conversationIds };
}

describe("§60 the PR conversation", () => {
  it("pr_open loads the conversation (every slurped page) with the PR; pr_reload_comments / refresh {pr} reload it; pr_close clears it", async () => {
    const { dir, h, calls, conversationIds } = await setup();
    expect(h.engine.state.pr.conversation).toEqual([]);

    await h.engine.request({ type: "pr_list" });
    await h.engine.request({ type: "pr_open", summaryId: "github.com/acme/widgets#7" });
    expect(h.engine.state.pr.errorText).toBeNull();
    expect(h.engine.state.pr.selected?.body).toBe("Fixes the cart total."); // the description is PRDetail.body
    expect(h.engine.state.pr.conversation?.[0]).toEqual({
      id: 3001,
      author: "alice",
      body: "Could you split this?",
      createdAt: "2026-01-02T03:04:05Z",
      updatedAt: "2026-01-02T03:04:05Z",
      url: "https://github.com/acme/widgets/pull/7#issuecomment-3001",
      authorAssociation: "MEMBER",
    });
    expect(conversationIds()).toEqual([3001, 3002, 3003]); // pages [[3001, 3002], [3003]]
    const get = calls().find((c) => c.args.includes("repos/acme/widgets/issues/7/comments"));
    expect(get?.args).toEqual(["api", "--hostname", "github.com", "--paginate", "--slurp", "repos/acme/widgets/issues/7/comments"]);

    // Someone comments on GitHub: a reload (and refresh {pr}) brings it in.
    const conv = JSON.parse(readFileSync(join(dir, "conversation.json"), "utf8")) as unknown[];
    writeFileSync(join(dir, "conversation.json"), JSON.stringify([...conv, comment(3004, "dave", "one more", "2026-01-04T00:00:00Z")]));
    await h.engine.request({ type: "pr_reload_comments" });
    expect(conversationIds()).toEqual([3001, 3002, 3003, 3004]);
    writeFileSync(join(dir, "conversation.json"), JSON.stringify([comment(3001, "alice", "Could you split this?", "2026-01-02T03:04:05Z")]));
    await h.engine.request({ type: "refresh", scope: ["pr"] });
    await h.waitFor((s) => (s.pr.conversation ?? []).length === 1, "refresh {pr} reloaded the conversation");

    await h.engine.request({ type: "pr_close" });
    expect(h.engine.state.pr.conversation).toEqual([]);
    expect(h.engine.state.pr.selected).toBeNull();
  });

  it("pr_comment posts the body to issues/N/comments through stdin, then the conversation has it; isCommenting while it posts", async () => {
    const { h, calls, conversationIds } = await setup();
    await h.engine.request({ type: "pr_list" });
    await h.engine.request({ type: "pr_open", summaryId: "github.com/acme/widgets#7" });
    expect(h.engine.state.pr.isCommenting).toBe(false);
    const before = calls().length;
    const states = h.states.length;

    const body = "Thanks — merging after CI.\n\n```ts\nconst a = 1;\n```";
    await h.engine.request({ type: "pr_comment", body });
    const made = calls().slice(before);
    expect(made[0]).toEqual({
      args: ["api", "--hostname", "github.com", "-X", "POST", "repos/acme/widgets/issues/7/comments", "--input", "-"],
      input: JSON.stringify({ body }),
    });
    expect(made.slice(1).map((c) => c.args.at(-1))).toEqual(["repos/acme/widgets/issues/7/comments"]); // the reload
    expect(conversationIds()).toEqual([3001, 3002, 3003, 4003]);
    expect(h.engine.state.pr.conversation?.at(-1)).toMatchObject({ id: 4003, author: "me", body, authorAssociation: "OWNER" });
    await h.settle();
    const seen = h.states.slice(states).map((s) => [s.pr.isCommenting, s.pr.isSubmitting]);
    expect(seen).toContainEqual([true, false]);
    expect(seen.at(-1)).toEqual([false, false]);
    expect(h.engine.state.pr.errorText).toBeNull();
  });

  it("pr_comment refusals: no selected PR, an empty body, a gh failure (its first line); nothing is posted", async () => {
    const { dir, h, calls, conversationIds } = await setup();
    await h.engine.request({ type: "pr_list" });
    await expect(h.engine.request({ type: "pr_comment", body: "hi" })).rejects.toThrow("no_pr_selected");

    await h.engine.request({ type: "pr_open", summaryId: "github.com/acme/widgets#7" });
    await expect(h.engine.request({ type: "pr_comment", body: "  \n\t" })).rejects.toThrow("empty_body");
    expect(calls().some((c) => c.args.includes("POST"))).toBe(false);

    writeFileSync(join(dir, "fail"), "");
    await expect(h.engine.request({ type: "pr_comment", body: "hi" })).rejects.toThrow(
      "pr_comment_failed:HTTP 403: Resource not accessible by integration",
    );
    const refusals = h.ofType("result").filter((r) => r.ok === false).map((r) => [r.code, r.error]);
    expect(refusals).toEqual([
      ["no_pr_selected", "no_pr_selected"],
      ["empty_body", "empty_body"],
      ["pr_comment_failed", "pr_comment_failed:HTTP 403: Resource not accessible by integration"],
    ]);
    expect(h.ofType("error")).toEqual([]); // a refusal, no error event
    expect(h.engine.state.pr.errorText).toBeNull();
    expect(h.engine.state.pr.isCommenting).toBe(false);
    expect(conversationIds()).toEqual([3001, 3002, 3003]);

    await h.engine.request({ type: "pr_close" });
    await expect(h.engine.request({ type: "pr_comment", body: "hi" })).rejects.toThrow("no_pr_selected");
  });
});
