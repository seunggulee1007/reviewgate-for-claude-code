#!/usr/bin/env node
// Real-CLI contract driver for docs/PROTOCOL.md §19.3, §33.4, §8 and §39.4–39.5 (r1-scope): next door without asking, in
// auto mode, through the bundled sidecar on a fresh scratch repository with a second worktree next to it. Model: sonnet
// (RG_MODEL; haiku has no auto mode).
//
//   node sidecar/test/driver-scope.mjs [scratchDir] [sidecar.mjs]   (default ~/rg-driver-scratch/scope (or $RG_DRIVER_SCRATCH/scope), RE-CREATED
//   and removed afterwards; sidecar/dist/sidecar.mjs). The scratch folder must not be under /tmp, /private/tmp or
//   /var/folders: the engine's instruction makes Claude refuse to put a worktree there.
//   CLAUDE_PATH=… (default ~/.local/bin/claude)
//
// 1. Reads next door — `cd ../acme-wt && ls && git log --oneline -1`, `git -C ../acme-wt status` — run with no card and
//    raise no row.
// 2. `cd ../acme-wt && touch made.txt` runs with no card; exactly one worktree_outside_review row, naming made.txt.
// 3. A note in Claude's memory and ../notes.txt (Write) run with no card; state.gate.changedOutside lists both.
// 4. A project skill that starts a task in its own worktree (EnterWorktree first, as such skills do): EnterWorktree runs
//    with no card and the chat follows it into the new worktree (r2-guards M05b, §39.4: chat_moved; before, it was refused
//    and the skill fell back to `git worktree add`, which still gets its row naming the new worktree); the main checkout's
//    branch stays `main`, the new worktree is listed.
// Cleans up ~/.claude/projects/<scratch keys> (only the ones it made), checks no CLI child is left, prints what it saw.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH = process.argv[2] ?? join(process.env.RG_DRIVER_SCRATCH ?? join(homedir(), "rg-driver-scratch"), "scope");
const SIDECAR = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "sidecar.mjs");
const CLAUDE = process.env.CLAUDE_PATH ?? `${process.env.HOME}/.local/bin/claude`;
const MODEL = process.env.RG_MODEL ?? "sonnet";
const STEP_TIMEOUT_MS = 240_000;

const t0 = Date.now();
const log = (m) => process.stderr.write(`[scope +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const observed = { cli: null, model: MODEL, failures: [] };
const check = (cond, msg) => {
  log(`${cond ? "OK  " : "FAIL"} ${msg}`);
  if (!cond) observed.failures.push(msg);
  return cond;
};
/** The CLI's ~/.claude/projects key of a cwd (§30; < 200 chars here). */
const projectKey = (cwd) => cwd.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");

if (/^\/(tmp|private\/tmp|var\/folders|private\/var\/folders)(\/|$)/.test(SCRATCH)) {
  process.stderr.write(`driver-scope: the scratch folder ${SCRATCH} must not be a temporary folder (Claude refuses worktrees there)\n`);
  process.exit(2);
}

// ---------------------------------------------------------------- scratch: a repository, a worktree next to it, a skill
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const ROOT = realpathSync(SCRATCH);
const sidecarEnv = { ...process.env, REVIEWGATE_DATA_DIR: process.env.REVIEWGATE_DATA_DIR || join(ROOT, "rg-data") };
const REPO = join(ROOT, "acme");
const WT = join(ROOT, "acme-wt");
const MEMORY = join(homedir(), ".claude", "projects", projectKey(REPO), "memory", "acme-note.md");
const PARENT = join(ROOT, "notes.txt");
mkdirSync(REPO, { recursive: true });
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
git(REPO, "init", "-q", "-b", "main");
git(REPO, "config", "user.email", "scope@example.com");
git(REPO, "config", "user.name", "scope");
writeFileSync(join(REPO, "App.java"), "class App {}\n");
mkdirSync(join(REPO, ".claude", "skills", "task-start"), { recursive: true });
writeFileSync(
  join(REPO, ".claude", "skills", "task-start", "SKILL.md"),
  [
    "---",
    "name: task-start",
    "description: Start work on a numbered task in a git worktree of its own.",
    "---",
    "",
    "Start the task whose number is given (N).",
    "",
    "1. Enter a separate git worktree for task N with the EnterWorktree tool (name: task-N).",
    "2. In that worktree create TASK.md containing the single line `task N`.",
    "3. Reply DONE and the worktree's path.",
    "",
  ].join("\n"),
);
git(REPO, "add", "-A");
git(REPO, "commit", "-q", "-m", "init");
git(REPO, "worktree", "add", "-q", "-b", "feature/acme-7", WT);
writeFileSync(join(WT, "wt.txt"), "in the other worktree\n");

// ---------------------------------------------------------------- the sidecar (one window)
const w = { state: null, events: [], waiters: [], replies: new Map(), nextId: 1, text: "" };
w.child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"], env: sidecarEnv });
createInterface({ input: w.child.stderr }).on("line", (l) => {
  if (/worktree_outside_review|worktree_blocked|scope|outside/i.test(l) && !/:debug\]/.test(l)) process.stderr.write(`  [sidecar] ${l.slice(0, 240)}\n`);
});
w.exited = new Promise((resolve) => w.child.on("exit", resolve));
w.send = (cmd) => w.child.stdin.write(JSON.stringify(cmd) + "\n");
createInterface({ input: w.child.stdout }).on("line", (line) => {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  if (ev.type === "state") w.state = ev.state;
  else {
    w.events.push(ev);
    if (ev.type === "text_delta" && !ev.unprompted) w.text += ev.text;
    else if (ev.type === "permission_request") {
      log(`card ${ev.toolName}${ev.reason ? ` reason=${ev.reason.code}` : ""} ${JSON.stringify(ev.input).slice(0, 120)} → allow`);
      w.send({ type: "permission_response", requestId: ev.requestId, allow: true });
    } else if (ev.type === "tool_use") log(`tool_use ${ev.name} ${JSON.stringify(ev.input).slice(0, 140)}`);
    else if (ev.type === "error") log(`error(${ev.code ?? ""} fatal=${ev.fatal}) ${String(ev.message).slice(0, 160)}`);
  }
  if (ev.id && w.replies.has(ev.id)) w.replies.get(ev.id)(ev);
  for (const x of [...w.waiters]) if (w.state && x.pred(w.state)) {
    w.waiters.splice(w.waiters.indexOf(x), 1);
    x.resolve(w.state);
  }
});
w.request = (cmd) => {
  const id = `s${w.nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${cmd.type}`)), STEP_TIMEOUT_MS);
    w.replies.set(id, (ev) => {
      clearTimeout(timer);
      w.replies.delete(id);
      resolve(ev);
    });
    w.send({ ...cmd, id });
  });
};
w.waitState = (pred, what, ms = STEP_TIMEOUT_MS) =>
  w.state && pred(w.state)
    ? Promise.resolve(w.state)
    : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; phase=${w.state?.gate.phase}`)), ms);
        w.waiters.push({ pred, resolve: (s) => { clearTimeout(timer); resolve(s); } });
      });
w.cliPids = () => {
  try {
    return execFileSync("pgrep", ["-P", String(w.child.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const settings = {
  ignorePatterns: [".omc/"], autoAllowTools: [], loadUserSettings: false, permissionMode: "auto",
  systemPromptAppend: "You are running inside a ReviewGate test. Do exactly what is asked, nothing else, and do not ask questions.",
  claudePath: CLAUDE, model: MODEL, ghHost: "github.com",
};
const idle = (s) => s.gate.phase !== "running" && s.gate.phase !== "collecting";
const ready = (s) => s.session.open && !s.session.starting;

/** One turn; what it raised: the cards, the error events, the Bash commands it ran. */
async function turn(text) {
  const before = w.state.hud.turnCount;
  const from = w.events.length;
  w.text = "";
  const r = await w.request({ type: "send", text, acceptPending: true });
  if (r.type === "result" && !r.ok) throw new Error(`send refused: ${r.error}`);
  await w.waitState((s) => s.hud.turnCount > before && idle(s), "turn end");
  await sleep(1500); // a row the engine sends once a worktree is listed comes a moment after the turn
  const evs = w.events.slice(from);
  return {
    from,
    text: w.text,
    cards: evs.filter((e) => e.type === "permission_request"),
    errors: evs.filter((e) => e.type === "error"),
    bash: evs.filter((e) => e.type === "tool_use" && e.name === "Bash").map((e) => String(e.input?.command ?? "")),
    tools: evs.filter((e) => e.type === "tool_use").map((e) => e.name),
  };
}

try {
  observed.cli = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
  await w.request({ type: "hello", protocolVersion: 2, client: "test", env: { PATH: process.env.PATH ?? "" }, settings });
  await w.request({ type: "open_project", path: REPO });
  await w.waitState(ready, "session open");
  check(w.state.session.permissionMode === "auto", `the session runs in auto mode (${w.state.session.permissionMode})`);

  // 1. ------------------------------------------------------------ reads next door: no card, no row
  const reads = await turn(
    "Run these two Bash commands, one Bash call each, exactly as written and nothing else: " +
      "`cd ../acme-wt && ls && git log --oneline -1` and then `git -C ../acme-wt status`. Then reply DONE.",
  );
  observed.reads = { bash: reads.bash, cards: reads.cards.map((c) => c.toolName), errors: reads.errors.map((e) => e.code) };
  check(reads.bash.some((c) => c.includes("cd ../acme-wt")) && reads.bash.some((c) => c.includes("git -C ../acme-wt status")), "1: both reads ran");
  check(reads.cards.length === 0, `1: no permission card for the reads (got ${reads.cards.length})`);
  check(!reads.errors.some((e) => e.code === "worktree_outside_review"), "1: no worktree_outside_review row for the reads");

  // 2. ------------------------------------------------------------ a write next door: no card, one row naming the file
  const write = await turn("Run exactly this Bash command and nothing else: `cd ../acme-wt && touch made.txt`. Then reply DONE.");
  const rows = write.errors.filter((e) => e.code === "worktree_outside_review");
  observed.write = { bash: write.bash, cards: write.cards.map((c) => c.toolName), rows: rows.map((e) => ({ path: e.path, files: e.files })) };
  check(existsSync(join(WT, "made.txt")), "2: made.txt was made in the other worktree");
  check(write.cards.length === 0, `2: no permission card for it (got ${write.cards.length})`);
  check(rows.length === 1 && rows[0].path === WT && JSON.stringify(rows[0].files) === JSON.stringify(["made.txt"]), "2: exactly one worktree_outside_review row, naming made.txt");
  check(rows.every((e) => e.fatal === false && e.scope === "session"), "2: the row is a non-fatal session notice");
  check(w.state.lastError === null || !String(w.state.lastError).includes("outside this window's review"), "2: the row is not the session's last error");

  // 3. ------------------------------------------------------------ Claude's memory and a parent folder: no card, listed
  const outside = await turn(
    `Use the Write tool twice, with exactly these absolute paths: create ${MEMORY} containing the single line \`acme note\`, ` +
      `and create ${PARENT} containing the single line \`notes\`. Then reply DONE.`,
  );
  observed.outside = { tools: outside.tools, cards: outside.cards.map((c) => `${c.toolName}:${c.reason?.code ?? ""}`), changedOutside: w.state.gate.changedOutside };
  check(existsSync(MEMORY) && existsSync(PARENT), "3: both files were written");
  check(outside.cards.length === 0, `3: no permission card for them (got ${outside.cards.length})`);
  const listed = w.state.gate.changedOutside ?? [];
  check(listed.includes(MEMORY) && listed.includes(PARENT), "3: gate.changedOutside lists the memory note and ../notes.txt");

  // 4. ------------------------------------------------------------ a worktree-first skill: EnterWorktree, the chat follows
  const worktreesBefore = git(REPO, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
  const task = await turn("Use the task-start skill to start task 42.");
  // M05b (§39.4): in auto mode the engine moves the chat once EnterWorktree ran — it ends the turn first, so the move may land
  // a moment after the turn's end.
  const movedSince = () => w.events.slice(task.from).filter((e) => e.type === "chat_moved");
  for (let waited = 0; task.tools.includes("EnterWorktree") && movedSince().length === 0 && waited < 60_000; waited += 250) await sleep(250);
  const after = git(REPO, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  const made = after.filter((p) => p !== REPO && p !== WT);
  observed.task = {
    tools: task.tools, bash: task.bash, cards: task.cards.map((c) => `${c.toolName}:${c.reason?.code ?? ""}`),
    errors: task.errors.map((e) => `${e.code}:${e.path ?? ""}`), worktrees: after, branch: git(REPO, "rev-parse", "--abbrev-ref", "HEAD"),
  };
  check(after.length === worktreesBefore + 1 && made.length === 1, `4: one new worktree (${made.join(", ")})`);
  check(made.every((p) => !/^\/(tmp|private\/tmp|var\/folders|private\/var\/folders)(\/|$)/.test(p)), "4: not under a temporary folder");
  check(task.cards.length === 0, `4: no permission card (got ${task.cards.map((c) => c.toolName).join(", ")})`);
  check(observed.task.branch === "main", `4: the main checkout's branch is unchanged (${observed.task.branch})`);
  check(made.length === 1 && w.state.workbenches.list.some((x) => x.path === made[0]), "4: the new worktree is listed (the chat can move there)");
  const moved = movedSince();
  observed.task.moved = moved.map((e) => ({ path: e.path, baseline: e.baseline, interrupted: e.interrupted }));
  if (task.tools.includes("EnterWorktree")) {
    check(!task.errors.some((e) => e.code === "worktree_blocked"), "4: EnterWorktree ran (M05b: never refused while isolation is allowed)");
    check(made.length === 1 && moved.some((e) => e.path === made[0]), "4: the chat followed it into the new worktree (chat_moved)");
  } else {
    check(task.bash.some((c) => /\bgit\b.*\bworktree\s+add\b/.test(c)), "4: Claude ran git worktree add");
    check(made.length === 1 && task.errors.some((e) => e.code === "worktree_outside_review" && e.path === made[0]), "4: a row names the new worktree");
  }
  observed.made = made;
} catch (e) {
  log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  observed.failures.push(e instanceof Error ? e.message : String(e));
} finally {
  w.send({ type: "shutdown" });
  await Promise.race([w.exited, sleep(8000)]);
  const left = w.cliPids();
  if (left.length > 0) {
    observed.failures.push("leftover CLI children");
    for (const pid of left) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* gone */
      }
    }
    try {
      w.child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  // The repository's worktrees (one Claude made somewhere else is removed too), then only the ~/.claude/projects folders of
  // those paths — the ones this driver's sessions and Claude's memory note made.
  let worktrees = [REPO, WT, ...(observed.made ?? [])];
  try {
    const listed = git(REPO, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    worktrees = [...new Set([...worktrees, ...listed])];
    for (const p of listed) {
      if (p === REPO || p.startsWith(ROOT + "/")) continue;
      log(`removing a worktree Claude made outside the scratch folder: ${p}`);
      git(REPO, "worktree", "remove", "--force", p);
    }
  } catch {
    /* the repository is gone: the paths above */
  }
  // Every one of them is this run's: the scratch repository and the worktrees it or Claude made.
  for (const cwd of worktrees) rmSync(join(homedir(), ".claude", "projects", projectKey(cwd)), { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
  process.exitCode = observed.failures.length ? 1 : 0;
  process.stdout.write(JSON.stringify(observed, null, 2) + "\n");
  log(observed.failures.length ? `FAILED (${observed.failures.length})` : "OK");
}
