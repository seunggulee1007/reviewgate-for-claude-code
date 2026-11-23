import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeTask, parseTaskRef, taskFetchArgs, taskFetchRefusal } from "../src/pr/task.js";
import { TASK_HANDOFF_FILE, takeTaskHandoff } from "../src/review/taskHandoff.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeFakeExe, type FakeExe } from "./helpers/fakeGh.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §63: `task_fetch {ref}` (one GitHub issue through `gh issue view`) and `workbench_create {task: {draft}}`. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
const fakes: FakeExe[] = [];
const track = (d: string) => (dirs.push(d), d);
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const f of fakes.splice(0)) f.restore();
  for (const d of dirs.splice(0)) removeDir(d);
});

function makeRepo(remote: string | null): string {
  const dir = track(realpathSync(makeTempDir("rg-taskfetch")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  if (remote) sh(dir, "remote", "add", "origin", remote);
  return dir;
}

/** A fake `gh`: logs its argv to `calls.jsonl`; issue 42 exists, 404 is "not found", 500 fails otherwise. */
function fakeGh(dir: string): FakeExe {
  const js = `
const dir = ${JSON.stringify(dir)};
if (args[0] === "--version") { fs.writeSync(1, "gh version 2.0.0 (fake)\\n"); process.exit(0); }
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "issue" && args[1] === "view" && args[2] === "42") {
  fs.writeSync(1, JSON.stringify({ number: 42, title: "Cart total is wrong", body: "Steps:\\n1. add two items", url: "https://" + args[4].split("/")[0] + "/" + args[4].split("/").slice(1).join("/") + "/issues/42",
    labels: [{ name: "bug", color: "d73a4a" }, { name: "cart" }] }));
} else if (args[2] === "404") {
  fs.writeSync(2, "GraphQL: Could not resolve to an issue or pull request with the number of 404. (repository.issue)\\n");
  process.exit(1);
} else {
  fs.writeSync(2, "HTTP 502: Bad gateway (https://api.github.com/graphql)\\nmore\\n");
  process.exit(1);
}
`;
  const fake = makeFakeExe(dir, "gh", js);
  fakes.push(fake);
  return fake;
}

async function setup(remote: string | null = "git@github.com:acme/widgets.git", gh = true) {
  const repo = makeRepo(remote);
  const bin = track(makeTempDir("rg-taskfetch-bin"));
  const fake = gh ? fakeGh(bin) : null;
  const h = makeHarness();
  harnesses.push(h);
  await h.hello(fake ? { ghPath: fake.path } : { ghPath: join(bin, "no-such-gh") });
  await h.open(repo);
  const calls = (): string[][] =>
    existsSync(join(bin, "calls.jsonl")) ? readFileSync(join(bin, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
  return { h, repo, calls };
}

describe("§63 parseTaskRef", () => {
  it("numbers, owner/repo#n and issue URLs; anything else is not a task", () => {
    expect(parseTaskRef("42")).toEqual({ host: null, repo: null, number: 42 });
    expect(parseTaskRef(" #42 ")).toEqual({ host: null, repo: null, number: 42 });
    expect(parseTaskRef("acme/widgets#7")).toEqual({ host: null, repo: "acme/widgets", number: 7 });
    expect(parseTaskRef("https://github.com/acme/widgets/issues/42")).toEqual({ host: "github.com", repo: "acme/widgets", number: 42 });
    expect(parseTaskRef("https://www.github.com/acme/widgets/issues/42/")).toEqual({ host: "github.com", repo: "acme/widgets", number: 42 });
    expect(parseTaskRef("https://GHE.Example.com/team/app/issues/9?x=1#issuecomment-3")).toEqual({ host: "ghe.example.com", repo: "team/app", number: 9 });
    for (const bad of ["", "0", "#0", "ACME-123", "https://github.com/acme/widgets/pull/42", "https://tracker.example.com/task/123", "42 43", "acme#1", "ftp://github.com/a/b/issues/1"]) {
      expect(parseTaskRef(bad), bad).toBeNull();
    }
  });

  it("argv names the host; gh's words become refusals; the JSON is read leniently", () => {
    expect(taskFetchArgs("github.com", "acme/widgets", 42)).toEqual(["issue", "view", "42", "--repo", "github.com/acme/widgets", "--json", "number,title,body,labels,url"]);
    expect(taskFetchRefusal("GraphQL: Could not resolve to an issue or pull request with the number of 9.")).toBe("not_found");
    expect(taskFetchRefusal("HTTP 404: Not Found")).toBe("not_found");
    expect(taskFetchRefusal("\nHTTP 401: Bad credentials\nrun gh auth login")).toBe("task_fetch_failed:HTTP 401: Bad credentials");
    expect(decodeTask('{"number":3,"title":"T","body":null,"labels":[{"name":"a"},{}],"url":"u"}')).toEqual({ id: "3", number: 3, title: "T", body: "", url: "u", labels: ["a"] });
    expect(decodeTask("[]")).toBeNull();
    expect(decodeTask("not json")).toBeNull();
  });
});

describe("§63 task_fetch", () => {
  it("a number is the origin remote's repository, on its host", async () => {
    const { h, calls } = await setup();
    const reply = await h.engine.request({ type: "task_fetch", ref: "#42" });
    expect(reply).toMatchObject({
      type: "task_fetched",
      task: { id: "42", number: 42, title: "Cart total is wrong", body: "Steps:\n1. add two items", url: "https://github.com/acme/widgets/issues/42", labels: ["bug", "cart"] },
    });
    expect(calls()).toEqual([["issue", "view", "42", "--repo", "github.com/acme/widgets", "--json", "number,title,body,labels,url"]]);
  });

  it("an issue URL names its own host and repository (another remote, or none)", async () => {
    const { h, calls } = await setup(null);
    const reply = await h.engine.request({ type: "task_fetch", ref: "https://ghe.example.com/team/app/issues/42" });
    expect(reply.task.url).toBe("https://ghe.example.com/team/app/issues/42");
    expect(calls()[0]).toContain("ghe.example.com/team/app");
  });

  it("refusals: bad_task_ref, no_remote, not_found, task_fetch_failed:<first line>, gh_missing", async () => {
    const { h, calls } = await setup();
    await expect(h.engine.request({ type: "task_fetch", ref: "ACME-123" })).rejects.toThrow("bad_task_ref");
    await expect(h.engine.request({ type: "task_fetch", ref: "404" })).rejects.toThrow("not_found");
    await expect(h.engine.request({ type: "task_fetch", ref: "500" })).rejects.toThrow("task_fetch_failed:HTTP 502: Bad gateway (https://api.github.com/graphql)");
    expect(calls()).toHaveLength(2); // a bad ref never runs gh

    const bare = await setup(null);
    await expect(bare.h.engine.request({ type: "task_fetch", ref: "42" })).rejects.toThrow("no_remote");
    await expect(bare.h.engine.request({ type: "task_fetch", ref: "acme/widgets#42" })).resolves.toMatchObject({ task: { number: 42 } });

    const noGh = await setup("git@github.com:acme/widgets.git", false);
    await expect(noGh.h.engine.request({ type: "task_fetch", ref: "42" })).rejects.toThrow("gh_missing");
  });
});

describe("§63 workbench_create {task: {draft: true}}", () => {
  it("the new workbench's fresh chat gets the text back for the composer — never sent — in the default chat kind", async () => {
    const repo = makeRepo(null);
    const managed = track(realpathSync(makeTempDir("rg-taskdraft-managed")));
    const h = makeHarness();
    harnesses.push(h);
    await h.hello({ worktreeRoot: managed });
    await h.open(repo);
    const text = "Read https://tracker.example.com/task/123 with the acme MCP server, summarize it, then wait.";
    await h.engine.request({ type: "workbench_create", branch: "feature/123-cart", task: { text, draft: true } });
    const wt = h.engine.state.workbenches.list.find((w) => w.branch === "feature/123-cart")!.path;
    const gitDir = sh(wt, "rev-parse", "--absolute-git-dir").trim();
    expect(JSON.parse(readFileSync(join(gitDir, "reviewgate", TASK_HANDOFF_FILE), "utf8"))).toMatchObject({ text, draft: true });

    const t = makeHarness();
    harnesses.push(t);
    await t.hello({ newChatKind: "terminal" });
    await t.open(wt);
    await t.waitFor(() => t.ofType("task_started").length === 1, "task_started");
    expect(t.ofType("task_started")[0]).toEqual({ type: "task_started", text, mode: "default", from: repo, sent: false, draft: true });
    const st = t.engine.state;
    expect(st.sessions.list.find((m) => m.id === st.sessions.currentId)?.kind).toBe("terminal");
    expect(t.sessions.flatMap((s) => s.sends)).toHaveLength(0);
  });

  it("takeTaskHandoff keeps only draft: true", () => {
    const dir = track(makeTempDir("rg-taskdraft-gitdir"));
    write(dir, `reviewgate/${TASK_HANDOFF_FILE}`, JSON.stringify({ version: 1, from: { path: "/work/acme" }, text: "x", draft: "yes", at: new Date(1_700_000_000_000).toISOString() }));
    expect(takeTaskHandoff(dir, 1_700_000_000_000)?.draft).toBeUndefined();
  });
});
