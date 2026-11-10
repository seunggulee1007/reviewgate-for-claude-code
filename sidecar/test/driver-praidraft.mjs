#!/usr/bin/env node
// Real-CLI check for docs/PROTOCOL.md §51 ("AI로 채우기" in the PR sheet): `pr_ai_draft` has a read-only fork of the main
// session write the PR's title and description from the branch's commits and diff, following the repository's PR
// template and keeping the title's issue key. Nothing is committed, pushed or changed. Through the bundled sidecar on a
// fresh scratch repository (loadUserSettings off). Two model calls on RG_MODEL (default haiku).
//
//   node sidecar/test/driver-praidraft.mjs [scratchDir] [sidecar.mjs]   (default $TMPDIR/rg-praidraft, RE-CREATED)
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
// Prints what was observed as JSON; exits 1 when the draft is missing or does not follow the template.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(tmpdir(), "rg-praidraft");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${homedir()}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "haiku";
const STEP_TIMEOUT_MS = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => process.stderr.write(`[praidraft +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
// The app-wide records (§36.8 cli-versions.json) go to the scratch folder, never the user's ~/.reviewgate.
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };

const repo = join(ROOT, "repo");
mkdirSync(join(repo, ".github"), { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "praidraft@example.com");
git(repo, "config", "user.name", "praidraft");
writeFileSync(join(repo, "cart.js"), "export function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0);\n}\n");
writeFileSync(join(repo, ".github", "pull_request_template.md"), "## 변경 내용\n\n## 테스트 방법\n\n## 체크리스트\n- [ ] 테스트를 추가했어요\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");
git(repo, "update-ref", "refs/remotes/origin/main", "main");
git(repo, "switch", "-q", "-c", "feature/PAY-42");
writeFileSync(join(repo, "cart.js"), "export function total(items) {\n  return items.reduce((sum, i) => sum + i.price * (1 - (i.discount ?? 0)), 0);\n}\n");
git(repo, "commit", "-q", "-am", "PAY-42: 장바구니 합계에 할인 반영", "-m", "할인 전 가격으로 더하던 합계를 할인 후 가격으로 계산");
const head = git(repo, "rev-parse", "HEAD");

const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
const exited = new Promise((resolve) => child.on("exit", resolve));
child.stderr.on("data", () => {});
let state = null;
const events = [];
const replies = new Map();
let next = 1;
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + "\n");
createInterface({ input: child.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "state") state = ev.state;
  else events.push(ev);
  if (ev.type === "permission_request") send({ type: "permission_response", requestId: ev.requestId, allow: true });
  if (ev.id && replies.has(ev.id)) replies.get(ev.id)(ev);
});
const request = (cmd) =>
  new Promise((resolve, reject) => {
    const id = `p${next++}`;
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
    replies.set(id, (ev) => {
      clearTimeout(timer);
      replies.delete(id);
      resolve(ev);
    });
    send({ ...cmd, id });
  });
const waitFor = async (pred, what) => {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

const observed = { cli: null };
let failed = false;
try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  const settings = {
    budget: { maxFiles: 5, maxLines: 200 },
    ignorePatterns: [], autoAllowTools: [], loadUserSettings: false,
    systemPromptAppend: "You are running inside a ReviewGate test. Do exactly what each message asks, nothing more.",
    claudePath: CLAUDE, model: MODEL, ghHost: "github.com",
  };
  await request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await request({ type: "open_project", path: repo });
  await waitFor(() => state?.session.open && !state.session.starting, "session open");
  // The task, so the fork knows why the change was made.
  await request({ type: "send", text: "Context only, change nothing: the cart total ignored item discounts (task PAY-42). Reply with exactly: OK" });
  await waitFor(() => events.some((e) => e.type === "turn_end"), "turn end");
  await waitFor(() => state?.gate.phase !== "running" && state?.gate.phase !== "collecting", "review collected");
  const reply = await request({ type: "pr_ai_draft", base: "main", title: "PAY-42: 장바구니 합계에 할인 반영", body: "- PAY-42: 장바구니 합계에 할인 반영" });
  observed.reply = reply.type === "pr_ai_draft" ? { title: reply.title, body: reply.body } : reply;
  observed.untouched = git(repo, "rev-parse", "HEAD") === head && git(repo, "status", "--porcelain") === "";
  log(JSON.stringify(observed));
  const body = reply.body ?? "";
  failed = reply.type !== "pr_ai_draft" || !reply.title.startsWith("PAY-42") || !body.includes("## 변경 내용")
    || !body.includes("## 테스트 방법") || !/할인/.test(body) || !observed.untouched;
} catch (e) {
  failed = true;
  observed.error = e instanceof Error ? e.message : String(e);
} finally {
  send({ type: "shutdown", id: "bye" });
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  const projects = join(homedir(), ".claude", "projects");
  for (const key of (() => {
    try {
      return readdirSync(projects);
    } catch {
      return [];
    }
  })()) {
    if (key.startsWith(projectKey(ROOT))) rmSync(join(projects, key), { recursive: true, force: true });
  }
}
process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
process.exit(failed ? 1 : 0);
